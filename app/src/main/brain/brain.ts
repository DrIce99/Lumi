// Lumi's mind: turns events into requests to the chosen AI service, runs the
// tools the model calls (speech, gaze, screen, memory, reminders) and
// streams what it says to the voice (or to a bubble in text mode).
//
// Each moment is a fresh request: a stable system prompt plus one user
// message carrying the situation, the screen, memory and recent
// conversation. Within a moment the loop only continues after
// look_at_screen, whose screenshot the model needs to see.
import type { Emotion } from "../../shared/emotions";
import { PROVIDERS } from "../../shared/providers";
import { FACT_KINDS, type FactKind, type Settings } from "../../shared/types";
import { log } from "../log";
import { RECENT_LINES, speakerLabel, type ConversationEntry, type Memory } from "./memory";
import { buildContext, buildSystemPrompt, type Situation, type Trigger } from "./prompt";
import { ProviderError, type ChatProvider, type LiveSay, type MomentSession, type ToolCallOut, type ToolResultIn } from "./providers/types";
import { parseToolCall, type LookRegion, type ToolCall } from "./tools";

export interface LookResult {
  notes: string[];
  images: { label: string; jpegBase64: string }[];
}

/** A validated say call. */
export interface SayCall {
  text: string;
  emotion: Emotion;
  intensity: number;
  look?: string;
}

/** Where one moment's speech goes: the voice, or a bubble. */
export interface SpeechSink {
  /** Every say call written so far, the last one possibly still growing. */
  live(says: LiveSay[]): void;
  /** The reply is complete: these are all its say calls. */
  final(says: SayCall[]): void;
  /** Resolves once everything was spoken or interrupted, with what the user actually heard. */
  done(): Promise<{ text: string; interrupted: boolean }>;
  /** Stops talking at once (barge-in, a new message). */
  abort(): void;
}

export type Purpose = "chat" | "idle";

export interface BrainHost {
  settings(): Settings;
  readonly memory: Memory;
  /** The service and model configured for a purpose, or null when none is usable. */
  provider(purpose: Purpose): { provider: ChatProvider; model: string } | null;
  situation(): Situation;
  startSpeech(trigger: Trigger): SpeechSink;
  /** A complete line outside a moment (errors, missing configuration). */
  say(text: string, emotion?: Emotion): void;
  setThinking(thinking: boolean): void;
  /** Moves the eyes to visible text or a region; returns what happened, for the model. */
  lookAt(target: { text?: string; region?: LookRegion }): string;
  lookAtScreen(focus: string | undefined, requestedByUser: boolean): Promise<LookResult>;
  /** The model chose silence; `minutes` delays the next autonomous moment. */
  quiet(minutes: number | undefined): void;
  /** Delays autonomous moments after rate limits and outages. */
  backOff(minutes: number): void;
  /** Names a recognized voice; returns what happened, for the model. */
  nameVoice?(voice: string, name: string): string;
}

const MAX_ROUNDS = 4;
/** Facts an episode summary may add at once (a small model can get carried away). */
const MAX_EPISODE_FACTS = 4;

const EPISODE_SYSTEM = `You keep the long-term memory of Lumi, a voice assistant that lives on the user's screen.
You get a stretch of conversation. Reply with only a JSON object:
{"summary": "...", "facts": [{"fact": "...", "kind": "user|work|preference|event"}]}
- summary: Italian, two to four short sentences in first person as Lumi, calling the user by name: what was talked about, decided, asked or promised, with names, places and dates. Enough to pick the thread up again later.
- facts: durable things about the user's life worth remembering for weeks: who they are, people around them, their work and projects, tastes and habits, upcoming events with their date. Third person, one short Italian sentence each, like "Ha una sorella, Giulia, che vive a Milano.".
  Not facts: requests to you, what they asked you to do or change, opinions about you, small talk, anything sensitive (passwords, health, money). Never repeat or contradict what is already known: if the user corrected something, write the correction only when they said it clearly. Usually zero or one fact.`;

