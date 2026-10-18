// The mood of the day: the morning draw, one-step changes along the mood
// tree, resistance and cooldown, the prompt line, the neutral face, the tool
// and the settings.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  dayKey,
  DayMood,
  describeMood,
  newDay,
  rollMood,
  shiftMood,
  SHIFT_COOLDOWN_MS,
  stepToward,
  type DayMoodState,
} from "../src/main/brain/dayMood";
import { buildContext, buildSystemPrompt, type Situation } from "../src/main/brain/prompt";
import { parseJsonReply } from "../src/main/brain/providers/text";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { Mood } from "../src/main/mood";
import { sanitizeSettings } from "../src/main/settings";
import { DAY_MOODS, DEFAULT_MOOD_WEIGHTS, type DayMoodId, type MoodWeights } from "../src/shared/dayMood";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

const only = (mood: DayMoodId): MoodWeights => Object.fromEntries(DAY_MOODS.map((m) => [m, m === mood ? 1 : 0])) as MoodWeights;
const at = (iso: string) => new Date(iso);

function state(mood: DayMoodId, intensity: number, over: Partial<DayMoodState> = {}): DayMoodState {
  return { day: "2026-10-18", rolled: mood, mood, intensity, since: "2026-10-18T07:00:00.000Z", changes: [], ...over };
}

/** Shifts repeatedly toward `to`, past the cooldown each time; returns the moods visited. */
function walk(start: DayMoodState, to: DayMoodId, times: number): DayMoodId[] {
  let s = start;
  let t = Date.parse("2026-10-18T09:00:00Z");
  const seen: DayMoodId[] = [];
  for (let i = 0; i < times; i++) {
    t += SHIFT_COOLDOWN_MS;
    s = shiftMood(s, to, new Date(t), "test").state;
    seen.push(s.mood);
  }
  return seen;
}

test("a day starts at 5:00 local time: past midnight is still the same day", () => {
  assert.equal(dayKey(new Date(2026, 9, 18, 4, 59)), "2026-10-17");
  assert.equal(dayKey(new Date(2026, 9, 18, 5, 0)), "2026-10-18");
  assert.equal(dayKey(new Date(2026, 9, 18, 23, 30)), "2026-10-18");
});

test("the morning draw follows the weights; yesterday's mood weighs 50% more; no weights = tranquilla", () => {
  assert.equal(rollMood(only("triste"), null, () => 0.99), "triste");
  assert.equal(rollMood(only("allegra"), "arrabbiata", () => 0), "allegra", "a zero weight stays zero even when carried over");
  const two = { ...only("allegra"), triste: 1 };
  // Order: allegra (1) before triste (1); with triste carried over it is 1 : 1.5
  assert.equal(rollMood(two, null, () => 0.45), "allegra");
  assert.equal(rollMood(two, "triste", () => 0.45), "triste", "0.45 * 2.5 = 1.125 falls past allegra's 1");
  assert.equal(rollMood(only("tranquilla"), null, () => 0.999999), "tranquilla");
  assert.equal(rollMood(Object.fromEntries(DAY_MOODS.map((m) => [m, 0])) as MoodWeights, null, () => 0.3), "tranquilla");
  const counts = new Map<DayMoodId, number>();
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 4200; i++) {
    const m = rollMood(DEFAULT_MOOD_WEIGHTS, null, random);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  // tranquilla 6/21 of 4200 = 1200
  assert.ok(Math.abs((counts.get("tranquilla") ?? 0) - 1200) < 120, String(counts.get("tranquilla")));
  assert.ok(Math.abs((counts.get("arrabbiata") ?? 0) - 200) < 60, String(counts.get("arrabbiata")));
  const fresh = newDay(new Date(2026, 9, 18, 8), only("irritata"), null, () => 0.5);
  assert.equal(fresh.mood, "irritata");
  assert.equal(fresh.rolled, "irritata");
  assert.equal(fresh.intensity, 0.7);
  assert.equal(fresh.day, "2026-10-18");
});

