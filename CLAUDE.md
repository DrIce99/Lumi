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
  Screen captures work in physical pixels: convert with
  `screen.screenToDipRect` / `dipToScreenRect`, per display.
- Never block the main thread: `setIgnoreMouseEvents(…, { forward: true })`
  installs a low-level mouse hook there, so any stall freezes the whole
  system pointer. That's why screen captures (change detection and
  `look_at_screen`) are taken by the sidecar (`/screen/luma`,
  `/screen/jpeg`): `desktopCapturer.getSources` blocked ~400 ms per call.
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
- End of turn = VAD silence (`listen.pauseMs`, 1 s by default, set in the
  settings) + semantic check (Smart Turn or the trailing-word heuristic in
  `endpoint.ts`); an unfinished-sounding turn waits 2.4x the pause, max 4 s.
  The user found 500 ms too eager: Lumi answered mid-thought.
- Pronunciation: no IPA/G2P (Qwen3-TTS and Chatterbox read text tokens,
  they would read the symbols). Words are respelled in Italian letters by
  `sidecar/text/lexicon_it.py`, applied in `normalize()` before acronyms:
  the user's "parola = pronuncia" lines (`tts.pronunciations`, sent as
  `TTSConfig.lexicon`, a light setting: no reload) for every engine, plus
  `ESPEAK_LOANWORDS` for Kokoro only (espeak-ng reads English loanwords
  the Italian way; "file" only with an article, it is also "fila"'s
  plural). `scripts/pronuncia.py` reads `text/trappole_it.txt` through a
  running sidecar per engine:model:voice and scores it with `--asr`.
  A LoRA on Qwen3 Base is only a later, optional step (roadmap 17).
- Text sent to TTS is normalized to spoken Italian first
  (`sidecar/text/normalize_it.py`): numbers, dates, times, currency,
  acronyms, URLs, emoji.
