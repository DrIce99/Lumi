// Recognizing voices: the owner at the microphone, other voices, names.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContext } from "../src/main/brain/prompt";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { cosine, LIKELY_VOICE, MIN_ENROLL_SECONDS, NEW_VOICE, SAME_VOICE, Speakers, voiceLabel } from "../src/main/voice/speakers";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

/** A voice: a direction in 8 dimensions, with some noise per utterance. */
function voice(seed: number) {
  const base = Array.from({ length: 8 }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453 % 1);
  let n = 0;
  return () => base.map((x, i) => x + 0.12 * Math.sin(++n * 3.1 + i * seed));
}

test("the first voice at the microphone is the owner's; the same voice matches and others are new", () => {
  const owner = voice(1);
  const marco = voice(2);
  const s = new Speakers(null);
  const first = s.identify(owner(), "mic");
  assert.equal(first.status, "new");
  assert.equal(first.voice?.owner, true);
  assert.equal(first.voice?.id, "v1");
  for (let i = 0; i < 5; i++) assert.equal(s.identify(owner(), "mic").voice?.owner, true);
  const other = s.identify(marco(), "Discord");
  assert.equal(other.status, "new");
  assert.equal(other.voice?.owner, undefined, "a new voice on Discord is never the owner");
  assert.equal(voiceLabel(other.voice!), "Voce 2");
  assert.equal(s.identify(marco(), "mic").voice, other.voice, "the same friend, now in the room");
  assert.deepEqual(other.voice?.via, ["Discord", "mic"]);
  assert.equal(s.owner()?.samples, 6);
});

test("uncertain voices change nothing; learn: false only looks", () => {
  const s = new Speakers(null);
  const a = [1, 0, 0, 0];
  s.identify(a, "mic");
  // Between the thresholds: not the same, not clearly new
  const between = (SAME_VOICE + NEW_VOICE) / 2;
  const b = [between, Math.sqrt(1 - between * between), 0, 0];
  assert.ok(Math.abs(cosine(a, b) - between) < 1e-9);
  const r = s.identify(b, "mic");
  assert.equal(r.status, "uncertain");
  assert.equal(s.voices().length, 1);
  assert.equal(s.owner()?.samples, 1);
  assert.equal(s.identify([0, 1, 0, 0], "Discord", { learn: false }).voice, null);
  assert.equal(s.voices().length, 1);
});

test("names, owner changes and forgetting are saved to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-voices-"));
  try {
    const file = join(dir, "voices.json");
    const s = new Speakers(file);
    s.identify([1, 0, 0], "mic");
    s.identify([0, 1, 0], "Discord");
    s.identify([0, 0, 1], "Discord");
    assert.equal(s.rename("Voce 2", "Marco")?.name, "Marco");
    assert.equal(s.rename("voce 9", "Nessuno"), null);
    assert.equal(s.find("marco")?.id, "v2");
    assert.equal(s.find("3")?.id, "v3");
    s.flush();
    const again = new Speakers(file);
    assert.equal(again.find("Marco")?.number, 2);
    assert.equal(again.setOwner("Voce 3")?.id, "v3");
    assert.equal(again.owner()?.id, "v3");
    assert.equal(again.forget("Marco"), true);
    assert.deepEqual(
      again.voices().map((v) => v.id),
      ["v1", "v3"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another voice is told apart in the prompt, and name_voice is a valid tool", () => {
  const context = buildContext({
    situation: {
      now: new Date("2026-10-12T21:00:00"),
      activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 10, awayMinutes: 0 },
      voice: true,
      screen: "",
      vision: "ask",
      voices: "Marco: heard on Discord, last 2026-10-12 20:59",
    },
    settings: { ...DEFAULT_SETTINGS, userName: "DrIce" },
    facts: [],
    reminders: [],
    diary: [],
    conversation: [{ at: "2026-10-12T20:59:00", who: "other", name: "Marco", via: "Discord", text: "Stasera si gioca?" }],
    trigger: { kind: "message", text: "Lumi, che ore sono?", via: "voice", speaker: "Voce 4" },
  });
  assert.match(context, /<voices>\nMarco: heard on Discord/);
  assert.match(context, /\] Marco \(Discord\): Stasera si gioca\?/);
  assert.match(context, /Voce 4 - a voice that is not DrIce's/);
  assert.deepEqual(parseToolCall("name_voice", { voice: "Voce 3", name: "Marco" }), { name: "name_voice", voice: "Voce 3", person: "Marco" });
  assert.equal(parseToolCall("name_voice", { voice: "Voce 3" }), null);
});

const at = (iso: string) => () => new Date(iso);

