// Habits (phase 11): patterns from app events, triggers and answers, and the
// controller (logging the foreground, reflection, proposals, "fai da sola").
import assert from "node:assert/strict";
import test from "node:test";
import { Habits, type HabitsHost } from "../src/main/brain/habits/habits";
import { defaultName, findPatterns, sequencePatterns, slotOf, timePatterns, type AppEvent } from "../src/main/brain/habits/patterns";
import { afterAnswer, dueHabit, readAnswer } from "../src/main/brain/habits/triggers";
import { MemoryDb, type HabitRow } from "../src/main/brain/memory/db";
import { MemoryStore } from "../src/main/brain/memory/store";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

/** Four weeks from Monday 2 March 2026: Spotify on weekdays around 9:00, Discord right after VS Code most times. */
function weeks(): AppEvent[] {
  const out: AppEvent[] = [];
  for (let day = 0; day < 28; day++) {
    const date = new Date(2026, 2, 2 + day);
    const weekday = date.getDay();
    const d = date.getDate();
    const m = date.getMonth() + 1;
    if (weekday >= 1 && weekday <= 5) {
      // Some days a little before 9, some a little after: still the same habit
      out.push({ ts: at(2026, m, d, 8, 50 + (day % 3) * 5), app: "Spotify.exe" });
      out.push({ ts: at(2026, m, d, 10, 0), app: "Code.exe" });
      if (day % 5 !== 0) out.push({ ts: at(2026, m, d, 10, 3), app: "Discord.exe" });
      else out.push({ ts: at(2026, m, d, 10, 3), app: "chrome.exe" });
    } else {
      out.push({ ts: at(2026, m, d, 15, 0), app: "steam.exe" });
    }
  }
  return out;
}

test("time patterns: the broadest day group that holds, nearby slots merged", () => {
  const time = timePatterns(weeks());
  const spotify = time.find((p) => p.app === "Spotify.exe")!;
  assert.equal(spotify.days, "feriali", "every weekday, not every day");
  assert.ok(Math.abs(spotify.slot - slotOf(new Date(2026, 2, 2, 9, 0))) <= 1);
  assert.equal(spotify.occurrences, 20);
  assert.equal(time.filter((p) => p.app === "Spotify.exe").length, 1, "one habit, not one per half hour");
  assert.equal(time.find((p) => p.app === "steam.exe")?.days, "weekend");
  assert.equal(defaultName(spotify, (a) => a.replace(".exe", "")), `nei giorni feriali verso le ${spotify.slot % 2 ? "8:30" : "9:00"} apri Spotify`.replace("8:30", `${Math.floor(spotify.slot / 2)}:30`));
});

test("sequence patterns: B after A in at least 70% of the times, 5 or more", () => {
  const seq = sequencePatterns(weeks());
  const discord = seq.find((p) => p.after === "Code.exe" && p.app === "Discord.exe")!;
  assert.equal(discord.occurrences, 16);
  assert.ok(discord.frequency >= 0.79 && discord.frequency <= 0.81);
  assert.ok(!seq.some((p) => p.app === "chrome.exe"), "chrome after Code only 20% of the times");
  assert.deepEqual(findPatterns(weeks().slice(0, 8)), [], "a few days are not a habit");
});

function habit(over: Partial<HabitRow> = {}): HabitRow {
  return {
    id: 1,
    key: "time:Spotify.exe:feriali:18",
    kind: "time",
    name: "musica la mattina",
    app: "Spotify.exe",
    detail: { days: "feriali", slot: 18 },
    confidence: 0.7,
    status: "active",
    accepted: 0,
    rejected: 0,
    auto: false,
    created: "",
    updated: "",
    ...over,
  };
}

test("triggers: the right half hour on the right days, not twice a day, never when blocked or in the cooldown", () => {
  const monday9 = new Date(2026, 2, 9, 9, 10);
  const ctx = { now: monday9, foreground: null, recentApps: [], blocked: null, lastProposal: 0, cooldownMs: 20 * 60_000 };
  assert.equal(dueHabit([habit()], ctx)?.id, 1);
  assert.equal(dueHabit([habit()], { ...ctx, now: new Date(2026, 2, 8, 9, 10) }), null, "Sunday");
  assert.equal(dueHabit([habit()], { ...ctx, now: new Date(2026, 2, 9, 11, 0) }), null, "another time");
  assert.equal(dueHabit([habit()], { ...ctx, blocked: "a call" }), null);
  assert.equal(dueHabit([habit()], { ...ctx, lastProposal: monday9.getTime() - 60_000 }), null, "cooldown");
  assert.equal(dueHabit([habit({ lastProposed: new Date(2026, 2, 9, 8, 0).toISOString() })], ctx), null, "once a day");
  assert.equal(dueHabit([habit()], { ...ctx, foreground: { app: "Spotify.exe", since: 0 } }), null, "already open");
  assert.equal(dueHabit([habit({ confidence: 0.35 })], ctx), null, "not sure enough");
  const seq = habit({ id: 2, key: "seq:Code.exe:Discord.exe", kind: "sequence", app: "Discord.exe", detail: { after: "Code.exe" } });
  assert.equal(dueHabit([seq], { ...ctx, foreground: { app: "Code.exe", since: monday9.getTime() - 20_000 } })?.id, 2);
  assert.equal(dueHabit([seq], { ...ctx, foreground: { app: "Code.exe", since: monday9.getTime() - 5 * 60_000 } }), null, "only right after A");
});

