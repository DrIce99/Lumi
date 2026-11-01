"""Audiobook jobs: a long text (or a .txt/.epub/.docx file) becomes one audio
file, chapter by chapter. Pieces of up to a few sentences are synthesized
one at a time on the TTS thread, so live speech can still get through
between them. Each take is tidied (edges, long silences, level) and, with a
local recognizer, heard back: a take that skips or invents words is
generated again with another seed, and the best one is kept. Output is WAV,
or M4B/M4A/MP3 with chapters when ffmpeg is installed.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from text.lexicon_it import lexicon_for
from text.normalize_it import normalize
from tts.base import SAMPLE_RATE, Cancel

from .audio import acceptable, level, tidy
from .parse import Book, load_book, parse_text, pieces

log = logging.getLogger("lumi.book")

CHAPTER_PAUSE_MS = 2000
#: Takes per piece at most (the first one plus retakes with other seeds)
ATTEMPTS = 3


@dataclass
class BatchJob:
    id: str
    output: Path
    title: str = ""
    state: str = "queued"
    done: int = 0
    total: int = 0
    error: str | None = None
    file: str | None = None
    chapters: list[dict] = field(default_factory=list)
    #: None until the first take: whether takes are heard back by a local recognizer
    checked: bool | None = None
    retakes: int = 0
    #: Pieces that failed every take: {chapter, atMs, text}
    doubtful: list[dict] = field(default_factory=list)
    report: str | None = None
    started: float = field(default_factory=time.time)
    cancel: Cancel = field(default_factory=Cancel)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "title": self.title,
            "error": self.error,
            "file": self.file,
            "chapters": self.chapters,
            "checked": self.checked,
            "retakes": self.retakes,
            "doubtful": len(self.doubtful),
            "report": self.report,
            "seconds": round(time.time() - self.started),
        }


def silence(ms: int) -> bytes:
    return b"\0\0" * int(SAMPLE_RATE * ms / 1000)


def ms_of(nbytes: int) -> int:
    return nbytes * 1000 // (2 * SAMPLE_RATE)


def clock(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}"


def ffmetadata(title: str, chapters: list[dict]) -> str:
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", " ")

    lines = [";FFMETADATA1", f"title={esc(title)}", "genre=Audiobook"]
    for ch in chapters:
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={ch['startMs']}", f"END={ch['endMs']}", f"title={esc(ch['title'])}"]
    return "\n".join(lines) + "\n"


class BatchRunner:
    def __init__(self, manager, attempts: int = ATTEMPTS):
        self.manager = manager
        self.attempts = attempts
        self.jobs: dict[str, BatchJob] = {}

    def start(self, output: str, source: str | None = None, text: str | None = None, title: str = "", dialogue_voice: str | None = None) -> BatchJob:
        job = BatchJob(uuid.uuid4().hex[:12], Path(output), title)
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, source, text, dialogue_voice), name=f"lumi-book-{job.id}", daemon=True).start()
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancel.event.set()
        return True

    def _speak(self, text: str, voice: str | None, cancel: Cancel, seed: int | None) -> tuple[bytes, bool]:
        """(audio, whether another seed would give another take)."""

        def run(engine):
            pcm = b"".join(engine.stream(text, "neutra", 0.5, voice or engine.config.voice, cancel, seed=seed))
            return pcm, getattr(engine, "seeded", False)

        return self.manager.submit("tts", run).result()

    def _hear(self, pcm: bytes) -> str | None:
        """What the local recognizer hears in a take; None without one."""
        if self.manager.config("stt") is None:
            return None
        import soxr

        audio = soxr.resample(np.frombuffer(pcm, "<i2").astype(np.float32) / 32768.0, SAMPLE_RATE, 16000).astype(np.float32)
        return self.manager.submit("stt", lambda engine: engine.transcribe(audio, [], False).text).result()

    def _take(self, text: str, voice: str | None, job: BatchJob, lexicon) -> tuple[bytes, bool]:
        """The first take that says the text, else the closest of `attempts`: (audio, passed)."""
        base_seed = getattr(self.manager.config("tts"), "seed", 7)
        best, best_score = b"", -1.0
        for attempt in range(self.attempts):
            if attempt:
                job.retakes += 1
            pcm, seeded = self._speak(text, voice, job.cancel, None if attempt == 0 else base_seed + 1009 * attempt)
            pcm = tidy(pcm)
            if job.cancel.cancelled or job.checked is False:
                return level(pcm), True
            try:
                heard = self._hear(pcm) if pcm else ""
            except Exception as err:
                log.warning("Audiobook %s: takes not checked, the recognizer failed (%s)", job.id, type(err).__name__)
                heard = None
            if heard is None:
                job.checked = False
                return level(pcm), True
            job.checked = True
            # The text sent to the voice is already spoken Italian: the transcript too
            ok, score = acceptable(text, normalize(heard, lexicon), len(pcm) / (2 * SAMPLE_RATE))
            if score > best_score:
                best, best_score = pcm, score
            if ok:
                return level(pcm), True
            if not seeded:
                break
        log.info("Audiobook %s: piece %d kept after %d takes, score %.2f", job.id, job.done, attempt + 1, best_score)
        return level(best), False

    def _run(self, job: BatchJob, source: str | None, text: str | None, dialogue_voice: str | None) -> None:
        job.state = "running"
        tmp = None
        try:
            book: Book = load_book(source) if source else parse_text(text or "", job.title)
            job.title = job.title or book.title
            plan = [(i, p) for i, ch in enumerate(book.chapters) for p in pieces(ch.text, dialogue=bool(dialogue_voice))]
            job.total = len(plan)
            if not plan:
                raise ValueError("Il testo è vuoto.")
            lexicon = lexicon_for(self.manager.config("tts"))
            job.output.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(suffix=".pcm", dir=job.output.parent)
            tmp = Path(tmp_name)
            written = 0
            with open(fd, "wb") as pcm:
                current = -1
                for n, (index, piece) in enumerate(plan):
                    if job.cancel.cancelled:
                        job.state = "cancelled"
                        return
                    if index != current:
                        if current >= 0:
                            job.chapters[-1]["endMs"] = ms_of(written)
                        current = index
                        job.chapters.append({"title": book.chapters[index].title, "startMs": ms_of(written), "endMs": 0})
                    spoken = normalize(piece.text, lexicon)
                    if spoken:
                        at = ms_of(written)
                        audio, ok = self._take(spoken, dialogue_voice if piece.dialogue and dialogue_voice else None, job, lexicon)
                        pcm.write(audio)
                        written += len(audio)
                        if not ok:
                            job.doubtful.append({"chapter": book.chapters[index].title, "atMs": at, "text": piece.text})
                    last_in_chapter = n + 1 == len(plan) or plan[n + 1][0] != index
                    pause = silence(CHAPTER_PAUSE_MS if last_in_chapter else piece.pause_ms)
                    pcm.write(pause)
                    written += len(pause)
                    job.done += 1
                job.chapters[-1]["endMs"] = ms_of(written)
            job.file = str(self._encode(tmp, job))
            if job.doubtful:
                job.report = str(self._report(job))
            job.state = "done"
            log.info("Audiobook %s ready: %s (%d pieces, %d retakes, %d doubtful)", job.id, job.file, job.total, job.retakes, len(job.doubtful))
        except Exception as err:
            log.exception("Audiobook %s failed", job.id)
            job.state = "error"
            job.error = f"{type(err).__name__}: {err}"[:400]
        finally:
            if tmp and tmp.exists():
                tmp.unlink()

    def _report(self, job: BatchJob) -> Path:
        """Next to the audio: where to listen again, with the text that should be there."""
        path = Path(job.file or job.output).with_suffix(".da-riascoltare.txt")
        lines = [
            f"{job.title}: punti in cui la voce potrebbe aver saltato o storpiato qualche parola",
            f"(nessuna delle {self.attempts} prove è stata riconosciuta uguale al testo).",
            "",
        ]
        lines += [f"{clock(d['atMs'])}  {d['chapter']}\n    {d['text']}" for d in job.doubtful]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def _encode(self, pcm_file: Path, job: BatchJob) -> Path:
        out = job.output
        ffmpeg = shutil.which("ffmpeg")
        if out.suffix.lower() in (".m4b", ".m4a", ".mp3") and ffmpeg:
            meta = pcm_file.with_suffix(".txt")
            meta.write_text(ffmetadata(job.title, job.chapters), encoding="utf-8")
            codec = ["-c:a", "libmp3lame", "-b:a", "96k"] if out.suffix.lower() == ".mp3" else ["-c:a", "aac", "-b:a", "64k"]
            cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", str(pcm_file), "-i", str(meta), "-map_metadata", "1", "-map_chapters", "1", *codec, str(out)]
            try:
                subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                return out
            finally:
                meta.unlink(missing_ok=True)
        # No ffmpeg (or WAV asked): a plain WAV file
        if out.suffix.lower() != ".wav":
            out = out.with_suffix(".wav")
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            with open(pcm_file, "rb") as src:
                while chunk := src.read(1 << 20):
                    w.writeframes(chunk)
        return out
