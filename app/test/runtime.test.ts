// The installed app's Python environment for the sidecar (roadmap 13).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { envPython, envReady, envUsable, extrasFor, lockHash, parseUvLine, SyncProgress, syncArgs, type RuntimePaths } from "../src/main/setup/runtime";

// Lines from a real `uv sync` (uv 0.9.5, no terminal)
const UV_OUTPUT = `Using CPython 3.12.11
Creating virtual environment at: C:/x/env
Downloading onnx (7.5MiB)
Downloading scipy (35.0MiB)
Downloading torch (2.4GiB)
 Downloading onnx
 Downloading scipy
Prepared 25 packages in 1m 10s
Installed 83 packages in 1.64s
 + winrt-windows-storage-streams==3.2.1`;

test("uv's output becomes progress: sizes announced, downloads finished, phases", () => {
  const events = UV_OUTPUT.split("\n").map(parseUvLine);
  assert.deepEqual(events[2], { kind: "download", name: "onnx", bytes: Math.round(7.5 * 1024 ** 2) });
  assert.deepEqual(events[5], { kind: "downloaded", name: "onnx" });
  assert.equal(events[7]?.kind, "phase");
  assert.equal(events[9], null, "the list of installed packages is not an event");
  const progress = new SyncProgress();
  for (const e of events) if (e) progress.add(e);
  assert.equal(progress.total, Math.round((7.5 + 35) * 1024 ** 2) + Math.round(2.4 * 1024 ** 3));
  assert.equal(progress.downloaded, Math.round((7.5 + 35) * 1024 ** 2), "torch is still downloading");
  assert.deepEqual(parseUvLine("Downloaded numpy"), { kind: "downloaded", name: "numpy" }, "older uv");
  assert.deepEqual(parseUvLine("Downloading cpython-3.12.11-windows-x86_64-none (download) (20.4MiB)"), { kind: "python", detail: "cpython-3.12.11-windows-x86_64-none" });
  assert.deepEqual(parseUvLine("error: Failed to fetch: `https://download.pytorch.org/...`"), { kind: "error", detail: "Failed to fetch: `https://download.pytorch.org/...`" });
});

test("each profile installs what it needs: no torch without an NVIDIA GPU", () => {
  assert.deepEqual(extrasFor("leggero"), ["wakeword"]);
  assert.deepEqual(extrasFor("bilanciato"), ["gpu", "wakeword"]);
  assert.deepEqual(extrasFor("locale"), ["gpu", "wakeword"]);
  const paths: RuntimePaths = { sidecarDir: "C:/app/resources/sidecar", uv: "uv.exe", envDir: "C:/env" };
  assert.deepEqual(syncArgs(paths, ["gpu", "wakeword"]), ["sync", "--frozen", "--no-dev", "--project", "C:/app/resources/sidecar", "--extra", "gpu", "--extra", "wakeword"]);
});

test("the environment is ready only for the lock and the extras it was built with", () => {
  const root = mkdtempSync(join(tmpdir(), "lumi-runtime-"));
  const sidecarDir = join(root, "sidecar");
  const envDir = join(root, "env");
  mkdirSync(sidecarDir);
  mkdirSync(join(envDir, "Scripts"), { recursive: true });
  writeFileSync(join(sidecarDir, "uv.lock"), "version = 1\n");
  const paths: RuntimePaths = { sidecarDir, uv: "uv", envDir };
  assert.equal(envReady(paths, ["wakeword"]), false, "no python yet");
  writeFileSync(envPython(envDir), "");
  assert.equal(envUsable(paths), false, "a python we didn't build is not ours");
  writeFileSync(join(envDir, "lumi-env.json"), JSON.stringify({ lock: lockHash(sidecarDir), extras: ["wakeword"] }));
  assert.equal(envReady(paths, ["wakeword"]), true);
  assert.equal(envReady(paths, ["gpu", "wakeword"]), false, "a profile with the GPU needs a sync");
  writeFileSync(join(sidecarDir, "uv.lock"), "version = 1\n# an update\n");
  assert.equal(envReady(paths, ["wakeword"]), false, "an update with a new lock needs a sync");
  assert.equal(envUsable(paths), true, "but the old environment can run meanwhile");
});
