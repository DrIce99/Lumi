// The shapes the eyes take beyond the capsule, the little props some
// expressions bring (glasses, lines) and their continuous motions. Only
// geometry and timing here, in px at the face's scale: face.ts draws it.
// Pure, tested.

export type Glyph = "capsule" | "ring" | "chevron";
export type Accessory = "glasses" | "squintLines" | "shockLines";
export type Motion = "tremble" | "pulse" | "reading";

export interface Point {
  x: number;
  y: number;
}

export type Segment = [Point, Point];

/** The violet of the shock lines (anime "gasp" marks). */
export const SHOCK_COLOR = "#9B6BD6";

// ---------------- the eyes ----------------

/** A ring eye (fear, shock): the ellipse of its outline and the pupil (0: empty). Eye-local. */
export function ringGeometry(width: number, height: number, pupil: number, scale: number): { rx: number; ry: number; line: number; pupil: number } {
  const line = 3.2 * scale;
  const rx = Math.max(line, width / 2 - line / 2);
  const ry = Math.max(line, height / 2 - line / 2);
  return { rx, ry, line, pupil: pupil > 0 ? Math.max(1.2 * scale, pupil * Math.min(rx, ry)) : 0 };
}

/**
 * A chevron eye: ">" for the eye on the left (it points to the nose), "<"
 * for the one on the right, so together they read "> <". Eye-local.
 */
export function chevronPoints(width: number, height: number, side: -1 | 1): [Point, Point, Point] {
  const dir = side === -1 ? 1 : -1;
  return [
    { x: (-dir * width) / 2, y: -height / 2 },
    { x: (dir * width) / 2, y: 0 },
    { x: (-dir * width) / 2, y: height / 2 },
  ];
}

export const chevronLine = (scale: number) => 4 * scale;

// ---------------- props ----------------

