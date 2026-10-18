// The avatar's body, procedurally: a resting pose that breathes and shifts
// its weight, and the built-in gestures as keyframes of bone rotations. Pure:
// avatar.ts turns the degrees into quaternions on the VRM's normalized bones.
//
// Conventions (VRM 1.0 normalized bones, the model faces the camera at +Z,
// so its left hand is on the viewer's right, at +X):
// - rotations are Euler XYZ in degrees on each bone;
// - arms: Z lowers/raises (left arm down = -Z, right arm down = +Z), Y swings
//   forward (left -Y, right +Y); the lower arm bends forward the same way;
// - head/neck/spine: X + = down/forward, Y + = toward the viewer's right, Z =
//   roll;
// - `hipsY`: the hips' vertical offset in meters (crouch, hop).

export type Euler = [number, number, number];

export interface BonePose {
  bones: Partial<Record<string, Euler>>;
  hipsY?: number;
}

/** What the expression and the moment add to the resting pose. */
export interface IdleInput {
  /** ms */
  t: number;
  energy: number;
  head: Euler;
  lean: number;
  shoulders: number;
  /** Speech level 0..1: the head moves a little with it. */
  talk: number;
  tremble: number;
  /** Flying: -1..1 each, leans the body along the motion. */
  travel: { vx: number; vy: number };
  /** Per-avatar phase, so two moments never look identical. */
  seed: number;
}

const RAD = Math.PI / 180;

/** Smooth noise in -1..1 (a sum of incommensurate sines). */
export function wander(t: number, seed: number, speed = 1): number {
  const x = (t / 1000) * speed + seed;
  return (Math.sin(x * 1.3) + Math.sin(x * 0.71 + 1.7) * 0.6 + Math.sin(x * 2.9 + 4.1) * 0.25) / 1.85;
}

// ---------------- arms by direction ----------------

type Vec = [number, number, number];
type Quat = [number, number, number, number];

function norm(v: Vec): Vec {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The shortest rotation taking unit vector a to unit vector b (as three's Quaternion.setFromUnitVectors). */
export function fromUnitVectors(a: Vec, b: Vec): Quat {
  let r = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1;
  let q: Quat;
  if (r < 1e-6) {
    r = 0;
    q = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0, r] : [0, -a[2], a[1], r];
  } else {
    q = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], r];
  }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Euler XYZ in degrees of a quaternion (three's convention), and back. */
export function toEuler(q: Quat): Euler {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  const deg = 180 / Math.PI;
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33) * deg, ey * deg, Math.atan2(-m12, m11) * deg];
  return [Math.atan2(m32, m22) * deg, ey * deg, 0];
}

export function fromEuler(e: Euler): Quat {
  const [x, y, z] = e.map((a) => (a * Math.PI) / 360);
  const c1 = Math.cos(x);
  const c2 = Math.cos(y);
  const c3 = Math.cos(z);
  const s1 = Math.sin(x);
  const s2 = Math.sin(y);
  const s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** Rotates v by q. */
export function rotate(q: Quat, v: Vec): Vec {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), conj(q));
  return [r[0], r[1], r[2]];
}

/**
 * One arm posed by where its parts point (model space: +X the model's left =
 * the viewer's right, +Y up, +Z toward the viewer): the upper arm along
 * `upper`, the forearm along `lower`; `hand` adds a wrist rotation.
 */
export function arm(side: "left" | "right", upper: Vec, lower: Vec, hand?: Euler): Partial<Record<string, Euler>> {
  const rest: Vec = side === "left" ? [1, 0, 0] : [-1, 0, 0];
  const qu = fromUnitVectors(rest, norm(upper));
  const ql = fromUnitVectors(rest, norm(lower));
  const out: Partial<Record<string, Euler>> = {
    [`${side}UpperArm`]: toEuler(qu),
    // The forearm's rotation is relative to the upper arm
    [`${side}LowerArm`]: toEuler(qmul(conj(qu), ql)),
  };
  if (hand) out[`${side}Hand`] = hand;
  return out;
}

/** Both arms, the left one mirrored from the right one's directions. */
export function arms(upper: Vec, lower: Vec, hand?: Euler): Partial<Record<string, Euler>> {
  return {
    ...arm("right", upper, lower, hand),
    ...arm("left", [-upper[0], upper[1], upper[2]], [-lower[0], lower[1], lower[2]], hand ? [hand[0], -hand[1], -hand[2]] : undefined),
  };
}

/** Arms relaxed at the sides (an A-pose with the elbows a little bent), fingers softly curled. */
export const REST_ARMS: Partial<Record<string, Euler>> = {
  ...arms([-0.27, -0.96, 0.06], [-0.14, -0.95, 0.27], [0, 0, 4]),
  ...fingers("left", 14),
  ...fingers("right", 14),
};

