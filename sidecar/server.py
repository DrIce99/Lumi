"""Lumi sidecar: speech recognition, speech synthesis, OCR and UI Automation
for the Electron app, on 127.0.0.1 only.

    uv run python server.py --port 8765 --dev

Every request carries the token the app passes in LUMI_SIDECAR_TOKEN
(HTTP: `Authorization: Bearer <token>`; WebSocket: `?token=<token>`).
Binary WebSocket frames are `[uint32 little-endian id][PCM 16-bit mono]`:
24 kHz from /tts, 16 kHz into /stt.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading

import paths

if sys.platform == "win32":
    # Physical pixels everywhere (UI Automation rectangles, screen captures), like the app's conversions
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        pass

# Model caches must point to %APPDATA%\Lumi\models before any model library is imported
_args_models = None
if "--models-dir" in sys.argv:
    _args_models = sys.argv[sys.argv.index("--models-dir") + 1]
paths.configure(_args_models)

import asyncio  # noqa: E402
import base64  # noqa: E402
import hmac  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import struct  # noqa: E402
import time  # noqa: E402
from contextlib import asynccontextmanager, suppress  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import devices  # noqa: E402
from book.batch import BatchRunner  # noqa: E402
from engines import EngineManager  # noqa: E402
from ocr.base import lines_to_json  # noqa: E402
from ocr.engines import OCRConfig  # noqa: E402
from stt.base import SAMPLE_RATE as STT_RATE  # noqa: E402
from stt.base import STTConfig, pcm16_to_float  # noqa: E402
from text.lexicon_it import lexicon_for  # noqa: E402
from text.normalize_it import normalize  # noqa: E402
from tts.base import SAMPLE_RATE as TTS_RATE  # noqa: E402
from tts.base import Cancel, EngineUnavailable, TTSConfig  # noqa: E402
from turn.smart_turn import SmartTurn  # noqa: E402
from uia.focus import UiaMonitor  # noqa: E402

VERSION = "0.1.0"
log = logging.getLogger("lumi.server")

TOKEN = os.environ.get("LUMI_SIDECAR_TOKEN", "")
PACKAGES = {
    "faster_qwen3_tts": "qwen3",
    "chatterbox": "chatterbox",
    "kokoro_onnx": "kokoro",
    "faster_whisper": "faster-whisper",
    "onnx_asr": "parakeet",
    "pywhispercpp": "whisper-cpp",
    "winrt": "windows-ocr",
    "rapidocr": "rapidocr",
    "uiautomation": "uia",
    "openwakeword": "openwakeword",
}


class State:
    manager: EngineManager
    books: BatchRunner
    uia: UiaMonitor
    uia_enabled = False
    turn = SmartTurn()
    turn_state = "idle"
    embedder = None  # embed.onnx_embed.OnnxEmbedder, created on the first /embed
    embed_error = ""
    wake_state = "idle"
    wake_model = ""
    wake_error = ""
    gpu: dict | None = None
    gpu_at = 0.0


state = State()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state.manager = EngineManager(str(paths.models_dir()))
    state.books = BatchRunner(state.manager)
    state.uia = UiaMonitor()
    log.info("Lumi sidecar %s ready (models in %s)", VERSION, paths.models_dir())
    yield
    state.uia.stop()
    state.manager.shutdown()


app = FastAPI(title="Lumi sidecar", version=VERSION, lifespan=lifespan)


# ---------------- auth ----------------


def check_token(value: str | None) -> bool:
    return not TOKEN or (value is not None and hmac.compare_digest(value, TOKEN))


def http_auth(request: Request) -> None:
    header = request.headers.get("authorization", "")
    if not check_token(header[7:] if header.lower().startswith("bearer ") else None):
        raise HTTPException(status_code=401, detail="token")


async def ws_accept(ws: WebSocket) -> bool:
    if not check_token(ws.query_params.get("token")):
        await ws.close(code=4401)
        return False
    await ws.accept()
    return True


# ---------------- health and configuration ----------------


def gpu() -> dict | None:
    """GPU memory, refreshed in the background: /health must answer at once."""
    if time.monotonic() - state.gpu_at > 10:
        state.gpu_at = time.monotonic()

        def refresh() -> None:
            state.gpu = devices.gpu_info()

        threading.Thread(target=refresh, name="lumi-gpu-info", daemon=True).start()
    return state.gpu


@app.get("/health")
def health(_: None = Depends(http_auth)) -> dict:
    engines = state.manager.statuses()
    if state.uia_enabled:
        engines.append({"kind": "uia", "name": "UI Automation", "state": "error" if state.uia.error else "ready", **({"detail": state.uia.error} if state.uia.error else {})})
    if state.turn_state != "idle":
        engines.append({"kind": "turn", "name": "Smart Turn v3.2", "state": state.turn_state, "device": "cpu", **({"detail": state.turn.error} if state.turn.error else {})})
    if state.embedder is not None:
        embed_state = "error" if state.embed_error else "ready" if state.embedder.loaded else "idle"
        engines.append({"kind": "embed", "name": f"Embedding ({state.embedder.name})", "state": embed_state, "device": "cpu", **({"detail": state.embed_error} if state.embed_error else {})})
    if state.wake_state != "idle":
        engines.append({"kind": "wake", "name": f"openWakeWord ({state.wake_model})", "state": state.wake_state, "device": "cpu", **({"detail": state.wake_error} if state.wake_error else {})})
    return {
        "ok": True,
        "version": VERSION,
        "engines": engines,
        "gpu": gpu(),
        "installed": [name for module, name in PACKAGES.items() if devices.installed(module)],
        "sampleRate": TTS_RATE,
        "pid": os.getpid(),
    }


class ConfigRequest(BaseModel):
    stt: dict | None = None
    tts: dict | None = None
    ocr: dict | None = None
    uia: dict | None = None
    preload: bool = True


def _pick(data: dict, cls) -> dict:
    fields = cls.__dataclass_fields__
    return {k: v for k, v in data.items() if k in fields and v is not None}


@app.post("/config")
def configure(req: ConfigRequest, _: None = Depends(http_auth)) -> dict:
    m = state.manager
    if req.tts is not None:
        if req.tts.get("enabled") is False:
            m.disable("tts")
        else:
            m.configure("tts", TTSConfig(**_pick(req.tts, TTSConfig)), req.preload)
    if req.stt is not None:
        # Remote speech recognition (Groq) runs in the app: nothing to load here
        if req.stt.get("enabled") is False or req.stt.get("engine") == "groq":
            m.disable("stt")
        else:
            m.configure("stt", STTConfig(**_pick(req.stt, STTConfig)), req.preload)
    if req.ocr is not None:
        if req.ocr.get("enabled") is False:
            m.disable("ocr")
        else:
            m.configure("ocr", OCRConfig(**_pick(req.ocr, OCRConfig)), req.preload)
    if req.uia is not None:
        state.uia_enabled = bool(req.uia.get("enabled", True))
        if not state.uia_enabled:
            state.uia.stop()
    return {"ok": True, "engines": m.statuses()}


@app.get("/voices")
def voices(_: None = Depends(http_auth)) -> dict:
    from tts.kokoro import ITALIAN_VOICES
    from tts.qwen3 import SPEAKERS

    out = {"qwen3": SPEAKERS, "kokoro": ITALIAN_VOICES, "chatterbox": ["predefinita"]}
    engine = state.manager.engine("tts")
    if engine is not None and engine.voices():
        out[engine.name] = engine.voices()
    return out


# ---------------- speech synthesis ----------------


@dataclass
class SpeakRequest:
    id: int
    text: str
    emotion: str
    intensity: float
    voice: str | None
    cancel: Cancel = field(default_factory=Cancel)


def frame(stream_id: int, pcm: bytes) -> bytes:
    return struct.pack("<I", stream_id & 0xFFFFFFFF) + pcm


@app.websocket("/tts")
async def tts_socket(ws: WebSocket) -> None:
    if not await ws_accept(ws):
        return
    loop = asyncio.get_running_loop()
    pending: asyncio.Queue[SpeakRequest] = asyncio.Queue()
    requests: dict[int, SpeakRequest] = {}
    send_lock = asyncio.Lock()

    async def send_json(obj: dict) -> None:
        async with send_lock:
            await ws.send_text(json.dumps(obj))

    async def synthesize(req: SpeakRequest) -> None:
        chunks: asyncio.Queue[bytes | None] = asyncio.Queue()
        started = time.monotonic()
        first_ms = None
        samples = 0

        def produce(engine) -> None:
            for pcm in engine.stream(req.text, req.emotion, req.intensity, req.voice or engine.config.voice, req.cancel):
                loop.call_soon_threadsafe(chunks.put_nowait, pcm)
                if req.cancel.cancelled:
                    break

        future = state.manager.submit("tts", produce)
        future.add_done_callback(lambda _f: loop.call_soon_threadsafe(chunks.put_nowait, None))
        await send_json({"id": req.id, "start": True, "sampleRate": TTS_RATE})
        while (pcm := await chunks.get()) is not None:
            if req.cancel.cancelled:
                continue
            if first_ms is None:
                first_ms = round((time.monotonic() - started) * 1000)
            samples += len(pcm) // 2
            async with send_lock:
                await ws.send_bytes(frame(req.id, pcm))
        error = None
        try:
            await asyncio.wrap_future(future)
        except EngineUnavailable as err:
            error = str(err)
        except Exception as err:
            log.exception("Synthesis %s failed", req.id)
            error = f"{type(err).__name__}: {err}"
        done = {
            "id": req.id,
            "done": True,
            "cancelled": req.cancel.cancelled,
            "firstMs": first_ms,
            "ms": round((time.monotonic() - started) * 1000),
            "audioMs": round(samples * 1000 / TTS_RATE),
        }
        if error:
            done["error"] = error
        await send_json(done)

    async def worker() -> None:
        while True:
            req = await pending.get()
            if not req.cancel.cancelled:
                await synthesize(req)
            requests.pop(req.id, None)

    task = asyncio.create_task(worker())
    try:
        while True:
            data = json.loads(await ws.receive_text())
            if "cancel" in data:
                target = data["cancel"]
                for req in list(requests.values()):
                    if target == "all" or req.id == target:
                        req.cancel.event.set()
                continue
            text = str(data.get("text", "")).strip()
            req_id = int(data.get("id", 0))
            if not text:
                await send_json({"id": req_id, "done": True, "cancelled": False, "firstMs": None, "ms": 0, "audioMs": 0})
                continue
            spoken = text if data.get("raw") else normalize(text, lexicon_for(state.manager.config("tts")))
            req = SpeakRequest(req_id, spoken, str(data.get("emotion") or "neutra"), float(data.get("intensity", 0.6)), data.get("voice"))
            requests[req_id] = req
            pending.put_nowait(req)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        for req in requests.values():
            req.cancel.event.set()
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task


# ---------------- speech recognition ----------------


@dataclass
class SttSession:
    id: int
    vocabulary: list[str]
    partials: bool
    voiceprint: bool = False
    audio: bytearray = field(default_factory=bytearray)
    ended: bool = False
    last_partial_bytes: int = 0
    last_partial: str = ""
    task: asyncio.Task | None = None


BYTES_PER_SECOND = STT_RATE * 2
PARTIAL_EVERY = 0.45
PARTIAL_MIN_NEW = 0.35
MAX_SECONDS = 60


def _transcribe(engine, audio, vocabulary, partial):
    return engine.transcribe(audio, vocabulary, partial)


async def _voiceprint(audio) -> list[float] | None:
    """The speaker embedding of a turn; None when it can't be measured (too short, no model)."""
    import voiceprint

    try:
        return await asyncio.to_thread(voiceprint.embed, audio)
    except Exception as err:  # noqa: BLE001 - a missing voiceprint must never cost the transcript
        log.warning("Voiceprint failed: %s", err)
        return None


