// "Look at X": finds a piece of text the model mentions among what Lumi can
// read on the screen (OCR lines and words, the focused element, the window
// title), approximately, so typos and OCR mistakes still match. Much cheaper
// than asking a vision model for coordinates. Pure, tested.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextItem {
  text: string;
  rect: Rect;
  words?: { text: string; rect: Rect }[];
}

export interface Match {
  rect: Rect;
  score: number;
  text: string;
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Similarity 0..1 of two short strings (1 - normalized edit distance). */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function union(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The best place on screen for `query`, or null when nothing is similar enough. */
export function findText(query: string, items: TextItem[], minScore = 0.72): Match | null {
  const q = normalizeText(query);
  if (!q) return null;
  const qWords = q.split(" ");
  let best: Match | null = null;
  const consider = (score: number, rect: Rect, text: string) => {
    if (!best || score > best.score) best = { rect, score, text };
  };
  for (const item of items) {
    const line = normalizeText(item.text);
    if (!line) continue;
    const words = item.words?.length ? item.words : null;
    if (line.includes(q)) {
      // Exact: narrow down to the words that contain it when we know them
      if (words) {
        const normalized = words.map((w) => normalizeText(w.text));
        for (let i = 0; i < normalized.length; i++) {
          const span: number[] = [];
          let joined = "";
          for (let j = i; j < normalized.length && joined.length < q.length + 2; j++) {
            joined = joined ? `${joined} ${normalized[j]}` : normalized[j];
            span.push(j);
            if (joined.includes(q)) {
              // Drop leading words that are not part of the match
              while (span.length > 1 && span.slice(1).map((k) => normalized[k]).join(" ").includes(q)) span.shift();
              consider(1, union(span.map((k) => words[k].rect)), item.text);
              break;
            }
          }
          if (best && (best as Match).score === 1) break;
        }
      }
      consider(0.99, item.rect, item.text);
      continue;
    }
    // Approximate: compare against windows of as many words as the query
    const lineWords = line.split(" ");
    const size = qWords.length;
    for (let i = 0; i + size <= lineWords.length || (i === 0 && lineWords.length < size); i++) {
      const window = lineWords.slice(i, i + size).join(" ");
      const score = similarity(q, window);
      if (score < minScore) continue;
      const rect = words && words.length === lineWords.length ? union(words.slice(i, i + size).map((w) => w.rect)) : item.rect;
      consider(score, rect, item.text);
      if (lineWords.length < size) break;
    }
  }
  return best && (best as Match).score >= minScore ? best : null;
}
