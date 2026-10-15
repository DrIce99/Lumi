// Where Lumi goes when it moves: a named place ("top_right", "near_text",
// "out_of_the_way"...) becomes the face's top-left corner (anchor), in
// screen DIP. The model never sends coordinates. Pure, tested.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PLACES = [
  "top_left",
  "top",
  "top_right",
  "left",
  "center",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
  "other_screen",
  "near_text",
  "near_mouse",
  "out_of_the_way",
  "home",
] as const;
export type Place = (typeof PLACES)[number];

export interface PlaceContext {
  /** The face's size (DIP). */
  size: { width: number; height: number };
  /** Where the face is now (anchor = its top-left corner). */
  anchor: Point;
  /** The work areas of the displays (no taskbar), in Windows' order. */
  areas: Rect[];
  /** The user's own place for Lumi (the last position they dragged it to). */
  home: Point | null;
  mouse: Point;
  /** Things not to cover: the active window while typing, the caret, the mouse. */
  avoid: Rect[];
  /** near_text: where that text is on screen. */
  target?: Rect | null;
}

/** Distance from the work area's edges. */
export const MARGIN = 24;
/** near_text / near_mouse: the gap between the face and what it stands next to. */
const GAP = 16;

export function rectOf(anchor: Point, size: { width: number; height: number }): Rect {
  return { x: anchor.x, y: anchor.y, width: size.width, height: size.height };
}

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(area: Rect, p: Point): boolean {
  return p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height;
}

/** The index of the display a point is on (else the nearest one). */
export function areaIndex(areas: Rect[], p: Point): number {
  const inside = areas.findIndex((a) => contains(a, p));
  if (inside >= 0) return inside;
  let best = 0;
  let bestDistance = Infinity;
  areas.forEach((a, i) => {
    const c = center(a);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/** Keeps the whole face inside an area, MARGIN from its edges when there is room. */
export function clampInside(anchor: Point, size: { width: number; height: number }, area: Rect): Point {
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  return {
    x: Math.round(clamp(anchor.x, area.x + MARGIN, area.x + area.width - size.width - MARGIN)),
    y: Math.round(clamp(anchor.y, area.y + MARGIN, area.y + area.height - size.height - MARGIN)),
  };
}

/** One of the nine fixed places of an area (corners, edges' middles, center). */
export function gridPlace(place: Place, size: { width: number; height: number }, area: Rect): Point | null {
  const col = { left: 0, center: 1, right: 2 } as const;
  const parts: Partial<Record<Place, [number, number]>> = {
    top_left: [col.left, 0],
    top: [col.center, 0],
    top_right: [col.right, 0],
    left: [col.left, 1],
    center: [col.center, 1],
    right: [col.right, 1],
    bottom_left: [col.left, 2],
    bottom: [col.center, 2],
    bottom_right: [col.right, 2],
  };
  const cell = parts[place];
  if (!cell) return null;
  const xs = [area.x + MARGIN, area.x + (area.width - size.width) / 2, area.x + area.width - size.width - MARGIN];
  const ys = [area.y + MARGIN, area.y + (area.height - size.height) / 2, area.y + area.height - size.height - MARGIN];
  return clampInside({ x: xs[cell[0]], y: ys[cell[1]] }, size, area);
}

/** Beside a rectangle: right, left, below or above it, the first that fits in its area without covering it. */
export function beside(target: Rect, size: { width: number; height: number }, area: Rect): Point {
  const midY = target.y + target.height / 2 - size.height / 2;
  const midX = target.x + target.width / 2 - size.width / 2;
  const options: Point[] = [
    { x: target.x + target.width + GAP, y: midY },
    { x: target.x - size.width - GAP, y: midY },
    { x: midX, y: target.y + target.height + GAP },
    { x: midX, y: target.y - size.height - GAP },
  ];
  for (const o of options) {
    const placed = clampInside(o, size, area);
    if (!intersects(rectOf(placed, size), target)) return placed;
  }
  return clampInside(options[0], size, area);
}

/**
 * The free spot closest to where the face is: the nine places of its
 * display, scored by how far they are, never on what must not be covered.
 */
export function outOfTheWay(ctx: PlaceContext): Point {
  const area = ctx.areas[areaIndex(ctx.areas, center(rectOf(ctx.anchor, ctx.size)))];
  const grid = PLACES.slice(0, 9).map((p) => gridPlace(p, ctx.size, area)!);
  const free = grid.filter((p) => !ctx.avoid.some((r) => intersects(rectOf(p, ctx.size), r)));
  const pool = free.length ? free : grid;
  const distance = (p: Point) => Math.hypot(p.x - ctx.anchor.x, p.y - ctx.anchor.y);
  // Not where it already is (it is in the way there)
  const moved = pool.filter((p) => distance(p) > Math.max(ctx.size.width, ctx.size.height));
  return (moved.length ? moved : pool).sort((a, b) => distance(a) - distance(b))[0];
}

/** Where a named place is; null when it can't be resolved (near_text without the text, home never set). */
export function placeAnchor(place: Place, ctx: PlaceContext): Point | null {
  if (!ctx.areas.length) return null;
  const here = areaIndex(ctx.areas, center(rectOf(ctx.anchor, ctx.size)));
  const area = ctx.areas[here];
  switch (place) {
    case "home":
      return ctx.home ? clampInside(ctx.home, ctx.size, ctx.areas[areaIndex(ctx.areas, center(rectOf(ctx.home, ctx.size)))]) : null;
    case "near_text": {
      if (!ctx.target) return null;
      return beside(ctx.target, ctx.size, ctx.areas[areaIndex(ctx.areas, center(ctx.target))]);
    }
    case "near_mouse": {
      const mouse = { x: ctx.mouse.x, y: ctx.mouse.y, width: 1, height: 1 };
      // Down and to the right of the pointer, without covering it
      const a = ctx.areas[areaIndex(ctx.areas, ctx.mouse)];
      const placed = clampInside({ x: ctx.mouse.x + 40, y: ctx.mouse.y + 30 }, ctx.size, a);
      return intersects(rectOf(placed, ctx.size), { ...mouse, x: mouse.x - 8, y: mouse.y - 8, width: 16, height: 16 })
        ? clampInside({ x: ctx.mouse.x - ctx.size.width - 40, y: ctx.mouse.y - ctx.size.height - 30 }, ctx.size, a)
        : placed;
    }
    case "other_screen": {
      if (ctx.areas.length < 2) return null;
      const next = ctx.areas[(here + 1) % ctx.areas.length];
      // The same relative place on the next display
      const rx = (ctx.anchor.x - area.x) / Math.max(1, area.width - ctx.size.width);
      const ry = (ctx.anchor.y - area.y) / Math.max(1, area.height - ctx.size.height);
      return clampInside({ x: next.x + rx * (next.width - ctx.size.width), y: next.y + ry * (next.height - ctx.size.height) }, ctx.size, next);
    }
    case "out_of_the_way":
      return outOfTheWay(ctx);
    default:
      return gridPlace(place, ctx.size, area);
  }
}
