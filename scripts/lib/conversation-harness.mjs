/**
 * Shared plumbing for the P3-012 verifier harnesses (no product code).
 *
 * Both `scripts/test-conversation-chain.mjs` (real staged Host + worker + Tool +
 * snapshot bytes + real Chrome runtime load) and
 * `scripts/test-conversation-preview.mjs` (real staged client component in real
 * Chrome against the real staged bridge) need the same trusted-staging loader,
 * isolated mutable state root, bridge context and Tool invocation. This module
 * keeps only that plumbing; every assertion stays in the harness scripts.
 *
 * Mutable state policy: the verified staging snapshot is never written. All
 * bridge/worker business state is redirected into a fresh OS temp directory and
 * is recorded in the evidence JSON.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealDataRoot, supportsDataRoot } from './data-root-isolation.mjs';

export const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ROOT = resolve(LIB_DIR, '..', '..');
export const DEFAULT_EVIDENCE_ROOT = resolve(LIB_DIR, '..', '..', '..', 'artifacts', 'p3-012', 'evidence');
export const REQUEST_PATH = '/api/dsh-video/request';

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function stamp(date) {
  return (date || new Date()).toISOString().replace(/[:.]/g, '-');
}

/** Generic CLI parser shared by both harnesses. */
export function parseCli(argv, options) {
  const settings = options || {};
  const args = { caseFilter: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--staging') {
      args.staging = argv[index + 1];
      index += 1;
    } else if (argument === '--out' && settings.allowOut !== false) {
      args.out = argv[index + 1];
      index += 1;
    } else if (argument === '--case' && settings.allowCase === true) {
      args.caseFilter = argv[index + 1];
      index += 1;
    } else {
      throw new UsageError('unknown argument ' + argument);
    }
  }
  if (typeof args.staging !== 'string' || args.staging.length === 0 || isAbsolute(args.staging) === false) {
    throw new UsageError('--staging must be an absolute staging directory');
  }
  if (args.out !== undefined && isAbsolute(args.out) === false) {
    throw new UsageError('--out must be an absolute directory when given');
  }
  if (settings.allowCase !== true) delete args.caseFilter;
  if (args.caseFilter !== null && args.caseFilter !== undefined) {
    args.caseFilter = args.caseFilter.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  }
  return args;
}

export class UsageError extends Error {}

/** Per-run check recorder: every acceptance point becomes one evidence entry. */
export function createChecks() {
  const checks = [];
  return {
    checks,
    check(name, ok, details) {
      const entry = { name, ok: ok === true };
      if (details !== undefined) entry.details = details;
      checks.push(entry);
      if (ok !== true) console.error('[check] FAIL ' + name + (details === undefined ? '' : ' ' + JSON.stringify(details).slice(0, 900)));
      return ok === true;
    },
    ok() {
      return checks.length > 0 && checks.every((entry) => entry.ok === true);
    },
    passed() {
      return checks.filter((entry) => entry.ok === true).length;
    },
  };
}

/**
 * Isolated mutable bridge state copied from the reviewed P3-008 browser harness
 * pattern: the staged tree keeps only immutable sources; the worker registry,
 * managed project tree, output and session state are redirected to temp.
 */
export async function prepareStateRoot(staging, config, prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix || 'dsh-p3012-'));
  const dataRootSupported = supportsDataRoot(config);
  const realDataRootBaseline = await snapshotRealDataRoot();
  // M1+ bundles treat <dataRoot> as authoritative; pre-M1 snapshots keep the
  // historical sibling layout so the same harness runs against both.
  const dataRoot = dataRootSupported ? join(base, 'data') : null;
  const directories = dataRootSupported
    ? {
        projects: join(dataRoot, 'projects'),
        output: join(dataRoot, 'cache', 'output'),
        inbox: join(dataRoot, 'asset-inbox'),
        sessionCwd: join(dataRoot, 'session-cwd'),
        managed: dataRoot,
      }
    : {
        projects: join(base, 'projects'),
        output: join(base, 'output'),
        inbox: join(base, 'asset-inbox'),
        sessionCwd: join(base, 'session-cwd'),
        managed: join(base, 'managed'),
      };
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  const stagingRegistry = JSON.parse(await readFile(config.registryPath, 'utf8'));
  assert(stagingRegistry !== null && typeof stagingRegistry === 'object' && typeof stagingRegistry.projectsRoot === 'string',
    'staging worker registry is not a managed registry');
  const projectsRegistryPath = join(directories.managed, 'projects.json');
  const registry = {
    ...stagingRegistry,
    projectsRoot: directories.projects,
    registryPath: projectsRegistryPath,
    outputRoot: directories.output,
    assetInboxRoot: directories.inbox,
  };
  delete registry.projects;
  const registryPath = join(directories.managed, 'registry.json');
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');
  await writeFile(projectsRegistryPath, JSON.stringify({ projects: {} }, null, 2) + '\n');
  const { legacyDataRoots: ignoredLegacyRoots, ...redirectedBase } = config;
  const redirected = {
    ...redirectedBase,
    registryPath,
    artifactRoot: directories.output,
    projectsRoot: directories.projects,
    assetInboxRoot: directories.inbox,
    sessionStatePath: join(base, 'session-state.json'),
    sessionCwd: directories.sessionCwd,
    ...(dataRootSupported ? { dataRoot, legacyDataRoots: [] } : {}),
  };
  return { base, dataRoot, dataRootSupported, realDataRootBaseline, registryPath, projectsRegistryPath, directories, config: redirected, stagingRegistry };
}

