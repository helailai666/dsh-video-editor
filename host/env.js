/**
 * Build the complete, explicit environment for the worker process.
 *
 * The Host runs inside Electron-as-Node and inherits Electron/IPC/Node startup
 * variables. Passing `process.env` through would carry `ELECTRON_RUN_AS_NODE`,
 * `NODE_CHANNEL_*`, `NODE_OPTIONS` and similar injection seams into a process we
 * start as a plain Node worker. Instead only an allowlist of operating-system
 * and rendering facts is copied; the source environment is never modified.
 *
 * This is hygiene, not a security sandbox. The one deliberate exception is
 * Windows, where the DSH shim resolves "node" to a non-spawnable .cmd file:
 * the bridge then spawns the Host's own Electron binary as Node and re-adds
 * ELECTRON_RUN_AS_NODE explicitly (see `workerNodeEnv` in host/bridge.js).
 * Inherited values are still never passed through here.
 */

const ALLOWED_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
]);

/** Prefixes that can change Node/Electron/bootstrap behavior or leak Host state. */
const FORBIDDEN_PREFIXES = ['ELECTRON_', 'NODE_', 'DSH_', 'DSH-', 'npm_', 'NPM_', 'PNPM_', 'VSCODE_'];

/**
 * @param source - environment to copy from; defaults to process.env.
 * @returns a new plain object containing only allowed string entries.
 */
export function buildWorkerEnv(source) {
  const input = source === undefined ? process.env : source;
  if (input === null || typeof input !== 'object') return {};
  const output = {};
  for (const key of ALLOWED_EXACT) {
    const value = input[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    output[key] = value;
  }
  // Defensive belt-and-suspenders: an allowlisted name can never be a dangerous
  // prefix, but keep the filter explicit so future additions stay checked.
  for (const key of Object.keys(output)) {
    if (FORBIDDEN_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) delete output[key];
  }
  return output;
}

export const WORKER_ENV_KEYS = Object.freeze([...ALLOWED_EXACT].sort());
