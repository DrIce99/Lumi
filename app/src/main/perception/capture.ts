// Screen changes, a few times per second: desktopCapturer thumbnails (about
// 640 px wide) of the monitor with the active window and of Lumi's monitor,
// diffed in 32x32 blocks. Lumi's own window never appears (content
// protection). The changed rectangles are reported in screen DIP.
import { desktopCapturer, type Display } from "electron";
import { log } from "../log";
import { changedBlocks, Habituation, lumaFromBgra, mergeBlocks, type Frame } from "./diff";

export interface Change {
  displayId: number;
  /** Screen DIP. */
  rect: { x: number; y: number; width: number; height: number };
  /** Fraction of the display the change covers. */
  coverage: number;
  /** 1 for a new change, lower for a region that keeps changing. */
  novelty: number;
}

const THUMB = 640;

export class ChangeDetector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly frames = new Map<number, Frame>();
  private readonly habits = new Map<number, Habituation>();

  constructor(
    private readonly options: {
      fps: () => number;
      /** The displays worth watching now. */
      displays: () => Display[];
      /** Whether to capture at all (perception on and not paused). */
      active: () => boolean;
      onChanges: (changes: Change[]) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const loop = async () => {
      const started = Date.now();
      if (this.options.active()) await this.tick();
      else this.frames.clear();
      const interval = 1000 / Math.max(0.5, this.options.fps());
      this.timer = setTimeout(loop, Math.max(50, interval - (Date.now() - started)));
    };
    this.timer = setTimeout(loop, 1000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.frames.clear();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const displays = this.options.displays();
      if (!displays.length) return;
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: THUMB, height: THUMB }, fetchWindowIcons: false });
      const changes: Change[] = [];
      for (const display of displays) {
        const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
        if (!source || source.thumbnail.isEmpty()) continue;
        const { width, height } = source.thumbnail.getSize();
        const frame = lumaFromBgra(source.thumbnail.toBitmap(), width, height);
        const prev = this.frames.get(display.id);
        this.frames.set(display.id, frame);
        if (!prev) continue;
        const grid = changedBlocks(prev, frame);
        const boxes = mergeBlocks(grid, width, height);
        let habit = this.habits.get(display.id);
        if (!habit) this.habits.set(display.id, (habit = new Habituation()));
        const novelty = habit.update(grid, boxes);
        const sx = display.bounds.width / width;
        const sy = display.bounds.height / height;
        boxes.forEach((box, i) => {
          changes.push({
            displayId: display.id,
            rect: {
              x: Math.round(display.bounds.x + box.x * sx),
              y: Math.round(display.bounds.y + box.y * sy),
              width: Math.round(box.width * sx),
              height: Math.round(box.height * sy),
            },
            coverage: (box.width * box.height) / (width * height),
            novelty: novelty[i],
          });
        });
      }
      if (changes.length) this.options.onChanges(changes);
    } catch (err) {
      log.warn("Screen capture failed", err);
    } finally {
      this.running = false;
    }
  }
}