test("answers: said aloud, and how they move the confidence", () => {
  assert.equal(readAnswer("Sì!"), true);
  assert.equal(readAnswer("va bene"), true);
  assert.equal(readAnswer("no grazie"), false);
  assert.equal(readAnswer("non ora"), false);
  assert.equal(readAnswer("sì, ma prima dimmi che ore sono"), null, "a real message goes to the brain");
  assert.deepEqual(afterAnswer(0.7, true), { confidence: 0.8, archived: false });
  assert.deepEqual(afterAnswer(0.4, false), { confidence: 0.25, archived: true });
});

function controller(over: Partial<HabitsHost> = {}) {
  let now = new Date(2026, 2, 30, 9, 10).getTime();
  const db = new MemoryDb(":memory:");
  const store = MemoryStore.local(db);
  const said: string[] = [];
  const opened: string[] = [];
  let fg: { process: string; path: string } | null = null;
  const host: HabitsHost = {
    settings: () => DEFAULT_SETTINGS,
    store,
    foreground: () => (fg ? { handle: "1", title: "secret title", process: fg.process, path: fg.path, pid: 1, rect: null } : null),
    paused: () => null,
    blocked: () => null,
    idleSec: () => 0,
    onBattery: () => false,
    name: async (list) => list.map((_, i) => `abitudine ${i + 1}`),
    propose: async () => true,
    open: async (h) => (opened.push(h.app), null),
    label: (a) => a.replace(/\.exe$/i, ""),
    say: (t) => said.push(t),
    now: () => now,
    ...over,
  };
  return { h: new Habits(host), db, store, said, opened, tick: (ms: number) => (now += ms), setFg: (v: typeof fg) => (fg = v) };
}

test("the controller logs an app once it stays in the foreground, never its title or paused apps", async () => {
  let paused: string | null = null;
  const c = controller({ paused: () => paused });
  c.setFg({ process: "Code.exe", path: "C:\\\\Code\\\\Code.exe" });
  c.h.pollForeground();
  c.tick(2000);
  c.h.pollForeground();
  assert.equal(c.db.eventsSince("", ["app"]).length, 0, "not after 2 s");
  c.tick(3000);
  c.h.pollForeground();
  const [event] = c.db.eventsSince("", ["app"]);
  assert.equal(event.app, "Code.exe");
  assert.deepEqual(event.detail, { path: "C:\\\\Code\\\\Code.exe" });
  assert.ok(!JSON.stringify(c.db.eventsSince("")).includes("secret"), "no window titles");
  paused = "a private window";
  c.setFg({ process: "KeePass.exe", path: "C:\\\\KeePass.exe" });
  for (let i = 0; i < 5; i++) {
    c.tick(2000);
    c.h.pollForeground();
  }
  assert.equal(c.db.eventsSince("", ["app"]).length, 1, "paused apps are never logged");
});

test("reflection turns weeks of events into named habits; proposals open the app or do it alone", async () => {
  const c = controller();
  for (const e of weeks()) c.db.logEvent({ ts: e.ts, kind: "app", app: e.app, detail: { path: `C:\\\\${e.app}` } });
  const result = await c.h.reflect();
  assert.ok(result.added >= 3);
  const habits = c.db.listHabits();
  const spotify = habits.find((h) => h.app === "Spotify.exe")!;
  assert.match(spotify.name, /^abitudine \d$/);
  assert.equal(spotify.detail.path, "C:\\\\Spotify.exe");
  assert.ok(spotify.confidence <= 0.8);
  assert.match(c.h.summary(), /abitudine/);
  // Monday 30 March, 9:10: Spotify is proposed, accepted, opened
  await c.h.checkTriggers();
  assert.deepEqual(c.opened, ["Spotify.exe"]);
  const after = c.db.listHabits().find((h) => h.app === "Spotify.exe")!;
  assert.equal(after.accepted, 1);
  assert.ok(after.confidence > spotify.confidence);
  // Allowed to do it alone: no question, Lumi says what it did
  await c.h.setAuto(after.id, true);
  c.db.updateHabit(after.id, { lastProposed: new Date(2026, 2, 1).toISOString() });
  await c.h.refresh();
  // The next Monday at the same time
  c.tick(7 * 86_400_000);
  await c.h.checkTriggers();
  assert.deepEqual(c.opened, ["Spotify.exe", "Spotify.exe"]);
  assert.match(c.said[0], /Ti apro Spotify, come al solito/);
});

test("rejected habits lose confidence and get archived; Dimentica tutto clears events and habits", async () => {
  const c = controller({ propose: async () => false });
  c.db.upsertHabit({ key: "time:Spotify.exe:feriali:18", kind: "time", name: "musica", app: "Spotify.exe", detail: { days: "feriali", slot: 18 }, confidence: 0.42 });
  await c.h.refresh();
  await c.h.checkTriggers();
  assert.deepEqual(c.opened, []);
  assert.equal(c.db.listHabits().length, 0, "archived");
  assert.equal(c.db.listHabits(true)[0].status, "archived");
  c.db.clear();
  assert.deepEqual(c.db.listHabits(true), []);
  assert.deepEqual(c.db.eventsSince(""), []);
});
