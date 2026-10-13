// Screenshots for look_at_screen, with change detection so an unchanged
// screen doesn't cost another image. Only taken on demand, never in the
// background; Lumi's own window is not in them (content protection).
import { desktopCapturer, type Display, type NativeImage } from "electron";
import { log } from "./log";

export interface Screenshot {
  label: string;
  jpegBase64: string;
  width: number;
  height: number;
  /** Nearly identical to the previous capture of the same screen. */
  unchanged: boolean;
}

const SIGNATURE_W = 32;
const SIGNATURE_H = 18;
const UNCHANGED_THRESHOLD = 2.5;

export class Vision {
  private readonly signatures = new Map<number, Uint8Array>();
  private lastLook = 0;

  /** Milliseconds since the last capture, or null if never. */
  sinceLastLook(): number | null {
    return this.lastLook ? Date.now() - this.lastLook : null;
  }

  async capture(targets: { display: Display; label: string }[], maxWidth: number): Promise<Screenshot[]> {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: maxWidth, height: maxWidth }, fetchWindowIcons: false });
    this.lastLook = Date.now();
    const shots: Screenshot[] = [];
    for (const [index, { display, label }] of targets.entries()) {
      const source = sources.find((s) => s.display_id === String(display.id)) ?? (targets.length === 1 && sources.length === 1 ? sources[0] : sources[index]);
      if (!source || source.thumbnail.isEmpty()) {
        log.warn(`No capture available for display ${display.id}`);
        continue;
      }
      let image = source.thumbnail;
      if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
      const { width, height } = image.getSize();
      shots.push({ label, jpegBase64: image.toJPEG(75).toString("base64"), width, height, unchanged: this.compareAndStore(display.id, image) });
    }
    return shots;
  }

  private compareAndStore(displayId: number, image: NativeImage): boolean {
    // Tiny grayscale thumbnail as a cheap fingerprint of the screen
    const bitmap = image.resize({ width: SIGNATURE_W, height: SIGNATURE_H, quality: "good" }).toBitmap();
    const signature = new Uint8Array(SIGNATURE_W * SIGNATURE_H);
    for (let i = 0; i < signature.length; i++) signature[i] = Math.round((bitmap[i * 4] + bitmap[i * 4 + 1] + bitmap[i * 4 + 2]) / 3);
    const previous = this.signatures.get(displayId);
    this.signatures.set(displayId, signature);
    if (!previous) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) diff += Math.abs(signature[i] - previous[i]);
    return diff / signature.length < UNCHANGED_THRESHOLD;
  }
}