test("moods move one step along the tree: toward calm, or deeper toward the asked mood", () => {
  assert.equal(stepToward("arrabbiata", "entusiasta"), "irritata");
  assert.equal(stepToward("irritata", "entusiasta"), "tranquilla");
  assert.equal(stepToward("tranquilla", "entusiasta"), "allegra");
  assert.equal(stepToward("allegra", "entusiasta"), "entusiasta");
  assert.equal(stepToward("triste", "arrabbiata"), "malinconica", "sad to angry passes through calm");
  assert.equal(stepToward("entusiasta", "triste"), "allegra");
  assert.equal(stepToward("annoiata", "annoiata"), "annoiata");
});

test("a strong bad mood resists: it softens first, and an angry Lumi needs several good moments to be happy", () => {
  const angry = state("arrabbiata", 0.8);
  const first = shiftMood(angry, "allegra", at("2026-10-18T09:00:00Z"), "the user apologized");
  assert.equal(first.outcome, "softened");
  assert.equal(first.state.mood, "arrabbiata");
  assert.equal(first.state.intensity, 0.5);
  assert.equal(first.state.since, angry.since, "the mood didn't change, so neither does its start");
  assert.deepEqual(walk(angry, "allegra", 4), ["arrabbiata", "irritata", "tranquilla", "allegra"]);
  // A mild bad mood moves at once
  const mild = shiftMood(state("malinconica", 0.4), "allegra", at("2026-10-18T09:00:00Z"), "a nice joke");
  assert.equal(mild.outcome, "changed");
  assert.equal(mild.state.mood, "tranquilla");
  assert.equal(mild.state.since, "2026-10-18T09:00:00.000Z");
  assert.equal(mild.state.changes.at(-1)?.reason, "a nice joke");
});

test("moods also get worse, and the same mood asked again gets stronger", () => {
  assert.deepEqual(walk(state("tranquilla", 0.5), "arrabbiata", 2), ["irritata", "arrabbiata"]);
  assert.deepEqual(walk(state("allegra", 0.8), "triste", 4), ["allegra", "tranquilla", "malinconica", "triste"]);
  const stronger = shiftMood(state("triste", 0.6), "triste", at("2026-10-18T09:00:00Z"), "mocked");
  assert.equal(stronger.outcome, "stronger");
  assert.equal(stronger.state.intensity, 0.85);
  assert.equal(shiftMood(state("tranquilla", 0.5), "tranquilla", at("2026-10-18T09:00:00Z"), "").outcome, "same");
});

test("one change per cooldown: a stream of compliments doesn't undo a bad day at once", () => {
  const first = shiftMood(state("triste", 0.4), "allegra", at("2026-10-18T09:00:00Z"), "kind words").state;
  const again = shiftMood(first, "allegra", at("2026-10-18T09:00:30Z"), "more kind words");
  assert.equal(again.outcome, "cooldown");
  assert.equal(again.state, first);
  assert.equal(shiftMood(first, "allegra", new Date(Date.parse("2026-10-18T09:00:00Z") + SHIFT_COOLDOWN_MS), "x").outcome, "changed");
});

test("the <situation> line says the mood, how strong, since when and why, and who can lift it", () => {
  const woke = describeMood(state("arrabbiata", 0.8));
  assert.match(woke, /^arrabbiata, strongly \(since \d\d:\d\d, you woke up like this\)/);
  assert.match(woke, /only the user can make it better/);
  const changed = shiftMood(state("malinconica", 0.4), "allegra", at("2026-10-18T09:00:00Z"), "the user made you laugh").state;
  const line = describeMood(changed);
  assert.match(line, /^tranquilla, slightly \(since \d\d:\d\d, because the user made you laugh\)/);
  assert.match(line, /you woke up malinconica today/);
  assert.doesNotMatch(line, /only the user/);
});

test("the face goes back to neutral after an answer, whatever the mood of the day", () => {
  let now = 0;
  const mood = new Mood(() => undefined, () => now, () => 0.5);
  mood.dispose();
  mood.set({ speaking: true });
  mood.setEmotion("gioia", 0.8);
  mood.set({ speaking: false });
  now = 3000;
  mood.tick();
  assert.equal(mood.state().expression, "neutra");
});

