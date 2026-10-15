// Tool definitions, input validation and reminder times.
import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCall, parseWhen, TOOLS } from "../src/main/brain/tools";
import { Memory } from "../src/main/brain/memory";

test("the README tools exist, are unique and closed", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const required of ["say", "look_at", "look_at_screen", "remember", "set_reminder", "stay_quiet"]) assert.ok(names.includes(required), required);
  assert.equal(names[0], "say");
  for (const t of TOOLS) {
    assert.equal(t.parameters.additionalProperties, false, t.name);
    assert.ok(t.description.length > 40, t.name);
  }
});

test("valid inputs are parsed, with lenient emotions", () => {
  assert.deepEqual(parseToolCall("say", { text: " ciao ", emotion: "happy" }), { name: "say", text: "ciao", emotion: "gioia", intensity: 0.6 });
  assert.deepEqual(parseToolCall("say", { text: "x", emotion: "boh", intensity: 4, look: "Errore" }), {
    name: "say",
    text: "x",
    emotion: "neutra",
    intensity: 1,
    look: "Errore",
  });
  assert.deepEqual(parseToolCall("look_at", { region: "caret" }), { name: "look_at", region: "caret" });
  assert.deepEqual(parseToolCall("look_at", { text: "Salva" }), { name: "look_at", text: "Salva" });
  assert.deepEqual(parseToolCall("look_at_screen", {}), { name: "look_at_screen" });
  assert.deepEqual(parseToolCall("remember", { fact: "Ama il caffè", kind: "preference" }), { name: "remember", fact: "Ama il caffè", kind: "preference" });
  assert.deepEqual(parseToolCall("remember", { fact: "Si chiama Diego" }), { name: "remember", fact: "Si chiama Diego", kind: "user" });
  assert.deepEqual(parseToolCall("stay_quiet", {}), { name: "stay_quiet" });
  assert.deepEqual(parseToolCall("stay_quiet", { minutes: 20 }), { name: "stay_quiet", minutes: 20 });
  const now = new Date(2026, 9, 13, 10, 0);
  const reminder = parseToolCall("set_reminder", { when: "+20", text: "Pausa" }, now);
  assert.equal(reminder?.name === "set_reminder" && reminder.due.getTime() - now.getTime(), 20 * 60_000);
});

test("invalid inputs are rejected", () => {
  const invalid: [string, unknown][] = [
    ["say", { text: "" }],
    ["say", "ciao"],
    ["say", null],
    ["look_at", {}],
    ["look_at", { region: "sky" }],
    ["remember", {}],
    ["forget", {}],
    ["set_reminder", { when: "domani forse", text: "x" }],
    ["set_reminder", { when: "+5" }],
    ["unknown_tool", {}],
  ];
  for (const [name, input] of invalid) assert.equal(parseToolCall(name, input), null, `${name} ${JSON.stringify(input)}`);
});

test("reminder times: minutes, hours, clock times and dates", () => {
  const now = new Date(2026, 9, 13, 10, 0);
  const minutes = (d: Date | null) => (d ? Math.round((d.getTime() - now.getTime()) / 60_000) : null);
  assert.equal(minutes(parseWhen("+20", now)), 20);
  assert.equal(minutes(parseWhen("20", now)), 20);
  assert.equal(minutes(parseWhen("45 minuti", now)), 45);
  assert.equal(minutes(parseWhen("2h", now)), 120);
  assert.equal(minutes(parseWhen(15, now)), 15);
  assert.equal(minutes(parseWhen("15:30", now)), 330);
  assert.equal(minutes(parseWhen("9:00", now)), 23 * 60, "a past time means tomorrow");
  assert.equal(minutes(parseWhen("2026-10-14 09:00", now)), 23 * 60);
  assert.equal(parseWhen("2020-01-01 09:00", now), null);
  assert.equal(parseWhen("25:00", now), null);
  assert.equal(parseWhen("0", now), null);
});

test("memory: facts, notes, interrupted answers, reminders and the diary", async () => {
  let clock = new Date(2026, 9, 13, 10, 0);
  const memory = new Memory(null, null, () => clock);
  const fact = memory.remember("  Ama  il caffè ", "preference");
  assert.equal(fact.text, "Ama il caffè");
  assert.equal(memory.remember("ama il caffè", "preference").id, fact.id, "no duplicates");
  memory.remember("Oggi è stanco", "note");
  assert.equal(memory.facts().length, 2);
  memory.addMessage("user", "ciao");
  memory.addMessage("lumi", "Ciao! Oggi", true);
  assert.equal(memory.recentConversation(1)[0].interrupted, true);
  memory.addReminder("Chiamare Marco", new Date(2026, 9, 13, 10, 30));
  clock = new Date(2026, 9, 13, 23, 0);
  assert.equal(memory.facts().length, 1, "notes expire");
  assert.deepEqual(
    memory.takeDueReminders().map((r) => r.text),
    ["Chiamare Marco"],
  );
  clock = new Date(2026, 9, 14, 9, 0);
  const days = await memory.pendingDiaryDays();
  assert.deepEqual(
    days.map((d) => [d.date, d.entries.length]),
    [["2026-10-13", 2]],
  );
  memory.addDiary("2026-10-13", "Abbiamo parlato.");
  assert.equal(memory.recentConversation(10).length, 0);
  assert.equal(memory.forget(fact.id), true);
  assert.equal(memory.forget(fact.id), false);
  // forget also cancels a pending reminder
  const reminder = memory.addReminder("Dentista", new Date(2026, 9, 15, 10, 0));
  assert.equal(memory.forget(reminder.id), true);
  assert.deepEqual(memory.reminders(), []);
});
