// Draws the attention candidates and the gaze target (LUMI_DEBUG_GAZE=1).
import type { DebugFrame } from "../../main/debugOverlay";

declare global {
  interface Window {
    debugGaze: { onFrame(cb: (frame: DebugFrame) => void): void };
  }
}

const COLORS: Record<string, string> = {
  speaking: "#ff5370",
  caret: "#ffcb6b",
  reading: "#c3e88d",
  text: "#82aaff",
  change: "#89ddff",
  mouse: "#c792ea",
  user: "#f78c6c",
};

const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

window.debugGaze.onFrame((frame) => {
  const dpr = window.devicePixelRatio || 1;
  const { width, height, x: ox, y: oy } = frame.bounds;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px Consolas, monospace";
  for (const c of frame.candidates) {
    const color = COLORS[c.kind] ?? "#ffffff";
    ctx.strokeStyle = color;
    ctx.globalAlpha = Math.max(0.25, Math.min(1, c.score * 1.5));
    ctx.lineWidth = 2;
    ctx.strokeRect(c.rect.x - ox, c.rect.y - oy, Math.max(4, c.rect.width), Math.max(4, c.rect.height));
    ctx.fillStyle = color;
    ctx.fillText(`${c.kind} ${c.score.toFixed(2)}`, c.rect.x - ox + 2, c.rect.y - oy - 4);
  }
  ctx.globalAlpha = 1;
  if (frame.target) {
    const x = frame.target.x - ox;
    const y = frame.target.y - oy;
    ctx.strokeStyle = COLORS[frame.target.kind] ?? "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.moveTo(x - 22, y);
    ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22);
    ctx.lineTo(x, y + 22);
    ctx.stroke();
  }
});
