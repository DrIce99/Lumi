// Moving Lumi around the screen: the move_to tool (asked by the user or on
// Lumi's own initiative), the trip back home after a stay, the "stop"
// that keeps it still for an hour, dodging the text cursor, and a short
// mood line for the prompt ("sulking in a corner since 14:02").
import type { Settings, Sociability } from "../../shared/types";
import { log } from "../log";
import type { MoveStyle } from "./path";
import { center, intersects, placeAnchor, rectOf, type Place, type Point, type Rect } from "./places";
import { checkMove, STILL_MS } from "./rules";

export interface MoveRequest {
  where: Place | "stop";
  text?: string;
  style?: MoveStyle;
  stay?: number;
}

export interface MoverFace {
  flyTo(target: Point, style: MoveStyle, done?: (arrived: boolean) => void): void;
  isMoving(): boolean;
  isDragging(): boolean;
  getAnchor(): Point;
  faceSize(): { width: number; height: number };
}

export interface MoverHost {
  settings(): Settings;
  face: MoverFace;
  /** The displays' work areas (DIP). */
  areas(): Rect[];
  cursor(): Point;
  /** The user's own place for Lumi (last drag), or null. */
  home(): Point | null;
  /**
   * Where some visible text is (screen DIP): what was read recently, the
   * regions the vision model named, else the screen read now. Null when it
   * is not there. May take a moment (an OCR).
   */
  locate(text: string): Rect | null | Promise<Rect | null>;
  /** The text cursor, when the user typed in the last few seconds. */
  caret(): Rect | null;
  /** The window being typed in, when the user is typing. */
  typingWindow(): Rect | null;
  /** Why an initiative must wait (do not disturb, a call, a fullscreen app, hidden), or null. */
  busy(): string | null;
  /** Lumi is answering the user right now. */
  answering(): boolean;
  /** The eyes look where Lumi is going. */
  lookAt(point: Point): void;
  now?(): number;
}

/**
 * A refused move, for the model. It usually said "eccomi" in the same reply
 * as the call, before knowing: it must hear that it did not move, and say so.
 */
function refusal(reason: string): string {
  return `You did NOT move: ${reason}. If you already said (or implied) that you moved or are pointing at something, correct yourself now in one short sentence.`;
}

const PLACE_TEXT: Record<Place, string> = {
  top_left: "the top left corner",
  top: "the top of the screen",
  top_right: "the top right corner",
  left: "the left side",
  center: "the center of the screen",
  right: "the right side",
  bottom_left: "the bottom left corner",
  bottom: "the bottom of the screen",
  bottom_right: "the bottom right corner",
  other_screen: "the other screen",
  near_text: "next to that text",
  near_mouse: "next to the mouse pointer",
  out_of_the_way: "a free spot",
  home: "your usual place",
};

/** The caret must stay this close to the face this long before Lumi gets out of the way. */
const DODGE_NEAR_PX = 60;
const DODGE_AFTER_MS = 2000;
const DODGE_EVERY_MS = 20_000;
const SULK_MS = 30 * 60_000;

export class Mover {
  private lastInitiative = Number.NEGATIVE_INFINITY;
  private stillUntil = 0;
  private returnTimer: NodeJS.Timeout | null = null;
  private away: { since: number; where: Place } | null = null;
  private sulking: number | null = null;
  private caretNearSince: number | null = null;
  private lastDodge = Number.NEGATIVE_INFINITY;