@app.websocket("/stt")
async def stt_socket(ws: WebSocket) -> None:
    if not await ws_accept(ws):
        return
    sessions: dict[int, SttSession] = {}
    send_lock = asyncio.Lock()
    manager = state.manager

    async def send_json(obj: dict) -> None:
        async with send_lock:
            await ws.send_text(json.dumps(obj))

    async def partial_loop(s: SttSession) -> None:
        loading = None
        while not s.ended:
            await asyncio.sleep(PARTIAL_EVERY)
            engine = manager.engine("stt")
            if engine is None and loading is None and manager.config("stt") is not None:
                # Not loaded yet (no preload): start loading, partials begin once it's ready
                loading = manager.load_async("stt")
            if s.ended or not s.partials or engine is None or not engine.fast:
                continue
            if len(s.audio) - s.last_partial_bytes < PARTIAL_MIN_NEW * BYTES_PER_SECOND:
                continue
            s.last_partial_bytes = len(s.audio)
            audio = pcm16_to_float(bytes(s.audio[-MAX_SECONDS * BYTES_PER_SECOND :]))
            try:
                result = await asyncio.wrap_future(manager.submit("stt", _transcribe, audio, s.vocabulary, True))
            except Exception:
                continue
            if not s.ended and result.text and result.text != s.last_partial:
                s.last_partial = result.text
                await send_json({"id": s.id, "partial": result.text})

    async def finish(s: SttSession) -> None:
        s.ended = True
        if s.task:
            s.task.cancel()
            with suppress(asyncio.CancelledError):
                await s.task
        audio = pcm16_to_float(bytes(s.audio[-MAX_SECONDS * BYTES_PER_SECOND :]))
        duration_ms = round(len(audio) * 1000 / STT_RATE)
        if duration_ms < 150:
            await send_json({"id": s.id, "final": "", "words": [], "durationMs": duration_ms, "ms": 0})
            return
        started = time.monotonic()
        # The voiceprint is measured on the CPU while the GPU transcribes
        print_task = asyncio.create_task(_voiceprint(audio)) if s.voiceprint else None
        try:
            result = await asyncio.wrap_future(manager.submit("stt", _transcribe, audio, s.vocabulary, False))
        except Exception as err:
            if print_task:
                print_task.cancel()
            await send_json({"id": s.id, "final": "", "words": [], "error": str(err), "durationMs": duration_ms})
            return
        reply = {
            "id": s.id,
            "final": result.text,
            "words": [{"word": w.word, "start": w.start, "end": w.end, "p": w.probability} for w in result.words],
            "durationMs": duration_ms,
            "ms": round((time.monotonic() - started) * 1000),
        }
        if print_task and result.text:
            vector = await print_task
            if vector:
                reply["voiceprint"] = vector
        await send_json(reply)

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                data = message["bytes"]
                s = sessions.get(int.from_bytes(data[:4], "little"))
                if s and not s.ended:
                    s.audio.extend(data[4:])
                continue
            data = json.loads(message.get("text") or "{}")
            kind, sid = data.get("type"), int(data.get("id", 0))
            if kind == "start":
                s = SttSession(sid, [str(w) for w in data.get("vocabulary", [])][:200], bool(data.get("partials", True)), bool(data.get("voiceprint", False)))
                s.task = asyncio.create_task(partial_loop(s))
                sessions[sid] = s
            elif kind == "end" and sid in sessions:
                asyncio.create_task(finish(sessions.pop(sid)))
            elif kind == "cancel" and sid in sessions:
                s = sessions.pop(sid)
                s.ended = True
                if s.task:
                    s.task.cancel()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        for s in sessions.values():
            s.ended = True
            if s.task:
                s.task.cancel()