test("a short clip never makes a voice, and an uncertain one is named only when it is close", () => {
  const s = new Speakers(null);
  s.identify([1, 0, 0, 0], "mic");
  const friend = [0, 1, 0, 0];
  // A one-second clip of someone new: nobody is named, nothing is remembered
  const short = s.identify(friend, "Discord", { seconds: MIN_ENROLL_SECONDS - 0.5 });
  assert.deepEqual([short.voice, short.status], [null, "uncertain"]);
  assert.equal(s.voices().length, 1);
  // The same voice with enough speech is a new person
  const long = s.identify(friend, "Discord", { seconds: MIN_ENROLL_SECONDS });
  assert.equal(long.status, "new");
  assert.equal(s.voices().length, 2);

  // Between "new" and "same": named as likely only from LIKELY_VOICE up
  const only = new Speakers(null);
  only.identify([1, 0, 0, 0], "mic");
  const far = (NEW_VOICE + LIKELY_VOICE) / 2;
  const unsure = only.identify([far, Math.sqrt(1 - far * far), 0, 0], "mic");
  assert.equal(unsure.status, "uncertain");
  assert.equal(unsure.likely, undefined, `${far.toFixed(2)} is too far to name`);
  const close = LIKELY_VOICE + 0.02;
  const likely = only.identify([close, Math.sqrt(1 - close * close), 0, 0], "mic");
  assert.equal(likely.status, "uncertain");
  assert.equal(likely.likely?.owner, true);
  assert.equal(only.voices().length, 1, "being a likely voice doesn't make or change anything");
});

test("a short clip doesn't refine a known voice either", () => {
  const s = new Speakers(null);
  s.identify([1, 0, 0, 0], "mic");
  s.identify([1, 0.05, 0, 0], "mic", { seconds: 0.8 });
  assert.equal(s.owner()?.samples, 1);
  s.identify([1, 0.05, 0, 0], "mic", { seconds: 3 });
  assert.equal(s.owner()?.samples, 2);
});

test("a voice that grows close to another is the same person: they become one, the name stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-voices-"));
  try {
    const file = join(dir, "voices.json");
    const profile = (id: string, number: number, centroid: number[], samples: number, extra: object = {}) => ({
      id, number, centroid, samples, firstHeard: "2026-10-14T18:00:00.000Z", lastHeard: "2026-10-14T19:00:00.000Z", via: ["Discord"], ...extra,
    });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        nextNumber: 5,
        voices: [
          profile("v1", 1, [0, 0, 0, 1], 20, { owner: true, via: ["mic"] }),
          profile("v2", 2, [1, 0, 0, 0], 6),
          profile("v3", 3, [0.92, 0.39, 0, 0], 3, { name: "Marco" }),
          profile("v4", 4, [0, 1, 0, 0], 4),
        ],
      }),
    );
    const s = new Speakers(file, at("2026-10-14T20:00:00.000Z"));
    assert.ok(cosine([1, 0, 0, 0], [0.92, 0.39, 0, 0]) > 0.9);
    const hit = s.identify([0.97, 0.2, 0, 0], "Discord", { exclude: (v) => !!v.owner, seconds: 3 });
    assert.equal(hit.status, "match");
    assert.deepEqual(s.voices().map((v) => v.id).sort(), ["v1", "v2", "v4"], "the smaller one was folded into the bigger");
    const kept = s.find("v2")!;
    assert.equal(kept.samples, 10);
    assert.equal(kept.name, "Marco", "the name moves to the voice that stays");
    assert.equal(hit.voice, kept);
    // The owner is never folded into someone else, however close
    const owner = s.owner()!;
    assert.equal(owner.samples, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chance clips heard once and never again are tidied away after a day; named voices and the owner stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-voices-"));
  try {
    const file = join(dir, "voices.json");
    const profile = (id: string, number: number, samples: number, lastHeard: string, extra: object = {}) => ({
      id, number, centroid: [number, 1, 0, 0], samples, firstHeard: lastHeard, lastHeard, via: ["Discord"], ...extra,
    });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        nextNumber: 9,
        voices: [
          profile("v1", 1, 1, "2026-10-10T10:00:00.000Z", { owner: true }),
          profile("v2", 2, 1, "2026-10-10T10:00:00.000Z"),
          profile("v3", 3, 1, "2026-10-10T10:00:00.000Z", { name: "Elena" }),
          profile("v4", 4, 5, "2026-10-10T10:00:00.000Z"),
          profile("v5", 5, 1, "2026-10-14T19:30:00.000Z"),
        ],
      }),
    );
    const s = new Speakers(file, at("2026-10-14T20:00:00.000Z"));
    assert.deepEqual(s.voices().map((v) => v.id), ["v1", "v3", "v4", "v5"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
