// Settings window: profile, brain services and keys, voice, screen
// perception, memory and the status of the voice engines.
import { BUNDLED_VOICES, DEFAULT_VOICE_DESCRIPTION, STT_MODELS, TTS_MODELS, TTS_VOICES, defaultVoice, voiceKind } from "../../shared/catalog";
import { DAY_MOODS, MOOD_LABEL, type DayMoodId, type MoodWeights } from "../../shared/dayMood";
import { PROFILE_INFO, suggestProfile } from "../../shared/profiles";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../shared/providers";
import {
  PROFILES,
  type BrainChoice,
  type EngineStatus,
  type ForgetCandidate,
  type RuntimeSetupState,
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

// ---------------- voice engine installation (installed app) ----------------

const GB = 1024 ** 3;

function size(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1).replace(".", ",")} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** What to install, by profile: no GPU means no torch. */
function installSize(extras: string[]): string {
  return extras.includes("gpu") ? "circa 4 GB da scaricare (PyTorch con CUDA), più i modelli della voce" : "circa 300 MB da scaricare, più i modelli della voce";
}

function renderSetup(state: RuntimeSetupState): void {
  const card = $<HTMLElement>("runtimeCard");
  card.hidden = state.phase === "dev";
  if (card.hidden) return;
  const progress = $<HTMLProgressElement>("runtimeProgress");
  const button = $<HTMLButtonElement>("runtimeInstall");
  const busy = state.phase === "installing" || state.phase === "starting" || state.phase === "models";
  button.disabled = busy;
  button.hidden = busy || state.phase === "ready";
  button.textContent = state.phase === "outdated" ? "Aggiorna il motore della voce" : state.phase === "error" ? "Riprova" : "Installa il motore della voce";
  progress.hidden = !busy;
  if (state.phase === "installing" && state.total > 0) progress.value = state.downloaded / state.total;
  else progress.removeAttribute("value");
  const text: Record<RuntimeSetupState["phase"], string> = {
    dev: "",
    missing: `Per parlare e ascoltare Lumi ha bisogno del suo motore della voce: ${installSize(state.extras)}. Intanto funziona in modalità testo.`,
    outdated: `Il profilo scelto (o un aggiornamento di Lumi) richiede di aggiornare il motore della voce: ${installSize(state.extras)}, ma solo ciò che manca.`,
    installing: state.total ? `Installazione: ${size(state.downloaded)} di ${size(state.total)} scaricati.` : "Installazione in corso…",
    starting: "Installato. Avvio i motori…",
    models: `Primo avvio: scarico i modelli della voce (${state.modelsMb} MB finora). La prima volta può volerci qualche minuto.`,
    ready: "Il motore della voce è installato e pronto.",
    error: `Installazione non riuscita: ${state.detail} I dettagli sono in logs\\setup.log.`,
  };
  $<HTMLElement>("runtimeText").textContent = text[state.phase];
  $<HTMLElement>("runtimeDetail").textContent = busy ? state.detail : "";
}

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
  $("ttsVoice").value = voice;
  voiceHint();
}

function voiceHint(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  const kind = voiceKind(engine, $<HTMLSelectElement>("ttsModel").value);
  const voices = kind === "clip" ? BUNDLED_VOICES : [...new Set([...(snapshot?.voices[engine] ?? []), ...TTS_VOICES[engine]])];
  datalist($<HTMLDataListElement>("ttsVoices"), voices);
  const input = $("ttsVoice");
  input.placeholder =
    kind === "clip"
      ? engine === "qwen3"
        ? "vuoto = voce italiana inclusa; «italiano» = maschile; o un file audio (10-20 s)"
        : "percorso di un file audio (10-20 s di voce pulita)"
      : kind === "description"
        ? DEFAULT_VOICE_DESCRIPTION
        : kind === "trained"
          ? "la voce dell'addestramento"
          : "nome della voce";
  input.disabled = kind === "trained";
  $<HTMLButtonElement>("pickVoice").hidden = kind !== "clip";
}

