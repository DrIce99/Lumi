// Serves the renderer files from `app://lumi/` instead of file://, so the
// pages get a real origin: fetch() of the VAD model, WebAssembly streaming,
// module workers and AudioWorklets all work as on the web.
import { net, protocol, session } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_ORIGIN = "app://lumi";

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Paths outside the dist folder the pages may read: URL path -> a file, or (ending in "/") a folder. */
const mounts = new Map<string, string>();

/** Serves `target` (a file, or a folder when `urlPath` ends in "/") at app://lumi<urlPath>; null removes it. */
export function mountAppPath(urlPath: string, target: string | null): void {
  if (target) mounts.set(urlPath, target);
  else mounts.delete(urlPath);
}

/** The file an app:// path maps to, or null when it is outside what is served. Exported for the tests. */
export function resolveAppPath(root: string, pathname: string, table: ReadonlyMap<string, string> = mounts): string | null {
  const path = decodeURIComponent(pathname);
  for (const [prefix, target] of table) {
    if (!prefix.endsWith("/")) {
      if (path === prefix) return target;
      continue;
    }
    if (!path.startsWith(prefix)) continue;
    const dir = normalize(target + sep);
    const file = normalize(join(dir, path.slice(prefix.length)));
    return file.startsWith(dir) && file !== dir ? file : null;
  }
  const base = normalize(root + sep);
  const file = normalize(join(base, path));
  return file.startsWith(base) ? file : null;
}

/** Maps app://lumi/<path> to files under `root` (the dist folder), plus the mounts. */
export function serveAppScheme(root: string): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = url.host === "lumi" ? resolveAppPath(root, url.pathname) : null;
    if (!file) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // Only our own pages may use the microphone; nothing else is granted
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl) && (permission === "media" || permission === "speaker-selection") && webContents !== null);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return isAppUrl(requestingOrigin) && (permission === "media" || permission === "speaker-selection");
  });
}

/**
 * Whether a URL or origin belongs to our pages. URL.origin is "null" for
 * custom schemes, so compare scheme and host instead.
 */
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "app:" && u.host === "lumi";
  } catch {
    return false;
  }
}
