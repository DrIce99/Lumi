"""Audiobook jobs: a long text (or a .txt/.epub file) becomes one audio
file, chapter by chapter. Sentences are synthesized one at a time on the
TTS thread, so live speech can still get through between them. Output is
WAV, or M4B/M4A/MP3 with chapters when ffmpeg is installed.
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

from text.normalize_it import normalize
from tts.base import SAMPLE_RATE, Cancel

from .parse import Book, load_book, parse_text, sentences, voice_parts

log = logging.getLogger("lumi.book")

SENTENCE_PAUSE_MS = 300
CHAPTER_PAUSE_MS = 1500


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
            "seconds": round(time.time() - self.started),
        }


def silence(ms: int) -> bytes:
    return b"\0\0" * int(SAMPLE_RATE * ms / 1000)


def ffmetadata(title: str, chapters: list[dict]) -> str:
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", " ")

    lines = [";FFMETADATA1", f"title={esc(title)}", "genre=Audiobook"]
    for ch in chapters:
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={ch['startMs']}", f"END={ch['endMs']}", f"title={esc(ch['title'])}"]
    return "\n".join(lines) + "\n"


class BatchRunner:
    def __init__(self, manager):
        self.manager = manager
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

    def _speak(self, text: str, voice: str | None, cancel: Cancel) -> bytes:
        def run(engine):
            return b"".join(engine.stream(text, "neutra", 0.5, voice or engine.config.voice, cancel))

        return self.manager.submit("tts", run).result()

    def _run(self, job: BatchJob, source: str | None, text: str | None, dialogue_voice: str | None) -> None:
        job.state = "running"
        tmp = None
        try:
            book: Book = load_book(source) if source else parse_text(text or "", job.title)
            job.title = job.title or book.title
            plan = [(i, s) for i, ch in enumerate(book.chapters) for s in sentences(ch.text)]
            job.total = len(plan)
            if not plan:
                raise ValueError("Il testo è vuoto.")
            job.output.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(suffix=".pcm", dir=job.output.parent)
            tmp = Path(tmp_name)
            written = 0
            with open(fd, "wb") as pcm:
                current = -1
                for index, sentence in plan:
                    if job.cancel.cancelled:
                        job.state = "cancelled"
                        return
                    if index != current:
                        if current >= 0:
                            pcm.write(silence(CHAPTER_PAUSE_MS))
                            written += len(silence(CHAPTER_PAUSE_MS))
                            job.chapters[-1]["endMs"] = written * 1000 // (2 * SAMPLE_RATE)
                        current = index
                        job.chapters.append({"title": book.chapters[index].title, "startMs": written * 1000 // (2 * SAMPLE_RATE), "endMs": 0})
                    for part, dialogue in voice_parts(sentence):
                        spoken = normalize(part)
                        if not spoken:
                            continue
                        audio = self._speak(spoken, dialogue_voice if dialogue and dialogue_voice else None, job.cancel)
                        pcm.write(audio)
                        written += len(audio)
                    pcm.write(silence(SENTENCE_PAUSE_MS))
                    written += len(silence(SENTENCE_PAUSE_MS))
                    job.done += 1
                if job.chapters:
                    job.chapters[-1]["endMs"] = written * 1000 // (2 * SAMPLE_RATE)
            job.file = str(self._encode(tmp, job))
            job.state = "done"
            log.info("Audiobook %s ready: %s (%d sentences)", job.id, job.file, job.total)
        except Exception as err:
            log.exception("Audiobook %s failed", job.id)
            job.state = "error"
            job.error = f"{type(err).__name__}: {err}"[:400]
        finally:
            if tmp and tmp.exists():
                tmp.unlink()

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
