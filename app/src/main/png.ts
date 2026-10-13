// Tiny PNG encoder (RGBA, no filtering) for the icons drawn in code.
import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Lumi's icon: two vertical capsules on a dark rounded square, drawn with
 * 4x4 supersampling for smooth edges. `dim` greys the eyes (offline, muted).
 */
export function drawEyesIcon(size: number, options: { dim?: boolean; dot?: [number, number, number] } = {}): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4;
  const eyeColor = options.dim ? [150, 148, 144] : [245, 243, 238];
  const bg = [28, 28, 34];
  const radius = size * 0.22;
  const eyeW = size * 0.17;
  const eyeH = size * 0.5;
  const centers = [size * 0.37, size * 0.63];
  const inCapsule = (x: number, y: number, cx: number) => {
    const half = eyeH / 2 - eyeW / 2;
    const dy = Math.max(0, Math.abs(y - size / 2) - half);
    return Math.hypot(x - cx, dy) <= eyeW / 2;
  };
  const inRounded = (x: number, y: number) => {
    const dx = Math.max(0, Math.abs(x - size / 2) - (size / 2 - radius));
    const dy = Math.max(0, Math.abs(y - size / 2) - (size / 2 - radius));
    return Math.hypot(dx, dy) <= radius;
  };
  const dotR = size * 0.16;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          let color: number[] | null = null;
          if (options.dot && Math.hypot(x - (size - dotR - 0.5), y - (size - dotR - 0.5)) <= dotR) color = options.dot;
          else if (centers.some((cx) => inCapsule(x, y, cx))) color = eyeColor;
          else if (inRounded(x, y)) color = bg;
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((255 * a) / (ss * ss));
      }
    }
  }
  return out;
}