# ---------------- OCR ----------------


class LumaRequest(BaseModel):
    """Screen rectangles (physical pixels) to capture as small luminance frames."""

    regions: list[dict]
    size: int = 640
    # Lumi's own windows when they are visible to captures: painted over
    exclude: list[dict] = []


@app.post("/screen/luma")
async def screen_luma(req: LumaRequest, _: None = Depends(http_auth)) -> Response:
    """Frames for the app's change detection: the luminance bytes one after the other, sizes in X-Sizes."""
    from screen import grab_luma

    def grab() -> list[tuple[int, int, bytes]]:
        return [grab_luma(int(r["x"]), int(r["y"]), int(r["width"]), int(r["height"]), req.size, req.exclude) for r in req.regions]

    try:
        frames = await asyncio.to_thread(grab)
    except Exception as err:  # noqa: BLE001 - a locked screen or a secure desktop can't be captured
        raise HTTPException(status_code=503, detail=f"capture failed: {err}") from err
    return Response(
        b"".join(f[2] for f in frames),
        media_type="application/octet-stream",
        headers={"X-Sizes": ",".join(f"{w}x{h}" for w, h, _ in frames)},
    )


class JpegRequest(BaseModel):
    """A screen rectangle (physical pixels) to capture for the vision model."""

    region: dict
    size: int = 1280
    exclude: list[dict] = []


