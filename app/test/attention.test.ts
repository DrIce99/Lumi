// The attention module: priorities, decay and hysteresis.
import assert from "node:assert/strict";
import test from "node:test";
import { Attention, score, type Candidate } from "../src/main/perception/attention";

const idle = { listening: false, speaking: false };
const box = (x: number, y: number) => ({ x, y, width: 10, height: 10 });
const candidate = (id: string, kind: Candidate["kind"], t: number, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  kind,
  rect: box(100, 100),
  salience: 1,
  t,
  ...extra,
});

test("scores follow the README priorities and decay with age", () => {
  const now = 10_000;
  const kinds: Candidate["kind"][] = ["speaking", "caret", "text", "change", "mouse"];
  const scores = kinds.map((k) => score(candidate(k, k, now), now, idle));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] > scores[i], `${kinds[i - 1]} > ${kinds[i]}`);
  const fresh = score(candidate("m", "mouse", now), now, idle);
  const old = score(candidate("m", "mouse", now - 700), now, idle);
  assert.ok(Math.abs(old - fresh / 2) < 1e-9, "half-life");
  // The user matters while listening, more than the mouse and screen changes
  const user = candidate("user", "user", now);
  assert.ok(score(user, now, { listening: true, speaking: false }) > score(candidate("c", "change", now), now, idle));
});

test("select picks the best candidate and forgets stale ones", () => {
  const a = new Attention();
  assert.equal(a.select(0, idle), null);
  a.add(candidate("mouse", "mouse", 0, { rect: box(0, 0), moving: true }));
  const first = a.select(0, idle);
  assert.equal(first?.kind, "mouse");
  assert.equal(first?.pursuit, true);
  assert.deepEqual(first?.point, { x: 5, y: 5 });
  // Long after, the mouse is forgotten
  assert.equal(a.select(10_000, idle), null);
  assert.equal(a.candidatesNow().length, 0);
});

test("hysteresis keeps the target unless something clearly better shows up", () => {
  const a = new Attention();
  a.add(candidate("c1", "change", 0, { salience: 0.8 }));
  assert.equal(a.select(0, idle)?.id, "c1");
  // Within the minimum dwell even a better change waits...
  a.add(candidate("c2", "change", 200, { salience: 0.9 }));
  assert.equal(a.select(200, idle)?.id, "c1");
  // ...and after it, a slightly better one still doesn't steal the gaze
  a.add(candidate("c1", "change", 300, { salience: 0.8 }));
  assert.equal(a.select(400, idle)?.id, "c1");
  // ...but a higher-priority kind does, at once
  a.add(candidate("caret", "caret", 410, { salience: 0.6 }));
  assert.equal(a.select(410, idle)?.id, "caret");
  // Within the minimum dwell a same-rank challenger waits
  a.add(candidate("caret2", "caret", 420, { salience: 1 }));
  assert.equal(a.select(420, idle)?.id, "caret");
  assert.equal(a.select(900, idle)?.id, "caret2");
});

test("what Lumi talks about beats everything; clear drops a kind", () => {
  const a = new Attention();
  a.add(candidate("caret", "caret", 0));
  a.add(candidate("say", "speaking", 0, { point: { x: 1, y: 2 } }));
  const target = a.select(0, idle);
  assert.equal(target?.kind, "speaking");
  assert.deepEqual(target?.point, { x: 1, y: 2 });
  a.clear("speaking");
  assert.equal(a.select(10, idle)?.kind, "caret");
  a.clear();
  assert.equal(a.select(20, idle), null);
});
