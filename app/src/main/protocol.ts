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

/** Maps app://lumi/<path> to files under `root` (the dist folder). */
export function serveAppScheme(root: string): void {
  const base = normalize(root + sep);
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = normalize(join(base, decodeURIComponent(url.pathname)));
    if (url.host !== "lumi" || !file.startsWith(base)) return new Response("Not found", { status: 404 });
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