/** Curls the four fingers by `deg` at each joint (left fingers curl with -Z, right with +Z). */
export function fingers(side: "left" | "right", deg: number, only?: string[]): Partial<Record<string, Euler>> {
  const out: Partial<Record<string, Euler>> = {};
  const z = side === "left" ? -deg : deg;
  for (const f of only ?? ["Index", "Middle", "Ring", "Little"]) {
    for (const joint of ["Proximal", "Intermediate", "Distal"]) out[`${side}${f}${joint}`] = [0, 0, z];
  }
  return out;
}

/** The resting pose at time t: breathing, a slow weight shift, the head drifting, plus the expression's posture. */
export function idlePose(p: IdleInput): BonePose {
  const t = p.t;
  const e = p.energy;
  // About 15 breaths a minute, a little faster when lively
  const breath = Math.sin((t / 4200) * Math.PI * 2 * (0.85 + 0.15 * e));
  const sway = wander(t, p.seed, 0.35 * e);
  const drift = (k: number, speed: number) => wander(t, p.seed + k, speed);
  const tremble = p.tremble ? p.tremble * Math.sin(t / 19) * Math.sin(t / 31) : 0;
  const nod = p.talk * (0.6 + 0.4 * drift(9, 2.2));
  const bones: Partial<Record<string, Euler>> = { ...REST_ARMS };
  bones.spine = [p.lean * 0.5 + breath * 0.6 + p.travel.vy * 4, sway * 1.2 * e, -sway * 1.5 * e - p.travel.vx * 6];
  bones.chest = [p.lean * 0.3 + breath * 0.9, 0, sway * 0.8 * e];
  bones.upperChest = [p.lean * 0.2 + breath * 0.7 + tremble * 1.5, 0, 0];
  const sh = p.shoulders + breath * 0.8 + tremble * 1.2;
  bones.leftShoulder = [0, 0, sh];
  bones.rightShoulder = [0, 0, -sh];
  bones.neck = [p.head[0] * 0.3 + drift(3, 0.5) * 1.2, p.head[1] * 0.3 + drift(4, 0.4) * 2 * e, p.head[2] * 0.3];
  bones.head = [
    p.head[0] * 0.7 + drift(5, 0.6) * 1.5 + nod * 4 + tremble * 2,
    p.head[1] * 0.7 + drift(6, 0.45) * 3 * e,
    p.head[2] * 0.7 + drift(7, 0.3) * 2 * e + sway * 1.5,
  ];
  // The arms hang a little away from the body as it sways
  const arm = REST_ARMS.leftUpperArm!;
  bones.leftUpperArm = [arm[0], arm[1], arm[2] - sway * 1.5 - p.travel.vx * 8 + tremble * 2];
  bones.rightUpperArm = [-arm[0], -arm[1], -arm[2] - sway * 1.5 - p.travel.vx * 8 - tremble * 2];
  return { bones, hipsY: breath * 0.002 };
}

// ---------------- gestures ----------------

export interface GestureKey {
  /** 0..1 of the gesture's duration. */
  t: number;
  pose: BonePose;
}

export interface GestureDef {
  ms: number;
  keys: GestureKey[];
  /** Blend in from the resting pose, and back out at the end (ms). */
  fadeIn: number;
  fadeOut: number;
}

const k = (t: number, bones: Partial<Record<string, Euler>>, hipsY?: number): GestureKey => ({ t, pose: { bones, ...(hipsY !== undefined ? { hipsY } : {}) } });

/** The same pose with left and right swapped (pointing or waving with the other hand). */
export function mirrorPose(pose: BonePose): BonePose {
  const bones: Partial<Record<string, Euler>> = {};
  for (const [name, e] of Object.entries(pose.bones)) {
    if (!e) continue;
    const other = name.startsWith("left") ? `right${name.slice(4)}` : name.startsWith("right") ? `left${name.slice(5)}` : name;
    bones[other] = [e[0], -e[1], -e[2]];
  }
  return { bones, ...(pose.hipsY !== undefined ? { hipsY: pose.hipsY } : {}) };
}

export function mirrorGesture(def: GestureDef): GestureDef {
  return { ...def, keys: def.keys.map((key) => ({ t: key.t, pose: mirrorPose(key.pose) })) };
}

