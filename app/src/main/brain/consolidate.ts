// The memory's consolidation run by hand (Settings -> Memoria): what the
// settings window says about it. The work itself is Brain.consolidate(),
// Habits.reflect() and Memory.backup().

/** What the settings window says after a manual consolidation (Italian). */
export function consolidationReport(
  done: { episodes: number; facts: number; days: number; periods: number },
  habits: { added: number; faded: number } | null,
  hasModel: boolean,
): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (done.episodes) parts.push(`${n(done.episodes, "episodio riassunto", "episodi riassunti")}${done.facts ? ` (${n(done.facts, "fatto nuovo", "fatti nuovi")})` : ""}`);
  if (done.days) parts.push(n(done.days, "giorno nel diario", "giorni nel diario"));
  if (done.periods) parts.push(n(done.periods, "riassunto di settimana o mese", "riassunti di settimane o mesi"));
  if (habits && (habits.added || habits.faded)) parts.push(`abitudini: ${habits.added} nuove, ${habits.faded} meno sicure`);
  const what = parts.length ? `Fatto: ${parts.join(", ")}.` : "Era già tutto in ordine: niente di nuovo da riassumere.";
  const model = hasModel ? "" : " Senza un modello per i momenti autonomi (scheda Cervello) i riassunti sono solo le frasi dette.";
  return `${what}${model} Backup di oggi aggiornato.`;
}
