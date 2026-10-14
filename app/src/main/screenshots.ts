// look_at_screen and attached images. First choice: the local vision model
// (perception/vision.ts), which describes the image in words, so nothing
// leaves the PC and the brain only reads text. Without it (or if it fails),
// the image goes to an online model only as sendScreenshots allows
// (never / ask with a bubble / always); otherwise Lumi relies on the text
// the local OCR reads.
import type { Display } from "electron";
import { PROVIDERS } from "../shared/providers";
import type { Settings } from "../shared/types";
import type { LookResult } from "./brain/brain";
import type { ChatProvider } from "./brain/providers/types";
import { log } from "./log";
import { askVision, describeForBrain, regionRect, VisionError, visionPrompt, type Rect, type VisionClientOptions } from "./perception/vision";
import type { Vision } from "./vision";

export interface LookArea {
  display: Display;
  /** What to capture, screen DIP: the active window or its whole display. */
  rect: Rect;
  label: string;
}

export interface ScreenshotHost {
  settings(): Settings;
  /** Why perception is paused (an app on the pause list, a private window, locked...), or null. */
  paused(): string | null;
  /** The local vision model, when one is configured. */
  localVision(): VisionClientOptions | null;
  /** An online model that can take an image (for when there is no local one); `separate`: not the chat model. */
  remoteModel(): { provider: ChatProvider; model: string; separate: boolean } | null;
  /** Asks the user with a question bubble; resolves true when they allow it. */
  ask(question: string): Promise<boolean>;
  area(): LookArea;
  /** Lines the local OCR reads in a screen area (DIP); empty when unavailable. */
  ocr(rect: Rect): Promise<string[]>;
  /** Things the vision model pointed out (screen DIP): the eyes can go there, look_at can find them. */
  seen(regions: { label: string; rect: Rect }[]): void;
  /** The local vision model is missing or its server is down: tell the user (rarely). */
  visionProblem(message: string): void;
  setLooking(looking: boolean): void;
}

const REMOTE_MAX_SIDE = 1280;
/** A window smaller than this share of its display is captured alone: more detail for small vision models. */
const CROP_BELOW = 0.5;

/** The active window (clipped to its display) when it is small enough to crop to, else null (the whole display). */
export function lookArea(window: Rect, display: Rect): Rect | null {
  const x = Math.max(window.x, display.x);
  const y = Math.max(window.y, display.y);
  const width = Math.min(window.x + window.width, display.x + display.width) - x;
  const height = Math.min(window.y + window.height, display.y + display.height) - y;
  if (width < 200 || height < 150) return null;
  return width * height < CROP_BELOW * display.width * display.height ? { x, y, width, height } : null;
}
const MAX_OCR_NOTE = 1500;

export class Screenshots {
  constructor(
    private readonly host: ScreenshotHost,
    private readonly vision: Vision,
  ) {}

  /**
   * An image the user attached (command bar), described in words. Attaching
   * it is the user's own choice, so "ask" doesn't ask again; "never" still
   * keeps it off online services.
   */
  async describeImage(name: string, jpegBase64: string, request: string): Promise<string> {
    const local = this.host.localVision();
    if (local) {
      try {
        log.info(`Attached image ${name} for local ${local.provider}/${local.model}`);
        const result = await askVision(local, jpegBase64, visionPrompt(request, []));
        return describeForBrain({ ...result, regions: [] }, "the attached image");
      } catch (err) {
        this.report(err);
      }
    }
    const chosen = this.host.remoteModel();
    if (!chosen) return "(no model that can see images is available: you can't see it)";
    if (this.host.settings().perception.sendScreenshots === "never" && chosen.provider.id !== "ollama") {
      return "(there is no local vision model and the user doesn't allow sending images online: you can't see it)";
    }
    try {
      log.info(`Attached image ${name} for ${chosen.provider.id}/${chosen.model}`);
      const result = await chosen.provider.complete({
        model: chosen.model,
        system:
          "You describe an image the user attached, for an assistant that cannot see it. Be concrete and compact (at most 150 words): what it shows and the details relevant to the request. Quote visible text exactly.",
        prompt: request ? `The user's request: ${request}` : "Describe the image.",
        images: [jpegBase64],
        maxTokens: 500,
      });
      return `What the image shows: ${result.text || "(no description)"}`;
    } catch (err) {
      log.warn("Describing an attached image failed", err);
      return "(looking at the image failed)";
    }
  }