// Right-handed gestures (the viewer sees them on the left); the one-handed ones are mirrored toward the screen's center
const WAVE_ARM = { rightUpperArm: [0, 20, -25] as Euler, rightHand: [0, 0, 0] as Euler };
const THINK = {
  ...arm("right", [-0.12, -0.72, 0.68], [0.42, 0.86, 0.28], [0, 0, -20]),
  ...arm("left", [0.15, -0.85, 0.5], [-0.82, -0.05, 0.56]),
  head: [-4, 4, 9] as Euler,
  ...fingers("right", 35),
};
const CROSS = {
  ...arm("right", [-0.2, -0.66, 0.72], [0.72, 0.3, 0.62]),
  ...arm("left", [0.2, -0.68, 0.7], [-0.72, 0.2, 0.66]),
  ...fingers("left", 40),
  ...fingers("right", 40),
  head: [-3, -6, 0] as Euler,
};
const SHRUG = {
  leftShoulder: [0, 0, 10] as Euler,
  rightShoulder: [0, 0, -10] as Euler,
  ...arms([-0.33, -0.93, 0.12], [-0.6, -0.05, 0.8], [-70, 0, 0]),
  head: [-2, 0, 9] as Euler,
};
const CHEER_UP = { ...arms([-0.45, 0.86, 0.22], [-0.18, 0.97, 0.15]), head: [-8, 0, 0] as Euler, ...fingers("left", 70), ...fingers("right", 70) };
const CHEER_PUMP = { ...CHEER_UP, ...arms([-0.62, 0.72, 0.3], [-0.3, 0.93, 0.2]) };
const CLAP_OPEN = arms([-0.1, -0.66, 0.74], [0.3, 0.35, 0.89]);
const CLAP_SHUT = arms([-0.1, -0.66, 0.74], [0.6, 0.35, 0.72]);
const FACEPALM = { ...arm("right", [-0.08, -0.55, 0.83], [0.2, 0.95, 0.25], [0, 0, -15]), head: [14, -4, 0] as Euler, neck: [6, 0, 0] as Euler };
const POINT = { ...arm("right", [-0.72, -0.1, 0.68], [-0.72, 0, 0.7]), ...fingers("right", 80, ["Middle", "Ring", "Little"]), ...fingers("right", 0, ["Index"]), head: [0, -12, 0] as Euler };

export const GESTURES: Record<string, GestureDef> = {
  wave: {
    ms: 1900,
    fadeIn: 300,
    fadeOut: 350,
    keys: [
      k(0, { ...WAVE_ARM, rightLowerArm: [0, 0, -75] }),
      k(0.22, { ...WAVE_ARM, rightLowerArm: [0, 0, -50] }),
      k(0.42, { ...WAVE_ARM, rightLowerArm: [0, 0, -95] }),
      k(0.62, { ...WAVE_ARM, rightLowerArm: [0, 0, -50] }),
      k(0.82, { ...WAVE_ARM, rightLowerArm: [0, 0, -95] }),
      k(1, { ...WAVE_ARM, rightLowerArm: [0, 0, -75] }),
    ],
  },
  nod: {
    ms: 950,
    fadeIn: 80,
    fadeOut: 150,
    keys: [k(0, { head: [0, 0, 0], neck: [0, 0, 0] }), k(0.25, { head: [14, 0, 0], neck: [5, 0, 0] }), k(0.5, { head: [-2, 0, 0], neck: [0, 0, 0] }), k(0.75, { head: [10, 0, 0], neck: [3, 0, 0] }), k(1, { head: [0, 0, 0], neck: [0, 0, 0] })],
  },
  shake_head: {
    ms: 1100,
    fadeIn: 80,
    fadeOut: 150,
    keys: [k(0, { head: [0, 0, 0] }), k(0.18, { head: [2, 18, 0] }), k(0.4, { head: [2, -18, 0] }), k(0.62, { head: [2, 14, 0] }), k(0.82, { head: [1, -9, 0] }), k(1, { head: [0, 0, 0] })],
  },
  shrug: { ms: 1500, fadeIn: 250, fadeOut: 400, keys: [k(0, SHRUG), k(1, SHRUG)] },
  think: { ms: 2800, fadeIn: 450, fadeOut: 500, keys: [k(0, THINK), k(1, THINK)] },
  point: { ms: 1900, fadeIn: 300, fadeOut: 400, keys: [k(0, POINT), k(1, POINT)] },
  bow: {
    ms: 1800,
    fadeIn: 200,
    fadeOut: 300,
    keys: [
      k(0, { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] }),
      k(0.35, { spine: [16, 0, 0], chest: [10, 0, 0], upperChest: [5, 0, 0], head: [10, 0, 0], neck: [5, 0, 0] }),
      k(0.65, { spine: [16, 0, 0], chest: [10, 0, 0], upperChest: [5, 0, 0], head: [10, 0, 0], neck: [5, 0, 0] }),
      k(1, { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] }),
    ],
  },
  cheer: { ms: 1600, fadeIn: 200, fadeOut: 400, keys: [k(0, CHEER_UP), k(0.3, CHEER_PUMP), k(0.55, CHEER_UP), k(0.8, CHEER_PUMP), k(1, CHEER_UP)] },
  clap: { ms: 1700, fadeIn: 250, fadeOut: 350, keys: [k(0, CLAP_OPEN), k(0.15, CLAP_SHUT), k(0.3, CLAP_OPEN), k(0.45, CLAP_SHUT), k(0.6, CLAP_OPEN), k(0.75, CLAP_SHUT), k(1, CLAP_OPEN)] },
  facepalm: { ms: 2000, fadeIn: 350, fadeOut: 450, keys: [k(0, FACEPALM), k(1, FACEPALM)] },
  cross_arms: { ms: 3500, fadeIn: 450, fadeOut: 550, keys: [k(0, CROSS), k(1, CROSS)] },
  tilt_head: { ms: 1600, fadeIn: 250, fadeOut: 350, keys: [k(0, { head: [-3, 0, 14], neck: [0, 0, 5] }), k(1, { head: [-3, 0, 14], neck: [0, 0, 5] })] },
  hop: {
    ms: 950,
    fadeIn: 60,
    fadeOut: 120,
    keys: [
      k(0, { leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0], leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0] }, 0),
      k(0.2, { leftUpperLeg: [-22, 0, 0], rightUpperLeg: [-22, 0, 0], leftLowerLeg: [40, 0, 0], rightLowerLeg: [40, 0, 0], leftFoot: [-18, 0, 0], rightFoot: [-18, 0, 0] }, -0.05),
      k(0.45, { leftUpperLeg: [-5, 0, 0], rightUpperLeg: [-5, 0, 0], leftLowerLeg: [12, 0, 0], rightLowerLeg: [12, 0, 0], leftFoot: [10, 0, 0], rightFoot: [10, 0, 0] }, 0.09),
      k(0.7, { leftUpperLeg: [-15, 0, 0], rightUpperLeg: [-15, 0, 0], leftLowerLeg: [28, 0, 0], rightLowerLeg: [28, 0, 0], leftFoot: [-13, 0, 0], rightFoot: [-13, 0, 0] }, -0.03),
      k(1, { leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0], leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0], leftFoot: [0, 0, 0], rightFoot: [0, 0, 0] }, 0),
    ],
  },
};

