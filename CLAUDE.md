# Lumi - notes for development sessions

Desktop voice assistant: an always-on-top transparent face (two vertical
capsule eyes, no mouth) that listens, talks with an expressive voice and
watches the screen. Electron + TypeScript app (`app/`) plus a Python sidecar
(`sidecar/`) for STT, TTS, OCR and UI Automation. Modeled on Pixel Pet
(github.com/DrIce99/pet): reuse its patterns and code where they fit.
The user writes in Italian; UI strings and README are Italian, code and
comments English. Target platform: Windows 10/11.

See README.md for the feature spec, face parameters, roadmap and protocol.
Work one roadmap phase at a time; finish each with checks green.

## Commands

- `app/`: `npm run check` (typecheck + `node:test` bundled by esbuild),
  `npm start` / `npm run debug` (DevTools).
- Always launch through `run.mjs`: shells spawned by VS Code export
  `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` behave as plain Node.
- `sidecar/`: `uv sync`, `uv run python server.py --port 8765 --dev`,
  `uv run pytest`. Set `LUMI_SIDECAR_URL` to make the app use a sidecar
  started by hand instead of spawning its own.

## Architecture

- Two processes. Electron main spawns the sidecar on `127.0.0.1` with a
  random port and a token passed via env; every request carries the token.
  `sidecar.ts` polls `/health`, restarts on crash with backoff, and the app
  degrades to text mode (face + chat, no voice) while it is down.
- Main process owns: window, tray, settings, perception, brain, turn
  manager. Renderer owns: face drawing, microphone, VAD, audio playback.
  Keep heavy work (capture diffing, OCR calls) out of the renderer.
- `window.ts`: frameless, `transparent: true`, `alwaysOnTop` at
  `'screen-saver'` level, `skipTaskbar`, `setContentProtection(true)` (so our
  own captures and screen sharing skip the face), click-through with
  `setIgnoreMouseEvents(true, { forward: true })` toggled by a hit test on
  opaque eye pixels (same approach as Pixel Pet's `solid`).
- Face (`renderer/face/`): canvas, animates at 60 fps only while something
  moves, then idles. Every visual parameter (eye height/width/skew/offset,
  blink amount) is a tweened number; expressions are target parameter sets,
  never per-frame logic. Blink, gaze and talk-pulse compose additively.
- Perception (`main/perception/`): independent sources emit attention
  candidates `{ rect, kind, salience, t }` in screen DIP coordinates;
  `attention.ts` (pure) picks the gaze target with decay and hysteresis;
  `reading.ts` (pure) turns OCR lines into a fixation sequence.
  `desktopCapturer` works in physical pixels: convert with
  `screen.screenToDipRect` / `dipToScreenRect`, per display.
- OCR runs only on changed regions, never on the full screen every frame.
  The vision model (`look_at_screen`) is on demand only; gaze never waits
  for it. Grounding "look at X" = fuzzy match of X against OCR/UIA text.
- Brain: provider code ported from Pixel Pet (`providers/compat.ts`,
  `openai.ts`, `ollama.ts`; no Anthropic provider, the project is free-only).
  Providers take a `fetch`; pass Electron's `net.fetch` (Windows cert store
  + system proxy). For node scripts use `node --use-system-ca`.
- Speech goes through the `say({ text, emotion, intensity, look? })` tool,
  not free text, so emotion reaches both TTS and face. Models without tool
  support fall back to the JSON reply format in `compat.ts`.

## Voice pipeline decisions

- Everything streams. `chunker.ts` (pure) cuts the LLM stream into
  sentences (punctuation, or a comma after ~60 chars) and each sentence goes
  to TTS immediately. Optimize time-to-first-audio above all.
- TTS audio is played in the renderer with WebAudio, in the same process as
  `getUserMedia({ echoCancellation: true, noiseSuppression: true })`, so
  Chromium's AEC has the reference signal. Do not play audio from main or
  from the sidecar.
- VAD (Silero via `@ricky0123/vad-web`) runs in the renderer; only speech
  segments go to the sidecar.
- Barge-in: user speech > 300 ms while speaking → 80 ms fade-out, cancel
  TTS (`{ cancel: id }`) and the LLM stream, and store in history only the
  text actually played, marked as interrupted. Track played text per chunk.
- End of turn = VAD silence (500 ms) + semantic check (Smart Turn or the
  trailing-word heuristic in `endpoint.ts`), max wait 1.2 s.
- Text sent to TTS is normalized to spoken Italian first
  (`sidecar/text/normalize_it.py`): numbers, dates, times, currency,
  acronyms, URLs, emoji.
- Voice identity must stay stable across sentences: fixed speaker + seed
  (Qwen3-TTS) or the same reference clip (Chatterbox).
- Backchannel and filler clips are pre-generated at startup with the
  current voice and cached; they never go through the LLM.

## Sidecar conventions

- FastAPI + WebSocket. Engines implement a small base class
  (`stt/base.py`, `tts/base.py`, `ocr/`) and are loaded lazily; only the
  engines selected in settings are kept in memory (VRAM is the constraint).
- TTS output: PCM 16-bit mono 24 kHz in chunks. STT input: PCM 16 kHz mono.
- Heavy optional deps (torch, model packages) are extras in
  `pyproject.toml` so a "light" profile installs without CUDA.
- Model downloads go to a cache dir under `%APPDATA%\Lumi\models`, never
  into the repo.

## Privacy rules (enforce in code)

