/**
 * Stable user data root for the dsh-video plugin (V1 M1-01).
 *
 * The plugin's authoritative data used to live inside an immutable per-version
 * staging snapshot; deleting or replacing that snapshot could hide (or destroy)
 * user projects. This module moves the authoritative layout to a stable root:
 *
 *   <dataRoot>/                      default ~/Movies/DSH Video, env/config override
 *   ├── registry.json                worker managed *external* config (exactly the
 *   │                                5 keys the frozen worker schema accepts:
 *   │                                projectsRoot/registryPath/outputRoot/
 *   │                                assetInboxRoot/browserPath)
 *   ├── projects.json                project map {version, managed, projects:{id:path}}
 *   ├── session-state.json           project <-> creation Session mapping (schema v1)
 *   ├── ui-state.json                lastProjectId/layout (written by ui-state.js)
 *   ├── migration.json               one-time legacy import record (M1-02)
 *   ├── projects/<projectId>/        project content
 *   ├── asset-inbox/                 temporary upload inbox (0600 files)
 *   ├── exports/                     exported media (created now, used from M3)
 *   └── cache/                       derived, rebuildable (output/previews/...)
 *
 * Compatibility rule: the worker managed-registry *format is unchanged*. The
 * only change is the directory it points at. `registry.json` must keep exactly
 * `projectsRoot`/`registryPath`/`outputRoot`/`assetInboxRoot`/`browserPath`
 * (the worker rejects unknown keys), while `projects.json` may carry the
 * `version`/`managed` bookkeeping fields because both readers only consume
 * `projects` (worker registry.mjs readRegistryFile, Host readManagedProjectMap).
 *
 * Everything here is deliberately fs-only and side-effect free at import time so
 * contract tests can drive it against a temporary HOME/dataRoot.
 */

import { chmod, cp, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { BridgeError, configurationError } from './errors.js';

export const DATA_ROOT_VERSION = 1;
export const REGISTRY_VERSION = 1;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_LEGACY_ROOTS = 16;
const DEFAULT_SEGMENTS = Object.freeze(['Movies', 'DSH Video']);
const DIR_MODE = 0o700;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataRootError(code, message, stage = 'data-root') {
  return new BridgeError(code, message, { stage });
}

/** Absolute or `~/`-prefixed path expanded against the given home directory. */
export function expandHomePath(value, home = homedir()) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

/** Default data root: `~/Movies/DSH Video`. */
export function defaultDataRoot(home = homedir()) {
  return join(home, ...DEFAULT_SEGMENTS);
}

/**
 * Resolve the authoritative data root.
 * Priority: Loader config `dataRoot` > env `DSH_VIDEO_DATA_ROOT` > default.
 *
 * @param config - normalized trusted config (may be null for diagnostics)
 * @param env - environment source (defaults to process.env)
 * @param home - home directory (defaults to os.homedir(); test seam)
 * @returns `{ root, source }` where source is `config` | `env` | `default`
 */
export function resolveDataRoot(config, env = process.env, home = homedir()) {
  const settings = config || {};
  if (typeof settings.dataRoot === 'string' && settings.dataRoot.length > 0) {
    if (isAbsolute(settings.dataRoot) === false) throw configurationError('"dataRoot" must be an absolute path');
    return { root: settings.dataRoot, source: 'config' };
  }
  const fromEnv = env && typeof env.DSH_VIDEO_DATA_ROOT === 'string' ? env.DSH_VIDEO_DATA_ROOT : '';
  if (fromEnv.length > 0) {
    const expanded = expandHomePath(fromEnv, home);
    if (isAbsolute(expanded) === false) throw configurationError('"DSH_VIDEO_DATA_ROOT" must be an absolute path');
    return { root: expanded, source: 'env' };
  }
  return { root: defaultDataRoot(home), source: 'default' };
}

async function ensureDirectory(path, created) {
  let info = null;
  try {
    info = await stat(path);
  } catch (_error) {
    info = null;
  }
  if (info === null) {
    await mkdir(path, { recursive: true, mode: DIR_MODE });
    created.push(path);
  } else if (info.isDirectory() === false) {
    throw dataRootError('E_DATA_ROOT', `Data root component is not a directory: ${basename(path)}`, 'data-root');
  }
  // File mode is defence in depth, not the security boundary: never chmod a
  // parent such as ~/Movies (we only chmod directories we own below the root).
  try {
    await chmod(path, DIR_MODE);
  } catch (_error) {
    /* best effort: a pre-existing directory owned by the user may refuse */
  }
  return path;
}

async function ensureFile(path, contents, created) {
  try {
    const info = await stat(path);
    if (info.isFile() && info.size > 0) return false;
    if (info.isDirectory()) throw dataRootError('E_DATA_ROOT', `Data root file path is a directory: ${basename(path)}`, 'data-root');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error && error.code === 'ENOENT') {
      await writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      created.push(path);
      return true;
    }
    throw error;
  }
  return false;
}

