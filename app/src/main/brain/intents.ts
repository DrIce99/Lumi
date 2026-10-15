// What the user's words ask for, read with a few Italian cues: small
// models often *say* "te lo segno" or "eccolo" without calling remember
// or looking at the screen. When the words ask for it, the code reads the
// screen itself and holds the model to it (brain.ts). Pure, tested.

/** Words matched whole, case and accents as written by speech recognition. */
function cues(...list: string[]): RegExp {
  return new RegExp(String.raw`(?<!\p{L})(?:${list.join("|")})(?!\p{L})`, "iu");
}

const REMEMBER = cues(
  "ricorda(?:ti|telo|melo|lo|la|li|le)?",
  "ricordate(?:lo|la)?",
  "segna(?:ti|telo|lo|la)",
  "segnatelo",
  "memorizza(?:lo|la|li|le)?",
  "salva(?:ti|telo|lo|la)",
  "tieni(?:lo)? a mente",
  "non (?:te lo )?dimenticare",
  "prendi nota",
  "annota(?:ti|lo)?",
);

/** "Ti ricordi...?" asks about the past: not a request to remember. */
const ASKING_PAST = cues("ti ricordi", "ricordi (?:quando|cosa|che|come|il|la|lo|di)", "te lo ricordi", "ricordami (?:tra|alle|domani|fra|di)");

const SCREEN = cues(
  "schermo",
  "schermata",
  "monitor",
  "finestra",
  "guarda(?:ci|lo|la)?",
  "leggi(?:lo|la|li|le)?",
  "vedi(?:lo)?",
  "c'è scritto",
  "è scritto",
  "scritto (?:qui|lì|li|sopra|sotto|in)",
  "in (?:basso|alto) a (?:destra|sinistra)",
  "in (?:basso|alto)",
  "a (?:destra|sinistra) (?:in|dello|del)",
  "qui sopra",
  "qua sopra",
  "quello che vedo",
  "sul pc",
);

const MOVE = cues(
  "spostati",
  "sposta(?:rti|ti)",
  "muoviti",
  "vai (?:in|sul|sull'|sulla|a|al|alla|vicino|accanto|dall'altra)",
  "va' (?:in|sul|sull'|a)",
  "mettiti",
  "trasferisciti",
  "trasloca",
  "levati",
  "togliti",
  "scansati",
  "spostare",
  "starti sull'altro",
  "altro schermo",
  "altro monitor",
  "torna (?:al tuo posto|a posto|qui|indietro)",
  "stai ferma",
  "stai fermo",
  "smettila di muoverti",
  "basta muoverti",
  "non muoverti",
);

export interface Intents {
  /** The user asks Lumi to remember something (a fact, a number, a name). */
  remember: boolean;
  /** The user refers to something on the screen. */
  screen: boolean;
  /** The user asks Lumi to move (or to stop moving). */
  move: boolean;
}

export function readIntents(text: string): Intents {
  const t = text.normalize("NFC");
  return { remember: REMEMBER.test(t) && !ASKING_PAST.test(t), screen: SCREEN.test(t), move: MOVE.test(t) };
}

/** What a request needs: the tool, and what the model is told when it answered without calling it. */
export const PROMISES: { intent: "remember" | "move"; tool: string; nudge: string }[] = [
  {
    intent: "remember",
    tool: "remember",
    nudge:
      "The user asked you to remember something and you have not called remember: whatever you said, it is not saved. Call remember now with the exact thing (numbers and names copied exactly from the conversation or <screen_now>), then confirm briefly with say. If you can't find what to remember, say so and ask for it.",
  },
  {
    intent: "move",
    tool: "move_to",
    nudge:
      "The user asked you to move (or to stop moving) and you have not called move_to: whatever you said, you did not move. Call move_to now with the right place (other_screen, a corner, near_mouse, home, or stop). If the result says you couldn't move, tell the user why in a few words.",
  },
];