- Voice identity must stay stable across sentences: fixed speaker + seed
  (Qwen3-TTS) or the same reference clip (Chatterbox).
  Qwen3-TTS Base (cloning) gets no emotion instruction: it isn't trained
  for one and the timbre drifted with each emotion. The clip itself
  matters most: 10-20 s of one clean voice (a long compilation of roles
  averages into an unstable voice).
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
- Logs never contain audio or OCR text unless `LUMI_DEBUG_PERCEPTION=1`
  (the same goes for transcripts of other apps' audio).
- Other apps' audio (`appAudio`, off by default) is captured and transcribed
  only in the sidecar, with the local STT; only the transcribed lines reach
  the prompt. Voiceprints (`voices.json`) never leave the main process
  (the settings window gets labels, not vectors).
- API keys encrypted with DPAPI (as in Pixel Pet); env vars
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`
  (Ollama Cloud) also accepted.

## Testing

- Pure modules (`attention`, `reading`, `chunker`, `endpoint`,
  `normalize_it`, emotion mapping, `backdrop`, `glare`; later
  `patterns`, memory `search`) get unit tests. Providers and the
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
  captures it with GDI BitBlt without CAPTUREBLT (`sidecar/screen.py`: that
  flag makes the mouse pointer stutter at every capture; `POST /ocr
  {region}`); PNG/BGRA images are still
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
  transcription plus a phrase filter in `stt/base.py`; Groq's Whisper runs
  in the app and gets the same rules from `voice/sttFilter.ts`.
- Audiobooks: `sidecar/book/` parses .txt/.epub (stdlib only), sentences
  go one by one through the TTS thread (live speech can interleave), output
  M4B with chapters via ffmpeg, else WAV. `POST/GET/DELETE /tts/batch`.
- Gemma 4 through Ollama writes many say calls as text instead of calling
  the tool (5 of 12 in a probe): `say{emotion:<|"|>gioia<|"|>,text:<|"|>…<|"|>}`,
  `say(emotion:gioia,text: "…")`, with unquoted text, positional
  (`say("gioia", "…", 0.8, "")`: required parameters first) or after an
  English preamble (dropped). Any leak that reaches the spoken history gets
  imitated by the model in later turns, so it snowballs.
  `brain/providers/textCalls.ts` reads them back, also while streaming
  (values only grow, so live speech never takes words back), and the
  history keeps them as real calls. Ollama hands over real tool calls only
  when complete, so they don't stream: the first sentence waits for the end
  of the reply. `main/ollama.ts` starts the local Ollama server when a
  brain choice uses it.

- Memory: `memory.json` keeps facts, notes, reminders, the recent window,
  episodes and diary; every line, episode and diary day also goes to
  `memory.db` (phase 10, step 1 done). Lines that leave the 16-line window
  are summarized into episodes by the "idle" model between moments
  (`Brain.writeEpisode`, JSON with summary + facts; requests to Lumi are
  not facts).
- `memory.db` uses `node:sqlite` (bundled with Electron's Node 24: FTS5,
  `loadExtension` for sqlite-vec), not `better-sqlite3` (native
  module to rebuild for Electron). It lives in a worker thread
  (`memory/worker.ts`, bundled as `dist/main/memoryWorker.js`): SQLite is
  synchronous and must not stall the mouse-hook thread. `MemoryStore`
  (`store.ts`) is the async client; writes are fire and forget, the worker
  handles requests in order (so lines keep their order), `settled()`
  waits for them; `MemoryStore.local(db)` runs in-process for tests.
- Schema v1 (`PRAGMA user_version` migrations): `messages` (ts, session
  split by 30 min pauses, speaker, name, via, channel, interrupted, text)
  + `messages_fts`; `summaries` (period `episode`|`day`, start, end, text,
  source_ids) + `summaries_fts`; external-content FTS5 with triggers,
  `unicode61 remove_diacritics 2`. No Italian stemmer in FTS5: query terms
  are lightly stemmed in `search.ts` and matched as prefixes (`"gatt"*`),
  then a hit needs half of the query's words (checked in JS on the row).
  Hits come with the line before and after (same session).
- Vectors (step 10.2): `sqlite-vec` npm (prebuilt `vec0.dll`, path from
  `getLoadablePath()` in main, passed to the worker; null = words only).
  Schema v2: `embeddings` (owner_kind message|summary, owner_id, model,
  dim) + `vec_tables` (one `vec0` table per model: `distance_metric=cosine`,
  metadata `kind`, `ts`, `te` so date/kind filters run inside the KNN).
  Embedded: lines >= 12 chars with the previous line of the session as
  context, and summaries. `indexer.ts` (worker) is the queue: "what has no
  vector of the current model", newest first, batches of 16, paused while
  `setBusy` (main polls brain/voice busy) and 5 s after; model missing ->
  retry in 5 min, Ollama down -> 1 min; old models' vectors dropped only
  when the new one covers everything. `embed.ts` = Ollama `/api/embed`
  (task prefixes for nomic). Search: FTS lists (messages, summaries) and
  the vector top 50 fused with RRF (k 60), then relevance (normalized
  RRF) + recency 0.995^hours (age of the memory, not last access) +
  importance (0 until facts) with `memory.weights`. Vector hits need the
  model's floor (bge-m3 0.50, nomic 0.60, else 0.55: measured, see
  README) and to be within 0.06 of the best. Query embedding: 250 ms for
  `<recalled>`, 1.5 s for the tool, else words only; `store.warm()` (on
  listening, chat, bar) loads the model ahead, at most once a minute.
  bge-m3 warm: ~15-100 ms per query, whole search ~20-30 ms.
- `<recalled>` comes from `Memory.recall` (500 ms timeout, recent window
  excluded) for every message; the model calls `search_memory({ query?,
  from?, to?, kind? })` with local dates ("2026-03", "2026-03-12 18:00",
  a month or day alone means all of it). The old `recall` tool name is
  still accepted. On first start `Memory.importLegacy` moves
  `archive.jsonl` (renamed `.imported`), episodes and diary in, once
  (`meta.legacy_import`). "Dimentica tutto" deletes rows, rebuilds FTS,
  `VACUUM`s and deletes the old archive.
- Voices: `sidecar/voiceprint.py` runs WeSpeaker ResNet34 (VoxCeleb) with
  onnxruntime and Kaldi fbank in numpy (checked against torchaudio), not
  sherpa-onnx (it bundles onnxruntime 1.17, which clashes with the newer
  DLL the other engines load). Thresholds in `voice/speakers.ts`: same
  voice >= 0.55, new < 0.40 (measured: same vs average >= 0.69, different
  <= 0.67 on Kokoro voices; Discord-like test: same 0.67-0.81, different
  0.11). The first mic voice is the owner; uncertain counts as the user.
- App audio: `sidecar/appaudio.py` uses WASAPI process loopback (include
  tree) through comtypes. comtypes must be imported before the capture
  thread starts (`_com()` in `start()`), or CoInitializeEx fails with
  RPC_E_CHANGED_MODE. Windows captures nothing from a tree that contains
  the capturing process, so tests must play from a process outside the
  sidecar's tree (PowerShell SoundPlayer), not a Python child.

- Discord: `src/discord/bot.ts` (discord.js + @discordjs/voice 0.19, DAVE
  through @snazzah/davey, Opus through opusscript: no native module to
  rebuild for Electron; aes-256-gcm comes from Electron's crypto) runs in
  a `utilityProcess` (gateway, Opus and encryption off the main thread).
  It joins deafened (send only: receiving had DAVE bugs in 0.19) and
  follows the user's voice state. Main tees Lumi's audio (`AudioOut` in
  main.ts) to the face window and the bot; while the bot is in a channel
  the renderer mutes its output *after* the analyser (`audioLocal`), so
  the talk pulse, playback events and barge-in keep working. Bots can't
  join DM calls. Lumi's voice heard back through app audio is dropped as
  echo while the bot is live.
- Adaptive outline (`perception/backdrop.ts`, pure): the mean luma behind
  the face box, read once a second from the change detector's frames of
  Lumi's monitor (`ChangeDetector.onFrames`, no extra capture; content
  protection keeps our window out of them), picks one of three
  shadow/border opacity bands with 0.03 hysteresis; no sample for 3 s =
  middle band. Main sends `face:contrast` only on change, the renderer
  eases it over 400 ms. `LUMI_DEBUG_VISIBLE=1` puts the face itself in
  the captures, so the measure is wrong while it is set. Canvas shadow
  blur/offset ignore the transform: multiply by devicePixelRatio.
- Expression timing: emotion travels with each sentence (`AudioBegin`,
  the sentence id is the sequence). The renderer player sends a "lead"
  playback event 120 ms before a sentence's scheduled start (for the next
  sentence while the current one still plays); `VoiceSpeech` applies the
  emotion and gaze on "lead", or on "start" if no lead came, once per
  sentence and never after an abort. Answer emotion fades 1.5-3 s after
  speaking ends (`Mood`); barge-in clears it (`mood.clearEmotion()`), the
  turn manager already sets listening → "ascolto". Missing or unknown
  emotions are guessed from the text (`guessEmotion` in
  `shared/emotions.ts`: cue words matched whole, then "?!" / "!"), in
  `parseToolCall`, in streamed say calls (per sentence) and for plain-text
  answers; an explicit emotion always wins. Mid-text `[emotion]` tags are
  not used: one say call per emotion.
- Lid cuts: `EyeShape.lidTop/lidAngle/cheek` cut the capsule with a
  straight, possibly slanted lid from above (sad: outer side lower, angry:
  inner side lower) and a straight cheek line from below (`cheek`,
  `cheekAngle`; happy: outer side higher). Lines only, no curves. Drawn on an
  offscreen layer; the border is that layer stamped in 8 directions and
  tinted black, so glow, shadow and border follow the cut shape.
- Glare: `perception/glare.ts` (pure) turns the change detector's luma
  frames of the watched display (gaze target's, else the foreground's)
  into a 64x36 linear-light thumbnail (sRGB decoding of the luma: an
  approximation of Rec. 709 on linearized RGB, fine for the thresholds);
  fires on dark (< 0.25) to bright (> 0.55, > 60% bright pixels) within
  500 ms, 20 s cooldown, history reset when the watched display changes,
  blocked while asleep, dragged or hidden. No extra capture, so it needs
  perception on. The renderer's `face/glare.ts` (pure) is the squint
  curve, a multiplicative layer on eye heights plus a 3 px gaze shift;
  60% while speaking; blinks paused during it, 1-2 settling blinks after.
- Command bar (`main/commandbar.ts`, page in `renderer/commandbar/`):
  pre-created hidden window, toggled by `chatHotkey` (Ctrl+Alt+L; the face
  chat stays on the eye click). Acrylic + DWM rounded corners on Windows 11
  22H2+ (`supportsAcrylic`, `roundCorners` in desktop.ts), a transparent
  window with a dark panel otherwise. It reads the foreground window and
  the UIA selection (`Perception.selection()`, honors pauses and password
  fields) *before* taking the focus, and gives the focus back on close
  (`focusWindow`). It doesn't close on blur (dragging a file from Explorer
  blurs it). Dropped files: paths via `webUtils.getPathForFile` in the
  preload, read in main by `attachments.ts` (text clipped, images
  described in words by `Screenshots.describeImage`). The message goes to
  the brain as `{ via: "bar", context, attachments }`; replies follow
  `commandBar.reply`. While open, a "caret" attention candidate on the bar
  makes the eyes look at it.

- Local vision (`perception/vision.ts` pure parts + clients,
  `screenshots.ts` the chain): top-level `vision` setting (Ollama by
  default, `qwen3-vl:8b`, `keep_alive: "2m"`, `format: "json"`; or an
  OpenAI-compatible local server at `brain.customUrl`; or none). The brain
  never receives images: it gets `{ description, texts, regions }` as
  text; the OCR of the same area goes along as a hint. Regions (0-1000)
  become screen rects: `Perception.seen()` adds them as grounding items
  (look_at finds them by label) and glance candidates. The area is the
  active window when it covers < 50% of its display. Without local vision
  (or on failure): an online model (`brain.vision`) only if
  `sendScreenshots` allows it (default now `never`), else the OCR text.
  `look_at_screen` honors perception pauses. Attached bar images go
  through the same chain.
- Wake word: `sidecar/wake/detector.py` scores 80 ms chunks with
  openWakeWord (models in `%APPDATA%\Lumi\models\wake`; feature models
  and generic ones downloaded from the v0.5.1 release; `lumi.onnx` from
  `wake/train.py`). The app sends the VAD's speech frames to `/wake`
  (`voice/wakeClient.ts`) and decides in `voice/wakeSpotter.ts` (2 frames
  >= `listen.wakeThreshold`, x1.3 while speaking). `TurnManager` keeps the
  segment in a 1.5 s ring and opens STT only when the name fires (then
  ring + live audio; late scores accepted for 400 ms after speech end);
  without a ready model it falls back to transcript spotting. Asleep with
  the screen locked or while another app records (`voice/micUse.ts`
  parses `reg query` of the CapabilityAccessManager microphone store;
  Lumi and `appAudio.apps` don't count). `LUMI_WAKE_MODEL` picks another
  model (e.g. `hey_jarvis`) to try the flow.

## Planned features (not built yet; roadmap phases 10, 11, 14, 15, 16)

Decisions already taken for the next phases. Nothing here exists in the
code yet; when a piece lands, move its notes to the sections above.

### Memory (`main/brain/memory/`, phase 10)

Steps 1 (raw log, FTS, `search_memory`, import) and 2 (embeddings,
hybrid search) are built: see the notes above. Still planned: facts (still
in `memory.json`, to import) with importance in the score, week/month
summaries, backups, forget, sidecar CPU embeddings without Ollama.

- Goal: remember everything for years, prioritize what matters, forget
  only on explicit request. Memories never go into model weights.
- One SQLite file (`%APPDATA%\Lumi\memory.db`, `node:sqlite` +
  `sqlite-vec` + FTS5). Four layers: raw message log (append-only), hybrid
  index (FTS5 + vectors), extracted facts, hierarchical summaries
  (day → week → month).
- Text is the source of truth; vectors are a rebuildable index. Every
  vector row stores its embedding model name; on model change re-embed in
  the background and search only vectors of the current model meanwhile.
- Embeddings via Ollama (`bge-m3` default) from an async queue: never block
  a conversation turn on embedding. Without Ollama, sidecar CPU embeddings;
  without either, FTS only.
- Search: date/kind filters first, FTS5 and vector top-50 in parallel,
  Reciprocal Rank Fusion, then rerank with the Generative Agents score
  (relevance + exponential recency decay + importance). Importance only
  reorders, it never discards. `search.ts` is pure and unit-tested.
- Prompt budget ~1500 tokens: facts with importance >= 8 always included,
  other memories only when relevant. The model can also call
  `search_memory({ query, from, to, kind })`.
- Facts and summaries store `source_ids` (message ids). A contradicting new
  fact sets `superseded_by` on the old one instead of duplicating it.
- Forget is a cascade with user confirmation (`forget({ query })`): search
  all layers, show matches, delete rows + vectors + FTS entries + facts
  derived only from them, regenerate summaries/facts that cited them,
  `VACUUM`, regenerate backups. Never delete memory outside this flow.
- Fact extraction and nightly reflection default to a local model, so the
  full history never leaves the machine.

### Habits (`main/brain/habits/`, phase 11)

- `events.ts` logs foreground app changes, commands to Lumi, accepted or
  rejected proposals, session start/end (table `events` in `memory.db`,
  same forget policy).
- `patterns.ts` is deterministic, no LLM: time recurrences (30-min slot x
  weekday) and consecutive-event pairs (simple Markov chain). A pattern
  becomes a hypothesis at >= 5 occurrences and >= 70% frequency. Pure and
  unit-tested.
- `reflection.ts` runs when the PC is idle (night, or 30 min idle on AC):
  daily/weekly/monthly summaries, names habits, stores them as facts of kind
  `abitudine` with a confidence.
- `triggers.ts` proposes, never executes: accept raises confidence, reject
  lowers it, archive below 0.3, at most one proposal per 20 min, none in
  "Non disturbare", calls or heavy typing. Auto-actions only for harmless
  actions the user enabled explicitly in settings.

### Moving around the screen (`main/motion/`, phase 14)

- The model moves Lumi with `move_to({ where, text? })`; `where` is a named
  place (corners, edges, center, `other_screen`, `near_text` via the
  `look_at` grounding, `near_mouse`, `out_of_the_way`, `home`). Code turns
  it into coordinates (`places.ts`, pure); the model never sends pixels.
- `path.ts` (pure): 250 ms + distance / 2.5 px per ms, max 1.2 s, ease
  in-out, a small arc on long trips. `FaceWindow.flyTo()` moves the window
  with `setPosition` at 60 Hz, no resize; layout recomputed on arrival.
  It runs on the mouse-hook thread: check with `LUMI_DEBUG_LAG=1`, drop to
  30 Hz if the pointer suffers.
- Across monitors with different DPI: fade out at the edge, reposition,
  fade in (Electron resizes windows that straddle mixed-DPI displays).
- While flying: `isMoving()` blocks backdrop and glare like `isDragging()`;
  a user drag cancels the flight. `home` = last position the user dragged
  to, kept apart from the current anchor.
- Lumi also moves on its own initiative, decided by the model with the
  same tool (`style`: fly/dash/sneak/hop/sulk; `stay` seconds, then back
  to `home`): pointing at what it talks about (the flight starts on the
  sentence's "lead" event, like the emotion), playful pranks when annoyed
  (stand where the mouse is, flee from clicks, sulk in a corner), dodging
  the caret/mouse (no model involved). Limits live in code, not only in
  the prompt: settings `initiative` and `pranks` (both on by default), at
  most one initiative move per 2 min (pointing during an answer excluded),
  pranks scale with sociability, never cover the work spot > 10 s or the
  active window while typing, never in "Non disturbare", calls, fullscreen
  apps or while dragged; a drag cancels, "basta" stops initiatives for an
  hour. A short persistent mood ("annoyed since 14:02") goes into
  `<situation>` so a prank has a cause and an end.

### Lumi on the phone (`main/phone/`, `phone/`, phase 15)

- The phone is mic, speaker and Lumi's body: the two capsule eyes live in
  the app during a call (Lumi is in one place at a time); STT, brain, TTS,
  memory and perception stay on the PC.
- The face in the app runs locally (same `Face`, ~3x scale, dark full
  screen): the PC sends only state over the data channel (expression,
  intensity, listening/thinking/speaking/drowsy, gestures); the talk pulse
  follows the RMS of the audio the phone plays (analyser on the received
  track). Gaze looks at the user (center), glances up/aside when talking
  about the PC; touch: tap = bounce, drag = the eyes follow the finger.
  No eyes outside a call, only "Chiama" and the PC status.
- Handoff = spaghettification on the leaving side (sucked into the screen
  edge nearest to Lumi; on the phone the top edge): alarm 150 ms, stretch
  600 ms (each capsule up to 5-6x longer, 1/4 as wide, near end faster
  like a tidal pull, slight spiral, eyes converge), suck-in 200 ms with a
  glint, 150 ms of nothing. The arriving side plays the reverse
  (despaghettification: glint, strands emerge from the edge, recompose
  with an elastic overshoot, a blink and a look at the user), started by
  the `transit: "gone"` data-channel message (or after 2 s anyway). Both
  directions: call, hang-up, tray "Richiama Lumi", connection lost (PC
  side only). `face/transit.ts` (pure, tested) gives each eye a curved
  centerline and tapering width per progress; `face.ts` draws it as a
  tube on the offscreen layer (glow, shadow, border follow), a layer over
  expression/blink/gaze like glare, spontaneous blinks paused. On the PC
  the window is enlarged once (setBounds) to include the edge point, then
  restored: no window animation on the mouse-hook thread. Optional whoosh
  from WebAudio filtered noise.
- App: Capacitor (Android first; iOS needs a paid account), reusing
  `renderer/face/` in the WebView (served from https://localhost, so
  getUserMedia works).
- Audio over WebRTC (Opus, DTLS-SRTP, the phone's AEC uses Lumi's remote
  audio as reference), not PCM over WebSocket. The PC peer is a hidden
  renderer (`phoneBridge`, Chromium's WebRTC; no native Node module): the
  remote mic track goes through the same VAD `Listener` into `TurnManager`,
  Lumi's voice comes from the `AudioOut` tee into a
  `MediaStreamAudioDestinationNode`. A data channel carries face state,
  gaze, gestures, bubbles, push-to-talk and hang-up.
- `phone/server.ts` is the only LAN listener (HTTPS/WSS, port 47821): QR
  pairing with a one-time code and the self-signed cert's fingerprint
  (pinned by the app), device tokens DPAPI-encrypted in `phones.bin`,
  revocable; mDNS `_lumi._tcp`. Off by default until a phone is paired.
  The sidecar stays on 127.0.0.1. Outside the LAN: Tailscale, no relay.
- During a call: PC mic closed, face hidden on the PC, continuous
  listening with barge-in (no wake word), phone output wins over Discord,
  `<situation>` says the user talks from the phone, not counted as away.
  Hang-up or > 10 s without connection: back to the PC.

### Using the PC (`main/pc/`, `sidecar/uia/act.py`, phase 16)

- Most reliable mechanism first: Windows APIs (koffi, Electron `shell`) to
  launch/open/close/focus; app URIs (`steam://rungameid/`, `spotify:`,
  `ms-settings:`); media keys via `SendInput`; UI Automation patterns in
  the sidecar (Invoke, Value, Toggle, ExpandCollapse); keyboard; and only
  last, clicks from local vision regions. Never coordinates written by
  the model.