/**
 * Compute the stable data-root layout. Pure: no filesystem access.
 * @returns paths used by the Host and the worker managed registry.
 */
export function dataRootLayout(root) {
  const projectsRoot = join(root, 'projects');
  const projectsRegistryPath = join(root, 'projects.json');
  const outputRoot = join(root, 'cache', 'output');
  const assetInboxRoot = join(root, 'asset-inbox');
  return {
    root,
    registryPath: join(root, 'registry.json'),
    projectsRegistryPath,
    projectsRoot,
    outputRoot,
    assetInboxRoot,
    exportsRoot: join(root, 'exports'),
    cacheRoot: join(root, 'cache'),
    previewsRoot: join(outputRoot, 'previews'),
    sessionCwd: join(root, 'session-cwd'),
    sessionStatePath: join(root, 'session-state.json'),
    uiStatePath: join(root, 'ui-state.json'),
    pluginSettingsPath: join(root, 'plugin-settings.json'),
    migrationPath: join(root, 'migration.json'),
  };
}

/**
 * Create/repair the data-root layout and its empty bookkeeping files.
 *
 * Only `<dataRoot>` and its owned subdirectories get mode 0700. Missing parents
 * (for example a brand-new `~/Movies`) are created by mkdir -p but never
 * chmod-ed. Existing non-empty files are never rewritten.
 *
 * @param root - absolute data root
 * @param options.browserPath - optional trusted Chrome path for the worker registry
 * @returns `{ paths, created, browserPath }`
 */
export async function ensureDataRoot(root, options = {}) {
  if (typeof root !== 'string' || isAbsolute(root) === false) {
    throw configurationError('"dataRoot" must be an absolute path');
  }
  const paths = dataRootLayout(root);
  const browserPath = typeof options.browserPath === 'string' && isAbsolute(options.browserPath) ? options.browserPath : undefined;
  const created = [];
  await ensureDirectory(paths.root, created);
  for (const path of [paths.projectsRoot, paths.assetInboxRoot, paths.exportsRoot, paths.cacheRoot, paths.outputRoot, paths.previewsRoot, paths.sessionCwd]) {
    await ensureDirectory(path, created);
  }
  const projectsRegistry = {
    version: REGISTRY_VERSION,
    managed: true,
    projects: {},
  };
  await ensureFile(paths.projectsRegistryPath, JSON.stringify(projectsRegistry, null, 2) + '\n', created);
  const workerRegistry = {
    projectsRoot: paths.projectsRoot,
    registryPath: paths.projectsRegistryPath,
    outputRoot: paths.outputRoot,
    assetInboxRoot: paths.assetInboxRoot,
    ...(browserPath === undefined ? {} : { browserPath }),
  };
  const registryCreated = await ensureFile(paths.registryPath, JSON.stringify(workerRegistry, null, 2) + '\n', created);
  if (registryCreated === false && browserPath !== undefined) {
    // A previously ensured registry may predate the browser configuration:
    // backfill only the missing browserPath, preserving every other key.
    const existing = await readWorkerRegistry(paths.registryPath);
    if (existing.ok === true && existing.value.browserPath === undefined) {
      await writeJsonAtomic(paths.registryPath, { ...existing.value, browserPath });
    }
  }
  const uiState = {
    version: 1,
    lastProjectId: null,
    layout: null,
    updatedAt: null,
  };
  await ensureFile(paths.uiStatePath, JSON.stringify(uiState, null, 2) + '\n', created);
  return { paths, created, browserPath };
}

