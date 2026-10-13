// Short pre-generated clips in Lumi's current voice: backchannel ("mh",
// "sì") while the user talks at length, fillers ("allora...") when an
// answer is slow to start, and an acknowledgement for the wake word alone.
// They never go through the model: generated once per voice, cached on
// disk, played at once.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Emotion } from "../../shared/emotions";
import type { AudioBegin, Settings, UtteranceKind } from "../../shared/types";
import { log } from "../log";
import type { TtsClient } from "./ttsClient";

export type ClipKind = "backchannel" | "filler" | "wake";

export const CLIP_TEXTS: Record<ClipKind, { text: string; emotion: Emotion; intensity: number }[]> = {
  backchannel: [
    { text: "Mh.", emotion: "neutra", intensity: 0.4 },
    { text: "Sì.", emotion: "neutra", intensity: 0.4 },
    { text: "Mh mh.", emotion: "neutra", intensity: 0.4 },
    { text: "Ah.", emotion: "sorpresa", intensity: 0.3 },
  ],
  filler: [
    { text: "Allora...", emotion: "pensiero", intensity: 0.5 },
    { text: "Vediamo...", emotion: "pensiero", intensity: 0.5 },
    { text: "Mmh, un attimo...", emotion: "pensiero", intensity: 0.5 },
    { text: "Dunque...", emotion: "pensiero", intensity: 0.5 },
  ],
  wake: [
    { text: "Sì?", emotion: "gioia", intensity: 0.5 },
    { text: "Dimmi.", emotion: "neutra", intensity: 0.5 },
  ],
};

const VOLUME: Record<ClipKind, number> = { backchannel: 0.45, filler: 0.9, wake: 0.9 };

interface Clip {
  text: string;
  emotion: Emotion;
  intensity: number;
  pcm: Uint8Array;
  rate: number;
}

export interface ClipOutput {
  begin(msg: AudioBegin): void;
  chunk(id: number, pcm: Uint8Array, sampleRate: number): void;
  end(id: number): void;
}

/** Cache key: the same text in another voice is another clip. */
export function clipKey(settings: Settings, text: string): string {
  const t = settings.tts;
  return createHash("sha1").update(JSON.stringify([t.engine, t.model, t.voice, t.seed, t.speed, text])).digest("hex").slice(0, 20);
}

export class Clips {
  private clips = new Map<ClipKind, Clip[]>();
  private voiceKey = "";
  private preparing: Promise<void> | null = null;
  private last = "";

  constructor(
    private readonly tts: TtsClient,
    private readonly out: ClipOutput,
    private readonly settings: () => Settings,
    private readonly dir: string,
    private readonly nextId: () => number,
  ) {}

  ready(kind: ClipKind): boolean {
    return (this.clips.get(kind)?.length ?? 0) > 0;
  }

  /** Loads the clips of the current voice from disk, synthesizing the missing ones. */
  prepare(): Promise<void> {
    const s = this.settings();
    const voiceKey = clipKey(s, "");
    if (voiceKey === this.voiceKey && this.preparing) return this.preparing;
    this.voiceKey = voiceKey;
    this.clips = new Map();
    this.preparing = this.load(voiceKey).catch((err: unknown) => log.warn("Preparing the voice clips failed", err));
    return this.preparing;
  }

  /** Plays a random clip of a kind; false when none is ready. */
  play(kind: ClipKind): boolean {
    const list = this.clips.get(kind);
    if (!list?.length) return false;
    const options = list.length > 1 ? list.filter((c) => c.text !== this.last) : list;
    const clip = options[Math.floor(Math.random() * options.length)];
    this.last = clip.text;
    const id = this.nextId();
    const utterance: UtteranceKind = kind === "backchannel" ? "backchannel" : "filler";
    this.out.begin({ id, kind: utterance, text: clip.text, emotion: clip.emotion, intensity: clip.intensity, volume: VOLUME[kind] * this.settings().tts.volume });
    this.out.chunk(id, clip.pcm, clip.rate);
    this.out.end(id);
    return true;
  }

  private async load(voiceKey: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    for (const kind of Object.keys(CLIP_TEXTS) as ClipKind[]) {
      for (const spec of CLIP_TEXTS[kind]) {
        if (this.voiceKey !== voiceKey) return;
        const s = this.settings();
        const file = join(this.dir, `${clipKey(s, spec.text)}.pcm`);
        let pcm: Uint8Array | null = existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
        if (!pcm) {
          pcm = await this.synthesize(spec.text, spec.emotion, spec.intensity);
          if (pcm) writeFileSync(file, pcm);
        }
        if (!pcm?.byteLength || this.voiceKey !== voiceKey) continue;
        const list = this.clips.get(kind) ?? [];
        list.push({ ...spec, pcm, rate: 24_000 });
        this.clips.set(kind, list);
      }
    }
    log.info(`Voice clips ready: ${[...this.clips.entries()].map(([k, v]) => `${v.length} ${k}`).join(", ")}`);
  }

  private synthesize(text: string, emotion: Emotion, intensity: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const parts: Uint8Array[] = [];
      const ok = this.tts.speak(
        { id: this.nextId(), text, emotion, intensity },
        {
          chunk: (pcm) => parts.push(pcm),
          done: (info) => {
            if (info.error || !parts.length) return resolve(null);
            const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
            let offset = 0;
            for (const p of parts) {
              out.set(p, offset);
              offset += p.byteLength;
            }
            resolve(out);
          },
        },
      );
      if (!ok) resolve(null);
    });
  }
}
