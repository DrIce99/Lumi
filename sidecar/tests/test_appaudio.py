"""Listening to other apps: finding them, cutting their audio into utterances, the /apps socket."""

import json
import threading
import time

import numpy as np

import appaudio
import server
import voiceprint
from engines import EngineManager

from .fakes import factories

RATE = 16000


def tone(seconds, amp=0.2):
    t = np.arange(int(RATE * seconds)) / RATE
    return (amp * np.sin(2 * np.pi * 200 * t)).astype(np.float32)


def quiet(seconds):
    return np.zeros(int(RATE * seconds), np.float32)


def test_app_roots_are_the_topmost_processes():
    table = [(1, 0, "explorer.exe"), (10, 1, "Discord.exe"), (11, 10, "Discord.exe"), (12, 10, "Discord.exe"), (20, 1, "chrome.exe"), (30, 1, "discord.exe")]
    assert appaudio.app_roots("Discord", table) == [10, 30]
    assert appaudio.app_roots("discord.exe", table) == [10, 30]
    assert appaudio.app_roots("Telegram", table) == []


def test_segmenter_cuts_utterances_at_pauses():
    seg = appaudio.Segmenter()
    out = []
    # Fed in odd-sized chunks, as a capture delivers them
    stream = np.concatenate([quiet(1), tone(1.2), quiet(0.3), tone(0.5), quiet(1), tone(0.2), quiet(1), tone(2)])
    for i in range(0, len(stream), 777):
        out += seg.push(stream[i : i + 777])
    out += seg.flush()
    lengths = [round(len(o) / RATE, 1) for o in out]
    # A 0.3 s pause doesn't end the turn; a 0.2 s blip is not an utterance; the last one ends with the stream
    assert len(out) == 2, lengths
    assert 1.9 <= lengths[0] <= 2.4, lengths
    assert 1.9 <= lengths[1] <= 2.4, lengths


def test_segmenter_cuts_very_long_speech():
    seg = appaudio.Segmenter(max_ms=3000)
    out = seg.push(tone(7))
    assert [round(len(o) / RATE) for o in out] == [3, 3]


class FakeCapture:
    def __init__(self, pid, on_audio):
        self.pid, self.on_audio, self.error, self.alive = pid, on_audio, None, True

    def start(self):
        return True

    def stop(self):
        self.alive = False


def test_listener_follows_apps_opening_and_closing():
    table = [(10, 1, "Discord.exe")]
    heard, statuses, made = [], [], []

    def factory(pid, on_audio):
        made.append(FakeCapture(pid, on_audio))
        return made[-1]

    listener = appaudio.AppListener(lambda app, a: heard.append((app, len(a))), statuses.append, factory, lambda: table, every=3600)
    listener.set_apps(["Discord", "Telegram"])
    listener.scan()
    assert statuses[-1] == {"Discord": "in ascolto", "Telegram": "chiusa"}
    made[0].on_audio(np.concatenate([tone(1), quiet(1)]))
    assert heard and heard[0][0] == "Discord"
    table.clear()
    listener.scan()
    assert statuses[-1] == {"Discord": "chiusa", "Telegram": "chiusa"}
    assert made[0].alive is False
    listener.close()


def test_apps_socket_transcribes_with_voiceprints(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server, "TOKEN", "")
    monkeypatch.setattr(voiceprint, "embed", lambda audio: [1.0, 0.0])
    made = []

    class Capture(FakeCapture):
        def __init__(self, pid, on_audio):
            super().__init__(pid, on_audio)
            made.append(self)

    monkeypatch.setattr(appaudio, "ProcessCapture", Capture)
    monkeypatch.setattr(appaudio, "processes", lambda: [(10, 1, "Discord.exe")])
    with TestClient(server.app) as client:
        server.state.manager = EngineManager(str(tmp_path), factories())
        client.post("/config", json={"stt": {"engine": "faster-whisper"}, "preload": False})
        with client.websocket_connect("/apps") as ws:
            ws.send_text(json.dumps({"apps": ["Discord"]}))
            status = json.loads(ws.receive_text())
            assert status == {"type": "status", "apps": {"Discord": "in ascolto"}}
            deadline = time.time() + 5
            while not made and time.time() < deadline:
                time.sleep(0.01)
            threading.Thread(target=made[0].on_audio, args=(np.concatenate([tone(1.5), quiet(1)]),)).start()
            heard = json.loads(ws.receive_text())
    assert heard["type"] == "heard" and heard["app"] == "Discord"
    assert heard["text"] == "ciao Lumi"
    assert heard["voiceprint"] == [1.0, 0.0]
