// Paired phones: a name and the key each one received through the QR code,
// encrypted with the OS keychain (DPAPI) in %APPDATA%\Lumi\phones.bin.
// Revoking a phone deletes its key: it can't log in again.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";

export interface PairedPhone {
  id: string;
  name: string;
  key: string;
  paired: string;
  lastSeen?: string;
}

/** What encrypts the file: Electron's safeStorage in the app, plain in tests. */
export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class PhoneDevices {
  private readonly file: string;
  private phones: PairedPhone[];

  constructor(
    dir: string,
    private readonly cipher: Cipher,
  ) {
    this.file = join(dir, "phones.bin");
    this.phones = this.load();
  }

  list(): PairedPhone[] {
    return [...this.phones];
  }

  get(id: string): PairedPhone | undefined {
    return this.phones.find((p) => p.id === id);
  }

  add(phone: PairedPhone): void {
    this.phones = [...this.phones.filter((p) => p.id !== phone.id), phone];
    this.save();
  }

  seen(id: string): void {
    const phone = this.get(id);
    if (!phone) return;
    phone.lastSeen = new Date().toISOString();
    this.save();
  }

  revoke(id: string): boolean {
    const before = this.phones.length;
    this.phones = this.phones.filter((p) => p.id !== id);
    if (this.phones.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.phones.length) {
      rmSync(this.file, { force: true });
      return;
    }
    if (!this.cipher.available()) throw new Error("La cifratura del sistema non è disponibile: impossibile salvare i telefoni abbinati.");
    writeFileSync(this.file, this.cipher.encrypt(JSON.stringify(this.phones)));
  }

  private load(): PairedPhone[] {
    if (!existsSync(this.file) || !this.cipher.available()) return [];
    try {
      const data: unknown = JSON.parse(this.cipher.decrypt(readFileSync(this.file)));
      return Array.isArray(data) ? data.filter((p): p is PairedPhone => !!p && typeof p.id === "string" && typeof p.key === "string") : [];
    } catch (err) {
      log.error("Cannot read the paired phones", err);
      return [];
    }
  }
}
