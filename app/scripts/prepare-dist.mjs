// Prepares what the installer ships besides the app (roadmap 13), in build/:
// - uv.exe, pinned and checked against its published SHA-256: on first
//   start it installs a managed CPython and the sidecar's locked packages
//   (main/setup/runtime.ts). The version is the one that wrote uv.lock.
// - icon.png (256 px): the tray's eyes, drawn by main/png.ts.
// Run by `npm run dist` after `node build.mjs`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const UV_VERSION = "0.9.5";
const UV_ZIP = "uv-x86_64-pc-windows-msvc.zip";
const UV_SHA256 = "515dc53d7553f1357d0abc1f70acd921fbb9e30230b1d9a08737236daa6ee920";

await mkdir("build/uv", { recursive: true });

// ---- uv ----
const uvExe = join("build", "uv", "uv.exe");
const stamp = join("build", "uv", "VERSION");
if (!existsSync(uvExe) || (await readFile(stamp, "utf8").catch(() => "")) !== UV_VERSION) {
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ZIP}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`uv download failed: ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(zip).digest("hex");
  if (sha !== UV_SHA256) throw new Error(`uv checksum mismatch: ${sha}`);
  const zipFile = join("build", "uv", UV_ZIP);
  await writeFile(zipFile, zip);
  // Windows 10+ ships bsdtar, which reads zip files (Git's GNU tar on PATH doesn't)
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", UV_ZIP, "uv.exe"], { cwd: join("build", "uv") });
  await rm(zipFile);
  await writeFile(stamp, UV_VERSION);
}
const version = execFileSync(uvExe, ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(`uv ${UV_VERSION}`)) throw new Error(`unexpected uv: ${version}`);
console.log(`Bundling ${version}`);

// ---- icon ----
await build({ entryPoints: ["src/main/png.ts"], outfile: "build/png.mjs", bundle: true, platform: "node", format: "esm", logLevel: "warning" });
const { drawEyesIcon, encodePng } = await import(pathToFileURL(join(process.cwd(), "build", "png.mjs")).href);
await writeFile(join("build", "icon.png"), encodePng(256, 256, drawEyesIcon(256)));
await rm(join("build", "png.mjs"));

// ---- the phone app, served to phones by the PC (phase 15) ----
if (!existsSync(join("..", "phone", "www", "index.html"))) {
  console.warn("phone/www is missing: run `npm run build` in phone/ first, or the installed app can't serve the phone page");
}
