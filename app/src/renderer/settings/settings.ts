// Settings window: profile, brain services and keys, voice, screen
// perception, memory and the status of the voice engines.
import { DEFAULT_VOICE_DESCRIPTION, STT_MODELS, TTS_MODELS, TTS_VOICES, voiceKind } from "../../shared/catalog";
import { PROFILE_INFO, suggestProfile } from "../../shared/profiles";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../shared/providers";
import {
  PROFILES,
  type BrainChoice,
  type EngineStatus,
  type Settings,
  type SettingsBridge,
  type SettingsSnapshot,
  type SidecarStatus,
  type SttEngine,
  type TtsEngine,
} from "../../shared/types";

declare global {
  interface Window {
    settingsApi: SettingsBridge;
  }
}

const api = window.settingsApi;
const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

let snapshot: SettingsSnapshot | null = null;
const removeKeys = new Set<ProviderId>();
const fetchedModels: Partial<Record<ProviderId, string[]>> = {};
type Purpose = "chat" | "idle" | "vision";
const PURPOSES: Purpose[] = ["chat", "idle", "vision"];

// ---------------- tabs ----------------

function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
}
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "general")));
if (location.hash) showTab(location.hash.slice(1));

// ---------------- helpers ----------------

function options(select: HTMLSelectElement, items: { value: string; label: string }[], value: string): void {
  select.replaceChildren(...items.map((i) => new Option(i.label, i.value)));
  if (!items.some((i) => i.value === value) && value) select.append(new Option(value, value));
  select.value = value;
}

function datalist(list: HTMLDataListElement, values: string[]): void {
  list.replaceChildren(
    ...values.map((v) => {
      const option = document.createElement("option");
      option.value = v;
      return option;
    }),
  );
}

function setStatus(text: string): void {
  const status = $<HTMLElement>("status");
  status.textContent = text;
  window.setTimeout(() => {
    if (status.textContent === text) status.textContent = "";
  }, 6000);
}

function bindOutput(input: string, output: string, format: (v: number) => string): void {
  const update = () => ($<HTMLOutputElement>(output).textContent = format(Number($(input).value)));
  $(input).addEventListener("input", update);
  update();
}

// ---------------- profile ----------------

function renderProfiles(next: SettingsSnapshot): void {
  const gpu = next.gpu;
  const suggested = suggestProfile(gpu);
  $<HTMLElement>("gpuText").textContent = gpu
    ? `Scheda video trovata: ${gpu.name}, ${Math.round(gpu.vramTotalMb / 1024)} GB. Profilo consigliato: ${PROFILE_INFO[suggested].label}.`
    : "Nessuna scheda video NVIDIA trovata: il profilo Leggero è il più adatto.";
  $<HTMLDivElement>("profiles").replaceChildren(
    ...PROFILES.map((id) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `profile${id === next.settings.profile ? " selected" : ""}${id === suggested ? " suggested" : ""}`;
      const title = document.createElement("strong");
      title.textContent = PROFILE_INFO[id].label;
      const description = document.createElement("small");
      description.textContent = `${PROFILE_INFO[id].description} Memoria video: ${PROFILE_INFO[id].vram}.`;
      button.append(title, description);
      button.addEventListener("click", async () => {
        fill(await api.applyProfile(id));
        setStatus(`Profilo ${PROFILE_INFO[id].label} applicato e salvato.`);
      });
      return button;
    }),
  );
}

// ---------------- brain ----------------

function providerSelect(purpose: Purpose, value: ProviderId): void {
  options(
    $<HTMLSelectElement>(`${purpose}Provider`),
    PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label })),
    value,
  );
}