test("DayMood draws once per day, keeps changes in mood.json and carries the last mood over", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-mood-"));
  try {
    const file = join(dir, "mood.json");
    let now = new Date(2026, 9, 18, 8, 0);
    let weights = only("triste");
    const a = new DayMood(file, () => weights, () => now, () => 0.5);
    assert.equal(a.current().mood, "triste");
    now = new Date(2026, 9, 18, 9, 0);
    const r = a.shift("allegra", "the user cheered you up");
    assert.equal(r.outcome, "softened", "0.7 > 0.5: it softens first");
    assert.match(r.text, /still triste, but a little less/);
    now = new Date(2026, 9, 18, 9, 5);
    assert.equal(a.shift("allegra", "again").after.mood, "malinconica");

    // A restart the same day keeps the mood; changing the weights waits for tomorrow
    weights = only("allegra");
    const b = new DayMood(file, () => weights, () => now, () => 0.5);
    assert.equal(b.current().mood, "malinconica");
    assert.equal(b.current().changes.length, 2);

    // Tomorrow: the weights say allegra, but yesterday's malinconica is carried over (weight 0 here stays 0)
    now = new Date(2026, 9, 19, 7, 0);
    const next = b.current();
    assert.equal(next.day, "2026-10-19");
    assert.equal(next.mood, "allegra");
    assert.equal(next.changes.length, 0);
    assert.equal(b.reroll().mood, "allegra");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("change_mood: the tool input, the JSON reply format, and the prompt only when the mood is on", () => {
  assert.deepEqual(parseToolCall("change_mood", { mood: "Allegra", reason: "she apologized" }), { name: "change_mood", mood: "allegra", reason: "she apologized" });
  assert.deepEqual(parseToolCall("change_mood", { mood: "triste" }), { name: "change_mood", mood: "triste", reason: "" });
  assert.equal(parseToolCall("change_mood", { mood: "felicissima" }), null);
  assert.deepEqual(parseJsonReply('{"emotion":"gioia","say":"Grazie!","mood":{"mood":"allegra","reason":"kind words"}}').map((c) => c.name), ["say", "change_mood"]);

  assert.match(buildSystemPrompt(DEFAULT_SETTINGS), /# Your mood of the day/);
  assert.doesNotMatch(buildSystemPrompt({ ...DEFAULT_SETTINGS, mood: { ...DEFAULT_SETTINGS.mood, enabled: false } }), /mood of the day/);
  const situation: Situation = {
    now: new Date(2026, 9, 18, 10),
    activity: { locked: false, away: false, awayMinutes: 0, idleSec: 3, sessionMinutes: 20 } as Situation["activity"],
    voice: true,
    screen: "",
    vision: "never",
    mood: "triste, clearly (since 08:00, you woke up like this) - sad",
  };
  const context = buildContext({ situation, settings: DEFAULT_SETTINGS, facts: [], reminders: [], diary: [], conversation: [], trigger: { kind: "tick" } });
  assert.match(context, /Your mood today: triste, clearly/);
});

test("settings: mood weights are clamped to 0-10 integers, missing ones take the defaults", () => {
  const s = sanitizeSettings({ mood: { enabled: false, weights: { triste: 42, allegra: -3, irritata: 2.6, arrabbiata: "x" } } });
  assert.equal(s.mood.enabled, false);
  assert.equal(s.mood.weights.triste, 10);
  assert.equal(s.mood.weights.allegra, 0);
  assert.equal(s.mood.weights.irritata, 3);
  assert.equal(s.mood.weights.arrabbiata, DEFAULT_MOOD_WEIGHTS.arrabbiata);
  assert.equal(s.mood.weights.tranquilla, DEFAULT_MOOD_WEIGHTS.tranquilla);
  assert.deepEqual(sanitizeSettings({}).mood, DEFAULT_SETTINGS.mood);
});
