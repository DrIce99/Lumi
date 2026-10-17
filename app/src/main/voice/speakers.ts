// Who is speaking: the voices Lumi has heard, as voiceprints (speaker
// embeddings measured by the sidecar). A new voiceprint is compared with
// every known voice (cosine similarity with its running average): close
// enough is that person and refines their average, far from all is a new
// voice ("Voce 3" until someone gives it a name), in between is uncertain
// and changes nothing. The first voice heard at the microphone becomes the
// owner's. Saved in %APPDATA%\Lumi\voices.json, never sent anywhere.
// Thresholds measured on the WeSpeaker ResNet34 model: same voice vs its
// average >= 0.69, different voices <= 0.67 (synthetic voices; real
// microphones score the same voice lower, hence the margins). Pure apart
// from the optional file, tested.
import { DebouncedWriter, readJson } from "../jsonStore";

/** At least this similar to a voice's average: the same person. */
export const SAME_VOICE = 0.55;
/** Less than this similar to every known voice: someone new. */
export const NEW_VOICE = 0.4;
/** Between "new" and "same" the closest voice is still the likely one, at least this similar (for labels, never for learning). */
export const LIKELY_VOICE = 0.5;
/** A new voice is only made from at least this much speech: a short clip's voiceprint is noise (call audio especially). */
export const MIN_ENROLL_SECONDS = 2;
/** A known voice's average is only refined by at least this much speech. */
export const MIN_LEARN_SECONDS = 1.5;
/** Two voices whose averages are this close are the same person (averages are steadier than single clips). */
export const MERGE_VOICES = 0.72;
/** A voice heard once and never again after this long was a chance clip, not a person. */
const ONE_SHOT_DAYS = 1;
/** A voice's average stops moving much after this many samples. */
const MAX_WEIGHT = 30;
const MAX_VOICES = 40;

export interface VoiceProfile {
  id: string;
  /** Number shown until it has a name ("Voce 3"). */
  number: number;
  name?: string;
  /** The computer's user. */
  owner?: boolean;
  /** Unit-length running average of the voiceprints. */
  centroid: number[];
  samples: number;
  firstHeard: string;
  lastHeard: string;
  /** Where it was heard: "mic", "Discord"... */
  via: string[];
}

export interface Identified {
  voice: VoiceProfile | null;
  similarity: number;
  status: "match" | "uncertain" | "new";
  /** An uncertain voice that is still close enough to be named as the likely one (LIKELY_VOICE). */
  likely?: VoiceProfile;
}

export interface IdentifyOptions {
  learn?: boolean;
  exclude?: (v: VoiceProfile) => boolean;
  /** How much speech the voiceprint comes from: short clips never make a new voice. */
  seconds?: number;
}

interface VoicesFile {
  version: 1;
  nextNumber: number;
  voices: VoiceProfile[];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** How a voice is called: its name, the user's name for the owner, else "Voce N". */
export function voiceLabel(v: VoiceProfile, userName = ""): string {
  return v.name || (v.owner && userName) || (v.owner ? "tu" : `Voce ${v.number}`);
}

export class Speakers {
  private data: VoicesFile;
  private readonly writer: DebouncedWriter | null;

  constructor(
    file: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    const loaded = file ? readJson<VoicesFile>(file) : null;
    this.data = loaded?.version === 1 ? loaded : { version: 1, nextNumber: 2, voices: [] };
    this.writer = file ? new DebouncedWriter(file, () => this.data) : null;
    if (this.tidy()) this.save();
  }

  /** Drops the chance clips: unnamed voices heard once, long ago. Returns whether anything went. */
  tidy(): boolean {
    const limit = this.now().getTime() - ONE_SHOT_DAYS * 86_400_000;
    const before = this.data.voices.length;
    this.data.voices = this.data.voices.filter((v) => v.owner || v.name || v.samples > 1 || Date.parse(v.lastHeard) > limit);
    return this.data.voices.length !== before;
  }

  voices(): VoiceProfile[] {
    return this.data.voices;
  }

  owner(): VoiceProfile | null {
    return this.data.voices.find((v) => v.owner) ?? null;
  }

  /**
   * Who this voiceprint belongs to; a match refines that voice, a new voice
   * is remembered. `via` says where it was heard. At the microphone, the
   * first voice ever heard becomes the owner's.
   */
  identify(print: number[], via: string, options: IdentifyOptions = {}): Identified {
    const learn = options.learn ?? true;
    const seconds = options.seconds ?? Infinity;
    const candidates = this.data.voices.filter((v) => !options.exclude?.(v));
    let best: VoiceProfile | null = null;
    let similarity = -1;
    for (const v of candidates) {
      const s = cosine(print, v.centroid);
      if (s > similarity) {
        similarity = s;
        best = v;
      }
    }
    if (best && similarity >= SAME_VOICE) {
      if (learn && seconds >= MIN_LEARN_SECONDS) best = this.update(best, print, via);
      return { voice: best, similarity, status: "match" };
    }
    if (!best || similarity < NEW_VOICE) {
      // A clip too short to trust doesn't make a voice: nobody is named for it, nothing is learned
      if (!learn || seconds < MIN_ENROLL_SECONDS) return { voice: null, similarity, status: seconds < MIN_ENROLL_SECONDS ? "uncertain" : "new" };
      const owner = via === "mic" && !this.owner();
      const voice = this.add(print, via, owner);
      return { voice, similarity, status: "new" };
    }
    return { voice: best, similarity, status: "uncertain", ...(similarity >= LIKELY_VOICE ? { likely: best } : {}) };
  }