function onTtsEngineChange(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  ttsChoices(TTS_MODELS[engine][0].id, defaultVoice(engine, TTS_MODELS[engine][0].id));
}

function onTtsModelChange(): void {
  const engine = $<HTMLSelectElement>("ttsEngine").value as TtsEngine;
  const kind = voiceKind(engine, $<HTMLSelectElement>("ttsModel").value);
  const voice = $("ttsVoice");
  if (kind === "description" && !voice.value.includes(" ")) voice.value = DEFAULT_VOICE_DESCRIPTION;
  if (kind === "speaker" && !TTS_VOICES[engine].includes(voice.value)) voice.value = TTS_VOICES[engine][0];
  if (kind === "trained") voice.value = "";
  if (kind === "clip" && !/[\\/.]/.test(voice.value) && !BUNDLED_VOICES.includes(voice.value.trim().toLowerCase()) && engine === "qwen3") voice.value = "";
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
    setup: "da installare: intanto Lumi funziona in modalità testo",
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

/** The phone tab: server state, the call, paired phones. */
function renderPhone(next: SettingsSnapshot): void {
  const p = next.phone;
  $<HTMLElement>("phoneStatus").textContent = !next.settings.phone.enabled
    ? "Spento."
    : !p.listening
      ? "La porta non si apre: forse è usata da un altro programma, prova un altro numero."
      : p.call === "active"
        ? `In chiamata: Lumi è sul telefono «${p.phoneName}».`
        : `In ascolto sulla porta ${next.settings.phone.port}.`;
  listItems(
    "phones",
    p.devices.map((d) => ({
      tag: d.lastSeen ? `visto ${new Date(d.lastSeen).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "mai collegato",
      text: d.name,
      action: () => void api.phoneRevoke(d.id).then(fill),
      actionLabel: "Rimuovi",
    })),
    "Nessun telefono abbinato.",
  );
}

$<HTMLButtonElement>("phonePair").addEventListener("click", async () => {
  await save(false);
  const r = await api.phonePair();
  $<HTMLElement>("phoneQrBox").hidden = !r.ok;
  if (r.ok) {
    $<HTMLImageElement>("phoneQr").src = r.qr;
    $<HTMLElement>("phoneLink").textContent = `Indirizzi del PC: ${r.hosts.join(", ") || "nessuno"}. Link: ${r.url}`;
  }
  setStatus(r.message);
});

/** One slider per mood; the output shows its chance with the current weights. */
function buildMoodWeights(): void {
  $("moodWeights").replaceChildren(
    ...DAY_MOODS.map((m) => {
      const label = Object.assign(document.createElement("label"), { className: "field" });
      const span = document.createElement("span");
      span.append(`${MOOD_LABEL[m]} `, Object.assign(document.createElement("output"), { id: `moodOut-${m}` }));
      const input = Object.assign(document.createElement("input"), { id: `mood-${m}`, type: "range", min: "0", max: "10", step: "1" });
      input.addEventListener("input", moodChances);
      label.append(span, input);
      return label;
    }),
  );
}
buildMoodWeights();

function moodWeights(): MoodWeights {
  return Object.fromEntries(DAY_MOODS.map((m) => [m, Number($(`mood-${m}`).value) || 0])) as MoodWeights;
}

function moodChances(): void {
  const w = moodWeights();
  const total = DAY_MOODS.reduce((sum, m) => sum + w[m], 0);
  for (const m of DAY_MOODS) $<HTMLOutputElement>(`moodOut-${m}`).textContent = total ? `${Math.round((w[m] / total) * 100)}%` : "-";
}

const moodName = (m: DayMoodId) => MOOD_LABEL[m].toLowerCase();

function renderDayMood(next: SettingsSnapshot): void {
  const m = next.dayMood;
  const time = (iso: string) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  if (!m) {
    $<HTMLElement>("moodToday").textContent = "Spento: Lumi è sempre del suo umore tranquillo.";
    return;
  }
  const strength = (i: number) => (i >= 0.75 ? "molto" : i > 0.5 ? "abbastanza" : "un po'");
  const story = m.changes.length
    ? ` Si è svegliata ${moodName(m.rolled)}, poi: ${m.changes.map((c) => `${time(c.at)} ${strength(c.intensity)} ${moodName(c.to)}`).join(", ")}.`
    : "";
  $<HTMLElement>("moodToday").textContent = `Oggi è ${strength(m.intensity)} ${moodName(m.mood)} (dalle ${time(m.since)}).${story}`;
}

$("face3d").addEventListener("change", () => ($<HTMLElement>("face3dOptions").hidden = !$("face3d").checked));
$<HTMLButtonElement>("pickModel").addEventListener("click", async () => {
  const path = await api.pickModelFile();
  if (path) $("faceModel").value = path;
});

$<HTMLButtonElement>("consolidate").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("consolidate");
  const status = $<HTMLElement>("consolidateStatus");
  button.disabled = true;
  status.textContent = "Sto consolidando… con un modello locale può volerci qualche minuto.";
  try {
    const r = await api.consolidateMemory();
    fill(r.snapshot);
    status.textContent = r.message;
  } catch (err) {
    status.textContent = `Errore: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    button.disabled = false;
  }
});

$<HTMLButtonElement>("moodReroll").addEventListener("click", async () => {
  await save(false);
  fill(await api.rerollMood());
  setStatus("Nuovo umore estratto ✓");
});

/** The habits found, each with its buttons: do it yourself / ask first, forget. */
function renderHabits(next: SettingsSnapshot): void {
  const list = $<HTMLUListElement>("habits");
  if (!next.habits.length) {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "Nessuna abitudine ancora: servono alcune settimane di uso." }));
    return;
  }
  list.replaceChildren(
    ...next.habits.map((h) => {
      const li = document.createElement("li");
      const tag = Object.assign(document.createElement("span"), {
        className: "tag",
        textContent: h.status === "archived" ? "archiviata" : `${Math.round(h.confidence * 100)}%${h.auto ? " · da sola" : ""}`,
      });
      const text = Object.assign(document.createElement("span"), { className: "text", textContent: `${h.name} (sì ${h.accepted}, no ${h.rejected})` });
      const toggle = Object.assign(document.createElement("button"), { type: "button", textContent: h.auto ? "Chiedi prima" : "Fai da sola" });
      toggle.addEventListener("click", () => void api.habit(h.id, h.auto ? "ask" : "auto").then(fill));
      const forget = Object.assign(document.createElement("button"), { type: "button", textContent: "Dimentica" });
      forget.addEventListener("click", () => void api.habit(h.id, "forget").then(fill));
      li.append(tag, text, toggle, forget);
      return li;
    }),
  );
}

