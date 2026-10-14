// Entry point: wires the face, perception, brain, voice and UI together.
import { app, BrowserWindow, dialog, globalShortcut, nativeImage, powerMonitor, screen, shell, type Display } from "electron";
import { writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import type { Emotion } from "../shared/emotions";
import { toEmotion } from "../shared/emotions";
import { applyProfile } from "../shared/profiles";
import { PROVIDER_IDS, type ProviderId } from "../shared/providers";
import type { BarContext, GpuInfo, KeySource, Settings, SettingsSnapshot, TtsEngine } from "../shared/types";
import { Activity } from "./activity";
import { readAttachments, type Attachment } from "./attachments";
import { Audiobooks } from "./audiobook";
import { GazeOverlay } from "./debugOverlay";
import { Autonomy } from "./brain/autonomy";
import { Brain, type BrainHost, type SpeechSink } from "./brain/brain";
import { Memory } from "./brain/memory";
import type { Situation, Trigger } from "./brain/prompt";
import { CommandBar } from "./commandbar";
import { detectGpu } from "./gpu";
import { readJson, writeJson } from "./jsonStore";
import { initLog, log } from "./log";
import { Mood } from "./mood";
import { ensureOllama } from "./ollama";
import { Backdrop, meanLuminance, rectInFrame } from "./perception/backdrop";
import { ChangeDetector } from "./perception/capture";
import { appName } from "./perception/context";
import { listVisionModels } from "./perception/vision";
import type { Frame } from "./perception/diff";
import { GlareDetector, glareStats, thumbnail } from "./perception/glare";
import { foregroundWindow, systemCaret } from "./perception/desktop";
import { Perception, type OcrLine } from "./perception/perception";
import { UiaClient } from "./perception/uia";
import { APP_ORIGIN, registerAppScheme, serveAppScheme } from "./protocol";
import { ApiKeyStore } from "./secrets";
import { Services } from "./services";
import { SettingsStore } from "./settings";
import { SettingsWindow } from "./settingsWindow";
import { Sidecar } from "./sidecar";
import { lookArea, Screenshots } from "./screenshots";
import { BubbleSpeech, Bubbles } from "./speech";
import { TeeSpeech } from "./teeSpeech";
import { LumiTray } from "./tray";
import { Clips } from "./voice/clips";
import { GroqStt } from "./voice/groqStt";
import { Speakers, voiceLabel } from "./voice/speakers";
import { botScript, DiscordToken, DiscordVoice } from "./discordVoice";
import { AppAudioClient, type AppUtterance } from "./voice/appAudio";
import { meaningless } from "./voice/endpoint";
import { matchWakeWord } from "./voice/wakeWord";
import { WakeClient } from "./voice/wakeClient";
import { otherMicUsers, readMicUse, type MicUser } from "./voice/micUse";
import { PushToTalk } from "./voice/pushToTalk";
import { SttClient } from "./voice/sttClient";
import { isEcho, TurnManager, type SttBackend } from "./voice/turns";
import { Voice, type AudioOut } from "./voice/voice";
import { readWav, toFrames16k } from "./voice/wavInput";
import { Vision } from "./vision";
import { FaceWindow, type Point } from "./window";

const DEBUG = process.argv.includes("--debug");
/** Attached images are scaled down to this long side before a model looks at them. */
const IMAGE_MAX_SIDE = 1344;

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app
    .whenReady()
    .then(start)
    .catch((err) => {
      log.error("Startup failed", err);
      app.quit();
    });
}

interface WindowState {
  anchor?: Point;
}

/** Settings whose change needs a new sidecar configuration. */
function engineKey(s: Settings): string {
  return JSON.stringify([s.tts, s.stt.engine, s.stt.model, s.stt.device, s.perception.enabled, s.perception.ocr, s.perception.uia]);
}

