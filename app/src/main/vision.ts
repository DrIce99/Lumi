// Screenshots for look_at_screen, with change detection so an unchanged
// screen doesn't cost another image. Only taken on demand, never in the
// background; Lumi's own window is not in them (content protection).
// The sidecar takes them: desktopCapturer.getSources blocks the main
// thread, and with it the click-through mouse hook and the system pointer.
import { nativeImage, type Display, type NativeImage } from "electron";
import { log } from "./log";
import type { Rect } from "./perception/vision";

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
  private readonly signatures = new Map<string, Uint8Array>();
  private lastLook = 0;

  /** `grab` returns a JPEG of `rect` (screen DIP, on `display`), at most `maxSide` pixels wide or high. */
  constructor(private readonly grab: (display: Display, maxSide: number, rect: Rect) => Promise<Buffer>) {}

  /** Milliseconds since the last capture, or null if never. */
  sinceLastLook(): number | null {
    return this.lastLook ? Date.now() - this.lastLook : null;
  }

  /** Captures each target: its `rect` (screen DIP), or the whole display. */
  async capture(targets: { display: Display; label: string; rect?: Rect }[], maxSide: number): Promise<Screenshot[]> {
    this.lastLook = Date.now();
    const shots: Screenshot[] = [];
    for (const { display, label, rect = display.bounds } of targets) {
      let jpeg: Buffer;
      try {
        jpeg = await this.grab(display, maxSide, rect);
      } catch (err) {
        log.warn(`No capture available for display ${display.id}`, err);
        continue;
      }
      const image = nativeImage.createFromBuffer(jpeg);
      if (image.isEmpty()) continue;
      const { width, height } = image.getSize();
      const key = `${display.id}:${rect.x},${rect.y},${rect.width},${rect.height}`;
      shots.push({ label, jpegBase64: jpeg.toString("base64"), width, height, unchanged: this.compareAndStore(key, image) });
    }
    return shots;
  }

  private compareAndStore(key: string, image: NativeImage): boolean {
    // Tiny grayscale thumbnail as a cheap fingerprint of the screen
    const bitmap = image.resize({ width: SIGNATURE_W, height: SIGNATURE_H, quality: "good" }).toBitmap();
    const signature = new Uint8Array(SIGNATURE_W * SIGNATURE_H);
    for (let i = 0; i < signature.length; i++) signature[i] = Math.round((bitmap[i * 4] + bitmap[i * 4 + 1] + bitmap[i * 4 + 2]) / 3);
    const previous = this.signatures.get(key);
    this.signatures.set(key, signature);
    if (!previous) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) diff += Math.abs(signature[i] - previous[i]);
    return diff / signature.length < UNCHANGED_THRESHOLD;
  }
}