@app.post("/screen/jpeg")
async def screen_jpeg(req: JpegRequest, _: None = Depends(http_auth)) -> Response:
    from screen import grab_jpeg

    r = req.region
    try:
        width, height, jpeg = await asyncio.to_thread(grab_jpeg, int(r["x"]), int(r["y"]), int(r["width"]), int(r["height"]), req.size, 75, req.exclude)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"capture failed: {err}") from err
    return Response(jpeg, media_type="image/jpeg", headers={"X-Size": f"{width}x{height}"})


class OcrRequest(BaseModel):
    """Either an image (PNG, or raw BGRA with its size) or a screen region to capture here."""

    image: str | None = None
    format: str = "png"
    width: int = 0
    height: int = 0
    region: dict | None = None
    lang: str = "it"
    exclude: list[dict] = []


def decode_image(req: OcrRequest):
    from PIL import Image

    raw = base64.b64decode(req.image or "")
    if req.format == "bgra":
        return Image.frombuffer("RGBA", (req.width, req.height), raw, "raw", "BGRA", 0, 1)
    return Image.open(io.BytesIO(raw))


def grab_region(region: dict, exclude: list[dict] | None = None):
    """Captures a rectangle of the screen (physical pixels), `exclude` painted over (Lumi's windows when visible)."""
    from PIL import Image

    from screen import grab_bgra

    box = {k: int(region[k]) for k in ("x", "y", "width", "height")}
    size = (max(1, box["width"]), max(1, box["height"]))
    return Image.frombytes("RGB", size, grab_bgra(box["x"], box["y"], *size, exclude), "raw", "BGRX")