const PC_TOOL_LABEL: Record<string, string> = { open: "apri", window: "finestra", media: "musica", find_files: "cerca file", trash_file: "cestino" };
const PC_ACTION_LABEL: Record<string, string> = {
  focus: "in primo piano",
  minimize: "riduci",
  maximize: "ingrandisci",
  restore: "ripristina",
  close: "chiudi",
  play_pause: "play/pausa",
  next: "traccia successiva",
  previous: "traccia precedente",
  volume_up: "volume su",
  volume_down: "volume giù",
  mute: "muto",
};
const PC_OUTCOME_LABEL: Record<string, string> = {
  done: "fatto",
  refused: "rifiutato",
  declined: "hai detto no",
  unanswered: "nessuna risposta",
  failed: "non riuscito",
  not_found: "non trovato",
  ambiguous: "ambiguo",
  stopped: "fermato",
};

/** Using the PC: the index and the latest actions (actions.jsonl). */
function renderPc(next: SettingsSnapshot): void {
  const { apps, games } = next.pc;
  $<HTMLElement>("pcIndex").textContent = next.settings.pc.enabled
    ? apps + games
      ? `Lumi conosce ${apps} app del menu Start e ${games} giochi di Steam (l'elenco si aggiorna ogni ora).`
      : "Sto leggendo le app del menu Start e i giochi di Steam..."
    : "";
  listItems(
    "pcActions",
    next.pc.actions.map((a) => ({
      tag: new Date(a.at).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      text: `${[PC_TOOL_LABEL[a.tool] ?? a.tool, a.action ? (PC_ACTION_LABEL[a.action] ?? a.action) : "", a.target].filter(Boolean).join(" · ")}: ${PC_OUTCOME_LABEL[a.outcome] ?? a.outcome}${a.confirmed ? " (confermato)" : ""}`,
    })),
    "Nessuna azione ancora.",
  );
}

