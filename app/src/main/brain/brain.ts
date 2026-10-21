// Lumi's mind: turns events into requests to the chosen AI service, runs the
// tools the model calls (speech, gaze, screen, memory, reminders) and
// streams what it says to the voice (or to a bubble in text mode).
//
// Each moment is a fresh request: a stable system prompt plus one user
// message carrying the situation, the screen, memory and recent
// conversation. Within a moment the loop continues after the tools that
// bring something back (look_at_screen, searches) and after actions on the
// PC (phase 16), whose verified result the model needs to go on: those get
// a budget of steps and time per request.
import { guessEmotion, type Emotion } from "../../shared/emotions";
import { PROVIDERS } from "../../shared/providers";
import type { DayMoodId } from "../../shared/dayMood";
import { FACT_KINDS, type FactKind, type Settings } from "../../shared/types";
import { log } from "../log";
import { ADDRESSING_SYSTEM, addressingPrompt, parseAddressingReply, THREAD_MAX_SECONDS, type Opened } from "../voice/addressing";
import { PROMISES, readIntents } from "./intents";
import { describeHit, factFromRow, importanceOf, RECENT_LINES, speakerLabel, type ConversationEntry, type Memory, type RewriteMaterial, type SummaryRecord } from "./memory";
import { buildContext, buildSystemPrompt, messageForHistory, type Situation, type Trigger } from "./prompt";
import { ProviderError, type ChatProvider, type LiveSay, type MomentSession, type ToolCallOut, type ToolResultIn } from "./providers/types";
import { isPcCall, parseToolCall, PC_TOOLS, type LookRegion, type PcCall, type ToolCall } from "./tools";

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
  /** A body gesture with the first sentence (shared/gestures.ts). */
  gesture?: string;
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
  /** Flies the face somewhere (move_to); `requested`: the user asked in this moment. Returns what happened, for the model. */
  moveTo?(call: Extract<ToolCall, { name: "move_to" }>, requested: boolean): string | Promise<string>;
  /** The text on screen now (local OCR of the active window or its display), or null when perception is off or paused. */
  readScreen?(): Promise<{ label: string; text: string } | null>;
  /** Opens the forget list for `query`: the user chooses and confirms there. Returns what happened, for the model. */
  openForget?(query: string): string;
  /** change_mood: `byUser` = a message moment (autonomous moments can't change the mood). Returns what happened, for the model. */
  changeMood?(mood: DayMoodId, reason: string, byUser: boolean): string;
  /** Web search and page reading; return what the model reads. */
  webSearch?(query: string): Promise<string>;
  readPage?(url: string): Promise<string>;
  /** Acts on the PC through the policy (main/pc/actions.ts); `first`: the moment's first action. Returns what happened, verified, for the model. */
  pc?(call: PcCall, context: { requested: boolean; first: boolean }): Promise<string>;
}

const MAX_ROUNDS = 4;
/** A sentence that waits longer than this for the "is it for me?" check is judged without the model. */
const ADDRESSING_TIMEOUT_MS = 1500;
const FOLLOW_UP = new Set<string>(["look_at_screen", "search_memory", "web_search", "read_page", ...PC_TOOLS]);
/** Actions on the PC per request, and the time they may take from the first one (roadmap 16). */
const PC_MAX_STEPS = 12;
const PC_MAX_MS = 60_000;
/** Rounds once the PC is involved: one per step, plus the answer. */
const PC_MAX_ROUNDS = PC_MAX_STEPS + 2;

/** The PC actions of one moment. */
interface PcBudget {
  steps: number;
  startedAt: number;
}
/** search_memory results per call, and characters per result. */
const MEMORY_RESULTS = 6;
const MEMORY_HIT_CHARS = 700;
/** Facts an episode summary may add at once (a small model can get carried away). */
const MAX_EPISODE_FACTS = 4;