function start(): void {
  const dataDir = app.getPath("userData");
  initLog(join(dataDir, "logs"));
  if (process.env.LUMI_DEBUG_LAG === "1") {
    // The click-through mouse hook runs on this thread: any block here stalls the system pointer
    const lag = monitorEventLoopDelay({ resolution: 5 });
    lag.enable();
    setInterval(() => {
      log.info(`Main thread delay: p50 ${(lag.percentile(50) / 1e6).toFixed(1)} ms, p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms, max ${(lag.max / 1e6).toFixed(1)} ms`);
      lag.reset();
    }, 5000);
  }
  log.info(`Lumi ${app.getVersion()} (Electron ${process.versions.electron}), data in ${dataDir}`);
  serveAppScheme(join(__dirname, ".."));

  const settingsStore = new SettingsStore(dataDir);
  const settings = () => settingsStore.get();
  const apiKeys = new ApiKeyStore(dataDir);
  const services = new Services(settings, apiKeys);
  const memory = new Memory(join(dataDir, "memory.json"));
  const speakers = new Speakers(join(dataDir, "voices.json"));

  /** Who said an utterance at the microphone: the user, or another voice (by name or "Voce N"). */
  function micSpeaker(print: number[] | undefined): { other: string | null } {
    if (!print || !settings().voices.enabled) return { other: null };
    const found = speakers.identify(print, "mic");
    log.info(`Voice at the microphone: ${found.status}${found.voice ? ` ${found.voice.id}` : ""} (${found.similarity.toFixed(2)})`);
    // Uncertain is given the benefit of the doubt: it is most likely the user
    if (!found.voice || found.voice.owner || found.status === "uncertain") return { other: null };
    return { other: voiceLabel(found.voice) };
  }

  /** The voices Lumi knows besides the user's, for the prompt. */
  function voicesSummary(): string {
    if (!settings().voices.enabled) return "";
    return speakers
      .voices()
      .filter((v) => !v.owner)
      .sort((a, b) => b.lastHeard.localeCompare(a.lastHeard))
      .slice(0, 12)
      .map((v) => `${voiceLabel(v)}${v.name ? "" : " (name unknown)"}: heard ${v.via.map((x) => (x === "mic" ? "at the microphone" : `on ${x}`)).join(" and ")}, last ${v.lastHeard.slice(0, 16).replace("T", " ")}`)
      .join("\n");
  }
  const stateFile = join(dataDir, "window.json");
  const windowState = readJson<WindowState>(stateFile) ?? {};
  const activity = new Activity(() => powerMonitor.getSystemIdleTime());
  let gpu: GpuInfo | null = null;
  void detectGpu().then((found) => {
    gpu = found;
    log.info(found ? `GPU: ${found.name}, ${found.vramTotalMb} MB` : "No NVIDIA GPU found");
  });

  // ---- the face ----
  let visible = true;
  let rendererStarted = false;
  const face = new FaceWindow(
    {
      ready: () => {
        mood.resend();
        onRendererReady();
      },
      click: () => talk(),
      contextMenu: () => tray.popup(face.win),
      send: (text) => void brain.handle({ kind: "message", text, via: "text" }),
      inputClosed: () => undefined,
      bubbleClicked: () => face.openInput(),
      bubbleChoice: (id, choice) => bubbles.answered(id, choice),
      playback: (event) => voice.playback(event),
      mic: (event) => {
        if (event.type === "ready") log.info("Microphone and voice activity detection ready");
        turns.mic(event);
      },
      moved: (anchor) => {
        windowState.anchor = anchor;
        writeJson(stateFile, windowState);
      },
    },
    { url: `${APP_ORIGIN}/renderer/face.html`, anchor: windowState.anchor ?? null, scale: settings().face.scale, color: settings().face.color },
  );
  const mood = new Mood((state) => face.state(state));
  const bubbles = new Bubbles(
    face,
    () => activity.snapshot().idleSec,
    () => settings().doNotDisturb || !visible,
  );

  // ---- the sidecar: voice, hearing and screen reading ----
  const sidecar = new Sidecar({
    dir: join(app.getAppPath(), "..", "sidecar"),
    modelsDir: join(dataDir, "models"),
    logDir: join(dataDir, "logs"),
    externalUrl: process.env.LUMI_SIDECAR_URL,
    externalToken: process.env.LUMI_SIDECAR_TOKEN,
  });
  let lastSentenceAt = 0;
  // ---- Lumi's voice in Discord calls ----
  const discordToken = new DiscordToken(join(dataDir, "discord.bin"));
  const discordVoice = new DiscordVoice(botScript(app.getAppPath()), (status) => {
    // In the channel the user hears Lumi in Discord: the speakers stay quiet (the eyes keep talking)
    face.audioLocal(status.state !== "in-channel");
  });
  const updateDiscord = () => {
    const s = settings().discord;
    const token = discordToken.get();
    const missing = !s.enabled ? "" : !token ? "manca il token del bot" : !s.userId ? "manca il tuo ID o nome utente Discord" : "";
    discordVoice.configure(s.enabled && token && s.userId ? { token, userId: s.userId } : null, missing);
  };
  /** Lumi's audio: to the face window, and to the Discord call while the bot is in it. */
  const audioOut: AudioOut = {
    audioBegin: (msg) => {
      face.audioBegin(msg);
      discordVoice.begin(msg);
    },
    audioChunk: (msg) => {
      face.audioChunk(msg);
      discordVoice.chunk(msg.id, new Uint8Array(msg.pcm), msg.sampleRate);
    },
    audioEnd: (id) => {
      face.audioEnd(id);
      discordVoice.end(id);
    },
    audioStop: (fadeMs) => {
      face.audioStop(fadeMs);
      discordVoice.cut();
    },
  };

  const voice = new Voice(sidecar, audioOut, settings, {
    sentenceStart: (sentence) => {
      lastSentenceAt = Date.now();
      mood.setEmotion(sentence.emotion, sentence.intensity);
      // The eyes go to what Lumi is talking about
      if (sentence.look) perception.lookAtText(sentence.look);
    },
    speaking: (active) => {
      mood.set({ speaking: active, ...(active ? { thinking: false } : {}) });
      turns.speakingChanged(active);
    },
    fallback: (text) => bubbles.say(text),
  });

  // Backchannel, fillers and the wake-word "sì?", pre-generated in Lumi's voice
  const clips = new Clips(
    voice.tts,
    {
      begin: (msg) => audioOut.audioBegin(msg),
      chunk: (id, pcm, sampleRate) => audioOut.audioChunk({ id, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer, sampleRate }),
      end: (id) => audioOut.audioEnd(id),
    },
    settings,
    join(dataDir, "cache", "clips"),
    () => voice.allocateId(),
  );
  let clipsTimer: NodeJS.Timeout | null = null;
  /** Prepares the clips a little after the voice is ready, so the first answer isn't delayed. */
  const prepareClips = () => {
    if (clipsTimer) clearTimeout(clipsTimer);
    clipsTimer = setTimeout(() => {
      if (voice.ready()) void clips.prepare();
    }, 8000);
  };
  sidecar.on("status", () => {
    if (voice.ready() && !clips.ready("filler")) prepareClips();
  });

  /** A spoken request for Lumi: if the answer is slow to start, a filler covers the wait. */
  function heard(text: string, speaker?: string): void {
    const asked = Date.now();
    void brain.handle({ kind: "message", text, via: "voice", ...(speaker ? { speaker } : {}) });
    if (!settings().listen.fillers) return;
    setTimeout(() => {
      if (brain.answering() && lastSentenceAt < asked && voice.ready() && clips.play("filler")) mood.set({ thinking: true });
    }, 1200);
  }

  // ---- hearing: speech recognition, turn-taking, push-to-talk ----
  const sidecarStt = new SttClient(() => sidecar.socketUrl("/stt"));
  const sidecarBackend: SttBackend = {
    partials: true,
    start: (id, options, handlers) => sidecarStt.start(id, options, handlers),
    audio: (id, pcm) => sidecarStt.audio(id, pcm),
    end: (id) => sidecarStt.end(id),
    cancel: (id) => sidecarStt.cancel(id),
  };
  const groqStt = new GroqStt(
    () => apiKeys.get("groq"),
    () => settings().stt.model,
    services.fetch,
  );
  /** The speech recognizer usable right now, or null (Lumi can't hear). */
  function sttBackend(): SttBackend | null {
    if (settings().stt.engine === "groq") return apiKeys.get("groq") ? groqStt : null;
    if (!sidecar.endpoint()) return null;
    const engine = sidecar.status().engines.find((e) => e.kind === "stt");
    return engine && (engine.state === "ready" || engine.state === "loading" || engine.state === "idle") ? sidecarBackend : null;
  }
  /** A call Lumi listens to is going on (set once the app audio client exists). */
  let inCall = () => false;

  // ---- wake word: openWakeWord in the sidecar (else the name is spotted in transcripts) ----
  const wakeModel = process.env.LUMI_WAKE_MODEL || "lumi";
  const wakeClient = new WakeClient(() => sidecar.socketUrl("/wake"), { scores: (scores) => turns.wakeScores(scores) });
  /** Other apps recording now (a call): the wake word sleeps meanwhile. */
  let micBusy: MicUser[] = [];
  const wakeWanted = () => {
    const s = settings();
    return visible && !s.doNotDisturb && (s.listen.mode === "wake-word" || (s.listen.mode === "continuous" && inCall()));
  };
  function updateWake(): void {
    wakeClient.set(wakeWanted() && sidecar.endpoint() !== null, wakeModel);
  }
  setInterval(() => {
    updateWake();
    if (!wakeWanted()) {
      micBusy = [];
      return;
    }
    void readMicUse().then((users) => {
      const others = otherMicUsers(users, process.execPath, settings().appAudio.apps);
      const before = micBusy.map((u) => u.name).join(", ");
      micBusy = others;
      const now = others.map((u) => u.name).join(", ");
      if (now !== before) {
        log.info(now ? `Wake word paused: the microphone is in use by ${now}` : "Wake word listening again");
        turns.refresh();
      }
    });
  }, 5000).unref();

  const turns = new TurnManager({
    settings,
    stt: () => (visible && !settings().doNotDisturb ? sttBackend() : null),
    micControl: (control) => face.micControl(control),
    utterance: (text, print) => {
      if (process.env.LUMI_DEBUG_HEAR) log.info(`Heard: ${text}`);
      else log.perception(`Heard: ${text}`);
      const { other } = micSpeaker(print);
      if (other && settings().voices.onlyMe) {
        // Someone else in the room: context for Lumi, not a request
        memory.addMessage("other", text, false, { name: other });
        return;
      }
      heard(text, other ?? undefined);
    },
    interrupt: () => {
      voice.stopAll();
      brain.interrupt();
      mood.clearEmotion();
    },
    speaking: () => voice.busy(),
    setListening: (listening) => mood.set({ listening }),
    recentSpeech: () =>
      memory
        .recentConversation(4)
        .filter((e) => e.who === "lumi")
        .map((e) => e.text)
        .join(" "),
    turnComplete: async (pcm) => {
      // Smart Turn in the sidecar; a slow answer is no answer (the heuristic decides)
      if (!sidecar.endpoint() || settings().stt.engine === "groq") return null;
      try {
        const result = await sidecar.request<{ probability: number }>("/turn", { audio: Buffer.from(pcm).toString("base64") }, 400);
        return result.probability;
      } catch {
        return null;
      }
    },
    backchannel: () => {
      if (settings().listen.backchannel && voice.ready() && !voice.busy()) clips.play("backchannel");
    },
    inCall: () => inCall(),
    wake: () => (wakeClient.ready ? wakeClient : null),
    wakeAllowed: () => !activity.snapshot().locked && micBusy.length === 0,
    acknowledge: () => {
      if (voice.ready() && !voice.busy()) clips.play("wake");
    },
    log: (message) => log.info(message),
  });
  sidecar.on("ready", () => void sidecar.request("/turn/load", {}, 120_000).catch(() => undefined));
  const pushToTalk = new PushToTalk(
    () => turns.pttDown(),
    () => turns.pttUp(),
  );
  sidecar.on("status", () => turns.refresh());
  let voices: Partial<Record<TtsEngine, string[]>> = {};
  sidecar.on("status", (status) => {
    settingsWindow.status(status);
    tray.refresh();
  });
  sidecar.on("ready", () => {
    void sidecar
      .request<Partial<Record<TtsEngine, string[]>>>("/voices")
      .then((v) => (voices = v))
      .catch(() => undefined);
  });

  // ---- perception: what Lumi sees on the screen ----
  const lumiDisplay = () => screen.getDisplayNearestPoint(face.faceCenter());
  const perception = new Perception({
    settings,
    faceCenter: () => face.faceCenter(),
    cursor: () => screen.getCursorScreenPoint(),
    userPoint: () => {
      const b = lumiDisplay().bounds;
      return { x: b.x + b.width / 2, y: b.y + b.height };
    },
    context: () => ({ listening: mood.state().listening, speaking: mood.state().speaking }),
    active: () => visible && !face.isDragging(),
    sendGaze: (gaze) => face.gaze(gaze),
    globalPause: () => {
      const a = activity.snapshot();
      if (settings().doNotDisturb) return "do not disturb";
      if (a.locked) return "the screen is locked";
      if (a.away) return "the user is away";
      return null;
    },
    foreground: () => foregroundWindow(),
    systemCaret: () => {
      const caret = systemCaret();
      return caret ? screen.screenToDipRect(null, caret) : null;
    },
    toDip: (rect) => screen.screenToDipRect(null, rect),
    toPhysical: (rect) => screen.dipToScreenRect(null, rect),
    ocr: async (region) => {
      if (!sidecar.endpoint() || !voice.configured) return null;
      const result = await sidecar.request<{ lines: OcrLine[] }>("/ocr", { region, lang: "it" }, 15_000);
      return result.lines;
    },
    notificationArea: () => {
      const w = screen.getPrimaryDisplay().workArea;
      return { x: w.x + w.width - 420, y: w.y + w.height - 320, width: 420, height: 320 };
    },
    screenBounds: () => lumiDisplay().bounds,
  });
  // Shadow and border under the eyes follow the brightness behind the face;
  // without fresh frames (perception off or paused) they go back to the middle values
  const backdrop = new Backdrop();
  setInterval(() => face.contrast(backdrop.contrast(Date.now())), 1000).unref();
  const changes = new ChangeDetector({
    fps: () => settings().perception.captureFps,
    // The monitor with the active window, plus the one Lumi is on
    displays: () => {
      const ids = new Set<number>([lumiDisplay().id]);
      const fg = foregroundWindow();
      if (fg?.rect) ids.add(screen.getDisplayMatching(screen.screenToDipRect(null, fg.rect)).id);
      return screen.getAllDisplays().filter((d) => ids.has(d.id));
    },
    active: () => visible && perception.watching() && sidecar.endpoint() !== null,
    grab: async (displays) => {
      const regions = displays.map((d) => screen.dipToScreenRect(null, d.bounds));
      const { data, headers } = await sidecar.requestBinary("/screen/luma", { regions, size: 640 });
      let offset = 0;
      return (headers.get("x-sizes") ?? "").split(",").map((size) => {
        const [width, height] = size.split("x").map(Number);
        const luma = data.subarray(offset, offset + width * height);
        offset += width * height;
        return { width, height, luma };
      });
    },
    onChanges: (list) => perception.onChanges(list),
    onFrames: (displays, frames) => {
      sampleBackdrop(displays, frames);
      watchGlare(displays, frames);
    },
  });

  function sampleBackdrop(displays: Display[], frames: Frame[]): void {
    if (!settings().face.adaptiveShadow || !backdrop.wantsSample(Date.now()) || face.isDragging()) return;
    const i = displays.findIndex((d) => d.id === lumiDisplay().id);
    const frame = frames[i];
    const region = frame && rectInFrame(face.faceRect(), displays[i].bounds, frame);
    if (!region) return;
    backdrop.sample(meanLuminance(frame, region), Date.now());
    face.contrast(backdrop.contrast(Date.now()));
  }

  // A screen that suddenly turns bright dazzles Lumi: the monitor watched is
  // the one with the gaze target (else the active window's)
  const glare = new GlareDetector();
  function watchGlare(displays: Display[], frames: Frame[]): void {
    if (!settings().face.glare) return;
    const target = perception.currentTarget();
    const fg = foregroundWindow();
    const watched = target
      ? screen.getDisplayNearestPoint({ x: Math.round(target.point.x), y: Math.round(target.point.y) })
      : fg?.rect
        ? screen.getDisplayMatching(screen.screenToDipRect(null, fg.rect))
        : lumiDisplay();
    const i = displays.findIndex((d) => d.id === watched.id);
    if (i < 0 || !frames[i]) return;
    const asleep = mood.state().drowsy || effectiveFace() === "sonno";
    const event = glare.push(glareStats(thumbnail(frames[i])), Date.now(), watched.id, asleep || face.isDragging() || !visible);
    if (!event) return;
    const b = watched.bounds;
    const light = { x: b.x + event.centroid.x * b.width, y: b.y + event.centroid.y * b.height };
    log.info("Dazzled by a screen that turned bright");
    face.glare(light.x - face.faceCenter().x);
  }
  /** The expression the face shows (sleepy when drowsy and neutral). */
  function effectiveFace(): string {
    const s = mood.state();
    return s.drowsy && s.expression === "neutra" ? "sonno" : s.expression;
  }
  const uia = new UiaClient(
    () => sidecar.socketUrl("/uia"),
    (snapshot) => perception.onUia(snapshot),
  );
  // Development aid: draw the attention candidates and the gaze target on screen
  const gazeOverlay =
    process.env.LUMI_DEBUG_GAZE === "1"
      ? new GazeOverlay(`${APP_ORIGIN}/renderer/debug/gaze.html`, perception, () => lumiDisplay().bounds, () => ({ listening: mood.state().listening, speaking: mood.state().speaking }))
      : null;

  // A notification that just arrived may deserve a spontaneous comment
  let lastNoticed = 0;
  perception.onNewText = (text, where) => {
    if (where !== "notifica" || Date.now() - lastNoticed < 3 * 60_000 || !canReact()) return;
    lastNoticed = Date.now();
    void brain.handle({ kind: "noticed", what: `a notification just appeared: "${text.slice(0, 200)}"` });
  };
  const updateUia = () => uia.set(sidecar.endpoint() !== null && settings().perception.enabled && settings().perception.uia);

  // ---- other apps' audio (a Discord call) ----
  const appAudio = new AppAudioClient(() => sidecar.socketUrl("/apps"), {
    heard: (u) => heardInApp(u),
    status: (apps) => {
      log.info(`App audio: ${Object.entries(apps).map(([app, state]) => `${app} ${state}`).join(", ") || "off"}`);
    },
  });
  const updateAppAudio = () => {
    const s = settings();
    const on = s.appAudio.enabled && sidecar.endpoint() !== null && !s.doNotDisturb;
    appAudio.set(on ? s.appAudio.apps : null, s.stt.vocabulary);
  };
  // A call: friends heard in an app, or the bot sitting in the user's voice channel
  inCall = () => appAudio.active() || discordVoice.live();
  sidecar.on("ready", updateAppAudio);
  sidecar.on("down", () => appAudio.set(null));

  /** Someone spoke in a listened app: context for Lumi, or a request when they call it by name. */
  function heardInApp(u: AppUtterance): void {
    if (meaningless(u.text)) return;
    let name = `Qualcuno su ${u.app}`;
    if (u.voiceprint && settings().voices.enabled) {
      // The user's own voice doesn't come back from the call: never the owner
      const found = speakers.identify(u.voiceprint, u.app, { exclude: (v) => !!v.owner });
      if (found.voice && found.status !== "uncertain") name = voiceLabel(found.voice);
    }
    // Lumi's own voice coming back from the call the bot is in
    if (discordVoice.live() && isEcho(u.text, memory.recentConversation(6).filter((e) => e.who === "lumi").map((e) => e.text).join(" "))) return;
    log.perception(`Heard on ${u.app} (${name}): ${u.text}`);
    const wake = matchWakeWord(u.text, settings().listen.wakeWord);
    const named = wake.matched || /\blumi\b/i.test(u.text);
    if (named && wake.rest !== "") {
      void brain.handle({ kind: "message", text: u.text, via: "voice", speaker: `${name} (su ${u.app})` });
      return;
    }
    memory.addMessage("other", u.text, false, { name, via: u.app });
  }
  sidecar.on("ready", updateUia);
  sidecar.on("down", () => uia.set(false));
  sidecar.on("ready", updateWake);
  sidecar.on("down", updateWake);

  // ---- vision: real screenshots, only on demand ----
  let visionProblemAt = 0;
  const screenshots = new Screenshots(
    {
      settings,
      localVision: () => {
        const v = settings().vision;
        const b = settings().brain;
        if (v.provider === "none" || !v.model) return null;
        if (v.provider === "custom" && !b.customUrl) return null;
        return { provider: v.provider, url: v.provider === "ollama" ? b.ollamaUrl : b.customUrl, model: v.model, keepAlive: v.keepAlive, fetch: services.fetch };
      },
      remoteModel: () => {
        const chosen = services.chosen("vision");
        return chosen ? { ...chosen, separate: services.separateVision() } : null;
      },
      paused: () => perception.paused(),
      ask: async (question) => {
        if (!visible) setVisible(true);
        mood.setEmotion("imbarazzo", 0.4, 20_000);
        const choice = await bubbles.ask(question, [{ id: "yes", label: "Sì" }, { id: "no", label: "No" }], 20_000);
        return choice === "yes";
      },
      area: () => {
        const fg = foregroundWindow();
        const window = fg?.rect ? screen.screenToDipRect(null, fg.rect) : null;
        const display = window ? screen.getDisplayMatching(window) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const index = screen.getAllDisplays().findIndex((d) => d.id === display.id) + 1;
        const crop = window && fg ? lookArea(window, display.bounds) : null;
        return crop && fg ? { display, rect: crop, label: `the active window (${appName(fg.process)}) on screen ${index}` } : { display, rect: display.bounds, label: `screen ${index}` };
      },
      ocr: async (rect) => {
        if (!sidecar.endpoint() || !voice.configured) return [];
        const result = await sidecar.request<{ lines: OcrLine[] }>("/ocr", { region: screen.dipToScreenRect(null, rect), lang: "it" }, 8000);
        return result.lines.map((l) => l.text);
      },
      seen: (regions) => perception.seen(regions),
      visionProblem: (message) => {
        // A hint now and then, not at every look
        if (Date.now() - visionProblemAt < 10 * 60_000) return;
        visionProblemAt = Date.now();
        bubbles.say(message, { kind: "system" });
      },
      setLooking: (looking) => {
        // Loading the vision model can take a while: the eyes think meanwhile
        if (looking) mood.setEmotion("pensiero", 0.5, 30_000);
      },
    },
    new Vision(async (_display, maxSide, rect) => {
      const { data } = await sidecar.requestBinary("/screen/jpeg", { region: screen.dipToScreenRect(null, rect), size: maxSide }, 10_000);
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }),
  );

  // ---- the mind ----
  const host: BrainHost = {
    settings,
    memory,
    provider: (purpose) => services.chosen(purpose),
    situation: () => situation(),
    startSpeech: (trigger) => startSpeech(trigger),
    say: (text, emotion) => sayLine(text, emotion ?? "neutra", true),
    setThinking: (thinking) => mood.set({ thinking }),
    lookAt: (target) => {
      if (!perception.watching()) return "Screen perception is off or paused: you can't look at the screen now.";
      return target.text ? perception.lookAtText(target.text) : perception.lookAtRegion(target.region ?? "active_window");
    },
    lookAtScreen: (focus, requestedByUser) => screenshots.look(focus, requestedByUser),
    quiet: (minutes) => {
      if (minutes) autonomy.scheduleIn(minutes);
    },
    backOff: (minutes) => autonomy.backOff(minutes),
    nameVoice: (which, name) => {
      if (!settings().voices.enabled) return "Voice recognition is off in the settings.";
      if (which.trim().toLowerCase() === "tu" || which.trim().toLowerCase() === "user") return "That is the user's own voice: it needs no name.";
      const voice = speakers.rename(which, name);
      return voice ? `${which} is now called ${voice.name}.` : `There is no voice called ${which}. Known voices: ${speakers.voices().filter((v) => !v.owner).map((v) => voiceLabel(v)).join(", ") || "none"}.`;
    },
  };
  const brain = new Brain(host);
  const autonomy = new Autonomy(
    () => settings().sociability,
    () => canReact() && !activity.snapshot().away,
    () => void brain.handle({ kind: "tick" }),
  );

  /** Where a moment's words go: the voice when it is available, bubbles otherwise. */
  function startSpeech(trigger: Trigger): SpeechSink {
    const spontaneous = trigger.kind !== "message";
    const bubble = (react: boolean) =>
      new BubbleSpeech(
        bubbles,
        {
          emotion: (e, i) => (react ? mood.setEmotion(e, i) : undefined),
          look: (text) => (react && perception.watching() ? void perception.lookAtText(text) : undefined),
        },
        spontaneous,
      );
    if (trigger.kind === "message" && trigger.via === "bar") {
      const reply = settings().commandBar.reply;
      if (reply === "text" || !voice.ready()) return bubble(true);
      return reply === "voice" && !settings().face.subtitles ? voice.speech() : new TeeSpeech(voice.speech(), bubble(false));
    }
    if (!voice.ready()) return bubble(true);
    const spoken = voice.speech();
    const typed = trigger.kind === "message" && trigger.via === "text";
    return typed || settings().face.subtitles ? new TeeSpeech(spoken, bubble(false)) : spoken;
  }

  /** A complete line outside a moment: spoken when possible, else in a bubble. */
  function sayLine(text: string, emotion: Emotion, system = false): void {
    if (voice.ready()) void voice.say(text, emotion);
    else {
      mood.setEmotion(emotion, 0.6);
      bubbles.say(text, { kind: system ? "system" : "speech" });
    }
  }

  /** Whether an event may start a moment on Lumi's own initiative. */
  function canReact(): boolean {
    const s = settings();
    return visible && !s.doNotDisturb && s.sociability !== "silenzioso" && brain.isAvailable() && !brain.isBusy();
  }

  function situation(): Situation {
    return {
      now: new Date(),
      activity: activity.snapshot(),
      voice: voice.ready(),
      screen: perception.summary(),
      vision: settings().vision.provider !== "none" && settings().vision.model ? "local" : settings().perception.sendScreenshots,
      voices: voicesSummary(),
    };
  }

  // ---- events ----

  function onRendererReady(): void {
    if (rendererStarted) return;
    rendererStarted = true;
    if (DEBUG) face.win.webContents.openDevTools({ mode: "detach" });
    // Development aid: save frames of the face window (and of a settings tab) as PNG files
    const capturePrefix = process.env.LUMI_DEBUG_CAPTURE;
    if (capturePrefix) {
      for (let i = 1; i <= 4; i++) {
        setTimeout(async () => {
          const image = await face.win.webContents.capturePage();
          writeFileSync(`${capturePrefix}_${i}.png`, image.toPNG());
        }, 1500 + i * 900);
      }
    }
    // Development aid: open the command bar at startup, with some text typed
    // in it unless the value is "1" (captured with LUMI_DEBUG_CAPTURE)
    const debugBar = process.env.LUMI_DEBUG_BAR;
    if (debugBar) {
      setTimeout(() => {
        commandBar.open();
        if (debugBar !== "1") {
          // A literal "\n" in the variable is a new line
          const typed = JSON.stringify(debugBar.replace(/\\n/g, "\n"));
          void commandBar.win.webContents.executeJavaScript(`{ const i = document.getElementById("input"); i.value = ${typed}; i.dispatchEvent(new Event("input")); }`);
        }
      }, 2000);
      if (capturePrefix) {
        setTimeout(async () => writeFileSync(`${capturePrefix}_bar.png`, (await commandBar.win.webContents.capturePage()).toPNG()), 3200);
      }
    }
    const settingsTab = process.env.LUMI_DEBUG_SETTINGS;
    if (settingsTab) {
      settingsWindow.open(settingsTab);
      setTimeout(async () => {
        const win = settingsWindow.window();
        if (!win || !capturePrefix) return;
        writeFileSync(`${capturePrefix}_settings.png`, (await win.webContents.capturePage()).toPNG());
      }, 3500);
    }
    setTimeout(() => void greet(), 1200);
  }

  /** Waits (up to `ms`) for the voice, so the greeting is spoken rather than written. */
  function voiceSoon(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (voice.ready()) resolve(true);
        else if (Date.now() - started > ms || sidecar.status().state === "error" || settings().muted) resolve(false);
        else setTimeout(check, 500);
      };
      check();
    });
  }

  async function greet(): Promise<void> {
    // Development aids: say a line without the brain, send a message as if spoken, or play a WAV into the ears
    const debugSay = process.env.LUMI_DEBUG_SAY;
    const debugMessage = process.env.LUMI_DEBUG_MESSAGE;
    const debugHear = process.env.LUMI_DEBUG_HEAR;
    if (debugHear) {
      await voiceSoon(180_000);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const frames = toFrames16k(readWav(debugHear));
        log.info(`Debug: hearing ${debugHear} (${frames.length} frames)`);
        turns.pttDown();
        for (const frame of frames) {
          turns.mic({ type: "frame", pcm: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer, speech: 1 });
          await new Promise((resolve) => setTimeout(resolve, 32));
        }
        turns.pttUp();
      } catch (err) {
        log.error(`LUMI_DEBUG_HEAR failed for ${debugHear}`, err);
      }
    }
    if (debugSay || debugMessage) {
      await voiceSoon(180_000);
      if (debugSay) {
        const [text, emotion] = debugSay.split("|");
        const sink = startSpeech({ kind: "message", text: "", via: "voice" });
        sink.final([{ text, emotion: toEmotion(emotion) ?? "neutra", intensity: 0.8 }]);
        const heard = await sink.done();
        log.info(`Debug line spoken: "${heard.text}"`);
      }
      if (debugMessage) await brain.handle({ kind: "message", text: debugMessage, via: "voice" });
    } else if (!settings().doNotDisturb) {
      await voiceSoon(60_000);
      const stats = memory.stats();
      const firstRun = memory.facts().length === 0 && memory.recentConversation(1).length === 0 && memory.diary().length === 0;
      await brain.handle({ kind: "startup", hoursAway: (Date.now() - Date.parse(stats.lastSeenAt)) / 3_600_000, firstRun });
    }
    memory.touch();
    await brain.writeDiary();
  }

  activity.on("away", () => mood.set({ drowsy: true }));
  activity.on("back", (minutesAway) => {
    mood.set({ drowsy: false });
    if (minutesAway >= 10 && canReact()) void brain.handle({ kind: "back", minutesAway });
  });
  powerMonitor.on("lock-screen", () => activity.setLocked(true));
  powerMonitor.on("unlock-screen", () => activity.setLocked(false));
  screen.on("display-added", () => face.displaysChanged());
  screen.on("display-removed", () => face.displaysChanged());
  screen.on("display-metrics-changed", () => face.displaysChanged());

  // Due reminders, announced only while the user is at the computer
  setInterval(() => {
    if (activity.snapshot().away) return;
    for (const reminder of memory.takeDueReminders()) {
      if (!visible) setVisible(true);
      face.gesture("bounce");
      const text = `Ehi, promemoria: ${reminder.text}`;
      memory.addMessage("lumi", text);
      sayLine(text, "sorpresa");
    }
  }, 15_000);

  // ---- tray, hotkeys, settings ----

  function setVisible(next: boolean): void {
    visible = next;
    if (next) face.win.showInactive();
    else {
      face.closeInput();
      face.win.hide();
      voice.stopAll();
    }
    tray.refresh();
  }

  function talk(): void {
    if (!visible) setVisible(true);
    if (face.isInputOpen()) face.closeInput();
    else face.openInput();
  }

  function statusLine(): string {
    const chat = services.chosen("chat");
    const brainText = chat ? `${chat.provider.id}/${chat.model}` : "nessun cervello configurato";
    const s = sidecar.status();
    const engine = voice.engine();
    const voiceText = settings().muted
      ? "voce disattivata"
      : s.state !== "ready"
        ? s.state === "starting"
          ? "voce in avvio"
          : "modalità testo"
        : engine?.state === "ready"
          ? `voce ${settings().tts.engine}`
          : engine?.state === "loading"
            ? "voce in caricamento"
            : "modalità testo";
    return `${voiceText} - ${brainText}`;
  }

  const audiobooks = new Audiobooks(
    sidecar,
    settings,
    (text) => bubbles.say(text, { kind: "system" }),
    () => tray.refresh(),
  );

  const tray = new LumiTray(
    {
      talk,
      ask: () => commandBar.open(),
      toggleVisible: () => setVisible(!visible),
      toggleDoNotDisturb: () => settingsStore.update({ doNotDisturb: !settings().doNotDisturb }),
      toggleMuted: () => settingsStore.update({ muted: !settings().muted }),
      togglePerception: () => settingsStore.update({ perception: { enabled: !settings().perception.enabled } }),
      setListenMode: (mode) => settingsStore.update({ listen: { mode } }),
      createAudiobook: () => void audiobooks.create(),
      cancelAudiobook: () => void audiobooks.cancel(),
      openSettings: () => settingsWindow.open(),
      openDataFolder: () => void shell.openPath(dataDir),
      quit: () => app.quit(),
    },
    () => ({
      visible,
      doNotDisturb: settings().doNotDisturb,
      muted: settings().muted,
      perception: settings().perception.enabled,
      listenMode: settings().listen.mode,
      status: statusLine(),
      voiceReady: voice.ready(),
      online: services.chosen("chat") !== null,
      chatHotkey: settings().chatHotkey,
      talkHotkey: settings().listen.hotkey,
      audiobook: audiobooks.status(),
    }),
  );

  // ---- command bar (Ctrl+Alt+L): a text field over everything ----
  const commandBar = new CommandBar(
    {
      context: () => (settings().commandBar.useSelection ? perception.selection() : null),
      gaze: (rect) => {
        // While the bar is open the eyes look at it, like at a caret
        if (rect) perception.add({ id: "commandbar", kind: "caret", rect, salience: 1, t: Date.now() });
        else perception.remove("commandbar");
      },
      submit: ({ text, context, files }) => void askFromBar(text, context, files),
    },
    `${APP_ORIGIN}/renderer/commandbar/commandbar.html`,
    join(dataDir, "commandbar.json"),
  );

  async function askFromBar(text: string, context: BarContext | null, files: string[]): Promise<void> {
    if (!visible) setVisible(true);
    let attachments: Attachment[] = [];
    if (files.length) {
      mood.set({ thinking: true });
      attachments = await readAttachments(files, {
        size: async (path) => (await stat(path)).size,
        read: async (path) => new Uint8Array(await readFile(path)),
        describeImage: async (path, name) => {
          let image = nativeImage.createFromPath(path);
          if (image.isEmpty()) return "(an image format that can't be opened)";
          const { width, height } = image.getSize();
          const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
          if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "good" });
          return screenshots.describeImage(name, image.toJPEG(82).toString("base64"), text);
        },
      });
    }
    log.info(`Command bar: ${text.length} characters${context ? ", with the selection" : ""}${attachments.length ? `, ${attachments.length} attachments` : ""}`);
    await brain.handle({ kind: "message", text: text || "(guarda gli allegati)", via: "bar", ...(context ? { context } : {}), ...(attachments.length ? { attachments } : {}) });
  }

  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const s = settings();
    if (s.chatHotkey) {
      try {
        if (!globalShortcut.register(s.chatHotkey, () => commandBar.toggle())) log.warn(`Hotkey ${s.chatHotkey} is already used by another application`);
      } catch (err) {
        log.warn(`Invalid hotkey ${s.chatHotkey}`, err);
      }
    }
    // The talk key works in every mode: it also skips the wake word
    pushToTalk.register(s.listen.hotkey);
  }

  function applyLoginItem(): void {
    // In development the app runs as `electron <folder>`, so pass the folder along
    app.setLoginItemSettings({ openAtLogin: settings().launchAtLogin, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
  }

  function snapshot(): SettingsSnapshot {
    return {
      settings: settings(),
      keys: Object.fromEntries(PROVIDER_IDS.map((id) => [id, apiKeys.source(id)])) as Record<ProviderId, KeySource>,
      facts: memory.facts(),
      reminders: memory.reminders(),
      diary: memory.diary(),
      appAudioStatus: appAudio.statuses,
      discord: { ...discordVoice.status(), token: discordToken.source() },
      knownVoices: speakers.voices().map((v) => ({ id: v.id, label: voiceLabel(v, settings().userName), owner: !!v.owner, via: v.via, samples: v.samples, lastHeard: v.lastHeard })),
      dataPath: dataDir,
      sidecar: sidecar.status(),
      gpu,
      voices,
    };
  }

  async function testVoice(text: string) {
    const line = text.trim() || "Ciao! Sono Lumi.";
    if (settings().muted) return { ok: false, message: "La voce è disattivata: togli la spunta da Generale → Voce disattivata." };
    if (!sidecar.endpoint()) return { ok: false, message: `I motori della voce non sono attivi (${sidecar.status().message || "spenti"}).` };
    await voice.configure();
    // The first time the model is downloaded and loaded: wait for it
    const ready = await voiceSoon(15 * 60_000);
    if (!ready) {
      const engine = voice.engine();
      return { ok: false, message: engine?.detail ? `La voce non è pronta: ${engine.detail}` : "La voce non è pronta: controlla la scheda Stato." };
    }
    const started = Date.now();
    const heard = await voice.say(line, "gioia", 0.7);
    return { ok: heard.text.length > 0, message: heard.text ? `Fatto in ${((Date.now() - started) / 1000).toFixed(1)} s.` : "Non sono riuscito a parlare: i dettagli sono nel log." };
  }

  const settingsWindow = new SettingsWindow(
    {
      snapshot,
      save: (next, keys) => {
        if (Object.keys(keys).length) apiKeys.update(keys);
        services.invalidate();
        brain.credentialsChanged();
        settingsStore.replace(next);
        return snapshot();
      },
      testConnection: async () => {
        const reports = await services.test();
        brain.credentialsChanged();
        tray.refresh();
        return reports;
      },
      listModels: (id) => services.listModels(id),
      listVisionModels: async (provider) => {
        if (provider === "none") return { ok: true, models: [], message: "" };
        if (provider === "custom") return services.listModels("custom");
        try {
          const models = await listVisionModels(settings().brain.ollamaUrl, services.fetch);
          return {
            ok: true,
            models,
            message: models.length ? `${models.length} modelli con la visione.` : 'Nessun modello con la visione: scaricane uno, ad esempio "ollama pull qwen3-vl:8b".',
          };
        } catch {
          return { ok: false, models: [], message: "Ollama non risponde: è installato e avviato?" };
        }
      },
      testVoice,
      applyProfile: (profile) => {
        settingsStore.replace({ ...applyProfile(settings(), profile), setupDone: true });
        services.invalidate();
        return snapshot();
      },
      pickVoiceFile: async (win: BrowserWindow) => {
        const result = await dialog.showOpenDialog(win, {
          title: "Campione di voce da clonare",
          filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
          properties: ["openFile"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      forgetFact: (id) => {
        memory.forget(id);
        return snapshot();
      },
      clearMemory: () => {
        memory.clear();
        speakers.clear();
        return snapshot();
      },
      forgetVoice: (id) => {
        speakers.forget(id);
        return snapshot();
      },
      setDiscordToken: (token) => {
        try {
          discordToken.set(token);
        } catch (err) {
          log.warn("Saving the Discord token failed", err);
        }
        updateDiscord();
        return snapshot();
      },
      openDataFolder: () => void shell.openPath(dataDir),
      restartSidecar: async () => {
        await sidecar.restart();
        return snapshot();
      },
    },
    `${APP_ORIGIN}/renderer/settings/settings.html`,
  );

  settingsStore.onChange((next, prev) => {
    if (next.face.scale !== prev.face.scale || next.face.color !== prev.face.color) face.setAppearance(next.face.scale, next.face.color);
    if (next.chatHotkey !== prev.chatHotkey || next.listen.hotkey !== prev.listen.hotkey || next.listen.mode !== prev.listen.mode) registerHotkeys();
    if (next.listen.mode !== prev.listen.mode || next.doNotDisturb !== prev.doNotDisturb) updateWake();
    if (next.launchAtLogin !== prev.launchAtLogin) applyLoginItem();
    if (engineKey(next) !== engineKey(prev)) void voice.configure();
    if (JSON.stringify(next.tts) !== JSON.stringify(prev.tts)) prepareClips();
    if (next.muted && !prev.muted) voice.stopAll();
    if (JSON.stringify(next.perception) !== JSON.stringify(prev.perception)) updateUia();
    if (JSON.stringify(next.discord) !== JSON.stringify(prev.discord)) updateDiscord();
    if (JSON.stringify(next.appAudio) !== JSON.stringify(prev.appAudio) || next.doNotDisturb !== prev.doNotDisturb || next.stt.vocabulary !== prev.stt.vocabulary) updateAppAudio();
    turns.refresh();
    tray.refresh();
  });

  app.on("second-instance", talk);
  // Lumi lives in the tray: closing the settings window must not quit
  app.on("window-all-closed", () => undefined);
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    windowState.anchor = face.getAnchor();
    writeJson(stateFile, windowState);
    memory.touch();
    memory.flush();
    speakers.flush();
    pushToTalk.unregister();
    globalShortcut.unregisterAll();
    turns.dispose();
    perception.stop();
    changes.stop();
    uia.set(false);
    appAudio.set(null);
    discordVoice.dispose();
    gazeOverlay?.dispose();
    autonomy.stop();
    bubbles.dispose();
    mood.dispose();
    voice.stopAll();
    sidecarStt.close();
    void Promise.all([sidecar.stop(), memory.archived()]).finally(() => app.quit());
  });

  /** Starts the local Ollama server when one of the brain choices (or the local vision) needs it. */
  const startOllamaIfUsed = () => {
    const b = settings().brain;
    if ([b.chat, b.idle, b.vision].some((c) => c.provider === "ollama" && c.model) || (settings().vision.provider === "ollama" && settings().vision.model)) void ensureOllama(b.ollamaUrl);
  };
  settingsStore.onChange((next, prev) => {
    if (JSON.stringify(next.brain) !== JSON.stringify(prev.brain) || JSON.stringify(next.vision) !== JSON.stringify(prev.vision)) startOllamaIfUsed();
  });

  startOllamaIfUsed();
  activity.start();
  perception.start();
  changes.start();
  autonomy.start();
  registerHotkeys();
  void sidecar.start();
  updateDiscord();
  if (settings().launchAtLogin) applyLoginItem();
  setInterval(() => memory.touch(), 5 * 60_000);
  setInterval(() => {
    if (!brain.isBusy()) void brain.writeDiary();
  }, 30 * 60_000);
  setInterval(() => tray.refresh(), 30_000);
  // First run: open the settings on the profile so the user can pick the brain and the voice
  if (!settings().setupDone) {
    setTimeout(() => settingsWindow.open("general"), 2500);
    settingsStore.update({ setupDone: true });
  }
  const brainInfo = (purpose: "chat" | "idle") => {
    const chosen = services.chosen(purpose);
    return chosen ? `${chosen.provider.id}/${chosen.model}` : "offline";
  };
  log.info(`Ready: chat ${brainInfo("chat")}, moments ${brainInfo("idle")}; face at ${JSON.stringify(face.win.getBounds())}`);
}
