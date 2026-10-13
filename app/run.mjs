// Starts the app with Electron. Terminals spawned by VS Code and other
// Electron apps may export ELECTRON_RUN_AS_NODE, which makes electron.exe
// behave like plain Node; drop it so the app always starts as a GUI app.
import { spawn } from "node:child_process";
import electronPath from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
