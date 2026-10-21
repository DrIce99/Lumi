// When Lumi plays an idle routine (3D only): asleep on the floor, reading,
// sitting on a ledge, walking about... after `afterMinutes` with nobody
// talking to her, then a pause of a few minutes before the next one. Any
// interaction ends the routine at once (the exit clip plays: from sleep she
// wakes with a start). While the user is away she sleeps until they are
// back. Routines that move the window (a walk, the screen's edge as a
// desk) need movement on Lumi's own initiative. Pure, tested: main.ts feeds
// it the conditions and carries out what it returns.

export interface IdleChoice {
  name: string;
  /** Moves the window: needs movement on Lumi's own initiative. */
  wanders: boolean;
  /** Asleep in the loop: chosen while the user is away. */
  sleeps: boolean;
  /** Seconds of each part, to know when the exit is over. */
  seconds: { enter: number; loop: number; exit: number };
}

export interface IdleConditions {
  /** The setting is on, the face is in 3D and visible. */
  enabled: boolean;
  /** Nothing else going on: not talking, listening, thinking, in a call, moving, in "Non disturbare". */
  free: boolean;
  /** The user is away from the computer. */
  away: boolean;
  /** Movement on Lumi's own initiative is allowed now. */
  mayWander: boolean;
  /** How long nobody must talk to her before a routine (the setting, ms). */
  afterMs: number;
}

export type IdlePlan = { kind: "start"; name: string; loopMs: number } | { kind: "stop"; name: string; startled: boolean };

/** A routine's loop lasts this long (ms), unless it is interrupted first. */
export const LOOP_MS = { min: 20_000, max: 45_000 };
/** Between two routines (ms, after the exit). */
export const GAP_MS = { min: 90_000, max: 240_000 };
/** Asleep while the user is away: after they come back she sleeps on this long at most. */
export const AFTER_BACK_MS = 30_000;

interface Playing {
  name: string;
  startedAt: number;
  /** When the loop ends on its own (Infinity: asleep until the user is back). */
  loopEnd: number;
  enterMs: number;
  exitMs: number;
  sleeps: boolean;
}

export class IdleDirector {
  private playing: Playing | null = null;
  private quietSince: number;
  private restUntil = 0;
  private recent: string[] = [];

  constructor(
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.quietSince = now;
  }

  current(): string | null {
    return this.playing?.name ?? null;
  }

  /** Someone talked to Lumi, clicked or dragged her, or she started speaking: the routine ends now. */
  interaction(now: number): IdlePlan | null {
    this.quietSince = now;
    const p = this.playing;
    if (!p) return null;
    // Startled only when woken from the loop (during the enter she wasn't asleep yet)
    const inLoop = now >= p.startedAt + p.enterMs;
    return this.stop(now, inLoop && p.sleeps);
  }

  /** The routine ended by itself (a walk that arrived): its exit plays. */
  finish(now: number): IdlePlan | null {
    return this.playing ? this.stop(now, false) : null;
  }

  /** Whether one could start now as far as time goes: main checks the costlier conditions only then. */
  due(now: number, afterMs: number, away: boolean): boolean {
    return this.playing === null && now >= this.restUntil && (away || now - this.quietSince >= afterMs);
  }

  /** Every half second or so. */
  tick(now: number, choices: IdleChoice[], c: IdleConditions): IdlePlan | null {
    const p = this.playing;
    if (p) {
      if (!c.enabled || !choices.some((x) => x.name === p.name)) return this.stop(now, false);
      // Back from being away: a little more sleep, then she gets up by herself
      if (p.loopEnd === Infinity && !c.away) p.loopEnd = now + AFTER_BACK_MS;
      if (now >= p.loopEnd) return this.stop(now, false);
      return null;
    }
    if (!c.enabled || !c.free || now < this.restUntil) return null;
    if (!c.away && now - this.quietSince < c.afterMs) return null;
    const pool = choices.filter((x) => c.mayWander || !x.wanders);
    if (pool.length === 0) return null;
    let pick: IdleChoice | undefined;
    if (c.away) {
      // Nobody there: she falls asleep (and stays asleep)
      const sleepers = pool.filter((x) => x.sleeps && !x.wanders);
      pick = sleepers[Math.floor(this.random() * sleepers.length)];
      if (!pick) return null;
    } else {
      // Not the last two again, when there is a choice
      const fresh = pool.filter((x) => !this.recent.includes(x.name));
      const from = fresh.length > 0 ? fresh : pool;
      pick = from[Math.floor(this.random() * from.length)];
    }
    const loopMs = c.away ? Infinity : Math.round(LOOP_MS.min + this.random() * (LOOP_MS.max - LOOP_MS.min));
    this.playing = {
      name: pick.name,
      startedAt: now,
      loopEnd: now + pick.seconds.enter * 1000 + loopMs,
      enterMs: pick.seconds.enter * 1000,
      exitMs: pick.seconds.exit * 1000,
      sleeps: pick.sleeps,
    };
    this.recent = [pick.name, ...this.recent.filter((n) => n !== pick!.name)].slice(0, 2);
    return { kind: "start", name: pick.name, loopMs };
  }

  private stop(now: number, startled: boolean): IdlePlan {
    const p = this.playing!;
    this.playing = null;
    this.restUntil = now + p.exitMs + GAP_MS.min + this.random() * (GAP_MS.max - GAP_MS.min);
    return { kind: "stop", name: p.name, startled };
  }
}

export interface Spot {
  x: number;
  y: number;
}

/** Walks stay this close to her place (DIP), so she paces about it instead of wandering off. */
export const WALK_RANGE = 280;
const WALK_MIN = 120;

/**
 * Where an idle walk goes: along the bottom of the face's row, back toward
 * her place when she is away from it, else to the side with more room.
 * `anchor` and the result are the face's top-left corner; null without room.
 */
export function walkTarget(anchor: Spot, home: Spot | null, faceWidth: number, area: { x: number; width: number }, random: () => number = Math.random): { target: Spot; dir: 1 | -1 } | null {
  const base = home ?? anchor;
  const lo = Math.max(area.x, base.x - WALK_RANGE);
  const hi = Math.min(area.x + area.width - faceWidth, base.x + WALK_RANGE);
  if (hi - lo < WALK_MIN) return null;
  let to: number;
  if (Math.abs(anchor.x - base.x) > 60) to = base.x;
  else {
    const right = hi - anchor.x;
    const left = anchor.x - lo;
    const room = Math.max(left, right);
    if (room < WALK_MIN) return null;
    const distance = WALK_MIN + random() * (room - WALK_MIN);
    to = right >= left ? anchor.x + distance : anchor.x - distance;
  }
  to = Math.round(Math.min(hi, Math.max(lo, to)));
  if (Math.abs(to - anchor.x) < WALK_MIN / 2) return null;
  return { target: { x: to, y: anchor.y }, dir: to > anchor.x ? 1 : -1 };
}

/** The desk routine: the face's bottom on the bottom edge of the work area (the screen's edge is the desk). */
export function deskSpot(anchor: Spot, faceHeight: number, area: { y: number; height: number }): Spot {
  return { x: anchor.x, y: Math.round(area.y + area.height - faceHeight) };
}