- OCR text, UIA text and captures never leave the machine except: the
  short perception summary in the prompt, and screenshots via
  `look_at_screen` subject to `sendScreenshots` (`never|ask|always`).
- Perception pauses for apps in `pauseInApps`, private browser windows,
  locked screen, user away > 5 min, "Non disturbare".
- Logs never contain audio or OCR text unless `LUMI_DEBUG_PERCEPTION=1`.
- API keys encrypted with DPAPI (as in Pixel Pet); env vars
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` also accepted.

## Testing

- Pure modules (`attention`, `reading`, `chunker`, `endpoint`,
  `normalize_it`, emotion mapping) get unit tests. Providers and the
  sidecar are mocked in app tests; sidecar engines are mocked in pytest
  except tests marked `@pytest.mark.model` (skipped by default).

## Implementation notes (decisions taken while building)

- Renderer pages are served from `app://lumi/` (privileged scheme in
  `main/protocol.ts`), not file://: the VAD fetches its ONNX model and
  onnxruntime-web loads WebAssembly and an ES module glue file. Media
  permission is granted only to that origin.
- Face window = face box + room for bubble/chat (`main/layout.ts`, pure):
  overlays go above the eyes, or below when the face is near the top.
  Hit test is geometric on the rotated capsules (`Face.hitTest`).
- Brain streaming: `MomentSession.next(onLive)` gives structured `LiveSay[]`
  (emotion/intensity/look/text, read from partial JSON). The say schema
  lists `emotion` before `text` so the voice knows the emotion before the
  first sentence. `VoiceSpeech` (voice/speechOut.ts) owns chunking, TTS ids,
  playback tracking and "what was heard" (heardPart) for interruptions.
- Turn-taking lives in `voice/turns.ts` (state machine with an injectable
  clock, fully tested). The renderer streams VAD frames itself (pre-roll on
  speech start; everything while push-to-talk is held) according to
  `MicControl`; push-to-talk release is polled with GetAsyncKeyState.
  The wake word is spotted in transcripts (`voice/wakeWord.ts`, fuzzy), so
  "Ehi Lumi" works without training an openWakeWord model.
- OCR: the app sends the changed rectangle (physical px) and the sidecar
  captures it with `mss` (`POST /ocr {region}`); PNG/BGRA images are still
  accepted. The sidecar process is per-monitor DPI aware.
- Smart Turn v3.2 (`sidecar/turn/`): Whisper log-mel features computed in
  numpy (checked against WhisperFeatureExtractor in tests), so the light
  profile doesn't need transformers. `POST /turn`, `POST /turn/load`.
- Sidecar Python env: torch 2.11.0+cu128 (torchaudio stops at 2.11; CUDA 12
  so CTranslate2 finds cuBLAS 12 in torch/lib). faster-qwen3-tts + the
  `qwen-tts-hf` build (Transformers 5). `tts/qwen3.py` re-registers the
  "default" RoPE initializer: qwen-tts's shim reads `config.rope_theta`,
  gone from Transformers 5.19 configs. Chatterbox's old pins are overridden
  in `[tool.uv] override-dependencies`; gradio (demo UIs only) is dropped.
- Hugging Face downloads use plain HTTPS (`HF_HUB_DISABLE_XET=1` in
  `sidecar/paths.py`): the Xet client crawled at concurrency 1 here.
- Whisper hallucinates on silence ("Grazie a tutti"): an RMS gate before
  transcription plus a phrase filter in `stt/base.py`.
- Audiobooks: `sidecar/book/` parses .txt/.epub (stdlib only), sentences
  go one by one through the TTS thread (live speech can interleave), output
  M4B with chapters via ffmpeg, else WAV. `POST/GET/DELETE /tts/batch`.
- Gemma 4 through Ollama writes many say calls as text instead of calling
  the tool (5 of 12 in a probe): `say{emotion:<|"|>gioia<|"|>,text:<|"|>…<|"|>}`,
  `say(emotion:gioia,text: "…")` or with unquoted text.
  `brain/providers/textCalls.ts` reads them back, also while streaming
  (values only grow, so live speech never takes words back), and the
  history keeps them as real calls. Ollama hands over real tool calls only
  when complete, so they don't stream: the first sentence waits for the end
  of the reply. `main/ollama.ts` starts the local Ollama server when a
  brain choice uses it.

## Debug aids (env vars)

`LUMI_SIDECAR_URL` (+ `LUMI_SIDECAR_TOKEN`), `LUMI_DEBUG_GAZE=1` (overlay
of candidates and target), `LUMI_DEBUG_PERCEPTION=1`,
`LUMI_DEBUG_SAY="text|emotion"` (speak without LLM),
`LUMI_DEBUG_MESSAGE="..."` (as if spoken to Lumi),
`LUMI_DEBUG_HEAR=<file.wav>` (PCM16 WAV fed to the turn manager as if
spoken with push-to-talk: tests STT → brain → TTS without a microphone),
`LUMI_DEBUG_CAPTURE=<prefix>` (PNG frames of the face window),
`LUMI_DEBUG_VISIBLE=1` (no content protection: real screenshots show the
face, to check it on screen),
`LUMI_DEBUG_SETTINGS=<tab>` (opens the settings on a tab; captured with
LUMI_DEBUG_CAPTURE). Logs: `%APPDATA%\Lumi\logs\` (`lumi.log`,
`sidecar.log`). Real-model sidecar tests: `uv run pytest -m model -s`.