function modelSuggestions(purpose: Purpose): void {
  const provider = $<HTMLSelectElement>(`${purpose}Provider`).value as ProviderId;
  const info = PROVIDERS[provider];
  const base = purpose === "vision" ? info.visionSuggestions : info.suggestions;
  datalist($<HTMLDataListElement>(`${purpose}Models`), [...new Set([...base, ...(fetchedModels[provider] ?? [])])]);
  const key = snapshot?.keys[provider] ?? "none";
  const needs = info.needsKey && key === "none" && !$(`key-${provider}`)?.value ? "Manca la chiave: inseriscila qui sotto." : "";
  $<HTMLElement>(`${purpose}Hint`).textContent = needs;
}

function onProviderChange(purpose: Purpose): void {
  const provider = $<HTMLSelectElement>(`${purpose}Provider`).value as ProviderId;
  const model = $(`${purpose}Model`);
  const info = PROVIDERS[provider];
  const known = new Set([...(fetchedModels[provider] ?? []), ...info.suggestions, ...info.visionSuggestions]);
  // A model name from another service makes no sense here
  if (model.value && !known.has(model.value)) model.value = "";
  if (!model.value && purpose !== "vision") model.value = info.suggestions[0] ?? "";
  if (!model.value && purpose === "vision") model.value = info.visionSuggestions[0] ?? "";
  modelSuggestions(purpose);
}

async function detectModels(purpose: Purpose): Promise<void> {
  const provider = $<HTMLSelectElement>(`${purpose}Provider`).value as ProviderId;
  const hint = $<HTMLElement>(`${purpose}Hint`);
  hint.textContent = "Cerco i modelli…";
  await save(false);
  const result = await api.listModels(provider);
  if (result.ok) fetchedModels[provider] = result.models;
  modelSuggestions(purpose);
  hint.textContent = result.ok ? `${result.message} Scegline uno dalla lista del campo modello.` : result.message;
}

function renderProviders(next: SettingsSnapshot): void {
  const box = $<HTMLDivElement>("providers");
  const typed = new Map<string, string>();
  box.querySelectorAll<HTMLInputElement>("input").forEach((input) => typed.set(input.id, input.value));
  box.replaceChildren(
    ...PROVIDER_IDS.map((id) => {
      const info = PROVIDERS[id];
      const card = document.createElement("div");
      card.className = "provider";
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = info.label;
      header.append(title);
      const note = document.createElement("p");
      note.textContent = info.note;
      card.append(header, note);
      const addInput = (inputId: string, value: string, placeholder: string, type = "text") => {
        const input = document.createElement("input");
        input.id = inputId;
        input.type = type;
        input.placeholder = placeholder;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.value = typed.get(inputId) ?? value;
        return input;
      };
      if (id === "ollama") card.append(addInput("ollamaUrl", next.settings.brain.ollamaUrl, "http://localhost:11434"));
      if (id === "custom") card.append(addInput("customUrl", next.settings.brain.customUrl, "http://localhost:1234/v1"));
      if (info.needsKey || id === "custom") {
        const row = document.createElement("div");
        row.className = "row";
        const key = addInput(`key-${id}`, "", info.needsKey ? "chiave API" : "chiave API (se serve)", "password");
        key.addEventListener("input", () => removeKeys.delete(id));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Rimuovi";
        remove.addEventListener("click", () => {
          removeKeys.add(id);
          key.value = "";
          setStatus(`La chiave di ${info.name} verrà rimossa quando salvi.`);
        });
        row.append(key, remove);
        const status = document.createElement("small");
        status.className = "hint";
        const source = next.keys[id];
        status.textContent =
          (source === "settings" ? "✓ Chiave salvata (cifrata). " : source === "environment" ? `Uso la variabile d'ambiente ${info.envKey}. ` : "Nessuna chiave. ") +
          (info.keyHelp ? `Si ottiene da ${info.keyHelp}.` : "");
        card.append(row, status);
      }
      return card;
    }),
  );
}

// ---------------- voice ----------------

function sttModels(): void {
  const engine = $<HTMLSelectElement>("sttEngine").value as SttEngine;
  datalist($<HTMLDataListElement>("sttModels"), STT_MODELS[engine]);
}

