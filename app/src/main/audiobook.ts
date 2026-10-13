// Audiobook mode: the same voice engine turns a .txt or .epub into an
// audio file with chapters (M4B through ffmpeg, else WAV). The sidecar does
// the work; this module picks the files, follows the progress and says
// when it's done.
import { app, dialog, shell } from "electron";
import { basename, extname, join } from "node:path";
import type { Settings } from "../shared/types";
import { log } from "./log";
import type { Sidecar } from "./sidecar";

interface Job {
  id: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  title: string;
  error: string | null;
  file: string | null;
}

const MALE = new Set(["ryan", "aiden", "eric", "dylan", "uncle_fu", "im_nicola"]);

/** A second voice for dialogue, contrasting with the narrator's. */
export function dialogueVoice(settings: Settings): string | undefined {
  const { engine, model, voice } = settings.tts;
  if (engine === "kokoro") return voice === "if_sara" ? "im_nicola" : "if_sara";
  if (engine === "qwen3" && /CustomVoice/i.test(model)) return MALE.has(voice) ? "serena" : "ryan";
  return undefined;
}

export class Audiobooks {
  private job: Job | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sidecar: Sidecar,
    private readonly settings: () => Settings,
    private readonly notify: (text: string) => void,
    private readonly changed: () => void,
  ) {}

  /** One line for the tray while a book is being made. */
  status(): string | null {
    const j = this.job;
    if (!j || (j.state !== "running" && j.state !== "queued")) return null;
    return `Audiolibro: ${j.total ? Math.floor((j.done / j.total) * 100) : 0}%`;
  }

  running(): boolean {
    return this.status() !== null;
  }

  async create(): Promise<void> {
    if (this.running()) {
      this.notify("Sto già preparando un audiolibro: aspetta che finisca, oppure annullalo dal menu.");
      return;
    }
    if (!this.sidecar.endpoint()) {
      this.notify("Per gli audiolibri servono i motori della voce, che ora non sono attivi.");
      return;
    }
    const open = await dialog.showOpenDialog({
      title: "Scegli un libro da leggere",
      filters: [{ name: "Libri", extensions: ["epub", "txt"] }],
      properties: ["openFile"],
    });
    const source = open.filePaths[0];
    if (open.canceled || !source) return;
    const save = await dialog.showSaveDialog({
      title: "Dove salvo l'audiolibro?",
      defaultPath: join(app.getPath("documents"), `${basename(source, extname(source))}.m4b`),
      filters: [
        { name: "Audiolibro M4B", extensions: ["m4b"] },
        { name: "MP3", extensions: ["mp3"] },
        { name: "WAV", extensions: ["wav"] },
      ],
    });
    if (save.canceled || !save.filePath) return;
    try {
      this.job = await this.sidecar.request<Job>("/tts/batch", { source, output: save.filePath, dialogueVoice: dialogueVoice(this.settings()) }, 30_000);
    } catch (err) {
      log.warn("Starting the audiobook failed", err);
      this.notify("Non sono riuscito a iniziare l'audiolibro: i dettagli sono nel log.");
      return;
    }
    this.notify(`Inizio a registrare "${basename(source)}". Ti avviso quando è pronto.`);
    this.poll();
  }

  async cancel(): Promise<void> {
    if (this.job) await fetchDelete(this.sidecar, `/tts/batch/${this.job.id}`);
  }

  private poll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const job = this.job;
      if (!job) return;
      try {
        this.job = await this.sidecar.request<Job>(`/tts/batch/${job.id}`, undefined, 10_000);
      } catch {
        // the sidecar may be restarting: try again
      }
      this.changed();
      const j = this.job!;
      if (j.state === "done" && j.file) {
        this.notify(`L'audiolibro "${j.title}" è pronto!`);
        shell.showItemInFolder(j.file);
      } else if (j.state === "error") {
        this.notify(`L'audiolibro non è riuscito: ${j.error ?? "errore sconosciuto"}.`);
      } else if (j.state === "cancelled") {
        this.notify("Audiolibro annullato.");
      } else {
        this.poll();
      }
    }, 3000);
  }
}

async function fetchDelete(sidecar: Sidecar, path: string): Promise<void> {
  const url = sidecar.endpoint();
  if (!url) return;
  await fetch(`${url.url}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${url.token}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}