  constructor(private readonly host: MoverHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** The move_to tool. `requested`: the user asked for it in this moment. Returns what happened, for the model. */
  async move(request: MoveRequest, requested: boolean): Promise<string> {
    const now = this.now();
    const face = this.host.face;
    if (request.where === "stop") {
      this.stillUntil = now + STILL_MS;
      this.sulking = null;
      this.cancelReturn();
      const home = this.host.home();
      if (home && Math.hypot(home.x - face.getAnchor().x, home.y - face.getAnchor().y) > 4) this.fly(home, "fly", "home");
      return "You'll stay in your place and won't move on your own for an hour.";
    }
    const where = request.where;
    const style = request.style ?? "fly";
    const target = where === "near_text" && request.text ? await this.host.locate(request.text) : null;
    if (where === "near_text" && !target) {
      log.info("Move next to text refused: the text is not on screen");
      return refusal(`"${request.text ?? ""}" is not among the text on the screen. Icons and buttons without a written label can't be found by text: call look_at_screen first, then use the name it gives them`);
    }
    const size = face.faceSize();
    const anchor = placeAnchor(where, {
      size,
      anchor: face.getAnchor(),
      areas: this.host.areas(),
      home: this.host.home(),
      mouse: this.host.cursor(),
      avoid: this.avoid(),
      target,
    });
    if (!anchor) return refusal(where === "other_screen" ? "there is only one screen" : where === "home" ? "you have no usual place yet: the user hasn't dragged you anywhere" : "you can't go there");
    const dest = rectOf(anchor, size);
    const work = this.avoid();
    const check = checkMove({
      where,
      style,
      stay: request.stay ?? 0,
      requested,
      answering: this.host.answering(),
      settings: this.host.settings().movement,
      sociability: this.host.settings().sociability as Sociability,
      now,
      lastInitiative: this.lastInitiative,
      stillUntil: this.stillUntil,
      held: face.isDragging() ? "the user is holding you" : null,
      busy: this.host.busy(),
      coversWork: work.some((r) => intersects(dest, r)),
      typing: this.host.typingWindow() !== null,
    });
    if (!check.ok) {
      log.info(`Move to ${where} refused: ${check.reason}`);
      return refusal(check.reason);
    }
    if (check.counts) this.lastInitiative = now;
    if (style === "sulk") this.sulking = now;
    else if (where === "home") this.sulking = null;
    this.fly(anchor, style, where, check.stay);
    return `Flying to ${PLACE_TEXT[where]}${check.stay ? `, then back to your place after ${check.stay} s` : ""}.`;
  }

  private fly(anchor: Point, style: MoveStyle, where: Place, stay = 0): void {
    this.cancelReturn();
    const size = this.host.face.faceSize();
    this.host.lookAt(center(rectOf(anchor, size)));
    log.info(`Moving to ${where} (${style})`);
    this.host.face.flyTo(anchor, style, (arrived) => {
      if (!arrived) return;
      this.away = where === "home" ? null : { since: this.now(), where };
      if (!stay) return;
      this.returnTimer = setTimeout(() => {
        this.returnTimer = null;
        const home = this.host.home();
        if (home && !this.host.face.isDragging()) this.fly(home, "fly", "home");
      }, stay * 1000);
    });
  }

  private cancelReturn(): void {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = null;
  }

  /** The user dragged the face: that is its place now, and any mood or planned return is over. */
  userMoved(): void {
    this.cancelReturn();
    this.away = null;
    this.sulking = null;
  }

  private avoid(): Rect[] {
    const c = this.host.cursor();
    return [this.host.caret(), this.host.typingWindow(), { x: c.x - 20, y: c.y - 20, width: 40, height: 40 }].filter((r): r is Rect => !!r);
  }

  /** Every half second: when the text cursor sits under the face for 2 s, Lumi gets out of the way (no model). */
  dodgeTick(): void {
    const now = this.now();
    const s = this.host.settings().movement;
    const face = this.host.face;
    const caret = this.host.caret();
    if (!s.enabled || !s.dodge || !caret || face.isMoving() || face.isDragging() || this.host.busy()) {
      this.caretNearSince = null;
      return;
    }
    const size = face.faceSize();
    const a = face.getAnchor();
    const near = intersects({ x: a.x - DODGE_NEAR_PX, y: a.y - DODGE_NEAR_PX, width: size.width + 2 * DODGE_NEAR_PX, height: size.height + 2 * DODGE_NEAR_PX }, caret);
    if (!near) {
      this.caretNearSince = null;
      return;
    }
    this.caretNearSince ??= now;
    if (now - this.caretNearSince < DODGE_AFTER_MS || now - this.lastDodge < DODGE_EVERY_MS) return;
    this.lastDodge = now;
    this.caretNearSince = null;
    const anchor = placeAnchor("out_of_the_way", { size, anchor: a, areas: this.host.areas(), home: this.host.home(), mouse: this.host.cursor(), avoid: this.avoid() });
    if (anchor) this.fly(anchor, "fly", "out_of_the_way");
  }

  /** A line for <situation>, or "" when Lumi is in its place and calm. */
  status(): string {
    const now = this.now();
    const parts: string[] = [];
    if (this.sulking && now - this.sulking > SULK_MS) this.sulking = null;
    const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (this.away) parts.push(`you are at ${PLACE_TEXT[this.away.where]}, not your usual place (since ${time(this.away.since)})`);
    if (this.sulking) parts.push(`you went to sulk there at ${time(this.sulking)}: you go back when the user makes peace (move_to home)`);
    if (now < this.stillUntil) parts.push(`the user asked you not to move on your own until ${time(this.stillUntil)}`);
    return parts.join("; ");
  }
}