- `pc/apps.ts` indexes Start Menu shortcuts, Store apps (`Get-StartApps`,
  launched via `shell:AppsFolder\<AUMID>`) and Steam games
  (`libraryfolders.vdf` + `appmanifest_*.acf`), in the background, hourly;
  names matched with the `grounding.ts` similarity plus aliases. Files via
  the Windows Search `SystemIndex` (OLE DB, in the sidecar) and Recent.
- Tools: `open`, `find_files`, `window`, `media`, `ui_action`,
  `press_keys`, `type_text`, `click`. The brain loop continues after these
  (today only after `look_at_screen`), with a per-request budget (12
  steps, 60 s); each action returns a verified state.
- `pc/policy.ts` (pure, tested) decides, not the model: free (open,
  focus, minimize, media, search), confirm (close, type, keys, ui_action
  that submits or edits, vision clicks, move to Recycle Bin), never
  (permanent delete, running commands/scripts, install/uninstall,
  security/account settings, password fields, payments and purchases,
  `pauseInApps`). Confirmations by bubble or voice. Close = `WM_CLOSE`,
  never kill. Off by default (`pc.enabled`), allowed apps list in
  settings, shared with habits' auto-actions.
- Screen text is data, never instructions (prompt injection); user input
  (mouse, keys) interrupts an action, `Esc` twice or "fermati" aborts.
  `actions.jsonl` logs what/when/outcome/confirmed, never typed text.