/** Resolve one executable from PATH or as an absolute path. */
export async function resolveExecutable(command, env) {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const directory of ((env && env.PATH) || process.env.PATH || '').split(':')) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (_error) {
      /* keep searching */
    }
  }
  throw new Error('executable not found: ' + command);
}

/** Fake native session controller: enough for the real SessionService mapping. */
export function fakeSessionController(prefix) {
  let counter = 0;
  const created = [];
  const prompted = [];
  return {
    created,
    prompted,
    async create() {
      counter += 1;
      const sessionId = 'session-conv-' + (prefix || 'run') + '-' + counter;
      created.push(sessionId);
      return { sessionId };
    },
    async rename(request) {
      return { title: request.title, seq: 1 };
    },
    async inspect(sessionId) {
      return { meta: { id: sessionId }, events: [] };
    },
    // Public DSH admission path used by `session.send`; queue mode only.
    async prompt(request) {
      if (request.mode !== 'queue') throw new Error('fake: unsupported prompt mode');
      if (Array.isArray(request.content) === false || request.content.some((part) => part.type !== 'text')) {
        throw new Error('fake: unsupported prompt content');
      }
      prompted.push(request);
      return { accepted: true };
    },
  };
}

/** Host plugin context surface needed by the staged VideoBridge. */
export function fakeCtx(prefix) {
  const routes = [];
  const warnings = [];
  const tools = [];
  const sessionController = fakeSessionController(prefix);
  const services = {
    sessionController,
    workspaceRegistry: { archivedSessionIds: [] },
    systemPrompt: { context() { return () => {}; } },
    agents: { get() { return undefined; } },
  };
  const ctx = {
    logger: {
      warn(...parts) { warnings.push(parts.map(String).join(' ').slice(0, 500)); },
      error(...parts) { warnings.push(parts.map(String).join(' ').slice(0, 500)); },
    },
    subprocess: { resolveExecutable },
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      },
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    // The reviewed P3-008 harness context does not run effect callbacks; the
    // bridge/session service only needs the surface to exist for activation.
    effect() {
      return () => {};
    },
    get(name) {
      return services[name];
    },
  };
  return { ctx, routes, tools, warnings, sessionController };
}

/** Import the real staged Tool definition (same bytes the host bundle ships). */
export async function loadStagedTool(stagingRoot) {
  const module = await import(join(stagingRoot, 'bundle', 'host', 'tool.js'));
  assert(typeof module.createVideoTool === 'function', 'staged bundle does not export createVideoTool');
  return module.createVideoTool;
}

/**
 * Invoke the Tool exactly like the host model path: `execute(args, exec)` with
 * the trusted Agent Session id. The Tool throws a formatted public error, so
 * failures are normalized into a typed record instead of a stack.
 */
