// npm run update: the installed Lumi gets the code of this folder, in one
// command. Builds the phone page and the installer (npm run dist), closes
// the installed Lumi if it runs, installs over it silently (the NSIS
// update keeps settings, memory and the voice engine's environment) and
// starts it again.
//   --no-phone  don't rebuild phone/www (it must exist already)
//   --no-start  don't start Lumi after installing
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const app = process.cwd();
const phone = join(app, "..", "phone");

function step(title) {
  console.log(`\n=== ${title} ===`);
}

/** Runs a command in a folder, showing its output; stops everything on failure. */
function run(command, cwd) {
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\nNon riuscito: "${command}" in ${cwd} (codice ${result.status}). L'app installata non è stata toccata.`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** PIDs of the installed Lumi (Lumi.exe; `npm start` runs as electron.exe). */
function lumiPids() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Lumi.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return [...out.matchAll(/^"Lumi\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

/** Where the installer put Lumi: the folder of the uninstall entry's uninstaller, else the per-user default. */
function installDir() {
  try {
    // electron-builder's entry has no InstallLocation: the uninstaller sits next to Lumi.exe
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -eq 'Lumi' } | Select-Object -First 1 -ExpandProperty UninstallString"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const uninstaller = /^"([^"]+)"/.exec(out)?.[1] ?? "";
    const dir = uninstaller ? dirname(uninstaller) : "";
    if (dir && existsSync(join(dir, "Lumi.exe"))) return dir;
  } catch {
    // no entry: first install, or another place
  }
  const fallback = join(process.env.LOCALAPPDATA ?? "", "Programs", "Lumi");
  return existsSync(join(fallback, "Lumi.exe")) ? fallback : null;
}

/** Closes the installed Lumi: politely (--quit lets it save memory and stop the voice engine), by force only if it doesn't. */
async function closeLumi(dir) {
  if (!lumiPids().length) return;
  console.log("Lumi è aperta: la chiudo.");
  if (dir) spawn(join(dir, "Lumi.exe"), ["--quit"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 30 && lumiPids().length; i++) await sleep(500);
  if (!lumiPids().length) return;
  // Builds before 2026-10-27 don't know --quit
  console.log("Non si è chiusa da sola (versione vecchia, senza --quit): la chiudo d'ufficio.");
  spawnSync("taskkill", ["/IM", "Lumi.exe", "/T", "/F"], { stdio: "ignore" });
  for (let i = 0; i < 20 && lumiPids().length; i++) await sleep(250);
  if (lumiPids().length) {
    console.error("Non riesco a chiudere Lumi: chiudila dalla tray e rilancia npm run update.");
    process.exit(1);
  }
}

const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
const setup = join(app, "release", `Lumi-Setup-${version}.exe`);

if (!args.has("--no-phone")) {
  step("App del telefono (phone/www)");
  if (!existsSync(join(phone, "node_modules"))) run("npm install", phone);
  run("npm run build", phone);
}

step("Installer (npm run dist)");
run("npm run dist", app);
if (!existsSync(setup)) {
  console.error(`Non trovo ${setup} dopo la build.`);
  process.exit(1);
}

step("Installazione");
const dir = installDir();
console.log(dir ? `Lumi installata in ${dir}: la aggiorno.` : "Lumi non risulta installata: la installo nella cartella predefinita.");
await closeLumi(dir);
// /S = silent; over an existing install NSIS runs the old uninstaller as an update and reuses its folder
const installed = spawnSync(setup, ["/S"], { stdio: "inherit" });
if (installed.status !== 0) {
  console.error(`L'installer è terminato con il codice ${installed.status}.`);
  process.exit(1);
}
const target = installDir();
if (!target) {
  console.error("L'installer è finito ma non trovo Lumi.exe installata.");
  process.exit(1);
}
console.log(`Aggiornata: ${target}`);

if (!args.has("--no-start")) {
  step("Avvio");
  spawn(join(target, "Lumi.exe"), [], { detached: true, stdio: "ignore" }).unref();
  console.log("Lumi è ripartita. Nel log (%APPDATA%\\Lumi\\logs\\lumi.log) la prima riga dice \"installed, built <data>\".");
}
