// Plays Lumi's voice with WebAudio, in the same renderer as the microphone
// so Chromium's echo canceller has the reference signal. Sentences play in
// order, their chunks scheduled back to back without gaps; a short pause
// separates sentences. stop() fades out (barge-in) and reports how much of
// the current sentence was heard. The analyser gives the speech level that
// makes the eyes pulse. Each sentence is announced ("lead") a little before
// it plays, so its emotion reaches the face ahead of the voice, as in people.
import type { AudioBegin, AudioChunk, PlaybackEvent } from "../../shared/types";
import { pcm16ToFloat, rms } from "./rms";

/** Pause between two sentences, seconds. */
const SENTENCE_GAP = 0.06;
/** Scheduling headroom for the first chunk, seconds. */
const START_LEAD = 0.03;
/** The face changes expression this long before the voice, seconds. */
const EXPRESSION_LEAD = 0.12;

interface Utterance {
  id: number;
  volume: number;
  kind: AudioBegin["kind"];
  pending: Float32Array<ArrayBuffer>[];
  rate: number;
  complete: boolean;
  started: boolean;
  /** The "lead" event was scheduled. */
  led: boolean;
  startAt: number;
  scheduledEnd: number;
  playing: number;
  totalSamples: number;
  gain: GainNode | null;
  sources: AudioBufferSourceNode[];
}

export interface PlayerHooks {
  event(event: PlaybackEvent): void;
  sentenceStart(kind: AudioBegin["kind"]): void;
  sentenceEnd(kind: AudioBegin["kind"]): void;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  private local = true;
  private readonly queue: Utterance[] = [];
  private nextFree = 0;
  private readonly samples = new Float32Array(1024);

  /** `destination`: where the voice goes instead of the speakers (the phone bridge's outgoing track). */
  constructor(
    private readonly hooks: PlayerHooks,
    private readonly destination: ((ctx: AudioContext) => AudioNode) | null = null,
  ) {}

  /** Creates the audio graph now (the phone bridge needs its outgoing track before any sound). */
  start(): void {
    this.ensure();
  }

  /** Something is playing or about to. */
  get active(): boolean {
    return this.queue.some((u) => u.started);
  }

  begin(msg: AudioBegin): void {
    this.ensure();
    this.queue.push({
      id: msg.id,
      volume: msg.volume,
      kind: msg.kind,
      pending: [],
      rate: 24_000,
      complete: false,
      started: false,
      led: false,
      startAt: 0,
      scheduledEnd: 0,
      playing: 0,
      totalSamples: 0,
      gain: null,
      sources: [],
    });
  }

  chunk(msg: AudioChunk): void {
    const u = this.queue.find((x) => x.id === msg.id);
    if (!u) return;
    u.rate = msg.sampleRate;
    u.pending.push(pcm16ToFloat(new Uint8Array(msg.pcm)));
    this.pump();
  }

  end(id: number): void {
    const u = this.queue.find((x) => x.id === id);
    if (!u) return;
    u.complete = true;
    this.pump();
    // Its audio may already have finished playing
    if (u.started) this.finishIfDone(u);
  }

  /** Fades everything out; the sentence being played reports how much was heard. */
  stop(fadeMs: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const head = this.queue[0];
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    const dropped = this.queue.splice(0);
    setTimeout(() => {
      for (const u of dropped) for (const s of u.sources) s.stop();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(1, ctx.currentTime);
    }, fadeMs + 10);
    this.nextFree = now + fadeMs / 1000 + SENTENCE_GAP;
    if (head?.started) {
      const totalMs = (head.totalSamples / head.rate) * 1000;
      const playedMs = Math.max(0, Math.min(totalMs, (now + fadeMs / 1000 - head.startAt) * 1000));
      this.hooks.event({ id: head.id, type: "end", playedMs: Math.round(playedMs), totalMs: Math.round(totalMs), interrupted: true });
      this.hooks.sentenceEnd(head.kind);
    }
  }

  /** Current output loudness (RMS), for the talk pulse. */
  level(): number {
    if (!this.analyser || !this.active) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return rms(this.samples);
  }

  private ensure(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // After the analyser: muting the speakers keeps the talk pulse going
    const output = ctx.createGain();
    output.gain.value = this.local ? 1 : 0;
    master.connect(analyser);
    analyser.connect(output);
    output.connect(this.destination ? this.destination(ctx) : ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.analyser = analyser;
    this.output = output;
    return ctx;
  }

  /** Plays through the speakers (true) or only "virtually" (false: Lumi's voice goes to a Discord call). */
  setLocal(local: boolean): void {
    this.local = local;
    if (this.output && this.ctx) this.output.gain.setTargetAtTime(local ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Schedules what can be played: only the first sentence in the queue plays. */
  private pump(): void {
    const ctx = this.ensure();
    for (;;) {
      const u = this.queue[0];
      if (!u) return;
      if (!u.started && !u.pending.length && u.complete) {
        // Nothing to play (synthesis failed or was cancelled): skip it silently
        this.queue.shift();
        continue;
      }
      while (u.pending.length) {
        const samples = u.pending.shift()!;
        if (!samples.length) continue;
        const buffer = ctx.createBuffer(1, samples.length, u.rate);
        buffer.copyToChannel(samples, 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        if (!u.gain) {
          u.gain = ctx.createGain();
          u.gain.gain.value = u.volume;
          u.gain.connect(this.master!);
        }
        source.connect(u.gain);
        let at: number;
        if (!u.started) {
          at = Math.max(ctx.currentTime + START_LEAD, this.nextFree);
          u.started = true;
          u.startAt = at;
          this.announce(u, at);
          const delay = Math.max(0, (at - ctx.currentTime) * 1000);
          setTimeout(() => {
            if (this.queue[0] === u) {
              this.hooks.event({ id: u.id, type: "start" });
              this.hooks.sentenceStart(u.kind);
            }
          }, delay);
        } else {
          // A chunk that arrives late leaves a tiny gap rather than overlapping
          at = Math.max(u.scheduledEnd, ctx.currentTime + 0.01);
        }
        u.scheduledEnd = at + buffer.duration;
        u.totalSamples += samples.length;
        u.playing++;
        u.sources.push(source);
        source.onended = () => {
          u.playing--;
          this.finishIfDone(u);
        };
        source.start(at);
      }
      // The next sentence will start right after this one: announce it early
      const next = this.queue[1];
      if (next && u.complete && next.pending.length) this.announce(next, u.scheduledEnd + SENTENCE_GAP);
      return;
    }
  }

  /** Sends "lead" for a sentence that will start at `at` (AudioContext time). */
  private announce(u: Utterance, at: number): void {
    if (u.led || !this.ctx) return;
    u.led = true;
    const delay = Math.max(0, (at - EXPRESSION_LEAD - this.ctx.currentTime) * 1000);
    setTimeout(() => {
      // Dropped by an interruption meanwhile: nothing to anticipate
      if (this.queue.includes(u)) this.hooks.event({ id: u.id, type: "lead" });
    }, delay);
  }

  private finishIfDone(u: Utterance): void {
    if (!u.complete || u.playing > 0 || u.pending.length || this.queue[0] !== u) return;
    this.queue.shift();
    const totalMs = Math.round((u.totalSamples / u.rate) * 1000);
    this.hooks.event({ id: u.id, type: "end", playedMs: totalMs, totalMs, interrupted: false });
    this.hooks.sentenceEnd(u.kind);
    this.nextFree = (this.ctx?.currentTime ?? 0) + SENTENCE_GAP;
    this.pump();
  }
}