/** The embedding queue's state, in words. */
/** What the sidecar's status for an app means for the person looking at the settings. */
function appAudioText(app: string, state: string): string {
  switch (state) {
    case "chiusa":
      return `${app} non è aperta su questo PC (se la usi dal browser, scrivi il nome del browser nell'elenco, per esempio chrome o opera)`;
    case "in ascolto":
      return `${app} in ascolto`;
    case "in ascolto, silenzio":
      return `${app} in ascolto, ma non arriva suono (nessuno parla?)`;
    default:
      return `${app} ${state}`;
  }
}

/** The model field is Ollama's: the CPU one is fixed (bge-m3 int8). */
function embeddingModelField(): void {
  const provider = $<HTMLSelectElement>("embeddingProvider").value;
  $("embeddingModel").disabled = provider === "sidecar" || provider === "none";
}

function where(status: NonNullable<SettingsSnapshot["memoryIndex"]>): string {
  return status.source === "sidecar" ? " sul processore" : status.source === "ollama" ? " in Ollama" : "";
}

function memoryIndexText(status: SettingsSnapshot["memoryIndex"], model: string): string {
  if (!status) return "";
  const count = `${status.done} ricordi su ${status.total} hanno il loro indice.`;
  switch (status.state) {
    case "off":
      return "Ricerca solo per parole.";
    case "unavailable":
      return "La ricerca per significato non è disponibile (sqlite-vec non si carica): restano le parole.";
    case "missing":
      return `Ollama non ha il modello ${model}: scaricalo con "ollama pull ${model}". Intanto la ricerca usa le parole.`;
    case "offline":
      return status.source === "sidecar"
        ? "Il motore vocale non è avviato: la ricerca usa le parole finché non torna."
        : "Ollama non risponde: la ricerca usa le parole finché non torna.";
    case "error":
      return `Problema con gli embedding: ${status.detail ?? "dettagli nel log"}.`;
    case "indexing":
    case "waiting":
      return `Sto indicizzando i ricordi con ${status.model}${where(status)} (quando Lumi non parla). ${count}`;
    default:
      return `Ricerca per significato attiva con ${status.model}${where(status)}. ${count}`;
  }
}