def offset_lines(lines: list[dict], dx: float, dy: float) -> list[dict]:
    for line in lines:
        line["rect"]["x"] += dx
        line["rect"]["y"] += dy
        for word in line["words"]:
            word["rect"]["x"] += dx
            word["rect"]["y"] += dy
    return lines


@app.post("/ocr")
async def ocr(req: OcrRequest, _: None = Depends(http_auth)) -> dict:
    started = time.monotonic()
    region = req.region

    def run(engine):
        image = grab_region(region, req.exclude) if region else decode_image(req)
        return engine.recognize(image, req.lang)

    try:
        lines = await asyncio.wrap_future(state.manager.submit("ocr", run))
    except EngineUnavailable as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    out = lines_to_json(lines)
    if region:
        # Back to screen coordinates
        out = offset_lines(out, float(region["x"]), float(region["y"]))
    engine = state.manager.engine("ocr")
    return {"lines": out, "engine": engine.name if engine else "", "ms": round((time.monotonic() - started) * 1000)}


# ---------------- audiobooks ----------------


class BatchRequest(BaseModel):
    """A long text, or a .txt/.epub file, into one audio file (WAV, or M4B with chapters via ffmpeg)."""

    output: str
    source: str | None = None
    text: str | None = None
    title: str = ""
    dialogueVoice: str | None = None


@app.post("/tts/batch")
def tts_batch(req: BatchRequest, _: None = Depends(http_auth)) -> dict:
    if not req.source and not req.text:
        raise HTTPException(status_code=400, detail="source or text")
    if state.manager.config("tts") is None:
        raise HTTPException(status_code=503, detail="nessun motore di sintesi configurato")
    job = state.books.start(req.output, req.source, req.text, req.title, req.dialogueVoice)
    return job.to_json()


@app.get("/tts/batch/{job_id}")
def tts_batch_status(job_id: str, _: None = Depends(http_auth)) -> dict:
    job = state.books.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job")
    return job.to_json()


@app.delete("/tts/batch/{job_id}")
def tts_batch_cancel(job_id: str, _: None = Depends(http_auth)) -> dict:
    return {"ok": state.books.cancel(job_id)}


# ---------------- embeddings for the memory (CPU) ----------------


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "document"  # "query" | "document"
    model: str = ""


def _embed(req: EmbedRequest) -> dict:
    from embed.onnx_embed import DEFAULT_MODEL, OnnxEmbedder

    name = req.model or DEFAULT_MODEL
    if state.embedder is None or state.embedder.name != name:
        state.embedder = OnnxEmbedder(name)
    try:
        vectors = state.embedder.embed(req.texts, "query" if req.kind == "query" else "document")
    except Exception as err:
        state.embed_error = f"{type(err).__name__}: {err}"[:300]
        raise
    state.embed_error = ""
    return {"model": name, "vectors": [[round(float(x), 6) for x in v] for v in vectors]}


