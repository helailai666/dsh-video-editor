import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MACOS_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Platform default Chrome executable, used when the worker registry carries no
 * explicit browserPath. The macOS path was hardcoded before Windows support
 * (upstream issue #38); Windows checks the standard install locations.
 */
export function defaultBrowserPath(env = process.env) {
  if (process.platform === "win32") {
    const candidates = [];
    for (const root of [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ]) {
      if (!root) continue;
      candidates.push(
        resolve(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
    }
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]) {
      if (!root) continue;
      candidates.push(resolve(root, "Google Chrome", "Application", "chrome.exe"));
    }
    return candidates.find((path) => existsSync(path)) || candidates[0] || "";
  }
  return MACOS_CHROME;
}

/**
 * Read the installed Chrome version from the numbered directory next to
 * chrome.exe. Spawning `chrome.exe --version` on Windows can flash a browser
 * window during doctor, so the version probe must stay side-effect free there.
 */
export function windowsChromeVersion(browserPath) {
  try {
    const found = readdirSync(dirname(browserPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(\.\d+){3}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return found.length ? `Google Chrome ${found[found.length - 1]}` : "unavailable";
  } catch {
    return "unavailable";
  }
}
