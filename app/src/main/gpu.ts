// Detects an NVIDIA GPU with nvidia-smi, for the hardware profile wizard.
import { execFile } from "node:child_process";
import type { GpuInfo } from "../shared/types";

/** Parses `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): GpuInfo | null {
  let best: GpuInfo | null = null;
  for (const line of output.split(/\r?\n/)) {
    const [name, total, free] = line.split(",").map((part) => part.trim());
    const vramTotalMb = Number(total);
    if (!name || !Number.isFinite(vramTotalMb) || vramTotalMb <= 0) continue;
    const gpu: GpuInfo = { name, vramTotalMb, ...(Number.isFinite(Number(free)) && free !== "" ? { vramFreeMb: Number(free) } : {}) };
    if (!best || gpu.vramTotalMb > best.vramTotalMb) best = gpu;
  }
  return best;
}

export function detectGpu(): Promise<GpuInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout)),
    );
  });
}