/** Exact prefix containment on already-canonical absolute paths. */
export function insidePath(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Read one JSON file, returning a typed, non-throwing result. */
export async function readJsonFile(path) {
  let raw;
  try {
    const info = await stat(path);
    if (info.isFile() === false) return { ok: false, error: 'E_NOT_FILE' };
    if (info.size > MAX_REGISTRY_BYTES) return { ok: false, error: 'E_FILE_LIMIT' };
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, error: 'E_MISSING' };
    return { ok: false, error: 'E_READ' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (_error) {
    return { ok: false, error: 'E_JSON' };
  }
}

/**
 * Read the project map with bounded recovery:
 *   1. `<path>` itself;
 *   2. `<path>.bak` (last known good copy, written by the Host after a clean read);
 *   3. newest same-directory atomic temp residue `.<basename>.*.tmp`;
 *   4. typed failure (callers start empty; the file is never deleted/rewritten).
 *
 * @returns `{ ok, projects, version, managed, source, error }`
 */
export async function readProjectsRegistry(path) {
  const attempts = [];
  attempts.push({ source: 'file', path });
  attempts.push({ source: 'backup', path: path + '.bak' });
  const candidates = [...attempts];
  try {
    const directory = dirname(path);
    const prefix = `.${basename(path)}.`;
    const names = await readdir(directory);
    const residues = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => join(directory, name))
      .sort()
      .slice(-3);
    for (const residue of residues) candidates.push({ source: 'temp', path: residue });
  } catch (_error) {
    /* the directory may not exist yet; treat as empty */
  }
  let lastError = 'E_MISSING';
  for (const candidate of candidates) {
    const parsed = await readJsonFile(candidate.path);
    if (parsed.ok === false) {
      if (parsed.error !== 'E_MISSING') lastError = parsed.error;
      continue;
    }
    const value = parsed.value;
    if (isPlainObject(value) === false || isPlainObject(value.projects) === false) {
      lastError = 'E_SHAPE';
      continue;
    }
    const projects = new Map();
    for (const [id, projectPath] of Object.entries(value.projects)) {
      if (PROJECT_ID.test(id) === false) return { ok: false, projects: new Map(), version: null, managed: false, source: 'rejected', error: 'E_PROJECT_ID' };
      if (typeof projectPath !== 'string' || isAbsolute(projectPath) === false) return { ok: false, projects: new Map(), version: null, managed: false, source: 'rejected', error: 'E_PROJECT_PATH' };
      projects.set(id, projectPath);
    }
    return {
      ok: true,
      projects,
      version: Number.isInteger(value.version) ? value.version : null,
      managed: value.managed === true,
      source: candidate.source,
      error: null,
    };
  }
  return { ok: false, projects: new Map(), version: null, managed: false, source: 'none', error: lastError };
}

/** Read the worker managed registry (external config for `--registry`). */
export async function readWorkerRegistry(path) {
  const parsed = await readJsonFile(path);
  if (parsed.ok === false) return { ok: false, value: null, error: parsed.error };
  const value = parsed.value;
  if (isPlainObject(value) === false) return { ok: false, value: null, error: 'E_SHAPE' };
  for (const key of Object.keys(value)) {
    if (['projectsRoot', 'registryPath', 'outputRoot', 'assetInboxRoot', 'browserPath'].includes(key) === false) {
      return { ok: false, value: null, error: 'E_KEYS' };
    }
  }
  if (typeof value.projectsRoot !== 'string' || isAbsolute(value.projectsRoot) === false) return { ok: false, value: null, error: 'E_PROJECTS_ROOT' };
  if (typeof value.registryPath !== 'string' || isAbsolute(value.registryPath) === false) return { ok: false, value: null, error: 'E_REGISTRY_PATH' };
  if (typeof value.outputRoot !== 'string' || isAbsolute(value.outputRoot) === false) return { ok: false, value: null, error: 'E_OUTPUT_ROOT' };
  return { ok: true, value, error: null };
}

/**
 * Validate every registered project directory against the trusted projectsRoot.
 * Missing/escaping projects are quarantined, never deleted; a corrupt registry
 * yields an empty map plus the typed error so the shell stays alive.
 *
 * @returns `{ projects: Map<id, realpath>, quarantined: Map<id, reason>, error }`
 */
export async function loadManagedProjects(registryPath, projectsRoot) {
  const registry = await readProjectsRegistry(registryPath);
  const projects = new Map();
  const quarantined = new Map();
  const rejected = new Map();
  const recoveredProjects = registry.ok === true ? new Map(registry.projects) : new Map();
  if (registry.ok === false) {
    return { projects, quarantined, rejected, recoveredProjects, error: registry.error, source: registry.source };
  }
  let rootReal;
  try {
    rootReal = await realpath(projectsRoot);
    if ((await stat(rootReal)).isDirectory() === false) throw new Error('not a directory');
  } catch (_error) {
    return { projects, quarantined, rejected, recoveredProjects, error: 'E_PROJECTS_ROOT', source: registry.source };
  }
  for (const [id, projectPath] of registry.projects) {
    let real;
    try {
      real = await realpath(projectPath);
      if ((await stat(real)).isDirectory() === false) throw new Error('not a directory');
    } catch (_error) {
      quarantined.set(id, 'E_PROJECT_MISSING');
      continue;
    }
    if (insidePath(rootReal, real) === false) {
      // A registry entry pointing outside projectsRoot is an integrity fault,
      // not a missing project: it is never listed and never trusted.
      rejected.set(id, 'E_PROJECT_ESCAPES');
      continue;
    }
    projects.set(id, real);
  }
  return { projects, quarantined, rejected, recoveredProjects, error: null, source: registry.source };
}

/**
 * Legacy data roots, in priority order: explicit Loader config
 * `legacyDataRoots` > env `DSH_VIDEO_LEGACY_ROOTS` > roots derived from the old
 * staging config paths (projectsRoot/sessionStatePath/registryPath).
 *
 * Derivation failure is reported as a `derivedError` entry, never silently
 * skipped. The current data root is always excluded.
 */
export function legacyRootsFromConfig(config, env = process.env, dataRoot = null) {
  const settings = config || {};
  const explicit = [];
  if (Array.isArray(settings.legacyDataRoots)) {
    for (const value of settings.legacyDataRoots) explicit.push({ root: value, source: 'config' });
  }
  const envValue = env && typeof env.DSH_VIDEO_LEGACY_ROOTS === 'string' ? env.DSH_VIDEO_LEGACY_ROOTS : '';
  if (envValue.length > 0) {
    for (const part of envValue.split(sep === '\\' ? ';' : ':')) {
      if (part.length > 0) explicit.push({ root: part, source: 'env' });
    }
  }
  const derived = [];
  const candidates = [];
  if (typeof settings.projectsRoot === 'string' && basename(settings.projectsRoot) === 'projects') {
    candidates.push({ root: dirname(settings.projectsRoot), via: 'projectsRoot' });
  }
  if (typeof settings.sessionStatePath === 'string' && basename(settings.sessionStatePath) === 'session-state.json') {
    candidates.push({ root: dirname(settings.sessionStatePath), via: 'sessionStatePath' });
  }
  if (typeof settings.registryPath === 'string' && basename(dirname(settings.registryPath)) === 'managed') {
    candidates.push({ root: dirname(dirname(settings.registryPath)), via: 'registryPath' });
  }
  for (const candidate of candidates) {
    if (isAbsolute(candidate.root) === false) {
      derived.push({ root: candidate.root, source: 'derived', via: candidate.via, error: 'E_NOT_ABSOLUTE' });
      continue;
    }
    derived.push({ root: candidate.root, source: 'derived', via: candidate.via });
  }
  const seen = new Set();
  const roots = [];
  for (const entry of [...explicit, ...derived]) {
    if (typeof entry.root !== 'string' || isAbsolute(entry.root) === false) continue;
    if (dataRoot !== null && resolve(entry.root) === resolve(dataRoot)) continue;
    if (seen.has(entry.root)) continue;
    seen.add(entry.root);
    roots.push(entry);
    if (roots.length >= MAX_LEGACY_ROOTS) break;
  }
  return roots;
}

export { PROJECT_ID as DATA_ROOT_PROJECT_ID };

// ─────────────────────────────────────────────────────────────────────────────
// M1-02: one-time, copy-only, idempotent legacy migration
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_VERSION = 1;

/** Atomically write one JSON document (same-directory temp + rename). */
export async function writeJsonAtomic(path, value) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Read migration.json; a corrupt record is reported and treated as absent (never deleted). */
export async function readMigrationRecord(path) {
  const parsed = await readJsonFile(path);
  if (parsed.ok === false) {
    if (parsed.error === 'E_MISSING') return { ok: true, record: null, error: null };
    return { ok: false, record: null, error: parsed.error };
  }
  const value = parsed.value;
  if (isPlainObject(value) === false || value.version !== MIGRATION_VERSION || Array.isArray(value.sources) === false) {
    return { ok: false, record: null, error: 'E_MIGRATION_SHAPE' };
  }
  return { ok: true, record: value, error: null };
}

function legacyProjectError(id, code, message) {
  return { projectId: id, code, message: String(message || '').slice(0, 200) };
}

/**
 * Discover the project map of one legacy root without writing anything.
 *
 * Supported layouts (checked in order):
 *   1. `<root>/managed/projects.json`      alpha.9+ staging inner registry
 *   2. `<root>/managed/registry.json`      alpha.9+ staging outer registry → registryPath
 *   3. `<root>/projects.json`              a previous stable data root
 *   4. `<root>/registry.json`              legacy P2 static registry {root, projects}
 *
 * @returns { projectsRoot, projects: Map<id, path>, sessionStatePath, browserPath, source }
 */
export async function discoverLegacyRoot(root) {
  const discovered = {
    root,
    projectsRoot: null,
    projects: new Map(),
    sessionStatePath: null,
    browserPath: undefined,
    source: null,
  };
  if (typeof root !== 'string' || isAbsolute(root) === false) return { ...discovered, error: 'E_NOT_ABSOLUTE' };
  let info = null;
  try {
    info = await stat(root);
  } catch (_error) {
    return { ...discovered, error: 'E_LEGACY_MISSING' };
  }
  if (info.isDirectory() === false) return { ...discovered, error: 'E_NOT_DIRECTORY' };

  // Candidate registry files, in preference order.
  const candidates = [];
  const managedInner = join(root, 'managed', 'projects.json');
  const dataRootInner = join(root, 'projects.json');
  const managedOuter = join(root, 'managed', 'registry.json');
  const staticRegistry = join(root, 'registry.json');
  candidates.push({ kind: 'inner', path: managedInner, source: 'managed/projects.json' });
  candidates.push({ kind: 'inner', path: dataRootInner, source: 'projects.json' });
  candidates.push({ kind: 'outer', path: managedOuter, source: 'managed/registry.json' });
  candidates.push({ kind: 'static', path: staticRegistry, source: 'registry.json' });
  for (const candidate of candidates) {
    const parsed = await readJsonFile(candidate.path);
    if (parsed.ok === false) continue;
    const value = parsed.value;
    if (isPlainObject(value) === false) continue;
    if (candidate.kind === 'outer') {
      if (typeof value.projectsRoot !== 'string' || isAbsolute(value.projectsRoot) === false) continue;
      if (typeof value.registryPath !== 'string' || isAbsolute(value.registryPath) === false) continue;
      const inner = await readJsonFile(value.registryPath);
      if (inner.ok === false || isPlainObject(inner.value) === false || isPlainObject(inner.value.projects) === false) continue;
      discovered.projectsRoot = value.projectsRoot;
      for (const [id, path] of Object.entries(inner.value.projects)) discovered.projects.set(id, path);
      discovered.browserPath = typeof value.browserPath === 'string' && isAbsolute(value.browserPath) ? value.browserPath : undefined;
      discovered.source = candidate.source;
      break;
    }
    if (candidate.kind === 'static') {
      if (typeof value.root !== 'string' || isAbsolute(value.root) === false) continue;
      if (isPlainObject(value.projects) === false) continue;
      discovered.projectsRoot = value.root;
      for (const [id, path] of Object.entries(value.projects)) discovered.projects.set(id, path);
      discovered.browserPath = typeof value.browserPath === 'string' && isAbsolute(value.browserPath) ? value.browserPath : undefined;
      discovered.source = candidate.source;
      break;
    }
    if (isPlainObject(value.projects) === false) continue;
    discovered.projectsRoot = join(root, 'projects');
    for (const [id, path] of Object.entries(value.projects)) discovered.projects.set(id, path);
    discovered.source = candidate.source;
    break;
  }
  discovered.sessionStatePath = (await readJsonFile(join(root, 'session-state.json'))).ok === true ? join(root, 'session-state.json') : null;
  return discovered;
}

/**
 * Copy legacy projects into the stable data root and merge the old session map.
 *
 * Guarantees:
 *   - legacy roots are only read; never rewritten, moved or deleted;
 *   - existing data-root projects are never overwritten (`skipped-existing`);
 *   - a per-project/root failure is recorded and does not block the others;
 *   - `migration.json` is written atomically and drives idempotent retries
 *     (a source is retried while `completed` is false).
 */
export async function migrateLegacyRoots({ paths, legacyRoots, logger }) {
  const recordRead = await readMigrationRecord(paths.migrationPath);
  const previous = recordRead.record === null ? { version: MIGRATION_VERSION, migratedAt: null, sources: [] } : recordRead.record;
  const completed = new Set(previous.sources.filter((entry) => entry && entry.completed === true).map((entry) => entry.root));
  const results = [];
  const mergedStates = [];
  const projectEntries = new Map();
  const existingRegistry = await readProjectsRegistry(paths.projectsRegistryPath);
  if (existingRegistry.ok === true) {
    for (const [id, projectPath] of existingRegistry.projects) projectEntries.set(id, projectPath);
  }
  let browserPath = undefined;
  for (const entry of legacyRoots || []) {
    const root = entry.root;
    if (completed.has(root)) {
      results.push({ root, source: entry.source, completed: true, skippedRun: true, copied: [], skipped: [], errors: [] });
      continue;
    }
    const discovered = await discoverLegacyRoot(root);
    const result = {
      root,
      source: entry.source,
      via: entry.via,
      format: discovered.source,
      projectsRoot: discovered.projectsRoot,
      completed: false,
      copied: [],
      skipped: [],
      errors: [],
      sessionState: { merged: false },
      startedAt: new Date().toISOString(),
    };
    if (discovered.error !== undefined) {
      result.errors.push({ code: discovered.error, message: 'legacy data root is unavailable' });
      results.push(result);
      continue;
    }
    if (discovered.browserPath !== undefined && browserPath === undefined) browserPath = discovered.browserPath;
    const projectsRoot = discovered.projectsRoot;
    for (const [id, projectPath] of discovered.projects) {
      if (PROJECT_ID.test(id) === false) {
        result.errors.push(legacyProjectError(id, 'E_PROJECT_ID', 'invalid project id'));
        continue;
      }
      if (typeof projectPath !== 'string' || isAbsolute(projectPath) === false) {
        result.errors.push(legacyProjectError(id, 'E_PROJECT_PATH', 'project path is not absolute'));
        continue;
      }
      const target = join(paths.projectsRoot, id);
      if (projectEntries.has(id)) {
        result.skipped.push(id);
        continue;
      }
      let sourceReal;
      try {
        sourceReal = await realpath(projectPath);
        if ((await stat(sourceReal)).isDirectory() === false) throw new Error('not a directory');
      } catch (_error) {
        result.errors.push(legacyProjectError(id, 'E_PROJECT_MISSING', 'project directory is unavailable'));
        continue;
      }
      if (projectsRoot !== null) {
        let rootReal;
        try {
          rootReal = await realpath(projectsRoot);
        } catch (_error) {
          result.errors.push({ code: 'E_PROJECTS_ROOT', message: 'legacy projects root is unavailable' });
          continue;
        }
        if (insidePath(rootReal, sourceReal) === false) {
          result.errors.push(legacyProjectError(id, 'E_PROJECT_ESCAPES', 'project escapes the legacy projects root'));
          continue;
        }
      } else if (insidePath(await realpath(root), sourceReal) === false) {
        result.errors.push(legacyProjectError(id, 'E_PROJECT_ESCAPES', 'project escapes the legacy data root'));
        continue;
      }
      // Never merge a copy into an existing unregistered directory. A failed
      // legacy copy may already have left one here; preserve it for recovery.
      let staging;
      try {
        try {
          await lstat(target);
          result.errors.push(legacyProjectError(id, 'E_PROJECT_TARGET_EXISTS', 'unregistered target exists; preserved for recovery'));
          continue;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        staging = await mkdtemp(join(paths.cacheRoot, 'migration-'));
        const complete = join(staging, 'project');
        await cp(sourceReal, complete, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
        await rename(complete, target);
        projectEntries.set(id, target);
        result.copied.push(id);
      } catch (error) {
        result.errors.push(legacyProjectError(id, 'E_PROJECT_COPY', error && error.message));
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
      }
    }
    if (discovered.sessionStatePath !== null) {
      const parsed = await readJsonFile(discovered.sessionStatePath);
      if (parsed.ok === true) {
        mergedStates.push(parsed.value);
        result.sessionState = { merged: true };
      } else {
        result.errors.push(legacyProjectError(null, 'E_SESSION_STATE', `session state unreadable (${parsed.error})`));
      }
    }
    result.completed = result.errors.length === 0;
    result.finishedAt = new Date().toISOString();
    results.push(result);
  }

  // Persist the project map (user data directory listing only; content is not
  // rewritten). Existing entries always win over a legacy mapping.
  if (projectEntries.size !== (existingRegistry.ok ? existingRegistry.projects.size : 0)) {
    await writeJsonAtomic(paths.projectsRegistryPath, { version: REGISTRY_VERSION, managed: true, projects: Object.fromEntries(projectEntries) });
  }
  // A worker browser path discovered in the legacy outer registry is derived
  // configuration: record it so frame/render keep using the reviewed Chrome.
  if (browserPath !== undefined) {
    const worker = await readWorkerRegistry(paths.registryPath);
    if (worker.ok === true && worker.value.browserPath === undefined) {
      await writeJsonAtomic(paths.registryPath, { ...worker.value, browserPath });
    }
  }
  const merged = {
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    sources: mergeSources(previous.sources, results),
  };
  await writeJsonAtomic(paths.migrationPath, merged);
  if (logger && typeof logger.warn === 'function') {
    for (const result of results) {
      if (result.errors.length > 0) logger.warn(`dsh-video migration ${result.root}: ${result.errors.length} error(s)`);
    }
  }
  return { record: merged, results, mergedStates };
}

/** Keep previous source records, replacing them by root (idempotent append). */
function mergeSources(previousSources, results) {
  const byRoot = new Map();
  for (const entry of previousSources) if (entry && typeof entry.root === 'string') byRoot.set(entry.root, entry);
  for (const result of results) {
    // An already-completed source keeps its original evidence (copied list,
    // timestamps); a fresh retry replaces the previous attempt.
    const existing = byRoot.get(result.root);
    if (result.skippedRun === true && existing !== undefined) continue;
    byRoot.set(result.root, result);
  }
  return [...byRoot.values()];
}

/** Whether any legacy root still needs a migration run. */
export async function migrationPending(paths, legacyRoots) {
  const record = await readMigrationRecord(paths.migrationPath);
  if (record.ok === false) return true;
  if (record.record === null) return (legacyRoots || []).length > 0;
  const completed = new Set(record.record.sources.filter((entry) => entry && entry.completed === true).map((entry) => entry.root));
  return (legacyRoots || []).some((entry) => completed.has(entry.root) === false);
}


/** Timestamped evidence suffix for a file that must be moved aside (never deleted). */
function corruptSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Move an unreadable/known-bad file aside and write a repaired replacement.
 * The original bytes are kept as `<path>.corrupt-<timestamp>`.
 */
export async function quarantineCorruptFile(path) {
  const backup = `${path}.corrupt-${corruptSuffix()}`;
  try {
    await rename(path, backup);
    return { moved: true, backup };
  } catch (_error) {
    return { moved: false, backup: null };
  }
}

/** Write only the last-known-good .bak copy of a project map. */
export async function writeProjectsBackup(paths, projects) {
  await writeJsonAtomic(paths.projectsRegistryPath + '.bak', { version: REGISTRY_VERSION, managed: true, projects: Object.fromEntries(projects) });
}

/** Atomically write a project map plus its last-known-good .bak copy. */
export async function writeProjectsRegistry(paths, projects) {
  const payload = { version: REGISTRY_VERSION, managed: true, projects: Object.fromEntries(projects) };
  await writeJsonAtomic(paths.projectsRegistryPath, payload);
  try {
    await writeJsonAtomic(paths.projectsRegistryPath + '.bak', payload);
  } catch (_error) {
    /* the recovery copy is advisory */
  }
}

/**
 * Repair a corrupt project map: keep the corrupt bytes aside, then write the
 * recovered (or empty) map so the frozen worker registry can still be read.
 */
export async function repairProjectsRegistry(paths, projects) {
  await quarantineCorruptFile(paths.projectsRegistryPath);
  await writeProjectsRegistry(paths, projects);
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (_error) {
    return false;
  }
}

/**
 * Last-resort project-map rebuild (M1-04 follow-up).
 *
 * When both the project map and its .bak/temp copies are unreadable, recover the
 * registry from the directories actually present under <dataRoot>/projects.
 * A directory counts as a project when it has index.html + project.json; anything
 * else (partial copy / foreign directory) is reported as quarantined instead of
 * being silently registered.
 */
export async function scanProjectsRoot(paths) {
  const projects = new Map();
  const quarantined = new Map();
  let names;
  try {
    names = await readdir(paths.projectsRoot);
  } catch (_error) {
    return { projects, quarantined, scanned: 0 };
  }
  names.sort();
  for (const name of names) {
    if (PROJECT_ID.test(name) === false) continue;
    const directory = join(paths.projectsRoot, name);
    let info;
    try {
      info = await stat(directory);
    } catch (_error) {
      continue;
    }
    if (info.isDirectory() === false) continue;
    let real;
    try {
      real = await realpath(directory);
    } catch (_error) {
      continue;
    }
    const hasIndex = await fileExists(join(real, 'index.html')) || await fileExists(join(real,'timeline.json'));
    const hasManifest = await fileExists(join(real, 'project.json'));
    if (hasIndex && hasManifest) projects.set(name, real);
    else quarantined.set(name, 'E_PROJECT_INCOMPLETE');
  }
  return { projects, quarantined, scanned: projects.size + quarantined.size };
}