function listItems(id: string, items: { tag: string; text: string; action?: () => void; actionLabel?: string }[], empty: string): void {
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
        button.textContent = item.actionLabel ?? "Dimentica";
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
  renderSetup(next.setup);
  $("userName").value = s.userName;
  $<HTMLTextAreaElement>("personality").value = s.personality;
  $<HTMLSelectElement>("sociability").value = s.sociability;
  $("doNotDisturb").checked = s.doNotDisturb;
  $("muted").checked = s.muted;
  $("subtitles").checked = s.face.subtitles;
  $("adaptiveShadow").checked = s.face.adaptiveShadow;
  $("glare").checked = s.face.glare;
  $("moveEnabled").checked = s.movement.enabled;
  $("moveInitiative").checked = s.movement.initiative;
  $("movePranks").checked = s.movement.pranks;
  $("moveDodge").checked = s.movement.dodge;
  $("face3d").checked = s.face.mode === "3d";
  $("faceModel").value = s.face.model;
  $<HTMLElement>("face3dOptions").hidden = s.face.mode !== "3d";
  $("idleEnabled").checked = s.face.idle.enabled;
  $("idleAfter").value = String(s.face.idle.afterMinutes);
  $<HTMLElement>("avatarIdles").textContent = next.avatarClips.idles.length
    ? `Routine trovate: ${next.avatarClips.idles.join(", ")}. Camminata e banco spostano Lumi: servono gli spostamenti di sua iniziativa.`
    : `Nessuna routine per ora: si creano con sidecar/motion (vedi il suo README) e vanno in ${next.avatarClips.dir}\\idle\\<nome>.`;
  $<HTMLElement>("avatarClips").textContent = `Gesti in più: metti dei file Mixamo .fbx (scaricati "Without Skin") o .vrma in ${next.avatarClips.dir}, con il nome del gesto ("wave.fbx" sostituisce il saluto incluso, "dance.fbx" ne aggiunge uno nuovo). ${next.avatarClips.names.length ? `Trovati: ${next.avatarClips.names.join(", ")}.` : "Per ora nessuno: usa i gesti inclusi."}`;
  $("moodEnabled").checked = s.mood.enabled;
  for (const m of DAY_MOODS) $(`mood-${m}`).value = String(s.mood.weights[m]);
  moodChances();
  renderDayMood(next);
  $("showInCaptures").checked = s.face.showInCaptures;
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
  const appNotes = [
    appStatus.length ? `Adesso: ${appStatus.map(([app, state]) => appAudioText(app, state)).join("; ")}.` : "",
    // Without voiceprints every friend is "Qualcuno su Discord"
    s.appAudio.enabled && !s.voices.enabled ? "Per distinguere chi parla attiva «Riconosci le voci» più sopra." : "",
  ].filter(Boolean);
  $<HTMLElement>("appAudioStatus").textContent = appNotes.join(" ");
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
  $("addressCheck").checked = s.listen.addressCheck;
  void renderMicDevices(s.listen.micDevice);
  $<HTMLSelectElement>("sttEngine").value = s.stt.engine;
  $("sttModel").value = s.stt.model;
  $<HTMLSelectElement>("sttDevice").value = s.stt.device;
  $("vocabulary").value = s.stt.vocabulary.join(", ");
  sttModels();
  $<HTMLSelectElement>("ttsEngine").value = s.tts.engine;
  ttsChoices(s.tts.model, s.tts.voice);
  $("speed").value = String(s.tts.speed);
  $("pitch").value = String(s.tts.pitch);
  $("volume").value = String(s.tts.volume);
  $("seed").value = String(s.tts.seed);
  $<HTMLTextAreaElement>("pronunciations").value = s.tts.pronunciations.join("\n");
  $<HTMLSelectElement>("webProvider").value = s.web.provider;
  $("searxngUrl").value = s.web.searxngUrl;
  $("backupDays").value = String(s.memory.backupDays);
  $("habitsEnabled").checked = s.habits.enabled;
  $("phoneEnabled").checked = s.phone.enabled;
  $("phonePort").value = String(s.phone.port);
  renderPhone(next);
  renderHabits(next);
  $("pcEnabled").checked = s.pc.enabled;
  $<HTMLTextAreaElement>("pcTrustedApps").value = s.pc.trustedApps.join("\n");
  renderPc(next);
  $<HTMLSelectElement>("embeddingProvider").value = s.memory.embeddings.provider;
  $("embeddingModel").value = s.memory.embeddings.model;
  embeddingModelField();
  $<HTMLElement>("memoryIndex").textContent = memoryIndexText(next.memoryIndex, s.memory.embeddings.model);

  $("perceptionEnabled").checked = s.perception.enabled;
  $<HTMLSelectElement>("ocr").value = s.perception.ocr;
  $("captureFps").value = String(s.perception.captureFps);
  $("ocrFps").value = String(s.perception.ocrFps);
  $("uia").checked = s.perception.uia;
  $<HTMLSelectElement>("sendScreenshots").value = s.perception.sendScreenshots;
  $<HTMLSelectElement>("localVisionProvider").value = s.vision.provider;
  $("localVisionModel").value = s.vision.model;
  $<HTMLTextAreaElement>("pauseInApps").value = s.perception.pauseInApps.join("\n");

  for (const id of ["scale", "followUpSeconds", "pauseMs", "wakeThreshold", "speed", "pitch", "volume", "captureFps", "ocrFps"]) $(id).dispatchEvent(new Event("input"));

  listItems(
    "facts",
    [...next.facts]
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.createdAt.localeCompare(a.createdAt))
      .map((f) => ({ tag: `${KIND_LABEL[f.kind] ?? f.kind}${f.importance ? ` · ${f.importance}` : ""}`, text: f.text, action: () => void api.forgetMemory(f.id).then(fill) })),
    "Non ricorda ancora niente di te.",
  );
  listItems(
    "reminders",
    next.reminders.map((r) => ({ tag: new Date(r.dueAt).toLocaleString("it-IT", { weekday: "short", hour: "2-digit", minute: "2-digit" }), text: r.text, action: () => void api.forgetMemory(r.id).then(fill), actionLabel: "Annulla" })),
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
    face: {
      scale: num("scale", s.face.scale),
      color: $("color").value,
      subtitles: $("subtitles").checked,
      adaptiveShadow: $("adaptiveShadow").checked,
      glare: $("glare").checked,
      showInCaptures: $("showInCaptures").checked,
      mode: $("face3d").checked ? "3d" : "minimal",
      model: $("faceModel").value.trim(),
      idle: { enabled: $("idleEnabled").checked, afterMinutes: num("idleAfter", s.face.idle.afterMinutes) },
    },
    voices: { enabled: $("voicesEnabled").checked, onlyMe: $("onlyMe").checked },
    habits: { ...s.habits, enabled: $("habitsEnabled").checked },
    phone: { enabled: $("phoneEnabled").checked, port: num("phonePort", s.phone.port) },
    pc: {
      enabled: $("pcEnabled").checked,
      trustedApps: $<HTMLTextAreaElement>("pcTrustedApps")
        .value.split(/\n|,/)
        .map((a) => a.trim())
        .filter(Boolean),
    },
    mood: { enabled: $("moodEnabled").checked, weights: moodWeights() },
    movement: { enabled: $("moveEnabled").checked, initiative: $("moveInitiative").checked, pranks: $("movePranks").checked, dodge: $("moveDodge").checked },
    web: { provider: $<HTMLSelectElement>("webProvider").value as Settings["web"]["provider"], searxngUrl: $("searxngUrl").value.trim() },
    memory: {
      ...s.memory,
      backupDays: num("backupDays", s.memory.backupDays),
      embeddings: { provider: $<HTMLSelectElement>("embeddingProvider").value as Settings["memory"]["embeddings"]["provider"], model: $("embeddingModel").value.trim() },
    },
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
      addressCheck: $("addressCheck").checked,
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
      pitch: num("pitch", s.tts.pitch),
      volume: num("volume", s.tts.volume),
      seed: num("seed", s.tts.seed),
      pronunciations: $<HTMLTextAreaElement>("pronunciations")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
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
bindOutput("pitch", "pitchOut", (v) => (v === 0 ? "naturale" : `${v > 0 ? "+" : "−"}${Math.abs(v).toLocaleString("it-IT")} ${Math.abs(v) === 1 ? "semitono" : "semitoni"}${v > 0 ? " (più acuta)" : " (più grave)"}`));
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
$<HTMLSelectElement>("embeddingProvider").addEventListener("change", embeddingModelField);
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

// ---------------- forgetting ----------------

const FORGET_TYPE: Record<ForgetCandidate["type"], string> = { message: "frase", summary: "riassunto", fact: "fatto" };
const forgetList = $<HTMLUListElement>("forgetList");
const forgetConfirm = $<HTMLButtonElement>("forgetConfirm");
let forgetItems: ForgetCandidate[] = [];

function selectedForget(): { messages: number[]; summaries: number[]; facts: number[] } {
  const out = { messages: [] as number[], summaries: [] as number[], facts: [] as number[] };
  forgetList.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked").forEach((box) => {
    const item = forgetItems[Number(box.dataset.index)];
    if (item) out[item.type === "message" ? "messages" : item.type === "summary" ? "summaries" : "facts"].push(item.id);
  });
  return out;
}