/** Reads the episode summarizer's reply; a plain-text reply is taken as the summary. */
export function parseEpisodeReply(text: string): { summary: string; facts: { fact: string; kind: FactKind }[] } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as { summary?: unknown; facts?: unknown };
      const summary = typeof o.summary === "string" ? o.summary.trim() : "";
      const facts = (Array.isArray(o.facts) ? o.facts : [])
        .map((f) => (typeof f === "string" ? { fact: f } : (f as { fact?: unknown; kind?: unknown })))
        .filter((f): f is { fact: string; kind?: unknown } => typeof f?.fact === "string" && f.fact.trim().length > 3)
        .map((f) => ({ fact: f.fact.trim(), kind: (FACT_KINDS as string[]).includes(String(f.kind)) && f.kind !== "note" ? (f.kind as FactKind) : "user" }))
        .slice(0, MAX_EPISODE_FACTS);
      if (summary) return { summary, facts };
    } catch {
      // not JSON after all
    }
  }
  return { summary: text.replace(/```\w*/g, "").trim(), facts: [] };
}

function transcript(entries: ConversationEntry[], user: string): string {
  return entries.map((e) => `${speakerLabel(e, user)}${e.via ? ` (${e.via})` : ""}: ${e.text}`).join("\n");
}

export class Brain {
  private busy = false;
  private currentIsMessage = false;
  private current: MomentSession | null = null;
  private speech: SpeechSink | null = null;
  private interrupted = false;
  private readonly queue: Trigger[] = [];
  private authFailed = false;
  private compacting = false;

  constructor(private readonly host: BrainHost) {}

  isBusy(): boolean {
    return this.busy;
  }

  isAvailable(purpose: Purpose = "idle"): boolean {
    return !this.authFailed && this.host.provider(purpose) !== null;
  }

  /** Call after keys or services change so a previous auth failure is retried. */
  credentialsChanged(): void {
    this.authFailed = false;
  }

  /** Stops the running moment: the model stream and the voice. What was already heard stays in the history. */
  interrupt(): void {
    if (!this.busy) return;
    this.interrupted = true;
    this.current?.abort();
    this.speech?.abort();
  }

  /**
   * A user message interrupts whatever is running and goes next; other
   * events are dropped while busy.
   */
  async handle(trigger: Trigger): Promise<void> {
    if (this.busy) {
      if (trigger.kind === "message") {
        this.queue.splice(0, this.queue.length, trigger);
        this.interrupt();
      }
      return;
    }
    this.busy = true;
    this.interrupted = false;
    this.currentIsMessage = trigger.kind === "message";
    try {
      await this.turn(trigger);
    } catch (err) {
      log.error("Unexpected error in a moment", err);
    } finally {
      this.busy = false;
      this.currentIsMessage = false;
      this.current = null;
      this.speech = null;
      const next = this.queue.shift();
      if (next) void this.handle(next);
      else void this.writeEpisode();
    }
  }

  /**
   * Summarizes the conversation that left the recent window into an
   * episode, picking out durable facts on the way. Runs between moments,
   * with the model for autonomous moments (usually the local one).
   */
  async writeEpisode(): Promise<void> {
    if (this.compacting) return;
    const memory = this.host.memory;
    const entries = memory.pendingEpisode();
    if (!entries) return;
    this.compacting = true;
    try {
      const user = this.host.settings().userName || "Utente";
      const chosen = this.authFailed ? null : this.host.provider("idle");
      let summary = "";
      let facts: { fact: string; kind: FactKind }[] = [];
      if (chosen) {
        const known = memory.facts().map((f) => `- ${f.text}`).join("\n") || "(nothing yet)";
        try {
          const result = await chosen.provider.complete({
            model: chosen.model,
            system: EPISODE_SYSTEM,
            prompt: `The user's name: ${user}\nAlready known about the user:\n${known}\n\nConversation (${entries[0].at.slice(0, 16)} - ${entries[entries.length - 1].at.slice(0, 16)}):\n${transcript(entries, user)}`,
          });
          ({ summary, facts } = parseEpisodeReply(result.text));
        } catch (err) {
          log.warn("Episode summary failed", err);
          return;
        }
      } else {
        // No model available: keep at least what was said to Lumi, so the window can move on
        summary = entries
          .filter((e) => e.who !== "lumi")
          .map((e) => e.text)
          .join(" / ")
          .slice(0, 600);
      }
      const episode = memory.addEpisode(entries, summary);
      for (const f of facts) memory.remember(f.fact, f.kind);
      if (episode) log.info(`Episode ${episode.id}: ${entries.length} lines summarized, ${facts.length} new facts`);
    } finally {
      this.compacting = false;
    }
  }

  /** Whether the running moment answers the user (not an autonomous one). */
  answering(): boolean {
    return this.busy && this.currentIsMessage;
  }

  /** Turns finished days of conversation into diary entries. */
  async writeDiary(): Promise<void> {
    const settings = this.host.settings();
    for (const day of this.host.memory.pendingDiaryDays()) {
      let summary = day.episodes.map((e) => e.summary).join(" ") || `Abbiamo scambiato ${day.entries.length} messaggi.`;
      const chosen = this.authFailed ? null : this.host.provider("idle");
      if (chosen && day.entries.length + day.episodes.length >= 2) {
        const user = settings.userName || "Utente";
        const earlier = day.episodes.map((e) => `(earlier, summarized) ${e.summary}`);
        const text = [...earlier, transcript(day.entries.slice(-120), user)].filter(Boolean).join("\n");
        try {
          const result = await chosen.provider.complete({
            model: chosen.model,
            system:
              "You keep the diary of Lumi, a voice assistant that lives on the user's screen. Summarize the day in Italian, in two to four short sentences written in first person as Lumi: what the user did, said or felt, and anything worth remembering tomorrow. Output only the summary.",
            prompt: `Conversation of ${day.date}:\n${text}`,
          });
          if (result.text) summary = result.text;
        } catch (err) {
          log.warn(`Diary summary for ${day.date} failed`, err);
        }
      }
      this.host.memory.addDiary(day.date, summary);
    }
  }

  private async turn(trigger: Trigger): Promise<void> {
    const host = this.host;
    const settings = host.settings();
    const isMessage = trigger.kind === "message";
    const context = buildContext({
      situation: host.situation(),
      settings,
      facts: host.memory.facts(),
      reminders: host.memory.reminders(),
      diary: host.memory.diary(),
      episodes: host.memory.recentEpisodes(),
      recalled: isMessage ? host.memory.search(trigger.text, 3, settings.userName || "Utente") : [],
      conversation: host.memory.recentConversation(RECENT_LINES),
      trigger,
    });
    if (isMessage) {
      if (trigger.speaker) host.memory.addMessage("other", trigger.text, false, { name: trigger.speaker });
      else host.memory.addMessage("user", trigger.text);
    }

    const chosen = this.authFailed ? null : host.provider(isMessage ? "chat" : "idle");
    if (!chosen) {
      if (isMessage || (trigger.kind === "startup" && trigger.firstRun)) {
        host.say(
          'Ciao, sono Lumi! Per risponderti mi serve un "cervello": clic destro sui miei occhi, poi Impostazioni, scheda Cervello. Ci sono opzioni gratuite.',
          "imbarazzo",
        );
      }
      return;
    }

    const { provider, model } = chosen;
    const session = provider.start({ model, system: buildSystemPrompt(settings), context });
    this.current = session;
    const speech = host.startSpeech(trigger);
    this.speech = speech;
    const says: SayCall[] = [];
    let nudged = false;
    let thinking = isMessage;

    if (isMessage) host.setThinking(true);
    try {
      for (let round = 0; round < MAX_ROUNDS && !this.interrupted; round++) {
        const prior: LiveSay[] = says.map((s) => ({ ...s, complete: true }));
        const onLive = (live: LiveSay[]) => {
          if (thinking && live.some((s) => s.text)) {
            thinking = false;
            host.setThinking(false);
          }
          speech.live([...prior, ...live]);
        };
        const result = await session.next(onLive);
        if (result.usage) log.info(`${provider.id}/${model}: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out`);
        if (result.stop === "refused") {
          if (isMessage && !says.length) says.push({ text: "Mmh, su questo preferisco non rispondere.", emotion: "imbarazzo", intensity: 0.5 });
          break;
        }
        if (result.stop === "length" && result.toolCalls.length) {
          // A cut-off tool input can still look valid: run nothing but the speech
          log.warn("Reply cut at the token limit with tool calls; keeping only the speech");
          for (const call of result.toolCalls) {
            const parsed = call.name === "say" ? parseToolCall(call.name, call.input) : null;
            if (parsed?.name === "say") says.push(toSay(parsed));
          }
          break;
        }
        const ran = await this.runTools(result.toolCalls, says, isMessage);
        // Plain text counts as speech only when answering: some open models
        // reply in text instead of calling say, but in autonomous moments
        // that text is often just their reasoning.
        if (!ran.said && isMessage && result.text) says.push({ text: result.text, emotion: "neutra", intensity: 0.6 });
        speech.live(says.map((s) => ({ ...s, complete: true })));
        if (!ran.followUp) {
          // Small models sometimes only act after a message: give them one more round to answer
          if (!isMessage || says.length || !ran.results.length || nudged) break;
          nudged = true;
          const last = ran.results[ran.results.length - 1];
          last.text = [last.text, "The user is still waiting for an answer: reply now with say."].filter(Boolean).join(" ");
        }
        session.addResults(ran.results);
      }
    } catch (err) {
      this.reportError(err, isMessage, provider, model);
    } finally {
      if (thinking) host.setThinking(false);
    }

    speech.final(says);
    const heard = await speech.done();
    if (heard.text) host.memory.addMessage("lumi", heard.text, heard.interrupted);
  }

  private async runTools(calls: ToolCallOut[], says: SayCall[], requestedByUser: boolean): Promise<{ results: ToolResultIn[]; said: boolean; followUp: boolean }> {
    const results: ToolResultIn[] = [];
    let said = false;
    let followUp = false;
    for (const call of calls) {
      const parsed = parseToolCall(call.name, call.input);
      if (!parsed) {
        log.warn(`Invalid input for tool ${call.name}`, call.input);
        results.push({ id: call.id, name: call.name, text: JSON.stringify({ INVALID_INPUT: JSON.stringify(call.input) }), images: [], isError: true });
        continue;
      }
      if (parsed.name === "look_at_screen") followUp = true;
      if (parsed.name === "say") said = true;
      try {
        const out = await this.execute(parsed, says, requestedByUser);
        results.push({ id: call.id, name: call.name, text: out.text, images: out.images, isError: false });
      } catch (err) {
        log.error(`Tool ${parsed.name} failed`, err);
        results.push({ id: call.id, name: call.name, text: err instanceof Error ? err.message : String(err), images: [], isError: true });
      }
    }
    return { results, said, followUp };
  }

  private async execute(call: ToolCall, says: SayCall[], requestedByUser: boolean): Promise<{ text: string; images: LookResult["images"] }> {
    const memory = this.host.memory;
    const done = (text: string) => ({ text, images: [] });
    switch (call.name) {
      case "say":
        says.push(toSay(call));
        return done("Said.");
      case "look_at":
        return done(this.host.lookAt({ text: call.text, region: call.region }));
      case "look_at_screen": {
        const look = await this.host.lookAtScreen(call.focus, requestedByUser);
        return { text: look.notes.join("\n") || (look.images.length ? "" : "Nothing to show."), images: look.images };
      }
      case "remember":
        return done(`Saved as [${memory.remember(call.fact, call.kind).id}].`);
      case "forget":
        return done(memory.forget(call.id) ? `Forgot [${call.id}].` : `There is no memory with id ${call.id}.`);
      case "recall": {
        const hits = memory.search(call.query, 5, this.host.settings().userName || "Utente");
        if (!hits.length) return done("Nothing found in your memory about that.");
        return done(hits.map((h) => `[${h.doc.at.slice(0, 16).replace("T", " ")}] ${h.doc.text}`).join("\n---\n"));
      }
      case "set_reminder": {
        const reminder = memory.addReminder(call.text, call.due);
        return done(`Reminder [${reminder.id}] set for ${call.due.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`);
      }
      case "name_voice":
        return done(this.host.nameVoice ? this.host.nameVoice(call.voice, call.person) : "You can't recognize voices now.");
      case "stay_quiet":
        this.host.quiet(call.minutes);
        return done("Staying quiet.");
    }
  }

  private reportError(err: unknown, isMessage: boolean, provider: ChatProvider, model: string): void {
    const e = err instanceof ProviderError ? err : new ProviderError("unknown", err instanceof Error ? err.message : String(err), err);
    if (e.kind === "aborted" || this.interrupted) {
      log.info("Moment interrupted");
      return;
    }
    log.error(`Request to ${provider.id} (${model}) failed`, e.cause ?? e);
    const service = PROVIDERS[provider.id].name;
    const ollama = provider.id === "ollama";
    let line: string;
    switch (e.kind) {
      case "auth":
        this.authFailed = true;
        line = `La chiave di ${service} non viene accettata. Controllala nelle impostazioni.`;
        break;
      case "permission":
        line = `La chiave di ${service} non può usare il modello ${model}: prova un altro modello nelle impostazioni.`;
        break;
      case "not_found":
        line = ollama
          ? `Ollama non ha il modello ${model}: scaricalo con ollama pull, oppure scegline un altro nelle impostazioni.`
          : `Il modello ${model} non esiste su ${service}: scegline un altro nelle impostazioni.`;
        break;
      case "rate_limit":
        this.host.backOff(10);
        line = "Ho fatto troppe richieste tutte insieme: riprova tra un attimo.";
        break;
      case "overloaded":
        this.host.backOff(5);
        line = ollama ? "Ollama ci mette troppo a rispondere: forse il modello è troppo pesante per questo PC." : `${service} non risponde, forse è sovraccarico.`;
        break;
      case "connection":
        this.host.backOff(5);
        line = ollama
          ? "Non riesco a parlare con Ollama: è avviato?"
          : e.certificate
            ? `La rete non si fida del certificato di ${service}: i dettagli sono nel log.`
            : "Non riesco a collegarmi a internet.";
        break;
      case "bad_request":
        line = "Ho avuto un problema tecnico con la richiesta: i dettagli sono nel log.";
        break;
      default:
        line = "Qualcosa è andato storto: i dettagli sono nel log.";
    }
    if (isMessage || e.kind === "auth") this.host.say(line, "tristezza");
  }
}

function toSay(call: Extract<ToolCall, { name: "say" }>): SayCall {
  return { text: call.text, emotion: call.emotion, intensity: call.intensity, ...(call.look ? { look: call.look } : {}) };
}