/** Gestures that are done with one hand: mirrored so the hand is on the side of the screen's center. */
export const HANDED = new Set(["wave", "point", "think", "facepalm"]);

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * The gesture at `ms` from its start: the pose between its keys (smoothed)
 * and its blend weight (fading in and out); null once it is over.
 */
export function sampleGesture(def: GestureDef, ms: number): { pose: BonePose; weight: number } | null {
  if (ms < 0 || ms > def.ms) return null;
  const u = ms / def.ms;
  let i = 0;
  while (i < def.keys.length - 2 && def.keys[i + 1].t <= u) i++;
  const a = def.keys[i];
  const b = def.keys[Math.min(i + 1, def.keys.length - 1)];
  const span = b.t - a.t;
  const f = span > 0 ? smooth(Math.min(1, Math.max(0, (u - a.t) / span))) : 0;
  const bones: Partial<Record<string, Euler>> = {};
  for (const name of new Set([...Object.keys(a.pose.bones), ...Object.keys(b.pose.bones)])) {
    const ea = a.pose.bones[name] ?? b.pose.bones[name]!;
    const eb = b.pose.bones[name] ?? ea;
    bones[name] = [ea[0] + (eb[0] - ea[0]) * f, ea[1] + (eb[1] - ea[1]) * f, ea[2] + (eb[2] - ea[2]) * f];
  }
  const ha = a.pose.hipsY;
  const hb = b.pose.hipsY ?? ha;
  const pose: BonePose = { bones, ...(ha !== undefined ? { hipsY: ha + ((hb ?? ha) - ha) * f } : {}) };
  const weight = Math.min(1, ms / Math.max(1, def.fadeIn), (def.ms - ms) / Math.max(1, def.fadeOut));
  return { pose, weight: smooth(Math.max(0, weight)) };
}

/** Blend weight of a clip of `durationMs` at `ms` with the given fades (user clips). */
export function clipWeight(durationMs: number, ms: number, fadeIn = 250, fadeOut = 300): number {
  if (ms < 0 || ms > durationMs) return 0;
  return smooth(Math.max(0, Math.min(1, ms / fadeIn, (durationMs - ms) / fadeOut)));
}

export function toRadians(e: Euler): Euler {
  return [e[0] * RAD, e[1] * RAD, e[2] * RAD];
}