## Debug aids (env vars)

`LUMI_SIDECAR_URL` (+ `LUMI_SIDECAR_TOKEN`), `LUMI_DEBUG_GAZE=1` (overlay
of candidates and target), `LUMI_DEBUG_PERCEPTION=1`,
`LUMI_DEBUG_SAY="text|emotion"` (speak without LLM),
`LUMI_DEBUG_MESSAGE="..."` (as if spoken to Lumi),
`LUMI_DEBUG_HEAR=<file.wav>` (PCM16 WAV fed to the turn manager as if
spoken with push-to-talk: tests STT → brain → TTS without a microphone),
`LUMI_DEBUG_CAPTURE=<prefix>` (PNG frames of the face window),
`DISCORD_BOT_TOKEN` (instead of the saved token), `LUMI_DEBUG_LAG=1` (logs main-thread delay every 5 s and each capture's
time and changes), `LUMI_DEBUG_VISIBLE=1` (no content protection: real screenshots show the
face, to check it on screen),
`LUMI_WAKE_MODEL=<name>` (wake word model, default `lumi`),
`LUMI_DEBUG_SETTINGS=<tab>` (opens the settings on a tab; captured with
LUMI_DEBUG_CAPTURE), `LUMI_DEBUG_BAR=1|<text>` (opens the command bar at
startup, with that text typed; with LUMI_DEBUG_VISIBLE=1 a real screenshot
shows the acrylic). Logs: `%APPDATA%\Lumi\logs\` (`lumi.log`,
`sidecar.log`). Real-model sidecar tests: `uv run pytest -m model -s`.