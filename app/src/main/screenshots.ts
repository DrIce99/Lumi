// look_at_screen: the sendScreenshots policy (never / ask with a bubble /
// always), the capture of the screen the user works on, and either the
// image for a model that sees, or a description written by the separate
// vision model. With Ollama nothing leaves the PC, so it never asks.
import type { Display } from "electron";
import { PROVIDERS } from "../shared/providers";
import type { Settings } from "../shared/types";
import type { LookResult } from "./brain/brain";
import type { ChatProvider } from "./brain/providers/types";
import { log } from "./log";
import type { Vision } from "./vision";

export interface ScreenshotHost {
  settings(): Settings;
  /** The model that will see the image: a separate vision model, or the chat model. */
  visionModel(): { provider: ChatProvider; model: string; separate: boolean } | null;
  /** Asks the user with a question bubble; resolves true when they allow it. */
  ask(question: string): Promise<boolean>;
  /** The display the user is working on. */
  display(): { display: Display; label: string };
  setLooking(looking: boolean): void;
}

const MAX_WIDTH = 1280;

export class Screenshots {
  constructor(
    private readonly host: ScreenshotHost,
    private readonly vision: Vision,
  ) {}

  async look(focus: string | undefined, requestedByUser: boolean): Promise<LookResult> {
    const settings = this.host.settings();
    const policy = settings.perception.sendScreenshots;
    const chosen = this.host.visionModel();
    if (!chosen) return { notes: ["No model that can see images is configured: rely on <screen>."], images: [] };
    const local = chosen.provider.id === "ollama";
    if (policy === "never") return { notes: ["The user doesn't allow screenshots: rely on the text in <screen>."], images: [] };
    if (policy === "ask" && !local) {
      const service = PROVIDERS[chosen.provider.id].name;
      const allowed = await this.host.ask(`Posso mandare uno screenshot dello schermo a ${service} per guardarlo?`);
      if (!allowed) return { notes: ["The user said no to the screenshot this time: rely on <screen>, and don't ask again right away."], images: [] };
    }
    const since = this.vision.sinceLastLook();
    if (!requestedByUser && since !== null && since < 60_000) {
      return { notes: [`You looked at the screen ${Math.round(since / 1000)} s ago: rely on what you saw.`], images: [] };
    }
    this.host.setLooking(true);
    try {
      const target = this.host.display();
      const [shot] = await this.vision.capture([target], MAX_WIDTH);
      if (!shot) return { notes: ["The screenshot failed."], images: [] };
      if (shot.unchanged && !requestedByUser) return { notes: [`${shot.label} looks the same as the last time you looked.`], images: [] };
      log.info(`Screenshot of ${shot.label} (${shot.width}x${shot.height}) for ${chosen.provider.id}/${chosen.model}`);
      if (!chosen.separate) return { notes: [], images: [{ label: `${shot.label}, ${shot.width}x${shot.height}`, jpegBase64: shot.jpegBase64 }] };
      // The chat model can't see: the vision model describes the screen in words
      const result = await chosen.provider.complete({
        model: chosen.model,
        system:
          "You describe a screenshot of a computer screen for an assistant that cannot see it. Be concrete and compact (at most 120 words): the application, what the user is doing, and the details relevant to the request. Quote short pieces of visible text exactly. Never transcribe passwords, private messages or personal data.",
        prompt: focus ? `What to look for: ${focus}` : "Describe what is on the screen.",
        images: [shot.jpegBase64],
        maxTokens: 400,
      });
      return { notes: [`What you see on ${shot.label}: ${result.text || "(no description)"}`], images: [] };
    } catch (err) {
      log.warn("look_at_screen failed", err);
      return { notes: ["Looking at the screen failed."], images: [] };
    } finally {
      setTimeout(() => this.host.setLooking(false), 800);
    }
  }
}
