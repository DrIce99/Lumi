// What Whisper invents on silence or noise ("Grazie a tutti", subtitle
// credits), for the recognizers that run in the app (Groq). Same rules as
// the sidecar's stt/base.py: an RMS gate before transcribing and a phrase
// filter after. Pure, tested.

const HALLUCINATIONS = [
  /sottotitoli (creati|a cura|e revisione)/,
  /amara\.org/,
  /grazie (a tutti )?per (la visione|l'ascolto|l'attenzione|aver guardato)/,
  /^\W*grazie (a tutti|mille)\W*$/,
  /iscriviti al canale/,
  /ci vediamo (al|nel) prossimo/,
  /^\W*(alla prossima|buona visione)\W*$/,
  /^\W*[[(]?(musica|applausi|risate)[\])]?\W*$/,
  /qtss/,
  /^\W*(grazie|ciao)\W*$/,
  /^\W*(\.\.\.|…)\W*$/,
];

/** Below this loudness (RMS, 0..1) the audio is silence: nothing to transcribe. */
export const SILENCE_RMS = 0.0025;

/** Whether PCM 16-bit mono audio is silence. */
export function isSilence(pcm: Uint8Array): boolean {
  const samples = Math.floor(pcm.byteLength / 2);
  if (!samples) return true;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples) < SILENCE_RMS;
}

/** Drops typical hallucinations; a lone "grazie" or "ciao" is kept only when there was enough audio for it. */
export function cleanTranscript(text: string, audioSeconds: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (HALLUCINATIONS.some((re) => re.test(lower)) && !(audioSeconds > 0.6 && /^\W*(grazie|ciao)\W*$/.test(lower))) return "";
  return t;
}