@app.post("/embed")
async def embed(req: EmbedRequest, _: None = Depends(http_auth)) -> dict:
    """Embeddings for the memory's search by meaning, when Ollama isn't there (roadmap 10.6).
    Never logs the texts: they are the user's conversations."""
    if len(req.texts) > 64:
        raise HTTPException(status_code=413, detail="at most 64 texts per request")
    try:
        return await asyncio.to_thread(_embed, req)
    except Exception as err:
        raise HTTPException(status_code=503, detail=str(err)) from err


# ---------------- end of turn ----------------


class TurnRequest(BaseModel):
    """The last seconds of the user's turn: PCM 16-bit 16 kHz mono, base64."""

    audio: str


def _turn_probability(audio) -> float:
    if state.turn.session is None:
        state.turn_state = "loading"
    try:
        p = state.turn.probability(audio)
    except Exception as err:
        state.turn.error = f"{type(err).__name__}: {err}"[:300]
        state.turn_state = "error"
        raise
    state.turn_state = "ready"
    return p


@app.post("/turn")
async def turn(req: TurnRequest, _: None = Depends(http_auth)) -> dict:
    audio = pcm16_to_float(base64.b64decode(req.audio))
    started = time.monotonic()
    try:
        probability = await asyncio.to_thread(_turn_probability, audio)
    except Exception as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    return {"probability": round(probability, 4), "ms": round((time.monotonic() - started) * 1000)}


@app.post("/turn/load")
async def turn_load(_: None = Depends(http_auth)) -> dict:
    """Loads Smart Turn in advance (the first turn must not wait for the download)."""
    import numpy as np

    try:
        await asyncio.to_thread(_turn_probability, np.zeros(16000, dtype=np.float32))
    except Exception as err:
        return {"ok": False, "error": str(err)}
    return {"ok": True}


# ---------------- wake word ----------------


@app.websocket("/wake")
async def wake_socket(ws: WebSocket) -> None:
    """Wake word scores. The app sends {"model": "lumi"} first (answer: {"type": "ready", "model"}
    or {"type": "error", "missing": bool, "error"}), then binary frames `[uint32 id][PCM 16-bit 16 kHz]`
    with the speech the VAD hears, and {"reset": true} at each new speech segment. For every 80 ms
    of audio the sidecar answers with a score: {"type": "scores", "scores": [...]}."""
    if not await ws_accept(ws):
        return
    from wake.detector import WakeDetector, WakeModelMissing

    detector = None
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is not None:
                try:
                    data = json.loads(message["text"])
                except ValueError:
                    continue
                if "model" in data:
                    name = str(data["model"])[:40]
                    try:
                        if state.wake_state != "ready":
                            state.wake_state = "loading"
                        detector = await asyncio.to_thread(WakeDetector.load, name)
                        state.wake_state, state.wake_model, state.wake_error = "ready", name, ""
                        await ws.send_text(json.dumps({"type": "ready", "model": name}))
                    except WakeModelMissing as err:
                        state.wake_state, state.wake_model, state.wake_error = "missing", name, str(err)
                        await ws.send_text(json.dumps({"type": "error", "missing": True, "error": str(err)}))
                    except Exception as err:  # noqa: BLE001 - openwakeword missing, download failed...
                        log.warning("Wake word model %s unavailable: %s", name, err)
                        state.wake_state, state.wake_model, state.wake_error = "error", name, f"{type(err).__name__}: {err}"[:300]
                        await ws.send_text(json.dumps({"type": "error", "missing": False, "error": state.wake_error}))
                elif data.get("reset") and detector is not None:
                    detector.reset()
            elif message.get("bytes") is not None and detector is not None:
                pcm = message["bytes"][4:]
                scores = await asyncio.to_thread(detector.feed, pcm)
                if scores:
                    await ws.send_text(json.dumps({"type": "scores", "scores": [round(s, 4) for s in scores]}))
    except (WebSocketDisconnect, RuntimeError):
        pass


# ---------------- UI Automation ----------------