export async function callTool(tool, args, agentSessionId) {
  const startedAt = Date.now();
  const exec = agentSessionId === null || agentSessionId === undefined
    ? {}
    : { agent: { session: { id: agentSessionId } } };
  try {
    const value = await tool.execute(args, exec);
    return { ok: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /\[(E_[A-Z0-9_]+)(?:,\s*([a-z_]+))?/.exec(message);
    return {
      ok: false,
      message,
      code: match !== null ? match[1] : null,
      stage: match !== null && match[2] !== undefined ? match[2] : null,
      ms: Date.now() - startedAt,
    };
  }
}

/** Bound a request/result value for the evidence JSON. */
export function sanitize(value, limit) {
  const max = Number.isInteger(limit) ? limit : 4000;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return { unserializable: true };
    if (text.length <= max) return value;
    return { truncated: true, length: text.length, preview: text.slice(0, max) };
  } catch (_error) {
    return { unserializable: true };
  }
}

/** Digest one file; used to prove the served snapshot bytes equal the entry. */
export async function fileDigest(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

/** Write one evidence JSON file under <out>/<sub>/ and return the path. */
export async function writeEvidence(outRoot, subdirectory, name, evidence) {
  const directory = subdirectory === null || subdirectory === undefined ? outRoot : join(outRoot, subdirectory);
  await mkdir(directory, { recursive: true });
  const file = join(directory, name + '-' + stamp() + '.json');
  await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
  return file;
}

/** Write one binary evidence artifact (screenshot) and return its path. */
export async function writeBinary(outRoot, subdirectory, name, bytes) {
  const directory = subdirectory === null || subdirectory === undefined ? outRoot : join(outRoot, subdirectory);
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, bytes);
  return file;
}

// ─── staging read-only audit (adapted from the P3-008 browser harness) ─────

const STAGING_EXCLUDED_PREFIXES = [
  'bundle/node_modules/',
  'engine-client/node_modules/',
  'engine-worker/node_modules/',
  'engine-worker/artifacts/',
  'engine-worker/cache/',
  'cache/',
  'evidence/',
  'projects/',
  'managed/',
  'restore/',
  'asset-inbox/',
  'session-cwd/',
  'session-state.json',
];

function stagingSourceExcluded(relativePath) {
  if (STAGING_EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) return true;
  return false;
}

export async function listStagingSources(stagingRoot) {
  const entries = [];
  async function walk(directory, relative) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const childRelative = relative === '' ? child.name : relative + '/' + child.name;
      if (stagingSourceExcluded(childRelative)) continue;
      const childPath = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(childPath, childRelative);
      } else if (child.isFile()) {
        const info = await stat(childPath);
        entries.push({ path: childRelative, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) });
      }
    }
  }
  await walk(stagingRoot, '');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function compareStagingSources(before, after) {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const changed = [];
  for (const [path, entry] of beforeMap) {
    const next = afterMap.get(path);
    if (next === undefined) changed.push({ path, change: 'removed' });
    else if (next.bytes !== entry.bytes || next.mtimeMs !== entry.mtimeMs) changed.push({ path, change: 'modified', beforeBytes: entry.bytes, afterBytes: next.bytes });
  }
  for (const path of afterMap.keys()) {
    if (beforeMap.has(path) === false) changed.push({ path, change: 'added' });
  }
  return { same: changed.length === 0, changed, beforeCount: before.length, afterCount: after.length };
}

/** Find one bridge route by exact path and fetch it through its own handler.
 * `pathWithQuery` may carry the fixed-runtime instance/nonce handshake. */
export async function fetchRoute(routes, pathWithQuery, init) {
  const path = String(pathWithQuery).split('?')[0];
  const route = routes.find((candidate) => candidate.path === path);
  assert(route !== undefined, 'route is not registered: ' + path);
  const request = new Request('http://127.0.0.1' + pathWithQuery, init || { method: 'GET' });
  return route.fetch(request);
}

/**
 * Strip the fixed runtime script tag the Host snapshot layer injects before
 * `</body>`; the remaining bytes must equal the published entry exactly.
 * The injected src carries `?v=1&instance=...&nonce=...` (0.3.2+ runtime
 * handshake), so the match tolerates any query string and one trailing newline.
 */
export function stripInjectedRuntime(html) {
  return html.replace(/<script src="[^"]*canvas-runtime\.js[^"]*"><\/script>\n/, '');
}

/** The resident local BridgeError code/message/stage from a public error body. */
export function publicErrorOf(body) {
  if (body === null || typeof body !== 'object' || body.ok !== false || body.error === null || typeof body.error !== 'object') return null;
  return {
    code: typeof body.error.code === 'string' ? body.error.code : null,
    message: typeof body.error.message === 'string' ? body.error.message : null,
    stage: typeof body.error.stage === 'string' ? body.error.stage : null,
    uncertain: body.error.uncertain === true,
  };
}

/** Bridge invoke via the HTTP source (UI-only actions stay reachable). */
export function invokeHttp(bridge, method, params) {
  return bridge.invoke(method, params, { source: 'http' });
}