export interface Lens {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/**
 * Glasses: a lens around each eye's resting place (they sit on the face:
 * the eyes move behind them), a bridge and short temples. `lift` raises
 * them (the finger pushing them up).
 */
export function glasses(left: Point, right: Point, scale: number, lift: number): { lenses: [Lens, Lens]; bridge: Segment; temples: [Segment, Segment]; line: number } {
  const width = 26 * scale;
  const height = 22 * scale;
  // A little below the eyes' resting center: the eyes look down, reading
  const lens = (c: Point): Lens => ({ x: c.x - width / 2, y: c.y + 5 * scale - lift - height / 2, width, height, radius: 6 * scale });
  const [l, r] = [lens(left), lens(right)];
  const top = l.y + height * 0.3;
  return {
    lenses: [l, r],
    bridge: [
      { x: l.x + width, y: top },
      { x: r.x, y: top },
    ],
    temples: [
      [
        { x: l.x, y: top },
        { x: l.x - 6 * scale, y: top - 2 * scale },
      ],
      [
        { x: r.x + width, y: top },
        { x: r.x + width + 6 * scale, y: top - 2 * scale },
      ],
    ],
    line: 2.2 * scale,
  };
}

export const GLASSES_PUSH_MS = 1300;

/**
 * The finger that pushes the glasses up, `t` ms into the gesture: it rises
 * from below to the outer side of the right lens, pushes it up, holds,
 * and goes back down. `lift` is how far the glasses are up (they stay a
 * little higher). Relative to the right lens's outer bottom corner.
 */
export function glassesPush(t: number, scale: number): { finger: { x: number; y: number; angle: number; length: number; width: number; alpha: number } | null; lift: number } {
  const ease = (u: number) => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3;
  const push = 4 * scale;
  const finger = (x: number, y: number, alpha: number) => ({ x, y, angle: -0.35, length: 22 * scale, width: 7 * scale, alpha });
  if (t < 0 || t >= GLASSES_PUSH_MS) return { finger: null, lift: t >= GLASSES_PUSH_MS ? push * 0.5 : 0 };
  if (t < 350) {
    const u = ease(t / 350);
    return { finger: finger((10 - 7 * u) * scale, (40 - 36 * u) * scale, u), lift: 0 };
  }
  if (t < 650) {
    const u = ease((t - 350) / 300);
    return { finger: finger(3 * scale, (4 - 4 * u) * scale - push * u, 1), lift: push * u };
  }
  if (t < 800) return { finger: finger(3 * scale, -push, 1), lift: push };
  const u = ease((t - 800) / 500);
  return { finger: u < 1 ? finger((3 + 7 * u) * scale, -push + (44 * u) * scale, 1 - u) : null, lift: push * (1 - 0.5 * u) };
}

/**
 * Doubt: a lid line above and one below a slit eye, touching it, so slit
 * and lines read as one piece per eye (a squeezed eye between its lids)
 * that moves with the gaze.
 */
export function squintLines(eye: { cx: number; cy: number; width: number; height: number }, scale: number): [Segment, Segment] {
  const half = eye.width / 2 + 3 * scale;
  // The stroke's center sits a little inside the slit's edge: no gap between them
  const inset = squintLine(scale) * 0.3;
  const above = eye.cy - eye.height / 2 + inset;
  const below = eye.cy + eye.height / 2 - inset;
  return [
    [
      { x: eye.cx - half, y: above },
      { x: eye.cx + half, y: above },
    ],
    [
      { x: eye.cx - half, y: below },
      { x: eye.cx + half, y: below },
    ],
  ];
}

export const squintLine = (scale: number) => 2.6 * scale;

/** Shock: three short violet strokes, slanted, above the outer top of the right eye. */
export function shockLines(eye: { cx: number; cy: number; width: number; height: number }, scale: number): Segment[] {
  const x0 = eye.cx + eye.width / 2 + 4 * scale;
  const y0 = eye.cy - eye.height / 2 - 2 * scale;
  return [0, 1, 2].map((i): Segment => {
    const x = x0 + i * 5 * scale;
    const length = (10 + 3 * i) * scale;
    return [
      { x: x + 3 * scale, y: y0 - length },
      { x, y: y0 - i * 2 * scale },
    ];
  });
}

export const shockLine = (scale: number) => 2.2 * scale;

// ---------------- motions ----------------

export interface MotionFrame {
  /** Offset of both eyes, px at scale 1. */
  dx: number;
  dy: number;
  /** Size multipliers. */
  sx: number;
  sy: number;
  /** Extra gaze, -1..1 of the horizontal range (reading). */
  gazeX: number;
}

export const STILL: MotionFrame = { dx: 0, dy: 0, sx: 1, sy: 1, gazeX: 0 };

/**
 * A continuous motion at `now` (ms): fear trembles (light, steady, never
 * quite periodic), effort pulses (quick squeezes), reading sweeps the
 * eyes along a line and back. `strength` 0..1 fades it in and out.
 */
export function motionAt(motion: Motion | null, now: number, seed: number, strength = 1): MotionFrame {
  if (!motion || strength <= 0) return STILL;
  switch (motion) {
    case "tremble":
      return {
        dx: strength * (0.55 * Math.sin(now * 0.113 + seed) + 0.3 * Math.sin(now * 0.271 + seed * 1.7)),
        dy: strength * (0.45 * Math.sin(now * 0.131 + seed * 2.3) + 0.25 * Math.sin(now * 0.229 + seed)),
        sx: 1,
        sy: 1,
        gazeX: 0,
      };
    case "pulse": {
      const squeeze = Math.abs(Math.sin((now / 300) * Math.PI));
      return { dx: 0, dy: 0, sx: 1 - 0.1 * strength * squeeze, sy: 1 - 0.2 * strength * squeeze, gazeX: 0 };
    }
    case "reading": {
      // 1.6 s along the line, 0.25 s back to its start
      const period = 1850;
      const t = (now + seed * 100) % period;
      const x = t < 1600 ? -0.6 + 1.2 * (t / 1600) : 0.6 - 1.2 * ((t - 1600) / 250);
      return { dx: 0, dy: 0, sx: 1, sy: 1, gazeX: strength * x };
    }
  }
}