  async look(focus: string | undefined, requestedByUser: boolean): Promise<LookResult> {
    const since = this.vision.sinceLastLook();
    if (!requestedByUser && since !== null && since < 60_000) {
      return { notes: [`You looked at the screen ${Math.round(since / 1000)} s ago: rely on what you saw.`], images: [] };
    }
    const paused = this.host.paused();
    if (paused) return { notes: [`You can't look at the screen now: ${paused}.`], images: [] };
    this.host.setLooking(true);
    try {
      const area = this.host.area();
      const local = this.host.localVision();
      if (local) {
        const settings = this.host.settings();
        const [shot] = await this.vision.capture([area], settings.vision.maxSide);
        if (!shot) return { notes: ["The screenshot failed."], images: [] };
        if (shot.unchanged && !requestedByUser) return { notes: [`${area.label} looks the same as the last time you looked.`], images: [] };
        const ocr = await this.host.ocr(area.rect).catch(() => []);
        try {
          log.info(`Screenshot of ${area.label} (${shot.width}x${shot.height}) for local ${local.provider}/${local.model}`);
          const result = await askVision(local, shot.jpegBase64, visionPrompt(focus ?? "", ocr));
          this.host.seen(result.regions.map((r) => ({ label: r.label, rect: regionRect(r, area.rect) })));
          return { notes: [describeForBrain(result, area.label)], images: [] };
        } catch (err) {
          this.report(err);
          return await this.remote(area, focus, ocr);
        }
      }
      return await this.remote(area, focus, null);
    } catch (err) {
      log.warn("look_at_screen failed", err);
      return { notes: ["Looking at the screen failed."], images: [] };
    } finally {
      setTimeout(() => this.host.setLooking(false), 800);
    }
  }

  /** No local vision (or it failed): an online model if the policy allows, else the OCR text. */
  private async remote(area: LookArea, focus: string | undefined, ocrDone: string[] | null): Promise<LookResult> {
    const policy = this.host.settings().perception.sendScreenshots;
    const chosen = this.host.remoteModel();
    const ocrOnly = async (why: string): Promise<LookResult> => {
      const lines = ocrDone ?? (await this.host.ocr(area.rect).catch(() => []));
      const text = lines.join("\n").slice(0, MAX_OCR_NOTE);
      return { notes: [text ? `${why} Text the local OCR reads on ${area.label}:\n${text}` : `${why} Rely on the text in <screen>.`], images: [] };
    };
    if (!chosen) return ocrOnly("No model that can see images is available.");
    const local = chosen.provider.id === "ollama";
    if (policy === "never" && !local) return ocrOnly("There is no local vision model and the user doesn't allow screenshots online.");
    if (policy === "ask" && !local) {
      const service = PROVIDERS[chosen.provider.id].name;
      const allowed = await this.host.ask(`Posso mandare uno screenshot dello schermo a ${service} per guardarlo?`);
      if (!allowed) return ocrOnly("The user said no to the screenshot this time (don't ask again right away).");
    }
    const [shot] = await this.vision.capture([area], REMOTE_MAX_SIDE);
    if (!shot) return { notes: ["The screenshot failed."], images: [] };
    log.info(`Screenshot of ${area.label} (${shot.width}x${shot.height}) for ${chosen.provider.id}/${chosen.model}`);
    if (!chosen.separate) return { notes: [], images: [{ label: `${area.label}, ${shot.width}x${shot.height}`, jpegBase64: shot.jpegBase64 }] };
    // The chat model can't see: the online vision model describes the screen in words
    const result = await chosen.provider.complete({
      model: chosen.model,
      system:
        "You describe a screenshot of a computer screen for an assistant that cannot see it. Be concrete and compact (at most 120 words): the application, what the user is doing, and the details relevant to the request. Quote short pieces of visible text exactly. Never transcribe passwords, private messages or personal data.",
      prompt: focus ? `What to look for: ${focus}` : "Describe what is on the screen.",
      images: [shot.jpegBase64],
      maxTokens: 400,
    });
    return { notes: [`What you see on ${area.label}: ${result.text || "(no description)"}`], images: [] };
  }

  private report(err: unknown): void {
    log.warn("Local vision failed", err);
    if (!(err instanceof VisionError)) return;
    const local = this.host.localVision();
    if (err.kind === "missing" && local) this.host.visionProblem(`Il modello di visione ${local.model} non c'è: scaricalo con "ollama pull ${local.model}".`);
    else if (err.kind === "offline") this.host.visionProblem("Il servizio della visione locale non risponde: Ollama è avviato?");
  }
}
