// Files dropped on the command bar, turned into text for the brain: text
// files are read (clipped), images are described in words by the model that
// can see (subject to sendScreenshots, see screenshots.ts), anything else is
// only named. Everything is bounded so a big file can't flood the prompt.
import { basename, extname } from "node:path";

export interface Attachment {
  name: string;
  /** What the brain reads about the file. */
  content: string;
}

export type FileKind = "image" | "text" | "binary";

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
export const MAX_FILES = 5;
/** Bigger files are not read at all. */
export const MAX_FILE_BYTES = 4_000_000;
/** Text read from all the files of one message, shared between them. */
export const MAX_TOTAL_CHARS = 24_000;

/** Image by extension; text when the first bytes have no NUL and decode as UTF-8; else binary. */
export function classify(name: string, head: Uint8Array): FileKind {
  if (IMAGE_EXTENSIONS.includes(extname(name).toLowerCase())) return "image";
  if (head.includes(0)) return "binary";
  // A cut in the middle of a multi-byte character is fine: only a few bytes at the end may be partial
  const decoded = new TextDecoder("utf-8").decode(head);
  const bad = decoded.split("�").length - 1;
  return bad <= 2 ? "text" : "binary";
}

/** At most `max` characters, cut at a line end when one is near, with a marker. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  const end = cut > max * 0.8 ? cut : max;
  return `${text.slice(0, end)}\n[… file troncato: ${text.length - end} caratteri non letti]`;
}

export interface AttachmentIo {
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  /** A description of the image in words, or why it can't be seen. */
  describeImage(path: string, name: string): Promise<string>;
}

export async function readAttachments(paths: string[], io: AttachmentIo): Promise<Attachment[]> {
  const out: Attachment[] = [];
  const texts: { index: number; text: string }[] = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    const name = basename(path);
    try {
      const size = await io.size(path);
      if (size > MAX_FILE_BYTES) {
        out.push({ name, content: `(too big to read: ${Math.round(size / 1_000_000)} MB)` });
        continue;
      }
      const data = await io.read(path);
      const kind = classify(name, data.subarray(0, 4096));
      if (kind === "image") out.push({ name, content: await io.describeImage(path, name) });
      else if (kind === "binary") out.push({ name, content: "(a binary file: its content can't be read)" });
      else {
        texts.push({ index: out.length, text: new TextDecoder("utf-8").decode(data) });
        out.push({ name, content: "" });
      }
    } catch {
      out.push({ name, content: "(the file couldn't be read)" });
    }
  }
  // Text files share the budget equally
  const each = texts.length ? Math.floor(MAX_TOTAL_CHARS / texts.length) : 0;
  for (const t of texts) out[t.index].content = clipText(t.text, each);
  if (paths.length > MAX_FILES) out.push({ name: `${paths.length - MAX_FILES} altri file`, content: `(ignored: at most ${MAX_FILES} files per message)` });
  return out;
}