function onSttEngineChange(): void {
  const engine = $<HTMLSelectElement>("sttEngine").value as SttEngine;
  $("sttModel").value = STT_MODELS[engine][0];
  sttModels();
}

function ttsChoices(model: string, voice: string): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  options(
    $<HTMLSelectElement>("ttsModel"),
    TTS_MODELS[engine].map((m) => ({ value: m.id, label: m.label })),
    model || TTS_MODELS[engine][0].id,
  );
  const voices = [...new Set([...(snapshot?.voices[engine] ?? []), ...TTS_VOICES[engine]])];
  datalist($<HTMLDataListElement>("ttsVoices"), voices);
  $("ttsVoice").value = voice;
  voiceHint();
}

function voiceHint(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  const kind = voiceKind(engine, $<HTMLSelectElement>("ttsModel").value);
  const input = $("ttsVoice");
  input.placeholder = kind === "clip" ? "percorso di un file audio (10-20 s di voce pulita)" : kind === "description" ? DEFAULT_VOICE_DESCRIPTION : "nome della voce";
  $<HTMLButtonElement>("pickVoice").hidden = kind !== "clip";
}

function onTtsEngineChange(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  ttsChoices(TTS_MODELS[engine][0].id, TTS_VOICES[engine][0]);
}

function onTtsModelChange(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  const kind = voiceKind(engine, $<HTMLSelectElement>("ttsModel").value);
  const voice = $("ttsVoice");
  if (kind === "description" && !voice.value.includes(" ")) voice.value = DEFAULT_VOICE_DESCRIPTION;
  if (kind === "speaker" && !TTS_VOICES[engine].includes(voice.value)) voice.value = TTS_VOICES[engine][0];
  if (kind === "clip" && !/[\\/.]/.test(voice.value) && engine === "qwen3") voice.value = "";
  voiceHint();
}

async function renderMicDevices(selected: string): Promise<void> {
  const select = $<HTMLSelectElement>("micDevice");
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    // no permission to list devices: only the default
  }
  options(
    select,
    [{ value: "", label: "Microfono predefinito di Windows" }, ...devices.filter((d) => d.deviceId && d.deviceId !== "default").map((d) => ({ value: d.deviceId, label: d.label || "Microfono" }))],
    selected,
  );
}

// ---------------- status ----------------

const ENGINE_KIND: Record<EngineStatus["kind"], string> = {
  stt: "ascolto",
  tts: "voce",
  ocr: "lettura",
  uia: "focus",
  turn: "fine turno",
  wake: "attivazione",
};
const ENGINE_STATE: Record<EngineStatus["state"], string> = {
  missing: "non installato",
  idle: "pronto da caricare",
  loading: "in caricamento…",
  ready: "pronto",
  error: "errore",
};