@app.websocket("/uia")
async def uia_socket(ws: WebSocket) -> None:
    if not await ws_accept(ws):
        return
    loop = asyncio.get_running_loop()
    latest: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)

    def push(snapshot: dict) -> None:
        def put() -> None:
            # Only the newest state matters
            if latest.full():
                latest.get_nowait()
            latest.put_nowait(snapshot)

        loop.call_soon_threadsafe(put)

    async def sender() -> None:
        while True:
            snapshot = await latest.get()
            await ws.send_text(json.dumps(snapshot))

    state.uia.subscribe(push)
    task = asyncio.create_task(sender())
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        state.uia.unsubscribe(push)
        task.cancel()


@app.websocket("/apps")
async def apps_socket(ws: WebSocket) -> None:
    """Listening to other apps (a Discord call). The app sends {"apps": ["Discord"], "vocabulary": [...]};
    the sidecar answers with {"type": "status", "apps": {...}} and, for every utterance heard,
    {"type": "heard", "app", "text", "durationMs", "voiceprint"?}. Closing the socket stops listening."""
    if not await ws_accept(ws):
        return
    from appaudio import RATE, AppListener

    loop = asyncio.get_running_loop()
    utterances: asyncio.Queue = asyncio.Queue(maxsize=20)
    send_lock = asyncio.Lock()
    vocabulary: list[str] = []
    manager = state.manager

    async def send_json(obj: dict) -> None:
        async with send_lock:
            await ws.send_text(json.dumps(obj))

    def on_utterance(app_name: str, audio) -> None:
        def put() -> None:
            if utterances.full():
                # Too much to transcribe: the oldest goes
                utterances.get_nowait()
            utterances.put_nowait((app_name, audio))

        loop.call_soon_threadsafe(put)

    def on_status(statuses: dict) -> None:
        asyncio.run_coroutine_threadsafe(send_json({"type": "status", "apps": statuses}), loop)

    async def transcriber() -> None:
        while True:
            app_name, audio = await utterances.get()
            if manager.config("stt") is None:
                await send_json({"type": "status", "apps": {app_name: "errore: serve il riconoscimento vocale locale (non Groq)"}})
                continue
            print_task = asyncio.create_task(_voiceprint(audio))
            try:
                result = await asyncio.wrap_future(manager.submit("stt", _transcribe, audio, vocabulary, False))
            except Exception as err:  # noqa: BLE001
                print_task.cancel()
                log.warning("Transcribing %s audio failed: %s", app_name, err)
                continue
            vector = await print_task
            if not result.text:
                continue
            message = {"type": "heard", "app": app_name, "text": result.text, "durationMs": round(len(audio) * 1000 / RATE)}
            if vector:
                message["voiceprint"] = vector
            await send_json(message)

    listener = AppListener(on_utterance, on_status)
    task = asyncio.create_task(transcriber())
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = json.loads(message.get("text") or "{}")
            vocabulary[:] = [str(w) for w in data.get("vocabulary", [])][:200]
            apps = [str(a) for a in data.get("apps", [])]
            await asyncio.to_thread(listener.set_apps, apps)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        task.cancel()
        await asyncio.to_thread(listener.close)


# ---------------- entry point ----------------


def watch_parent(pid: int) -> None:
    """Exits when the app's process is gone.

    It waits on the process handle rather than reading stdin: on Windows a
    pending synchronous read on stdin blocks every subprocess started
    meanwhile (DuplicateHandle on the inherited stdin), freezing the engines.
    """
    if sys.platform == "win32":
        import ctypes

        synchronize = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            log.warning("Can't watch the app process %s", pid)
            return
        ctypes.windll.kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
    else:
        while True:
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(2)
    log.info("The app went away: exiting")
    os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Lumi sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--models-dir", default=None)
    parser.add_argument("--dev", action="store_true", help="log more")
    parser.add_argument("--parent-pid", type=int, default=0, help="exit when this process (the app) exits")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.dev and os.environ.get("LUMI_DEBUG") else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    for noisy in ("httpx", "huggingface_hub", "urllib3", "numba", "matplotlib", "phonemizer"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("the sidecar only listens on 127.0.0.1")
    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), name="lumi-parent", daemon=True).start()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", ws_max_size=16 * 1024 * 1024)


if __name__ == "__main__":
    main()