  /** Gives a voice a name ("Voce 3" -> "Marco"); the voice is found by id, number, label or current name. */
  rename(which: string, name: string): VoiceProfile | null {
    const voice = this.find(which);
    const clean = name.trim().slice(0, 40);
    if (!voice || !clean) return null;
    voice.name = clean;
    this.save();
    return voice;
  }

  /** Marks a voice as the owner's (the previous owner's voice stays, as anyone else). */
  setOwner(which: string): VoiceProfile | null {
    const voice = this.find(which);
    if (!voice) return null;
    for (const v of this.data.voices) delete v.owner;
    voice.owner = true;
    this.save();
    return voice;
  }

  forget(which: string): boolean {
    const voice = this.find(which);
    if (!voice) return false;
    this.data.voices = this.data.voices.filter((v) => v !== voice);
    this.save();
    return true;
  }

  clear(): void {
    this.data = { version: 1, nextNumber: 2, voices: [] };
    this.save();
  }

  find(which: string): VoiceProfile | null {
    const key = which.trim().toLowerCase();
    if (!key) return null;
    const number = /^(?:voce\s*)?(\d+)$/.exec(key)?.[1];
    return (
      this.data.voices.find(
        (v) => v.id === key || (number !== undefined && v.number === Number(number)) || v.name?.toLowerCase() === key || (v.owner && (key === "tu" || key === "owner")),
      ) ?? null
    );
  }

  flush(): void {
    this.writer?.flush();
  }

  private add(print: number[], via: string, owner: boolean): VoiceProfile {
    const at = this.now().toISOString();
    const voice: VoiceProfile = {
      id: `v${this.data.nextNumber}`,
      number: owner ? 1 : this.data.nextNumber++,
      ...(owner ? { owner: true } : {}),
      centroid: normalize([...print]),
      samples: 1,
      firstHeard: at,
      lastHeard: at,
      via: [via],
    };
    if (owner) voice.id = "v1";
    this.data.voices.push(voice);
    this.prune();
    this.save();
    return voice;
  }

  /** Refines a voice with a new clip; the voice it ends up as (two that became close are one person). */
  private update(voice: VoiceProfile, print: number[], via: string): VoiceProfile {
    const w = Math.min(voice.samples, MAX_WEIGHT);
    voice.centroid = normalize(voice.centroid.map((x, i) => (x * w + (print[i] ?? 0)) / (w + 1)));
    voice.samples += 1;
    voice.lastHeard = this.now().toISOString();
    if (!voice.via.includes(via)) voice.via.push(via);
    const merged = this.mergeInto(voice);
    this.save();
    return merged;
  }

  /**
   * A voice that grew close to another one: the same person heard before as two. The one
   * with more samples stays (and its name); an owner or a name is never given up for another.
   */
  private mergeInto(voice: VoiceProfile): VoiceProfile {
    let kept = voice;
    for (const other of [...this.data.voices]) {
      // `other` may be the voice folded in a moment ago (the list is a copy)
      if (other === kept || !this.data.voices.includes(other) || cosine(kept.centroid, other.centroid) < MERGE_VOICES) continue;
      if (!!kept.owner !== !!other.owner) continue;
      if (kept.name && other.name && kept.name !== other.name) continue;
      const [big, small] = kept.samples >= other.samples ? [kept, other] : [other, kept];
      const total = big.samples + small.samples;
      big.centroid = normalize(big.centroid.map((x, i) => (x * big.samples + (small.centroid[i] ?? 0) * small.samples) / total));
      big.samples = total;
      big.name ??= small.name;
      big.firstHeard = big.firstHeard < small.firstHeard ? big.firstHeard : small.firstHeard;
      big.lastHeard = big.lastHeard > small.lastHeard ? big.lastHeard : small.lastHeard;
      for (const via of small.via) if (!big.via.includes(via)) big.via.push(via);
      this.data.voices = this.data.voices.filter((v) => v !== small);
      kept = big;
    }
    return kept;
  }

  /** Too many voices: the unnamed ones heard least recently go first. */
  private prune(): void {
    if (this.data.voices.length <= MAX_VOICES) return;
    const removable = this.data.voices.filter((v) => !v.owner && !v.name).sort((a, b) => a.lastHeard.localeCompare(b.lastHeard));
    const drop = new Set(removable.slice(0, this.data.voices.length - MAX_VOICES));
    this.data.voices = this.data.voices.filter((v) => !drop.has(v));
  }

  private save(): void {
    this.writer?.schedule();
  }
}