function renderStatus(status: SidecarStatus): void {
  const state = {
    off: "spenti: Lumi funziona in modalità testo",
    starting: "in avvio…",
    ready: "attivi",
    error: "non disponibili",
  }[status.state];
  $<HTMLElement>("statusLine").textContent = `Voce e vista: ${state}${status.message ? ` - ${status.message}` : ""}`;
  $<HTMLElement>("sidecarText").textContent = [
    `Stato: ${state}.`,
    status.message,
    status.gpu ? `Scheda video: ${status.gpu.name}${status.gpu.vramFreeMb !== undefined ? `, ${Math.round(status.gpu.vramFreeMb / 1024)} GB liberi su ${Math.round(status.gpu.vramTotalMb / 1024)}` : ""}.` : "",
    status.installed.length ? `Pacchetti installati: ${status.installed.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const list = $<HTMLUListElement>("engines");
  if (!status.engines.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nessun motore attivo.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...status.engines.map((e) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = `tag ${e.state}`;
      tag.textContent = ENGINE_STATE[e.state];
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = `${ENGINE_KIND[e.kind]}: ${e.name}${e.device ? ` (${e.device})` : ""}${e.detail ? ` - ${e.detail}` : ""}`;
      li.append(tag, text);
      return li;
    }),
  );
}

// ---------------- form ----------------

function listItems(id: string, items: { tag: string; text: string; action?: () => void }[], empty: string): void {
  const list = $<HTMLUListElement>(id);
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = empty;
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = item.tag;
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = item.text;
      li.append(tag, text);
      if (item.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Dimentica";
        button.addEventListener("click", item.action);
        li.append(button);
      }
      return li;
    }),
  );
}

const KIND_LABEL: Record<string, string> = {
  user: "chi sei",
  work: "lavoro",
  preference: "gusti",
  event: "evento",
  lumi: "noi due",
  note: "nota di oggi",
};

function fill(next: SettingsSnapshot): void {
  snapshot = next;
  const s = next.settings;
  renderProfiles(next);
  $("userName").value = s.userName;
  $<HTMLTextAreaElement>("personality").value = s.personality;
  $<HTMLSelectElement>("sociability").value = s.sociability;
  $("doNotDisturb").checked = s.doNotDisturb;
  $("muted").checked = s.muted;
  $("subtitles").checked = s.face.subtitles;
  $("adaptiveShadow").checked = s.face.adaptiveShadow;
  $("glare").checked = s.face.glare;
  $("voicesEnabled").checked = s.voices.enabled;
  $("onlyMe").checked = s.voices.onlyMe;
  $("discordEnabled").checked = s.discord.enabled;
  $("discordUserId").value = s.discord.userId;
  $("discordToken").value = "";
  $<HTMLElement>("discordTokenState").textContent = next.discord.token === "saved" ? "(salvato)" : next.discord.token === "env" ? "(da DISCORD_BOT_TOKEN)" : "(manca)";
  $<HTMLElement>("discordStatus").textContent = DISCORD_STATE[next.discord.state] ? `Adesso: ${DISCORD_STATE[next.discord.state]}${next.discord.detail ? ` - ${next.discord.detail}` : ""}.` : "";
  $("appAudioEnabled").checked = s.appAudio.enabled;
  $<HTMLTextAreaElement>("appAudioApps").value = s.appAudio.apps.join("\n");
  const appStatus = Object.entries(next.appAudioStatus);
  $<HTMLElement>("appAudioStatus").textContent = appStatus.length ? `Adesso: ${appStatus.map(([app, state]) => `${app} ${state}`).join(", ")}.` : "";
  $("scale").value = String(s.face.scale);
  $("color").value = s.face.color.toLowerCase();
  $("chatHotkey").value = s.chatHotkey;
  $<HTMLSelectElement>("barReply").value = s.commandBar.reply;
  $("barSelection").checked = s.commandBar.useSelection;
  $("launchAtLogin").checked = s.launchAtLogin;

  renderProviders(next);
  for (const purpose of PURPOSES) {
    const choice: BrainChoice = s.brain[purpose];
    providerSelect(purpose, choice.provider);
    $(`${purpose}Model`).value = choice.model;
    modelSuggestions(purpose);
  }

  $<HTMLSelectElement>("listenMode").value = s.listen.mode;
  $("hotkey").value = s.listen.hotkey;
  $("wakeWord").value = s.listen.wakeWord;
  $("wakeThreshold").value = String(s.listen.wakeThreshold);
  $("followUpSeconds").value = String(s.listen.followUpSeconds);
  $("pauseMs").value = String(s.listen.pauseMs);
  $("bargeIn").checked = s.listen.bargeIn;
  $("backchannel").checked = s.listen.backchannel;
  $("fillers").checked = s.listen.fillers;
  void renderMicDevices(s.listen.micDevice);
  $<HTMLSelectElement>("sttEngine").value = s.stt.engine;
  $("sttModel").value = s.stt.model;
  $<HTMLSelectElement>("sttDevice").value = s.stt.device;
  $("vocabulary").value = s.stt.vocabulary.join(", ");
  sttModels();
  $<HTMLSelectElement>("ttsEngine").value = s.tts.engine;
  ttsChoices(s.tts.model, s.tts.voice);
  $("speed").value = String(s.tts.speed);
  $("volume").value = String(s.tts.volume);
  $("seed").value = String(s.tts.seed);

  $("perceptionEnabled").checked = s.perception.enabled;
  $<HTMLSelectElement>("ocr").value = s.perception.ocr;
  $("captureFps").value = String(s.perception.captureFps);
  $("ocrFps").value = String(s.perception.ocrFps);
  $("uia").checked = s.perception.uia;
  $<HTMLSelectElement>("sendScreenshots").value = s.perception.sendScreenshots;
  $<HTMLSelectElement>("localVisionProvider").value = s.vision.provider;
  $("localVisionModel").value = s.vision.model;
  $<HTMLTextAreaElement>("pauseInApps").value = s.perception.pauseInApps.join("\n");

  for (const id of ["scale", "followUpSeconds", "pauseMs", "wakeThreshold", "speed", "volume", "captureFps", "ocrFps"]) $(id).dispatchEvent(new Event("input"));

  listItems(
    "facts",
    next.facts.map((f) => ({ tag: KIND_LABEL[f.kind] ?? f.kind, text: f.text, action: () => void api.forgetFact(f.id).then(fill) })),
    "Non ricorda ancora niente di te.",
  );
  listItems(
    "reminders",
    next.reminders.map((r) => ({ tag: new Date(r.dueAt).toLocaleString("it-IT", { weekday: "short", hour: "2-digit", minute: "2-digit" }), text: r.text })),
    "Nessun promemoria.",
  );
  listItems(
    "diary",
    [...next.diary].reverse().map((d) => ({ tag: d.date, text: d.summary })),
    "Il diario si riempie giorno dopo giorno.",
  );
  listItems(
    "knownVoices",
    next.knownVoices.map((v) => ({
      tag: v.owner ? "la tua" : v.via.filter((x) => x !== "mic").join(", ") || "microfono",
      text: `${v.label} - sentita ${v.samples} ${v.samples === 1 ? "volta" : "volte"}, l'ultima ${new Date(v.lastHeard).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
      action: () => void api.forgetVoice(v.id).then(fill),
    })),
    "Nessuna voce ancora.",
  );
  renderStatus(next.sidecar);
  $<HTMLElement>("dataPath").textContent = `Impostazioni, memoria, modelli e log sono in ${next.dataPath}.`;
}

