// When Lumi may move, decided in code, not by the model. A move the user
// asked for always goes (unless movement is off or the face is in the
// user's hand); a move on Lumi's own initiative (pointing at something,
// a prank, dodging) has limits: settings, at most one every 2 minutes,
// never in "Non disturbare", during calls, over fullscreen apps, or onto
// the window the user is typing in. Pure, tested.
import type { Sociability } from "../../shared/types";
import type { MoveStyle } from "./path";
import type { Place } from "./places";

export const INITIATIVE_EVERY_MS = 2 * 60_000;
/** A prank may cover the user's work spot this long at most. */
export const PRANK_COVER_S = 10;
/** "Basta" / "stai ferma": no initiative for this long. */
export const STILL_MS = 60 * 60_000;
export const MAX_STAY_S = 300;

/** Styles that are a prank or a mood, not a plain move. */
const PRANKS: ReadonlySet<MoveStyle> = new Set(["dash", "hop", "sulk"]);

export interface MoveCheck {
  where: Place;
  style: MoveStyle;
  /** Seconds to stay before going home (0: stay). */
  stay: number;
  /** The user asked (a message), not Lumi's own idea. */
  requested: boolean;
  /** Lumi is answering the user right now (pointing at what it talks about is part of the answer). */
  answering: boolean;
  settings: { enabled: boolean; initiative: boolean; pranks: boolean };
  sociability: Sociability;
  now: number;
  lastInitiative: number;
  stillUntil: number;
  /** Why the face can't move now at all (dragged by the user), or null. */
  held: string | null;
  /** Why an initiative must wait (do not disturb, a call, a fullscreen app, hidden), or null. */
  busy: string | null;
  /** The destination covers where the user is working (caret, mouse, the window being typed in). */
  coversWork: boolean;
  typing: boolean;
}

/** null when the move may go, with the stay it may keep; else why not (for the model). */
export function checkMove(c: MoveCheck): { ok: true; stay: number; counts: boolean } | { ok: false; reason: string } {
  if (c.held) return { ok: false, reason: c.held };
  if (!c.settings.enabled) return { ok: false, reason: "the user turned movement off in the settings" };
  const stay = Math.max(0, Math.min(MAX_STAY_S, Math.round(c.stay)));
  if (c.requested) return { ok: true, stay, counts: false };
  if (!c.settings.initiative) return { ok: false, reason: "moving on your own initiative is off in the settings: move only when asked" };
  if (c.now < c.stillUntil) return { ok: false, reason: "the user asked you to stay still for a while" };
  if (c.busy) return { ok: false, reason: c.busy };
  const prank = PRANKS.has(c.style);
  if (prank && (!c.settings.pranks || c.sociability === "silenzioso")) return { ok: false, reason: "pranks are off: no playful moves" };
  const pointing = c.where === "near_text" && c.answering;
  if (!pointing && c.now - c.lastInitiative < INITIATIVE_EVERY_MS) return { ok: false, reason: "you moved on your own a moment ago: wait a little" };
  if (c.coversWork && c.typing) return { ok: false, reason: "that would cover what the user is typing" };
  // Covering the work spot is a short joke, never a long one
  const capped = c.coversWork ? Math.min(stay || PRANK_COVER_S, PRANK_COVER_S) : stay;
  return { ok: true, stay: capped, counts: !pointing };
}
