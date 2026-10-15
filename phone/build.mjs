// Bundles the phone app's web part into www/ (Capacitor's web dir). The
// face is the desktop app's own code (app/src/renderer/face/), imported as is.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("www", { recursive: true, force: true });
await mkdir("www", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "www/app.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "warning",
});
for (const file of ["index.html", "style.css"]) await cp(`src/${file}`, `www/${file}`);
