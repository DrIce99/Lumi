"""End-to-end check of a running sidecar, the way the app uses it.

    uv run python server.py --port 8765 --dev          # in one terminal
    uv run python scripts/smoke.py --url http://127.0.0.1:8765

Configures the engines, speaks a sentence through /tts (streaming, timed),
sends that audio back through /stt as if it were the microphone, asks
/turn whether the turn is complete and reads a corner of the screen with
/ocr. Prints the latencies.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import struct
import sys
import time
import urllib.request
import wave

import numpy as np


def http(url: str, token: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    req = urllib.request.Request(
        url + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


async def speak(ws_url: str, text: str, emotion: str) -> tuple[bytes, float, float]:
    import websockets

    async with websockets.connect(ws_url, max_size=None) as ws:
        started = time.monotonic()
        await ws.send(json.dumps({"type": "speak", "id": 1, "text": text, "emotion": emotion, "intensity": 0.7}))
        audio = b""
        first = None
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                if first is None:
                    first = time.monotonic() - started
                audio += msg[4:]
                continue
            data = json.loads(msg)
            if data.get("done"):
                if data.get("error"):
                    raise RuntimeError(data["error"])
                return audio, first or 0.0, time.monotonic() - started


async def listen(ws_url: str, pcm16k: bytes) -> tuple[dict, list[str], float]:
    import websockets

    partials: list[str] = []
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "id": 7, "vocabulary": ["Lumi"], "partials": True}))
        frame = 512 * 2
        for i in range(0, len(pcm16k), frame):
            await ws.send(struct.pack("<I", 7) + pcm16k[i : i + frame])
            await asyncio.sleep(0.032)  # like a live microphone
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.001)
                    data = json.loads(msg)
                    if "partial" in data:
                        partials.append(data["partial"])
            except (asyncio.TimeoutError, TimeoutError):
                pass
        ended = time.monotonic()
        await ws.send(json.dumps({"type": "end", "id": 7}))
        while True:
            data = json.loads(await ws.recv())
            if "partial" in data:
                partials.append(data["partial"])
            if "final" in data:
                return data, partials, time.monotonic() - ended


def wait_ready(url: str, token: str, kinds: set[str], timeout: float) -> dict:
    started = time.monotonic()
    while True:
        health = http(url, token, "/health")
        states = {e["kind"]: e for e in health["engines"]}
        if all(states.get(k, {}).get("state") == "ready" for k in kinds):
            return health
        bad = [e for e in states.values() if e["state"] in ("error", "missing")]
        if bad:
            raise RuntimeError(f"engine failed: {bad}")
        if time.monotonic() - started > timeout:
            raise TimeoutError(f"engines not ready: {states}")
        time.sleep(2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("LUMI_SIDECAR_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--token", default=os.environ.get("LUMI_SIDECAR_TOKEN", ""))
    parser.add_argument("--tts", default="qwen3")
    parser.add_argument("--tts-model", default="1.7B-CustomVoice")
    parser.add_argument("--voice", default="ryan")
    parser.add_argument("--stt", default="faster-whisper")
    parser.add_argument("--text", default="Ciao! Sono Lumi. Alle 15:30 ti ricordo la riunione, va bene?")
    parser.add_argument("--out", default="smoke.wav")
    args = parser.parse_args()
    url, token = args.url.rstrip("/"), args.token
    ws = url.replace("http", "ws", 1)

    print("health:", http(url, token, "/health")["installed"])
    http(url, token, "/config", {"tts": {"engine": args.tts, "model": args.tts_model, "voice": args.voice}, "stt": {"engine": args.stt}, "ocr": {"engine": "windows"}, "uia": {"enabled": False}, "preload": True})
    started = time.monotonic()
    health = wait_ready(url, token, {"tts", "stt"}, timeout=1800)
    print(f"engines ready in {time.monotonic() - started:.0f} s:", [(e["kind"], e["name"], e.get("device")) for e in health["engines"]])

    for warm in (False, True):
        audio, first, total = asyncio.run(speak(f"{ws}/tts?token={token}", args.text, "gioia"))
        seconds = len(audio) / 2 / 24000
        print(f"TTS{' (warm)' if warm else ''}: first audio after {first * 1000:.0f} ms, {seconds:.1f} s of audio in {total:.2f} s")
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(audio)

    import soxr

    pcm16k = (np.clip(soxr.resample(np.frombuffer(audio, "<i2").astype(np.float32) / 32768, 24000, 16000), -1, 1) * 32767).astype("<i2").tobytes()
    final, partials, after = asyncio.run(listen(f"{ws}/stt?token={token}", pcm16k))
    print(f"STT: {len(partials)} partials, final {after * 1000:.0f} ms after the end: {final['final']!r}")

    turn = http(url, token, "/turn", {"audio": base64.b64encode(pcm16k).decode()}, timeout=120)
    print(f"Smart Turn: p(complete) = {turn['probability']:.2f} in {turn['ms']} ms")

    ocr = http(url, token, "/ocr", {"region": {"x": 0, "y": 0, "width": 600, "height": 300}}, timeout=60)
    print(f"OCR ({ocr['engine']}): {len(ocr['lines'])} lines in {ocr['ms']} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
