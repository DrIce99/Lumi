// Bundles main, preload and renderer with esbuild. Type checking is separate
// (`npm run typecheck`) because esbuild only strips types.
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const withTests = process.argv.includes("--tests");
const common = { bundle: true, sourcemap: true, target: "es2023", logLevel: "warning" };

await rm("dist", { recursive: true, force: true });

const jobs = [
  build({
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main/main.js",
    platform: "node",
    format: "cjs",
    // node_modules (electron, koffi) are resolved at runtime
    packages: "external",
  }),
  build({
    ...common,
    // memory.db lives in a worker thread: SQLite calls are synchronous
    entryPoints: ["src/main/brain/memory/worker.ts"],
    outfile: "dist/main/memoryWorker.js",
    platform: "node",
    format: "cjs",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["src/discord/bot.ts"],
    outfile: "dist/discord/bot.js",
    platform: "node",
    format: "cjs",
    // discord.js, @discordjs/voice (with the native DAVE module) and opusscript stay in node_modules
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["src/preload/face.ts", "src/preload/settings.ts", "src/preload/commandbar.ts", "src/preload/debug.ts", "src/preload/phoneBridge.ts"],
    outdir: "dist/preload",
    platform: "node",
    format: "cjs",
    // sandboxed preloads may only require("electron")
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/main.ts", "src/renderer/avatar/index.ts", "src/renderer/settings/settings.ts", "src/renderer/commandbar/commandbar.ts", "src/renderer/debug/gaze.ts", "src/renderer/phone/bridge.ts"],
    outbase: "src/renderer",
    outdir: "dist/renderer",
    platform: "browser",
    format: "iife",
    // onnxruntime-web is loaded by the VAD at runtime from dist/renderer/vad
    loader: { ".wasm": "file" },
  }),
];

if (withTests) {
  const testFiles = (await readdir("test")).filter((f) => f.endsWith(".test.ts"));
  jobs.push(
    build({
      ...common,
      entryPoints: testFiles.map((f) => `test/${f}`),
      outdir: "dist/test",
      platform: "node",
      format: "cjs",
      packages: "external",
    }),
  );
}

await Promise.all(jobs);

for (const file of ["face.html", "face.css", "settings/settings.html", "settings/settings.css", "commandbar/commandbar.html", "commandbar/commandbar.css", "debug/gaze.html", "phone/bridge.html"]) {
  await cp(`src/renderer/${file}`, `dist/renderer/${file}`);
}

// The 3D avatar's bundled model (loaded by renderer/avatar only in 3D mode)
await mkdir("dist/renderer/avatar", { recursive: true });
if (existsSync("assets/avatar/Lumi.vrm")) await cp("assets/avatar/Lumi.vrm", "dist/renderer/avatar/Lumi.vrm");
else console.warn("Avatar model missing: assets/avatar/Lumi.vrm");

// Voice activity detection: the Silero model, its audio worklet and the
// onnxruntime-web WebAssembly files are fetched by the renderer at runtime.
const vadAssets = [
  ["node_modules/@ricky0123/vad-web/dist", ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx", "silero_vad_legacy.onnx"]],
  ["node_modules/onnxruntime-web/dist", ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]],
];
await mkdir("dist/renderer/vad", { recursive: true });
for (const [dir, files] of vadAssets) {
  for (const file of files) {
    if (existsSync(`${dir}/${file}`)) await cp(`${dir}/${file}`, `dist/renderer/vad/${file}`);
    else console.warn(`VAD asset missing: ${dir}/${file}`);
  }
}
