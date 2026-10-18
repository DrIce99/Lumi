# Lumi - notes for development sessions

Desktop voice assistant: an always-on-top transparent face (two vertical
capsule eyes, no mouth; or a 3D VRM avatar with `face.mode` "3d") that listens, talks with an expressive voice and
watches the screen. Electron + TypeScript app (`app/`) plus a Python sidecar
(`sidecar/`) for STT, TTS, OCR and UI Automation. Modeled on Pixel Pet
(github.com/DrIce99/pet): reuse its patterns and code where they fit.
The user writes in Italian; UI strings and README are Italian, code and
comments English. Target platform: Windows 10/11.

See README.md for the feature spec, face parameters, roadmap and protocol.
Work one roadmap phase at a time; finish each with checks green.

## Commands

- `app/`: `npm run check` (typecheck + `node:test` bundled by esbuild),
  `npm start` / `npm run debug` (DevTools), `npm run dist` (NSIS
  installer in `release/`; `dist:dir` = unpacked only; build `phone/www`
  first).
- Always launch through `run.mjs`: shells spawned by VS Code export
  `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` behave as plain Node.
- `phone/` (Capacitor app): `npm run typecheck`, `npm run build` (www/),
  `npm run apk` (needs JAVA_HOME = Android Studio's `jbr`, Android SDK).
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
  own captures and screen sharing skip the face; with `face.showInCaptures`
  it is off, so OBS and Remote Desktop see Lumi, and our captures send the
  face/command bar rects as `exclude` to the sidecar, which paints them
  flat gray; the backdrop is then read beside the window), click-through with
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
  running sidecar per engine:model:voice and scores it with `--asr`
  (letters compared without accents and spaces: "chi sa"/"chissà" is the
  recognizer's spelling) and `--accent` (Whisper's language-id
  probability for Italian: a foreign accent lowers it with every word
  right).
- Default voice (roadmap 17.3, measured): Qwen3 1.7B Base with an empty
  voice field = `sidecar/tts/voices/italiana.flac` (15 s of a LibriVox
  reader, public domain; "italiano" is the male one, the audiobooks'
  dialogue voice; Chatterbox takes the names too). Base clones scored
  0.998-0.999 Italian, CustomVoice 0.89-0.92 (foreign accent),
  VoiceDesign 0.95 and its voice drifted between sentences (voiceprint
  similarity 0.35 vs 0.52-0.62). The price: Base gets no emotion
  instruction.
- Written accents (17.4): `scripts/accenti.py` reads `text/accenti_it.txt`
  pairs, aligns letters with torchaudio's MMS_FA and measures syllable
  prominence and F1 (`scripts/prosody.py`, pure). Qwen3-TTS ignores
  "àncora"/"pèsca" (chance level, every model); Kokoro (espeak-ng)
  follows them (stress 11/20, open/closed 13/16, +275 Hz), so the prompt
  asks for accents on homographs only when `tts.engine` is kokoro
  (`writtenAccents` in prompt.ts).
- LoRA (17.5, `sidecar/lora/`, extra `lora` = peft): `prepare.py` (LibriVox
  -> Whisper words -> clips cut at pauses found in the audio, by each
  word's END: Whisper's word times leave no gaps and stretch a word's start
  back into the pause; cutting at segment ends left the next word's onset
  in 25% of clips and the model learned to add words) -> codec codes;
  `train.py` = Qwen's sft recipe fixed (text through `text_projection`,
  labels shifted once: Transformers' causal loss shifts again, code
  predictor fed the hidden state one position earlier with unshifted
  labels, language tag "italian" in the prefix like generation; checked
  by the untrained model's loss: 11.8 -> 1.36), LoRA r16 on q/k/v/o/MLP,
  merged into a one-speaker custom_voice checkpoint with `lumi_finetune`
  {speaker, language} in config.json. Settings model "1.7B-Italiano" ->
  `models/lora/italiano/model` (kind "trained": its speaker, its language,
  no instruction). Result (6.8 h, Lisa Caputo): close to Base but not
  better (words 0.990 vs 0.994, Italian 0.982 vs 0.998), so Base stays
  the default.
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
  `normalize_it`, emotion mapping, `backdrop`, `glare`, `prosody`,
  `lora/data`; later
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

