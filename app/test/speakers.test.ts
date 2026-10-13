// Recognizing voices: the owner at the microphone, other voices, names.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContext } from "../src/main/brain/prompt";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { cosine, NEW_VOICE, SAME_VOICE, Speakers, voiceLabel } from "../src/main/voice/speakers";
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
