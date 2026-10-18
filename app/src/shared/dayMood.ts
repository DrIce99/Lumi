// Lumi's mood of the day: drawn every morning with the weights in the
// settings, changed only by what the user does (main/brain/dayMood.ts).
//
// The moods form a tree rooted at "tranquilla": a change moves one step at a
// time, toward calm (the parent) or deeper into a mood (a child). So an angry
// Lumi goes arrabbiata -> irritata -> tranquilla -> allegra, never straight
// from anger to joy.

export const DAY_MOODS = ["tranquilla", "allegra", "entusiasta", "annoiata", "malinconica", "triste", "irritata", "arrabbiata"] as const;
export type DayMoodId = (typeof DAY_MOODS)[number];

export type MoodWeights = Record<DayMoodId, number>;

/** Each mood's parent, one step closer to calm (null: the root). */
export const MOOD_PARENT: Record<DayMoodId, DayMoodId | null> = {
  tranquilla: null,
  allegra: "tranquilla",
  entusiasta: "allegra",
  annoiata: "tranquilla",
  malinconica: "tranquilla",
  triste: "malinconica",
  irritata: "tranquilla",
  arrabbiata: "irritata",
};

/** +2 very good ... -2 very bad: what "better" and "worse" mean. */
export const MOOD_VALENCE: Record<DayMoodId, number> = {
  tranquilla: 0,
  allegra: 1,
  entusiasta: 2,
  annoiata: -1,
  malinconica: -1,
  triste: -2,
  irritata: -1,
  arrabbiata: -2,
};

/** Labels for the settings window. */
export const MOOD_LABEL: Record<DayMoodId, string> = {
  tranquilla: "Tranquilla",
  allegra: "Allegra",
  entusiasta: "Entusiasta",
  annoiata: "Annoiata",
  malinconica: "Malinconica",
  triste: "Triste",
  irritata: "Irritata",
  arrabbiata: "Arrabbiata",
};

/** Mostly good days, a bad one now and then (0-10 each). */
export const DEFAULT_MOOD_WEIGHTS: MoodWeights = {
  tranquilla: 6,
  allegra: 5,
  entusiasta: 2,
  annoiata: 2,
  malinconica: 2,
  triste: 1,
  irritata: 2,
  arrabbiata: 1,
};

export function isDayMood(value: unknown): value is DayMoodId {
  return typeof value === "string" && (DAY_MOODS as readonly string[]).includes(value);
}