const EPISODE_SYSTEM = `You keep the long-term memory of Lumi, a voice assistant that lives on the user's screen.
You get a stretch of conversation. Reply with only a JSON object:
{"summary": "...", "facts": [{"fact": "...", "kind": "user|work|preference|event", "importance": 1-10, "replaces": "f12"}]}
- summary: Italian, two to four short sentences in first person as Lumi, calling the user by name: what was talked about, decided, asked or promised, with names, places and dates. Enough to pick the thread up again later.
- facts: durable things about the user's life worth remembering for weeks: who they are, people around them, their work and projects, tastes and habits, upcoming events with their date. Third person, one short Italian sentence each, like "Ha una sorella, Giulia, che vive a Milano.".
  Not facts: requests to you, what they asked you to do or change, opinions about you, small talk, anything sensitive (passwords, health, money). Never repeat what is already known. Usually zero or one fact.
- importance: 9-10 who they are and the people closest to them (name, family, partner, where they live, their job); 6-8 projects, strong and lasting preferences, important upcoming events; 3-5 small tastes and details.
- replaces: only when the new fact corrects or updates a known one (they moved, changed job, a date changed): the known fact's id, e.g. "f12". Write the correction only when the user said it clearly.`;

const PERIOD_SYSTEM = `You keep the diary of Lumi, a voice assistant that lives on the user's screen. You get the diary days of a week or a month. Summarize the period in Italian, in three to six short sentences written in first person as Lumi: what the user worked on, what happened, the people and events that mattered, how they were; with dates when useful. Output only the summary.`;

/** Reads the episode summarizer's reply; a plain-text reply is taken as the summary. */
export interface ExtractedFact {
  fact: string;
  kind: FactKind;
  importance?: number;
  replaces?: string;
}