function collect(): Settings {
  if (!snapshot) throw new Error("not loaded");
  const s = snapshot.settings;
  const num = (id: string, fallback: number) => {
    const value = Number($(id).value);
    return Number.isFinite(value) ? value : fallback;
  };
  const choice = (purpose: Purpose): BrainChoice => ({
    provider: $<HTMLSelectElement>(`${purpose}Provider`).value as ProviderId,
    model: $(`${purpose}Model`).value,
  });
  return {
    ...s,
    userName: $("userName").value,
    personality: $<HTMLTextAreaElement>("personality").value,
    sociability: $<HTMLSelectElement>("sociability").value as Settings["sociability"],
    doNotDisturb: $("doNotDisturb").checked,
    muted: $("muted").checked,
    chatHotkey: $("chatHotkey").value,
    commandBar: { reply: $<HTMLSelectElement>("barReply").value as Settings["commandBar"]["reply"], useSelection: $("barSelection").checked },
    launchAtLogin: $("launchAtLogin").checked,
    face: { scale: num("scale", s.face.scale), color: $("color").value, subtitles: $("subtitles").checked, adaptiveShadow: $("adaptiveShadow").checked, glare: $("glare").checked },
    voices: { enabled: $("voicesEnabled").checked, onlyMe: $("onlyMe").checked },
    discord: { enabled: $("discordEnabled").checked, userId: $("discordUserId").value.trim() },
    appAudio: {
      enabled: $("appAudioEnabled").checked,
      apps: $<HTMLTextAreaElement>("appAudioApps")
        .value.split(/\n|,/)
        .map((a) => a.trim())
        .filter(Boolean),
    },
    brain: {
      chat: choice("chat"),
      idle: choice("idle"),
      vision: choice("vision"),
      ollamaUrl: $("ollamaUrl")?.value ?? s.brain.ollamaUrl,
      customUrl: $("customUrl")?.value ?? s.brain.customUrl,
    },
    listen: {
      mode: $<HTMLSelectElement>("listenMode").value as Settings["listen"]["mode"],
      hotkey: $("hotkey").value,
      wakeWord: $("wakeWord").value,
      wakeThreshold: Number($("wakeThreshold").value),
      followUpSeconds: num("followUpSeconds", s.listen.followUpSeconds),
      pauseMs: num("pauseMs", s.listen.pauseMs),
      bargeIn: $("bargeIn").checked,
      backchannel: $("backchannel").checked,
      fillers: $("fillers").checked,
      micDevice: $<HTMLSelectElement>("micDevice").value,
    },
    vision: {
      ...s.vision,
      provider: $<HTMLSelectElement>("localVisionProvider").value as Settings["vision"]["provider"],
      model: $("localVisionModel").value.trim(),
    },
    stt: {
      engine: $<HTMLSelectElement>("sttEngine").value as SttEngine,
      model: $("sttModel").value,
      device: $<HTMLSelectElement>("sttDevice").value as Settings["stt"]["device"],
      vocabulary: $("vocabulary")
        .value.split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    },
    tts: {
      engine: $<HTMLSelectElement>("ttsEngine").value as TtsEngine,
      model: $<HTMLSelectElement>("ttsModel").value,
      voice: $("ttsVoice").value,
      speed: num("speed", s.tts.speed),
      volume: num("volume", s.tts.volume),
      seed: num("seed", s.tts.seed),
    },
    perception: {
      enabled: $("perceptionEnabled").checked,
      ocr: $<HTMLSelectElement>("ocr").value as Settings["perception"]["ocr"],
      captureFps: num("captureFps", s.perception.captureFps),
      ocrFps: num("ocrFps", s.perception.ocrFps),
      uia: $("uia").checked,
      sendScreenshots: $<HTMLSelectElement>("sendScreenshots").value as Settings["perception"]["sendScreenshots"],
      pauseInApps: $<HTMLTextAreaElement>("pauseInApps")
        .value.split("\n")
        .map((a) => a.trim())
        .filter(Boolean),
    },
  };
}