function updateForgetButton(): void {
  const s = selectedForget();
  const n = s.messages.length + s.summaries.length + s.facts.length;
  forgetConfirm.disabled = n === 0;
  forgetConfirm.textContent = n ? `Dimentica i ${n} selezionati` : "Dimentica i selezionati";
}

async function searchForget(query: string): Promise<void> {
  $("forgetQuery").value = query;
  $<HTMLElement>("forgetResult").textContent = "";
  if (!query.trim()) return;
  forgetList.hidden = false;
  forgetList.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "Cerco…" }));
  forgetItems = await api.findForget(query);
  $<HTMLElement>("forgetActions").hidden = forgetItems.length === 0;
  if (!forgetItems.length) {
    forgetList.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "Lumi non ricorda niente su questo." }));
    return;
  }
  forgetList.replaceChildren(
    ...forgetItems.map((item, index) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.strong;
      box.dataset.index = String(index);
      box.addEventListener("change", updateForgetButton);
      const tag = Object.assign(document.createElement("span"), { className: "tag", textContent: `${FORGET_TYPE[item.type]} · ${item.label}` });
      const when = Object.assign(document.createElement("span"), {
        className: "when",
        textContent: new Date(item.at).toLocaleString("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      });
      const text = Object.assign(document.createElement("span"), { className: "text", textContent: item.text.length > 400 ? `${item.text.slice(0, 399)}…` : item.text });
      label.append(box, tag, when, text);
      li.append(label);
      return li;
    }),
  );
  updateForgetButton();
}

$<HTMLButtonElement>("forgetSearch").addEventListener("click", () => void searchForget($("forgetQuery").value));
$("forgetQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void searchForget($("forgetQuery").value);
});
forgetConfirm.addEventListener("click", async () => {
  const selection = selectedForget();
  const n = selection.messages.length + selection.summaries.length + selection.facts.length;
  if (!n || !window.confirm(`Lumi dimenticherà ${n} ricordi e ciò che dipende solo da loro. Non si può annullare. Continuo?`)) return;
  forgetConfirm.disabled = true;
  forgetConfirm.textContent = "Sto dimenticando…";
  const result = await api.forgetItems(selection);
  fill(result.snapshot);
  forgetItems = [];
  forgetList.hidden = true;
  $<HTMLElement>("forgetActions").hidden = !result.message;
  forgetConfirm.hidden = true;
  $<HTMLElement>("forgetResult").textContent = result.message;
  setStatus(result.ok ? "Fatto: ricordi dimenticati." : "Non sono riuscito a dimenticare.");
  window.setTimeout(() => (forgetConfirm.hidden = false), 100);
});
api.onRefresh(() => {
  void api.load().then((next) => {
    fill(next);
    if (next.phone.devices.length) $<HTMLElement>("phoneQrBox").hidden = true;
    setStatus("Telefono abbinato.");
  });
});
api.onForgetQuery((query) => {
  showTab("memory");
  void searchForget(query);
});

$<HTMLButtonElement>("runtimeInstall").addEventListener("click", async () => {
  $<HTMLButtonElement>("runtimeInstall").disabled = true;
  fill(await api.installRuntime());
});

api.onSetup((state) => {
  if (snapshot) snapshot = { ...snapshot, setup: state };
  renderSetup(state);
});

api.onStatus((status) => {
  if (snapshot) snapshot = { ...snapshot, sidecar: status };
  renderStatus(status);
});

void api.load().then(fill);
