// Reading simulation: when new text appears, the eyes go through it the way
// a person reads. Fixations every 7-9 characters along the line, 200-250 ms
// each (about 250 words per minute), a quick return to the start of the
// next line, small random regressions (10%), at most ~6 lines. Pure, tested.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReadLine {
  text: string;
  rect: Rect;
  words?: { text: string; rect: Rect }[];
}

export interface Fixation {
  x: number;
  y: number;
  ms: number;
  line: number;
}

export const MAX_LINES = 6;

/** Horizontal position of character `index` in a line (word boxes when known, else proportional). */
export function charX(line: ReadLine, index: number): number {
  const text = line.text;
  if (line.words?.length) {
    let pos = 0;
    for (const word of line.words) {
      const start = text.indexOf(word.text, pos);
      if (start < 0) continue;
      const end = start + word.text.length;
      if (index <= end) {
        const within = Math.max(0, Math.min(1, (index - start) / Math.max(1, word.text.length)));
        return word.rect.x + word.rect.width * within;
      }
      pos = end;
    }
  }
  return line.rect.x + line.rect.width * Math.max(0, Math.min(1, index / Math.max(1, text.length)));
}

/** The sequence of fixations to read `lines`, top to bottom. */
export function readingPlan(lines: ReadLine[], random: () => number = Math.random, maxLines = MAX_LINES): Fixation[] {
  const plan: Fixation[] = [];
  lines.slice(0, maxLines).forEach((line, lineIndex) => {
    const length = line.text.trim().length;
    if (!length) return;
    const y = line.rect.y + line.rect.height / 2;
    const points: number[] = [];
    // The first fixation lands a few characters into the line, not on its edge
    for (let i = Math.min(3, length - 1); i < length; i += 7 + Math.floor(random() * 3)) points.push(i);
    if (points[points.length - 1] < length - 4) points.push(length - 2);
    for (let k = 0; k < points.length; k++) {
      plan.push({ x: Math.round(charX(line, points[k])), y: Math.round(y), ms: 200 + Math.round(random() * 50), line: lineIndex });
      // Now and then the eyes jump back a little to re-read
      if (k > 0 && random() < 0.1) {
        plan.push({ x: Math.round(charX(line, points[k - 1])), y: Math.round(y), ms: 180 + Math.round(random() * 40), line: lineIndex });
      }
    }
  });
  return plan;
}

/** Reading time of a plan, ms. */
export function planDuration(plan: Fixation[]): number {
  return plan.reduce((sum, f) => sum + f.ms, 0);
}