export function parseEpisodeReply(text: string): { summary: string; facts: ExtractedFact[] } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as { summary?: unknown; facts?: unknown };
      const summary = typeof o.summary === "string" ? o.summary.trim() : "";
      const facts = (Array.isArray(o.facts) ? o.facts : [])
        .map((f) => (typeof f === "string" ? { fact: f } : (f as { fact?: unknown; kind?: unknown; importance?: unknown; replaces?: unknown })))
        .filter((f): f is { fact: string; kind?: unknown; importance?: unknown; replaces?: unknown } => typeof f?.fact === "string" && f.fact.trim().length > 3)
        .map((f): ExtractedFact => ({
          fact: f.fact.trim(),
          kind: (FACT_KINDS as string[]).includes(String(f.kind)) && f.kind !== "note" ? (f.kind as FactKind) : "user",
          ...(typeof f.importance === "number" && Number.isFinite(f.importance) ? { importance: Math.round(Math.min(10, Math.max(1, f.importance))) } : {}),
          ...(typeof f.replaces === "string" && /^f\d+$/.test(f.replaces.trim()) ? { replaces: f.replaces.trim() } : {}),
        }))
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
  /** Facts the episode writer found so far (consolidate() reports the new ones). */
  private factsFound = 0;

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
  async writeEpisode(): Promise<boolean> {
    if (this.compacting) return false;
    const memory = this.host.memory;
    const entries = memory.pendingEpisode();
    if (!entries) return false;
    this.compacting = true;
    try {
      const user = this.host.settings().userName || "Utente";
      const chosen = this.authFailed ? null : this.host.provider("idle");
      let summary = "";
      let facts: ExtractedFact[] = [];
      if (chosen) {
        // With their ids: a correction names the fact it replaces
        const known = (await memory.factsFor(transcript(entries, user))).map((f) => `[${f.id}] (${f.kind}, ${importanceOf(f)}) ${f.text}`).join("\n") || "(nothing yet)";
        try {
          const result = await chosen.provider.complete({
            model: chosen.model,
            system: EPISODE_SYSTEM,
            prompt: `The user's name: ${user}\nAlready known about the user:\n${known}\n\nConversation (${entries[0].at.slice(0, 16)} - ${entries[entries.length - 1].at.slice(0, 16)}):\n${transcript(entries, user)}`,
          });
          ({ summary, facts } = parseEpisodeReply(result.text));
        } catch (err) {
          log.warn("Episode summary failed", err);
          return false;
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
      const source = { from: entries[0].at, to: entries[entries.length - 1].at };
      for (const f of facts) memory.remember(f.fact, f.kind, { importance: f.importance, replaces: f.replaces, source });
      if (episode) log.info(`Episode ${episode.id}: ${entries.length} lines summarized, ${facts.length} new facts`);
      this.factsFound += facts.length;
      return episode !== null;
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Everything that consolidates the memory, now, instead of between
   * moments and every half hour (the settings' button): the conversation
   * that left the recent window into episodes (and their facts), finished
   * days into the diary, finished weeks and months into their summaries.
   */
  async consolidate(): Promise<{ episodes: number; facts: number; days: number; periods: number }> {
    const facts = this.factsFound;
    let episodes = 0;
    // A long backlog is summarized a window at a time
    for (let i = 0; i < 50 && (await this.writeEpisode()); i++) episodes++;
    const { days, periods } = await this.writeDiary();
    return { episodes, facts: this.factsFound - facts, days, periods };
  }

  /** Whether the running moment answers the user (not an autonomous one). */
  answering(): boolean {
    return this.busy && this.currentIsMessage;
  }

  /**
   * Reads a heard sentence and says whether the user meant it for Lumi
   * (true), someone else or nobody (false); null when no model answered in
   * time. A tiny request with the last lines of conversation, not the whole
   * prompt: the cheap model for autonomous moments is enough.
   */
  async isAddressed(text: string, context: { inCall: boolean; opened: Opened; othersHeard?: boolean | null }, timeoutMs = ADDRESSING_TIMEOUT_MS): Promise<boolean | null> {
    const chosen = this.authFailed ? null : (this.host.provider("idle") ?? this.host.provider("chat"));
    if (!chosen) return null;
    const user = this.host.settings().userName || "Utente";
    const now = Date.now();
    // The last lines of the exchange with their age: a sentence may pick up a thread from a minute ago
    const recent = this.host.memory
      .recentConversation(6)
      .filter((e) => now - Date.parse(e.at) <= THREAD_MAX_SECONDS * 1000);
    const lastLumi = [...recent].reverse().find((e) => e.who === "lumi");
    const prompt = addressingPrompt({
      text,
      conversation: recent.map((e) => `${speakerLabel(e, user)} (${Math.max(0, Math.round((now - Date.parse(e.at)) / 1000))} s ago): ${e.text.slice(0, 200)}`),
      lumiAgo: lastLumi ? (now - Date.parse(lastLumi.at)) / 1000 : null,
      inCall: context.inCall,
      othersHeard: context.othersHeard ?? null,
      opened: context.opened,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        chosen.provider.complete({ model: chosen.model, system: ADDRESSING_SYSTEM, prompt, maxTokens: 60 }).then((r) => parseAddressingReply(r.text)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      return answer;
    } catch (err) {
      log.warn("Checking whether a sentence was for Lumi failed", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turns finished days of conversation into diary entries. */
  async writeDiary(): Promise<{ days: number; periods: number }> {
    const settings = this.host.settings();
    let days = 0;
    for (const day of await this.host.memory.pendingDiaryDays()) {
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
      days++;
    }
    return { days, periods: await this.writePeriods() };
  }

  /** Weeks and months that are over get their summary, from their days (a few at a time). */
  async writePeriods(): Promise<number> {
    const memory = this.host.memory;
    const chosen = this.authFailed ? null : this.host.provider("idle");
    if (!chosen) return 0;
    let written = 0;
    for (const span of await memory.duePeriods()) {
      const days = await memory.daysIn(span.start, span.end);
      if (!days.length) continue;
      // A month has up to 31 days: each one is clipped so small models get it all
      const clip = span.kind === "month" ? 350 : 900;
      const text = days.map((d) => `${d.start.slice(0, 10)}: ${d.text.length > clip ? `${d.text.slice(0, clip - 1)}…` : d.text}`).join("\n");
      try {
        const result = await chosen.provider.complete({ model: chosen.model, system: PERIOD_SYSTEM, prompt: `Diary of ${span.label}:\n${text}` });
        if (result.text.trim()) {
          memory.addPeriodSummary(span, result.text);
          log.info(`Summary of ${span.label} written`);
          written++;
        }
      } catch (err) {
        log.warn(`Summary of ${span.label} failed`, err);
        return written;
      }
    }
    return written;
  }

  /**
   * After a forget, a summary that cited deleted things is written again
   * from what is left (with the idle model); null when there is no model:
   * the summary is then deleted.
   */
  async rewriteSummary(summary: SummaryRecord, material: RewriteMaterial): Promise<string | null> {
    const chosen = this.authFailed ? null : this.host.provider("idle");
    if (!chosen) return null;
    const user = this.host.settings().userName || "Utente";
    const source = material.lines.length
      ? transcript(material.lines.slice(-150), user)
      : material.days.map((d) => `${d.start.slice(0, 10)}: ${d.text.slice(0, 600)}`).join("\n");
    const what = { episode: "this stretch of conversation", day: "this day", week: "this week", month: "this month" }[summary.kind];
    const result = await chosen.provider.complete({
      model: chosen.model,
      system: `You keep the diary of Lumi, a voice assistant that lives on the user's screen. Summarize ${what} in Italian, in two to five short sentences written in first person as Lumi, using only the text below. Output only the summary.`,
      prompt: source,
    });
    return result.text.trim() || null;
  }

  private async turn(trigger: Trigger): Promise<void> {
    const host = this.host;
    const settings = host.settings();
    const isMessage = trigger.kind === "message";
    // One search for the user's words: related facts go into <memory>, the rest into <recalled>
    const found = isMessage ? await host.memory.recall(trigger.text, 8) : [];
    const relatedFacts = found.flatMap((h) => (h.kind === "fact" ? [factFromRow(h.fact).id] : []));
    const facts = host.memory.promptFacts(relatedFacts);
    // The user's words mention the screen: read it now, rather than hoping the model looks
    const intents = isMessage ? readIntents(trigger.text) : { remember: false, screen: false, move: false };
    let screenNow: { label: string; text: string } | null = null;
    if (intents.screen && host.readScreen) {
      try {
        screenNow = await host.readScreen();
        if (screenNow) host.memory.addFinding("screen_now", screenNow.text, screenNow.label);
      } catch (err) {
        log.warn("Reading the screen for the message failed", err);
      }
    }
    const context = buildContext({
      situation: host.situation(),
      settings,
      facts,
      factsTotal: host.memory.facts().length,
      reminders: host.memory.reminders(),
      diary: host.memory.diary(),
      episodes: host.memory.recentEpisodes(),
      recalled: found.filter((h) => h.kind !== "fact").slice(0, 3),
      conversation: host.memory.recentConversation(RECENT_LINES),
      // What tools found earlier, except the screen just read (it is in <screen_now>)
      findings: host.memory.recentFindings().filter((f) => !(screenNow && f.source === "screen_now" && f.text === screenNow.text)),
      screenNow,
      trigger,
    });
    if (isMessage) {
      if (trigger.speaker) host.memory.addMessage("other", trigger.text, false, { name: trigger.speaker });
      else host.memory.addMessage("user", messageForHistory(trigger));
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
    const session = provider.start({ model, system: buildSystemPrompt(settings), context, ...(settings.pc.enabled ? {} : { exclude: PC_TOOLS }) });
    this.current = session;
    const speech = host.startSpeech(trigger);
    this.speech = speech;
    const says: SayCall[] = [];
    let nudged = false;
    /** Tools called in any round of this moment, and the promises already held to (once each). */
    const calledSoFar = new Set<string>();
    const heldTo = new Set<string>();
    let thinking = isMessage;
    const pc: PcBudget = { steps: 0, startedAt: 0 };

    if (isMessage) host.setThinking(true);
    try {
      for (let round = 0; round < (pc.steps ? PC_MAX_ROUNDS : MAX_ROUNDS) && !this.interrupted; round++) {
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
        const ran = await this.runTools(result.toolCalls, says, isMessage, pc);
        // Plain text counts as speech only when answering: some open models
        // reply in text instead of calling say, but in autonomous moments
        // that text is often just their reasoning.
        if (!ran.said && isMessage && result.text) says.push({ text: result.text, ...guessEmotion(result.text) });
        speech.live(says.map((s) => ({ ...s, complete: true })));
        for (const name of ran.called) calledSoFar.add(name);
        // Asked to remember or to move, and the tool wasn't called (small models just say "te lo segno", "arrivo"): one more round to do it
        const broken = PROMISES.filter((p) => intents[p.intent] && !calledSoFar.has(p.tool) && !heldTo.has(p.tool));
        if (broken.length && ran.results.length && round < (pc.steps ? PC_MAX_ROUNDS : MAX_ROUNDS) - 1) {
          for (const p of broken) heldTo.add(p.tool);
          log.info(`Asked for ${broken.map((p) => p.tool).join(", ")} but it wasn't called: one more round`);
          const last = ran.results[ran.results.length - 1];
          last.text = [last.text, ...broken.map((p) => p.nudge)].filter(Boolean).join(" ");
          session.addResults(ran.results);
          continue;
        }
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

  private async runTools(calls: ToolCallOut[], says: SayCall[], requestedByUser: boolean, pc: PcBudget): Promise<{ results: ToolResultIn[]; said: boolean; followUp: boolean; called: Set<string> }> {
    const results: ToolResultIn[] = [];
    const called = new Set<string>();
    let said = false;
    let followUp = false;
    for (const call of calls) {
      const parsed = parseToolCall(call.name, call.input);
      if (!parsed) {
        log.warn(`Invalid input for tool ${call.name}`, call.input);
        results.push({ id: call.id, name: call.name, text: JSON.stringify({ INVALID_INPUT: JSON.stringify(call.input) }), images: [], isError: true });
        continue;
      }
      // Tools that bring something back: the model needs another round to use it
      if (FOLLOW_UP.has(parsed.name)) followUp = true;
      if (parsed.name === "say") said = true;
      called.add(parsed.name);
      try {
        const out = isPcCall(parsed) ? { text: await this.actOnPc(parsed, requestedByUser, pc), images: [] } : await this.execute(parsed, says, requestedByUser);
        // A refused move must reach the model, or it goes on believing it moved
        if (parsed.name === "move_to" && /^You did NOT|^You can't/.test(out.text)) followUp = true;
        results.push({ id: call.id, name: call.name, text: out.text, images: out.images, isError: false });
      } catch (err) {
        log.error(`Tool ${parsed.name} failed`, err);
        results.push({ id: call.id, name: call.name, text: err instanceof Error ? err.message : String(err), images: [], isError: true });
      }
    }
    if (called.size) log.info(`Tools called: ${[...called].join(", ")}`);
    return { results, said, followUp, called };
  }

  /** One action on the PC, within the moment's budget of steps and time. */
  private async actOnPc(call: PcCall, requested: boolean, pc: PcBudget): Promise<string> {
    if (!this.host.pc || !this.host.settings().pc.enabled) return "You can't act on this PC: using the PC is off in the settings (tab PC). Tell the user they can turn it on there.";
    if (this.interrupted) return "You were interrupted: nothing more was done.";
    const now = Date.now();
    if (pc.steps >= PC_MAX_STEPS || (pc.startedAt && now - pc.startedAt > PC_MAX_MS)) {
      log.info(`PC budget used (${pc.steps} steps, ${Math.round((now - pc.startedAt) / 1000)} s): ${call.name} not run`);
      return `You did NOT do it: this request already used its ${PC_MAX_STEPS} actions or ${PC_MAX_MS / 1000} seconds. Stop here, tell the user what you did and what is left.`;
    }
    const first = pc.steps === 0;
    if (first) pc.startedAt = now;
    pc.steps++;
    return this.host.pc(call, { requested, first });
  }

  private async execute(call: Exclude<ToolCall, PcCall>, says: SayCall[], requestedByUser: boolean): Promise<{ text: string; images: LookResult["images"] }> {
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
        if (look.notes.length) memory.addFinding("look_at_screen", look.notes.join("\n"), call.focus);
        return { text: look.notes.join("\n") || (look.images.length ? "" : "Nothing to show."), images: look.images };
      }
      case "remember": {
        const recent = memory.recentConversation(4);
        const source = recent.length ? { from: recent[0].at, to: new Date().toISOString() } : undefined;
        const fact = memory.remember(call.fact, call.kind, { importance: call.importance, replaces: call.replaces, source });
        return done(`Saved as [${fact.id}]${call.replaces && !memory.facts().some((f) => f.id === call.replaces) ? `, replacing [${call.replaces}]` : ""}.`);
      }
      case "forget":
        if (call.query) {
          return done(
            this.host.openForget
              ? this.host.openForget(call.query)
              : "You can't open the forget list now: tell the user they can do it in the settings, tab Memoria, section «Dimentica qualcosa».",
          );
        }
        return done(memory.forget(call.id!) ? `Forgot [${call.id}].` : `There is no memory or reminder with id ${call.id}.`);
      case "search_memory": {
        const result = await memory.searchMemory({ query: call.query, from: call.from, to: call.to, kind: call.kind, limit: MEMORY_RESULTS });
        if (!result) return done("Your long-term memory is not available right now.");
        if (result.badRange) return done("Those dates can't be read: use from/to like '2026-03', '2026-03-12' or '2026-03-12 18:00'.");
        if (!result.hits.length) return done("Nothing found in your memory about that.");
        const user = this.host.settings().userName || "Utente";
        const text = result.hits.map((h) => describeHit(h, user, MEMORY_HIT_CHARS)).join("\n---\n");
        memory.addFinding("search_memory", text, call.query ?? [call.from, call.to].filter(Boolean).join(" - "));
        return done(result.more ? `${text}\n(${result.more} more results: narrow the search with more words or a shorter period)` : text);
      }
      case "set_reminder": {
        const reminder = memory.addReminder(call.text, call.due);
        return done(`Reminder [${reminder.id}] set for ${call.due.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`);
      }
      case "move_to":
        return done(this.host.moveTo ? await this.host.moveTo(call, requestedByUser) : "You can't move now.");
      case "web_search":
        if (!this.host.webSearch) return done("You can't search the web now.");
        {
          const found = await this.host.webSearch(call.query);
          memory.addFinding("web_search", found, call.query);
          return done(found);
        }
      case "read_page":
        if (!this.host.readPage) return done("You can't read web pages now.");
        {
          const page = await this.host.readPage(call.url);
          memory.addFinding("read_page", page, call.url);
          return done(page);
        }
      case "name_voice":
        return done(this.host.nameVoice ? this.host.nameVoice(call.voice, call.person) : "You can't recognize voices now.");
      case "stay_quiet":
        this.host.quiet(call.minutes);
        return done("Staying quiet.");
      case "change_mood":
        return done(this.host.changeMood ? this.host.changeMood(call.mood, call.reason, requestedByUser) : "Your mood of the day is off.");
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
  return { text: call.text, emotion: call.emotion, intensity: call.intensity, ...(call.look ? { look: call.look } : {}), ...(call.gesture ? { gesture: call.gesture } : {}) };
}