- Memory: `memory.json` keeps notes, reminders, the recent window,
  episodes, diary and a copy of the facts; every line, episode, diary day
  and fact also goes to `memory.db` (phase 10, steps 1-5 done). Lines that leave the 16-line window
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
  README) and to be within 0.06 of the best. Query embedding: 400 ms for
  `<recalled>` (Ollama: 15-80 ms, rare spikes > 1 s), 1.5 s for the tool, else words only; `store.warm()` (on
  listening, chat, bar) loads the model ahead, at most once a minute.
  bge-m3 warm: ~15-100 ms per query, whole search ~20-30 ms.
- CPU embeddings (step 10.6): `memory.embeddings.provider` auto (default:
  Ollama if `ensureOllama` succeeds, else sidecar) | ollama | sidecar |
  none, resolved in main's `configureMemory` (re-run on sidecar "ready":
  its port and token change). The sidecar's `POST /embed` runs
  `embed/onnx_embed.py`: bge-m3 int8 ONNX (Xenova/bge-m3, 570 MB, CLS
  pooling) with onnxruntime + tokenizers, half the cores, unloaded after
  10 min idle, never logs texts. Chosen by measure on a synthetic Italian
  set: top-1 1.00 (Ollama's bge-m3 0.95, e5-small/base 0.80/0.85,
  MiniLM 0.80), 15 ms/line, cosine >= 0.985 with Ollama's vectors, so
  the bge-m3 floor applies; stored as model "bge-m3-int8" (its own vec0
  table: switching source re-embeds in the background).
- Facts (step 10.3): schema v3 `facts` (id = the app's own number:
  "f12"/"n13" keep their ids, the counter is memory.json's `nextId`;
  importance 1-10, source_ids from the conversation span, expires for
  notes, superseded_by) + `facts_fts`; durable active facts get vectors
  (owner_kind `fact`, ts = created) and take part in hybrid search, with
  importance/10 in the score. `Memory` keeps the active facts in memory
  (sync reads; memory.json holds the copy), writes go to the worker;
  `loadFacts()` imports memory.json's facts once (`meta.facts_import`,
  default importance per kind: user 7, work 6, event 6, preference 5,
  lumi 4, note 3), then the database's list wins. Corrections:
  `remember({ ..., importance, replaces })` and the episode writer's
  `replaces` (it gets the important and similar facts with their ids,
  `Memory.factsFor`) supersede the old fact. The prompt's `<memory>` is
  `selectFacts` (pure): notes, importance >= 8, facts related to the
  message (the same recall search: fact hits go to `<memory>`, the rest
  to `<recalled>`), the last 3 days, within 3000 chars, plus a line with
  how many are left out. bge-m3 can't link "che lavoro faccio?" to a fact
  about RPG (0.37): words or the model's own search_memory must do it.
