// API keys for every service, encrypted with the OS keychain (DPAPI on Windows).
import { safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProvider, PROVIDERS, type ProviderId } from "../shared/providers";
import type { KeySource } from "../shared/types";
import { log } from "./log";

export class ApiKeyStore {
  private readonly file: string;
  private keys: Partial<Record<ProviderId, string>>;

  constructor(dir: string) {
    this.file = join(dir, "apikeys.bin");
    this.keys = this.load();
  }

  /** The stored key, or the service's environment variable. */
  get(provider: ProviderId): string | null {
    const env = PROVIDERS[provider].envKey;
    return this.keys[provider] || (env ? process.env[env]?.trim() : "") || null;
  }

  source(provider: ProviderId): KeySource {
    if (this.keys[provider]) return "settings";
    const env = PROVIDERS[provider].envKey;
    return env && process.env[env]?.trim() ? "environment" : "none";
  }

  /** Applies changes: a non-empty value stores the key, an empty one removes it. */
  update(changes: Partial<Record<ProviderId, string>>): void {
    for (const [provider, value] of Object.entries(changes)) {
      if (!isProvider(provider) || typeof value !== "string") continue;
      const key = value.trim();
      if (key) this.keys[provider] = key;
      else delete this.keys[provider];
    }
    if (!Object.keys(this.keys).length) {
      rmSync(this.file, { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("La cifratura del sistema non è disponibile: impossibile salvare le chiavi in modo sicuro.");
    }
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.keys)));
  }

  private load(): Partial<Record<ProviderId, string>> {
    if (!existsSync(this.file) || !safeStorage.isEncryptionAvailable()) return {};
    try {
      const parsed: unknown = JSON.parse(safeStorage.decryptString(readFileSync(this.file)));
      if (!parsed || typeof parsed !== "object") return {};
      const keys: Partial<Record<ProviderId, string>> = {};
      for (const [provider, value] of Object.entries(parsed)) {
        if (isProvider(provider) && typeof value === "string") keys[provider] = value;
      }
      return keys;
    } catch (err) {
      log.error("Cannot read the stored API keys", err);
      return {};
    }
  }
}