const DISCORD_STATE: Record<string, string> = {
  connecting: "si collega",
  online: "online, aspetta che entri in un canale vocale",
  "in-channel": "nel canale",
  error: "errore",
};

/** Typed keys to store and keys marked for removal. */
function keyChanges(): Partial<Record<ProviderId, string>> {
  const changes: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const typed = $(`key-${id}`)?.value.trim();
    if (typed) changes[id] = typed;
    else if (removeKeys.has(id)) changes[id] = "";
  }
  return changes;
}

async function save(announce = true): Promise<void> {
  try {
    const keys = keyChanges();
    const token = $("discordToken").value.trim();
    if (token) await api.setDiscordToken(token);
    fill(await api.save(collect(), keys));
    for (const id of Object.keys(keys)) {
      const input = $(`key-${id}`);
      if (input) input.value = "";
    }
    removeKeys.clear();
    if (announce) setStatus("Salvato ✓");
  } catch (err) {
    setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`);
  }
}

bindOutput("scale", "scaleOut", (v) => `×${v.toFixed(1)}`);
bindOutput("pauseMs", "pauseOut", (v) => `${(v / 1000).toLocaleString("it-IT", { minimumFractionDigits: 1 })} s`);
bindOutput("followUpSeconds", "followUpOut", (v) => (v ? `${v} s` : "niente (serve sempre il tasto o la parola)"));
bindOutput("speed", "speedOut", (v) => `×${v.toFixed(2)}`);
bindOutput("volume", "volumeOut", (v) => `${Math.round(v * 100)}%`);
bindOutput("wakeThreshold", "wakeThresholdOut", (v) => v.toFixed(2));
bindOutput("captureFps", "captureFpsOut", (v) => String(v));
bindOutput("ocrFps", "ocrFpsOut", (v) => v.toFixed(1));

$<HTMLButtonElement>("save").addEventListener("click", () => void save());
for (const purpose of PURPOSES) {
  $<HTMLSelectElement>(`${purpose}Provider`).addEventListener("change", () => onProviderChange(purpose));
  $<HTMLButtonElement>(`${purpose}Detect`).addEventListener("click", () => void detectModels(purpose));
}
$<HTMLButtonElement>("localVisionDetect").addEventListener("click", async () => {
  const hint = $<HTMLElement>("localVisionHint");
  hint.textContent = "Cerco i modelli con la visione…";
  await save(false);
  const result = await api.listVisionModels($<HTMLSelectElement>("localVisionProvider").value as Settings["vision"]["provider"]);
  $<HTMLDataListElement>("localVisionModels").replaceChildren(...result.models.map((m) => Object.assign(document.createElement("option"), { value: m })));
  hint.textContent = result.ok && result.models.length ? `${result.message} Scegline uno dalla lista del campo modello.` : result.message;
});
$<HTMLSelectElement>("sttEngine").addEventListener("change", onSttEngineChange);
$<HTMLSelectElement>("ttsEngine").addEventListener("change", onTtsEngineChange);
$<HTMLSelectElement>("ttsModel").addEventListener("change", onTtsModelChange);
$<HTMLButtonElement>("pickVoice").addEventListener("click", async () => {
  const path = await api.pickVoiceFile();
  if (path) $("ttsVoice").value = path;
});
$<HTMLButtonElement>("test").addEventListener("click", async () => {
  const list = $<HTMLUListElement>("testResult");
  list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "Provo…" }));
  await save(false);
  const reports = await api.testConnection();
  list.replaceChildren(
    ...reports.map((r) => {
      const li = document.createElement("li");
      li.className = r.ok ? "ok" : "fail";
      li.textContent = r.message;
      return li;
    }),
  );
});
$<HTMLButtonElement>("testVoice").addEventListener("click", async () => {
  const result = $<HTMLElement>("voiceResult");
  result.textContent = "Preparo la voce… (la prima volta il modello viene scaricato e caricato: può volerci qualche minuto)";
  await save(false);
  const report = await api.testVoice($("voiceText").value);
  result.textContent = report.message;
});
$<HTMLButtonElement>("openData").addEventListener("click", () => void api.openDataFolder());
$<HTMLButtonElement>("restartSidecar").addEventListener("click", async () => {
  setStatus("Riavvio i motori…");
  fill(await api.restartSidecar());
});

const clearButton = $<HTMLButtonElement>("clearMemory");
let armedUntil = 0;
clearButton.addEventListener("click", async () => {
  if (Date.now() > armedUntil) {
    armedUntil = Date.now() + 4000;
    clearButton.classList.add("armed");
    clearButton.textContent = "Sicuro? Clicca di nuovo";
    window.setTimeout(() => {
      clearButton.classList.remove("armed");
      clearButton.textContent = "Dimentica tutto";
    }, 4000);
    return;
  }
  armedUntil = 0;
  fill(await api.clearMemory());
  setStatus("Memoria cancellata.");
});

api.onStatus((status) => {
  if (snapshot) snapshot = { ...snapshot, sidecar: status };
  renderStatus(status);
});

void api.load().then(fill);