- Weeks, months, backups (step 10.4): schema v4 (summaries_au trigger,
  periods `week`/`month`). `periods.ts` (pure): local Monday weeks,
  calendar months, `duePeriods` (over, with day summaries, not written,
  oldest first, max 4 per run); `Brain.writePeriods` runs after
  `writeDiary` with the idle model (a month's days clipped to 350 chars).
  `backup.ts`: `VACUUM INTO` a temp file then rename,
  `%APPDATA%\Lumi\backups\memory-YYYY-MM-DD.db`, keep
  `memory.backupDays` (7; 0 = none), at startup and every 3 h.
- Forget cascade (step 10.5): only the user deletes conversation. The
  model's `forget({ query })` opens Settings -> Memoria with the search
  done (`SettingsWindow.openForget`); `forget({ id })` still deletes one
  fact. `db.findForForget`: any word (FTS) + vectors down to floor - 0.05,
  superseded facts included; `strong` (half the words, or floor + 0.05)
  = pre-checked, the rest unchecked. `db.forget`: lines (+ vectors of the
  next line in the session, embedded with it as context), chosen
  summaries, chosen facts and facts whose source_ids were all deleted;
  returns stale summaries (episode/day covering a deleted line, then
  week/month over them), which `Memory.forgetItems` rewrites from what is
  left with `Brain.rewriteSummary` or deletes (no material or no model),
  updating memory.json too. Then `compact()`: FTS 'optimize', every vec0
  table copied to a new one (sqlite-vec deletes only flip a validity bit,
  the bytes stay), VACUUM, WAL checkpoint; a test greps the file bytes.
  Then the old archive and all backups go (a fresh one is made).
- Short-term memory and kept promises (found with gemini-flash-lite: it
  said "te lo segno" / "eccolo" without calling remember or looking, and
  mangled a 9-digit UID because the prompt said never to read long
  numbers). Now: `brain/intents.ts` (pure) reads "ricordati/segnati/..."
  and screen words from the message; a screen mention makes the brain
  OCR the look area itself (`host.readScreen`, local OCR of the active
  window or its display, only while perception watches) into
  `<screen_now>`; a remember or move request ("spostati", "altro
  schermo", "stai ferma"...) whose tool wasn't called gets one more round
  with an explicit instruction (`PROMISES` in intents.ts). A refused
  move_to is a follow-up result, so the model learns it didn't move.
  Each round logs the tool names called ("Tools called: ...") and the
  mover logs refusals: "said it but didn't do it" shows in lumi.log. Tool results (look_at_screen,
  web_search, read_page, search_memory, screen_now) stay 30 min in RAM as
  `<recent_findings>` (max 5, 1200 chars, never on disk). Recent window
  24 lines (was 16). The prompt asks numbers/codes exactly as digits and
  forbids claiming an action without its tool call. The sidecar reads
  numbers of 7+ digits, and 3+ after UID/PIN/codice/..., digit by digit.
- `<recalled>` comes from `Memory.recall` (650 ms timeout, recent window
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

- Web: `main/web.ts`, tools `web_search` / `read_page` (follow-up tools,
  like `look_at_screen` and `search_memory`: the brain loop goes on after
  them even when a `say` came in the same reply). `web.provider` auto =
  Ollama's web search/fetch with the Ollama Cloud key (not tried live:
  no key here), else DuckDuckGo's HTML page (`html.duckduckgo.com/html/`,
  real link in `uddg=`, ads via `y.js` skipped); SearXNG `format=json`.
  `read_page` only reads public pages: `readableUrl` + DNS check of every
  hop (`redirect: "manual"`), 2 MB max, page charset honored, text of
  `<main>`/`<article>` else `<body>`, 6000 chars. Results and pages are
  labeled as data, not instructions. Search words go to `log.perception`.
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
- Characterful expressions (saccente, sospetto, paura, spavento, smorfia,
  apatia): `ExpressionDef` gained `glyph` (capsule | ring | chevron; a
  glyph change crossfades 160 ms while the shape tweens), `pupil` (ring),
  `accessories` (glasses, squintLines, shockLines: on the same offscreen
  layer so they get border and glow; the glasses are anchored to the
  face's resting centers, not the gaze, while doubt and shock lines move
  with the eyes; the doubt lines touch the slit (stroke center inset into
  its edge), so slit + lids read as one piece per eye; alpha-tweened in/out), `motion` (tremble, pulse,
  reading: `motionAt`, strength follows intensity), `noBlink`
  (`Blinker.pause` 1 h, `resume` after), `still` (gaze: no wander, no
  micro-saccades; `nextEventAt` = Infinity, so `face.ts` caps its sleep
  at 60 s: setTimeout(Infinity) fires at once), `randomSide` (gaze bias
  side picked at onset), `fixedShape` (intensity doesn't shrink glyphs and
  lines). New gestures: `freeze` (gaze held and blinks paused 500 ms, then
  a jolt) and `glassesPush` (finger timeline in `glassesPush`, glasses
  stay 2 px higher). Geometry is pure in `face/glyphs.ts`. Checked by eye
  with `LUMI_DEBUG_FACE` + `LUMI_DEBUG_CAPTURE` (+ `LUMI_DATA_DIR` and an
  unreachable `LUMI_SIDECAR_URL` to keep the real data and models out).
- Habits (phase 11, `main/brain/habits/`): schema v5 `events(ts, kind,
  app, detail)` + `habits` in memory.db. `Habits.pollForeground` (2 s)
  logs an app once it stays 4 s in the foreground: process name + exe
  path (`ForegroundWindow.path`), never titles, never while perception is
  paused (pause apps, private windows, away). Commands log only the
  channel. `patterns.ts` (pure): time patterns per app x half-hour slot
  (neighbor slots count, the exact slot wins), the broadest day group
  that holds on each of its weekdays (>= 75% of the threshold), and
  sequences A->B within 10 min; >= 5 and >= 70%. Reflection when the PC
  rests (1-6 am + 10 min idle, or 30 min idle on AC), max every 20 h:
  last 8 weeks, new habits named by the idle model (JSON array) else
  `defaultName`, faded ones lose 0.1, archived < 0.3; events > 12 weeks
  pruned. `triggers.ts` (pure): time habits within one slot of theirs,
  sequences within 60 s of A; once a day per habit, cooldown 20 min,
  blocked by DND/call/typing/conversation/away. Proposal = voice +
  bubble Sì/No; a spoken "sì"/"no" (readAnswer) right after it is caught
  in `heard()` and never reaches the brain. Accept opens `detail.path`
  (shell.openPath, .exe only), +0.1; reject -0.15. `auto` habits (user
  choice in settings) open without asking. `LUMI_DEBUG_REFLECT=1`.
- Phone (phase 15): `shared/phone.ts` is the protocol, WebCrypto only
  (runs in Node and in the phone's WebView). The QR is
  `lumi://pair?h=hosts&p=port&i=pairing id&k=256-bit key&n=PC name`,
  one-time, 5 min. Login = HMAC challenge-response (`proofText` with
  both nonces), the PC proves the key back (`lumi-server|sn|cn`); after
  it every signaling message is a `SignedChannel` message (session key
  from key + nonces, sender + sequence in the MAC). Signed offer/answer
  carry the DTLS fingerprints, so the WebSocket stays plain (`ws`, no
  self-signed cert to pin); the server (`main/phone/server.ts`) is the
  only LAN listener, on only with `phone.enabled`, and also serves
  `phone/www` at `/app/`. Keys: `phones.bin` (DPAPI, `devices.ts`);
  the phone keeps its key in localStorage. `link.ts` (states idle /
  connecting / leaving / active / returning) runs the call through a
  hidden renderer (`renderer/phone/bridge.ts`: RTCPeerConnection with no
  ICE servers, non-trickle; VAD `Listener` on the remote track; a
  `Player` into a MediaStreamDestination fed by the `AudioOut` tee).
  `WebRtcHideLocalIpsWithMdns` is disabled in main: the bridge never
  opens a mic, so Chromium would offer mDNS names. Data channel `lumi`:
  state (+ face color), gestures, subtitles (`FaceWindow.onSubtitle`),
  `transit: gone`, ptt, mute, hangup. During a call: continuous
  listening, PC face hidden, mic control routed to the bridge, not away.
  Transit (`face/transit.ts`, pure): out 1100 ms (alarm, stretch, suck,
  empty), in 1200 ms; tubes drawn on the eye layer; the PC's point is
  the face window's edge toward the nearest screen edge
  (`layout.transitPoint`: the window never resizes). Hang-up from the
  phone: phone plays "out", sends hangup, PC plays "in". From the PC:
  hangup -> phone plays "out" and answers "gone" (2.5 s timeout). Lost
  > 10 s ends the call. App (`phone/`): Capacitor 8 Android,
  `androidScheme: "http"` (localhost is a secure context and can open
  ws:// to the LAN), cleartext + mic/camera permissions in the manifest;
  `build.mjs` bundles `app/src/renderer/face` and `shared/phone.ts`
  with esbuild. Not built: mDNS discovery, keystore, foreground service,
  the whoosh. `LUMI_DEBUG_PAIR=<file>` writes a pairing link (an Electron
  page with `--use-fake-device-for-media-stream` on
  `http://127.0.0.1:<port>/app/?pair=<link>` makes a test phone).
- Is it for Lumi? (`voice/addressing.ts`, pure): `TurnManager` tags every
  turn with how it opened (`Opened`: ptt | name | barge | open | followup,
  third argument of `host.utterance`) and `main.ts` `forLumi()` decides
  before `heard()`: ptt/name/barge always; else `classifyAddressing`
  (name anywhere via a strict regex, NOT `matchWakeWord`: "lui"/"luci" are
  one edit from "lumi"; fillers; "ragazzi/mamma/<named voice>," vocatives;
  an answer to Lumi's question <25 s; assistant-like requests; in a call
  with friends nothing unless named) -> yes/no/maybe. Context signals
  (all computed in `forLumi`): `threadAgo` (seconds since Lumi answered a
  user line: an exchange; 90 s open, a continuation opener like "e
  domani?" is then a yes, up to 300 s the model reads it), `othersHeard`
  (a non-owner voice at the mic < 30 s, `lastOtherVoiceAt`; null without
  `voices.enabled`: two voices answering each other = not for Lumi),
  `otherVoice` (this sentence is not the user's: only the name or a
  question of hers counts; else it is stored as context). "maybe" asks
  `Brain.isAddressed` (tiny prompt: 6 lines with their age, who else was
  heard, idle model, 1.5 s, no tools); no answer = `addressedWithoutModel`
  (follow-up window or open exchange, never with other voices, a call or
  another voice). A literal backspace once replaced `` in a regex written
  through a Python heredoc: grep for  after such edits. Not-for-
  Lumi sentences are neither stored nor sent anywhere; logs say verdict
  and reason, never the text. Setting `listen.addressCheck` (on). The
  prompt also lets the model `stay_quiet` on a message that is obviously
  for someone else.
- Speakers: `identify(print, via, { seconds })`: a new voice needs >= 2 s
  of speech, a known voice learns from >= 1.5 s, uncertain voices >= 0.50
  come back as `likely` (labels only), averages >= 0.72 merge
  (`mergeInto`: the list is a copy, check `includes`, or a folded voice is
  added twice), voices heard once and not for a day are tidied at load.
  The sidecar always sends a voiceprint for app audio, but main only uses
  it with `voices.enabled`: with it off every friend is "Qualcuno su
  Discord" (this was the user's setting). App audio status from the
  sidecar: "chiusa" (process not running), "in ascolto", "in ascolto,
  silenzio" (no sound for 20 s). "Discord" also matches DiscordPTB,
  DiscordCanary, Vesktop... (`appaudio.VARIANTS`); a browser has to be
  named to hear Discord on the web. Checked live with a copy of
  powershell.exe renamed Discord.exe playing a WAV: chiusa -> in ascolto,
  3 utterances.
- Moving (phase 14, `main/motion/`): the model calls `move_to({ where,
  text?, style?, stay? })`; `where` is a named place (`places.ts`, pure:
  nine grid spots 24 px inside the work area, other_screen at the same
  relative spot, near_text via `locateOnScreen` in main (recent OCR +
  vision regions through `Perception.locateText`, else the active window
  is OCR'd now: change-driven OCR never reads a static screen), near_mouse, out_of_the_way (nearest
  grid spot not on caret / typing window / mouse), home, stop). `path.ts`
  (pure): 250 ms + dist/2.5, max 1.2 s, times the style factor; arc for
  fly, hops for hop. `FaceWindow.flyTo` moves the window at 60 Hz through
  `applyBounds` like a drag (measured: max 18 ms loop delay, no stalls),
  fades (setOpacity) across displays with different scaleFactor, a drag
  stops it; `face:travel` {vx, vy, landed} stretches the eyes along the
  motion and squashes them on landing (`land` gesture + blink).
  `rules.ts` (pure): asked moves always go (unless movement off or held);
  initiative needs settings, 1 per 2 min (near_text while answering
  free), no pranks (dash/hop/sulk) when off or "silenzioso", never in
  DND/call/fullscreen/hidden/after `stop` (1 h), never over the typing
  window, max 10 s over caret/mouse. `mover.ts`: stay -> back home,
  sulk mood (30 min) and position go into `<situation>` ("Your body:"),
  dodge = caret within 60 px for 2 s (not the mouse: the user clicks the
  eyes), every 20 s max. `home` = last user drag (`window.json.home`,
  defaults to the start position). The flight starts when the tool call
  completes, not on the sentence's lead. `Mover.move` is async (the
  locate may OCR). Refusals read "You did NOT move: ..." + "correct
  yourself" and are follow-up results: the model says "eccomi" in the
  same reply as the call, before the result, so the prompt asks for a
  neutral say there and no moving when it can't find the target.
  `LUMI_DEBUG_MOVE=a,b,c`.
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

- Distribution (phase 13): electron-builder (`build` in app/package.json),
  NSIS per user. The installer ships the sidecar's source + uv.lock and
  `uv.exe` (pinned 0.9.5 = the lock's uv, SHA-256 checked by
  `scripts/prepare-dist.mjs`, which also draws `build/icon.png` with
  `png.ts`), not Python: `setup/runtime.ts` runs `uv sync --frozen
  --no-dev --extra ...` (profile: leggero = wakeword, else gpu +
  wakeword) with UV_PROJECT_ENVIRONMENT = %LOCALAPPDATA%\Lumi\sidecar-env
  and UV_PYTHON_PREFERENCE=only-managed; `lumi-env.json` there records
  lock hash + extras (`envReady`; `envUsable` = an older env may run while
  a sync is due). uv 0.9 ends a download by repeating "Downloading name"
  without the size (parsed for the progress). `setup/setup.ts`
  (RuntimeSetup) stops the sidecar, syncs, restarts it and follows the
  models' download (engines "loading" + models folder size) to "ready";
  the settings' Generale tab shows it with an Install/Update button.
  Packaged paths: resources/sidecar, resources/uv/uv.exe,
  resources/phone/www (= getAppPath()/..); sqlite-vec's DLL is in
  asarUnpack and its path is rewritten to app.asar.unpacked; the
  uninstaller deletes sidecar-env unless it is an update (installer.nsh).
  Sidecar state "setup" = no environment yet (text mode). Not done: code
  signing, auto-update.

- Mood of the day (roadmap 18, `brain/dayMood.ts` pure + `DayMood` store
  in `mood.json`, ids/tree/weights in `shared/dayMood.ts`): drawn at the
  first use of a day (days start at 5:00) with `mood.weights` (0-10), the
  previous day's last mood x1.5. Eight moods in a tree rooted at
  tranquilla (allegra>entusiasta, malinconica>triste, irritata>arrabbiata,
  annoiata); `change_mood({ mood, reason })` moves one step (`stepToward`),
  toward calm a mood above 0.5 first softens by 0.3, the same mood asked
  again gets +0.25, one change per 90 s, refused outside message moments
  (`changeMood(..., byUser)`). `<situation>` gets "Your mood today" and
  the system prompt a "Your mood of the day" section (only when enabled).
  The face at rest stays neutral: a trace of the mood there (tried) kept
  a smile, and in 3D an open mouth, after every answer. Logs carry mood
  names, never the reason.

- Lumi in 3D (roadmap 19, `face.mode` minimal|3d, `face.model` = a .vrm
  path, "" = `app/assets/avatar/Lumi.vrm`, copied to dist by build.mjs):
  `renderer/faceView.ts` is the interface both faces implement; the face
  window's main.ts swaps them live on `layout.mode` (new canvas per
  avatar: a canvas whose WebGL context was lost can't give another one).
  The avatar bundle (`renderer/avatar/index.ts` -> `window.LumiAvatar`,
  three + @pixiv/three-vrm, ~2 MB) is loaded by a script tag only in 3D;
  no WebGL or a broken model -> back to the eyes. Face box per mode:
  `FACE_BOX` (3d 180x220, a half-length shot: `framing.ts` bustSpan =
  hips + 6 cm to the hair's top; below the box the body fades through a
  CSS mask on the canvas, since the bubble may sit there); `computeLayout`/`clampAnchor` take the mode;
  a mode change keeps the bottom center. Per frame (`avatar.ts`): idle
  pose (`pose.ts`, pure: Euler XYZ degrees on normalized bones, model
  faces +Z, left arm down = -Z, X+ = head down) -> gestures slerped over
  it with fade weights -> gaze (Blinker/GazeController reused; 40% on
  head+neck: 28%, 12% while reading/caret/text; the eyes get the full
  range: yaw/pitch = gaze x the range map's inputMaxValue, 90 on VRoid,
  which maps to only 8-12 degrees; on the eyes VRMLookAt's pitch + =
  down, checked on the model: the head bone's X + is down too) -> expression weights
  eased (`expressions3d.ts`; on VRoid models split into Fcl_BRW/EYE morphs
  + Fcl_MTH at rest only, x0.5, happy = Fun mouth, gone while talking:
  the Fcl_ALL presets open the mouth) + blink + visemes (`visemes()`:
  level opens, `Player.brightness()` = 3x energy share above 1.5 kHz picks
  e/i vs o/u vs a) -> `vrm.update()` (spring bones). Arm poses are given
  as directions (`arm()`/`arms()`: fromUnitVectors, forearm local =
  conj(upper) * world, `twist` = forearm roll for the palm: +90 on a
  raised right arm faces the viewer) because Euler twists sent forearms
  the wrong way. Fingers curl with Z (left -, right +); the thumb folds
  across the palm with -Y on the right (`thumb()`, checked on the model).
  The 3D window is wider/taller for the arms (`roomFor` in layout.ts).
  `say.gesture` (free id, `gestureId`) rides the first sentence of its say
  call, applied on lead with the emotion (`act()` in main: 3D -> face.act,
  eyes -> `EYE_GESTURE`); the prompt's "# Your body" exists only in 3D.
  User clips: `%APPDATA%\Luminimations\<gesture>.fbx|.vrma` (watched,
  `AvatarFiles`), served via `mountAppPath` (`/user/model.vrm`,
  `/user/animations/`, `resolveAppPath` refuses escapes); Mixamo FBX
  retargeted as in three-vrm's example; tracks sampled with their own
  interpolants, no AnimationMixer (its fades blend against the bind
  pose, not the procedural one). Hit test = alpha of the last frame
  (`preserveDrawingBuffer`). Checked by eye with `LUMI_DEBUG_ACT`.

## Planned features (phase 16 not built yet; phase 10 kept as its design notes)

Decisions already taken for the next phases. Nothing here exists in the
code yet; when a piece lands, move its notes to the sections above.

### Memory (`main/brain/memory/`, phase 10)

Phase 10 is built (raw log, FTS, search_memory, import; embeddings and
hybrid search; facts; weeks, months and backups; forget cascade; CPU
embeddings in the sidecar): see the notes above. The bullets below are
the design it follows.

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
- Never delete conversation memory outside the forget flow (user-picked,
  confirmed in the settings window); see the notes above.
- Fact extraction and nightly reflection default to a local model, so the
  full history never leaves the machine.

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
`LUMI_DEBUG_PAIR=<file>` (writes a phone pairing link), `LUMI_DEBUG_TRANSIT=1`
(leave and come back as for a call),
`LUMI_DEBUG_SETTINGS=<tab>` (opens the settings on a tab; captured with
LUMI_DEBUG_CAPTURE), `LUMI_DEBUG_FACE=<expr,...>` (cycles expressions on a
dark background, no greeting; with LUMI_DEBUG_CAPTURE saves each at 250,
650, 1500 ms), `LUMI_DEBUG_MOVE=<places>` (flies there one after the other),
`LUMI_DEBUG_ACT=<gestures>` (body gestures in turn from 5 s, every 3 s;
"rest", "gaze:dx:dy", "mode:minimal|3d"; with LUMI_DEBUG_CAPTURE saves
each at 300, 700, 1300 ms),
`LUMI_DEBUG_REFLECT=1` (habits reflection 20 s after start),
`LUMI_DATA_DIR=<dir>` (another userData: settings, memory,
logs), `LUMI_DEBUG_RUNTIME=<dir>` (the installed app's uv environment
flow from the sources, env in that folder; in the packaged app it only
moves the env), `LUMI_DEBUG_INSTALL=<profile>` (apply it and install the
voice engine at startup, no click), `LUMI_DEBUG_BAR=1|<text>` (opens the command bar at
startup, with that text typed; with LUMI_DEBUG_VISIBLE=1 a real screenshot
shows the acrylic). Logs: `%APPDATA%\Lumi\logs\` (`lumi.log`,
`sidecar.log`). Real-model sidecar tests: `uv run pytest -m model -s`.