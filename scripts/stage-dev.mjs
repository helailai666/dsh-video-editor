#!/usr/bin/env node
/**
 * Prepare an immutable development staging snapshot for Plugin Manager `link:`
 * installation. This is NOT a portable distribution tarball.
 *
 * It copies the committed root bundle and the engine packages from one exact,
 * reviewed engine commit, prepares the worker dependency closure with
 * `npm ci --ignore-scripts`, prepares the controlled fixture, and records every
 * source commit, file digest, version and local dependency link.
 *
 * Usage:
 *   node scripts/stage-dev.mjs --engine-commit <sha> --bundle-version <semver> \
 *     --node <absolute node> [--browser <absolute chrome>] \
 *     [--font <absolute ttf>] [--out <dir>] [--skip-fixture] [--allow-dirty]
 *
 * The default output lives next to the repository worktree (never inside it):
 *   ../artifacts/p2-b/staging
 *
 * The root bundle version is never guessed: `--bundle-version` is required and
 * must equal the version in the committed root package.json of the exact commit
 * being staged. A malformed value or mismatch fails before the output directory
 * or dependency install is created (see scripts/lib/stage-version.mjs), and the
 * reviewed engine version pins below stay unchanged.
 *
 * The engine commit must already expose the P2-003 `./worker` and
 * `./package.json` exports. The script refuses an old engine snapshot instead of
 * silently staging a client without the explicit env/cwd seam.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { admitBundleVersion, parseBundleVersion } from './lib/stage-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_PATHS = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'host/bridge.js',
  'host/updates.js',
  'host/release-runtime.js',
  'host/audio.js',
  'host/audio-synth.js',
  'host/audio-synth-worker.js',
  'skills/audio-creation/SKILL.md',
  'skills/audio-creation/THIRD_PARTY.md',
  'skills/music-scoring-library/SKILL.md',
  'skills/drama-beat-shifts/SKILL.md',
  'host/data-root.js',
  'host/ui-state.js',
  'host/config.js',
  'host/engine.js',
  'host/env.js',
  'host/errors.js',
  'host/limits.js',
  'host/routes.js',
  'host/media-routes.js',
  'host/tool.js',
  'host/sessions.js',
  'host/session-state.js',
  'host/preview.js',
  'host/snapshot.js',
  'host/asset-inbox.js',
  'host/canvas-runtime.js',
  'README.md',
];
const DEFAULT_OUT = resolve(ROOT, '..', 'artifacts', 'p2-b', 'staging');
/**
 * Engine package versions that an independently reviewed fixed commit may use.
 * Add a pair only after the coordinator names a reviewed fixed commit; never
 * follow the p1 branch HEAD automatically.
 */
const REVIEWED_ENGINE_PAIRS = Object.freeze([
  { client: '0.1.1', worker: '0.1.1' },
  { client: '0.3.0', worker: '0.3.0' },
  { client: '0.3.1', worker: '0.3.1' },
  { client: '0.3.2', worker: '0.3.2' },
  { client: '0.4.0', worker: '0.4.0' },
  { client: '0.5.0', worker: '0.5.0' },
  { client: '0.6.0', worker: '0.6.0' },
  { client: '0.7.0', worker: '0.7.0' },
  { client: '0.8.0', worker: '0.8.0' },
  { client: '0.8.1', worker: '0.8.1' },
  { client: '0.8.2', worker: '0.8.2' },
  { client: '0.8.3', worker: '0.8.3' },
  { client: '0.9.0', worker: '0.9.0' },
]);
/** Managed-project registries exist from engine 0.3.0; stricter than the pair list on purpose. */
const MANAGED_ENGINE_VERSIONS = Object.freeze(['0.3.0', '0.3.1', '0.3.2', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.8.1', '0.8.2', '0.8.3', '0.9.0']);

const ENGINE_CLIENT = 'packages/video-engine-client';
const ENGINE_WORKER = 'packages/video-engine-worker';

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/stage-dev.mjs --engine-commit <sha> --bundle-version <semver> --node <absolute node> [--browser <absolute chrome>] [--font <absolute ttf>] [--out <dir>] [--skip-fixture] [--allow-dirty]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  args.legacyDataRoots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--skip-fixture') args.skipFixture = true;
    else if (key === '--allow-dirty') args.allowDirty = true;
    else if (key === '--legacy-data-root' || key === '--migrate-from') {
      const value = argv[index + 1];
      if (value === undefined || isAbsolute(value) === false) usage(`${key} must be an absolute path`);
      args.legacyDataRoots.push(value);
      index += 1;
    }
    else if (key === '--engine-commit' || key === '--bundle-version' || key === '--node' || key === '--browser' || key === '--font' || key === '--out' || key === '--data-root') {
      const value = argv[index + 1];
      if (value === undefined) usage(`missing value for ${key}`);
      const name = key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      args[name] = value;
      index += 1;
    } else usage(`unknown argument ${key}`);
  }
  if (!args.engineCommit) usage('--engine-commit is required');
  if (!args.bundleVersion) usage('--bundle-version is required');
  try {
    args.bundleVersion = parseBundleVersion(args.bundleVersion, '--bundle-version');
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  if (!args.node || isAbsolute(args.node) === false) usage('--node must be an absolute Node executable path');
  if (args.browser !== undefined && isAbsolute(args.browser) === false) usage('--browser must be absolute');
  if (args.font !== undefined && isAbsolute(args.font) === false) usage('--font must be absolute');
  if (args.out !== undefined && isAbsolute(args.out) === false) usage('--out must be absolute');
  if (args.dataRoot !== undefined && isAbsolute(args.dataRoot) === false) usage('--data-root must be absolute');
  args.legacyDataRoots = [...new Set(args.legacyDataRoots)];
  return args;
}

function run(command, options) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} exited with ${result.status}`);
}

function git(args, options) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root, options) {
  const settings = options || {};
  const output = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (settings.exclude !== undefined && settings.exclude(rel) === true) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(rel);
    }
  }
  await walk(root);
  return output.sort();
}

async function digestTree(root, exclude) {
  const files = await listFiles(root, { exclude });
  const entries = [];
  for (const rel of files) {
    const bytes = await readFile(join(root, rel));
    entries.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return entries;
}

async function copyRuntimeFiles(sourceRoot, bundleRoot) {
  for (const rel of RUNTIME_PATHS) {
    const source = join(sourceRoot, rel);
    if (existsSync(source) === false) throw new Error(`committed runtime file is missing: ${rel}`);
    const destination = join(bundleRoot, rel);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

async function extractCommitPaths(commit, paths, destination) {
  await mkdir(destination, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', commit, ...paths], {
    cwd: ROOT,
    encoding: 'buffer',
  });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${String(archive.stderr)}`);
  const tar = spawnSync('tar', ['-x', '-C', destination], {
    cwd: ROOT,
    input: archive.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (tar.status !== 0) throw new Error(`tar extraction for ${commit} failed`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootCommit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  if (dirty.length > 0 && args.allowDirty !== true) {
    throw new Error('the root worktree is not clean; commit the reviewed code before staging (or pass --allow-dirty for an exploratory snapshot)');
  }
  // R1 (P2-007): the explicitly declared bundle version must equal the version
  // pinned in the committed root manifest for this exact commit. This runs
  // before the output directory, engine extraction or any dependency install.
  const committedPackageSource = git(['show', `${rootCommit}:package.json`]);
  let committedPackage;
  try {
    committedPackage = JSON.parse(committedPackageSource);
  } catch (_error) {
    throw new Error(`committed root package.json at ${rootCommit} is not valid JSON`);
  }
  const bundleVersionGate = admitBundleVersion({
    expectedVersion: args.bundleVersion,
    manifestVersion: committedPackage.version,
  });
  const engineCommit = git(['rev-parse', '--verify', `${args.engineCommit}^{commit}`]);

  const out = args.out === undefined ? DEFAULT_OUT : resolve(args.out);
  if (existsSync(out)) {
    const entries = await readdir(out);
    if (entries.length > 0) throw new Error(`staging output ${out} is not empty; use a new immutable directory`);
    await rm(out, { recursive: true, force: true });
  }
  const work = join(out, '.work');
  const bundleRoot = join(out, 'bundle');
  const clientRoot = join(out, 'engine-client');
  const workerRoot = join(out, 'engine-worker');
  await mkdir(bundleRoot, { recursive: true });
  await mkdir(work, { recursive: true });

  try {
    // 1. Root bundle from the exact reviewed commit, not the working tree.
    await extractCommitPaths(rootCommit, RUNTIME_PATHS, work);
    await copyRuntimeFiles(work, bundleRoot);
    // package.json is not inside RUNTIME_PATHS; write the committed one already
    // admitted by the bundle version gate above.
    await writeFile(join(bundleRoot, 'package.json'), committedPackageSource);
    const parsedPackage = committedPackage;

    // 2. Engine packages from the exact engine commit.
    await extractCommitPaths(engineCommit, [ENGINE_CLIENT, ENGINE_WORKER], work);
    await cp(join(work, ENGINE_CLIENT), clientRoot, { recursive: true });
    await cp(join(work, ENGINE_WORKER), workerRoot, { recursive: true });
    const clientPackage = JSON.parse(await readFile(join(clientRoot, 'package.json'), 'utf8'));
    const workerPackage = JSON.parse(await readFile(join(workerRoot, 'package.json'), 'utf8'));
    const reviewed = REVIEWED_ENGINE_PAIRS.find((pair) => pair.client === clientPackage.version && pair.worker === workerPackage.version);
    if (reviewed === undefined) {
      throw new Error(`engine versions ${clientPackage.version}/${workerPackage.version} are not a reviewed engine pair; update REVIEWED_ENGINE_PAIRS only with an independently reviewed fixed commit`);
    }
    for (const [name, manifest] of [['client', clientPackage], ['worker', workerPackage]]) {
      if (manifest.private !== true) throw new Error(`engine ${name} package must stay private in the snapshot`);
    }
    for (const [name, manifest] of [['client', clientPackage], ['worker', workerPackage]]) {
      const exportsValue = manifest.exports;
      const hasWorker = typeof exportsValue === 'object' && exportsValue !== null && exportsValue['./worker'] !== undefined;
      const hasManifest = typeof exportsValue === 'object' && exportsValue !== null && exportsValue['./package.json'] !== undefined;
      if (name === 'worker' && (hasWorker === false || hasManifest === false)) {
        throw new Error('engine worker commit does not expose ./worker and ./package.json; use the reviewed P2-003 commit');
      }
      if (name === 'client' && hasManifest === false) {
        throw new Error('engine client commit does not expose ./package.json; use the reviewed P2-003 commit');
      }
    }

    // 3. Staging-only local dependency wiring: manifest entries plus relative
    // symlinks inside this immutable snapshot. This is not a portable tarball.
    const stagedPackage = Object.assign({}, parsedPackage, {
      dependencies: Object.assign({}, parsedPackage.dependencies || {}, {
        'dsh-video-engine-client': 'file:../engine-client',
        'dsh-video-engine-worker': 'file:../engine-worker',
      }),
    });
    await writeFile(join(bundleRoot, 'package.json'), JSON.stringify(stagedPackage, null, 2) + '\n');
    await mkdir(join(bundleRoot, 'node_modules'), { recursive: true });
    await symlink(join('..', '..', 'engine-client'), join(bundleRoot, 'node_modules', 'dsh-video-engine-client'), 'dir');
    await symlink(join('..', '..', 'engine-worker'), join(bundleRoot, 'node_modules', 'dsh-video-engine-worker'), 'dir');

    // 4. Worker dependency closure from its committed lock, ignore-scripts.
    const cache = join(out, 'cache');
    const npmEnv = Object.assign({}, process.env, { npm_config_cache: cache });
    run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: workerRoot, env: npmEnv });
    const esbuildCandidates = [
      join(workerRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      join(workerRoot, 'node_modules', '@esbuild'),
    ];
    const esbuildAvailable = esbuildCandidates.some((candidate) => existsSync(candidate));

    // 5. Controlled fixture and registry.
    if (args.skipFixture !== true) {
      const fixtureEnv = Object.assign({}, process.env);
      if (args.font !== undefined) fixtureEnv.VIDEO_FONT_PATH = args.font;
      if (args.browser !== undefined) fixtureEnv.VIDEO_BROWSER_PATH = args.browser;
      run(['npm', 'run', 'prepare-fixture'], { cwd: workerRoot, env: fixtureEnv });
    }
    let registryPath = join(workerRoot, 'artifacts', 'registry.json');
    if (existsSync(registryPath) === false) throw new Error(`fixture registry not found at ${registryPath}; run without --skip-fixture`);
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    await mkdir(registry.outputRoot, { recursive: true });
    let managed = null;
    if (MANAGED_ENGINE_VERSIONS.includes(clientPackage.version)) {
      const projectsRoot = join(out, 'projects');
      const assetInboxRoot = join(out, 'asset-inbox');
      const managedDir = join(out, 'managed');
      const restoreRoot = join(out, 'restore');
      await mkdir(managedDir, { recursive: true });
      await mkdir(projectsRoot, { recursive: true });
      await mkdir(assetInboxRoot, { recursive: true });
      await mkdir(restoreRoot, { recursive: true });
      const fixtureProject = join(workerRoot, 'artifacts', 'projects', 'demo');
      await cp(fixtureProject, join(projectsRoot, 'demo'), { recursive: true });
      await cp(fixtureProject, join(restoreRoot, 'demo'), { recursive: true });
      const innerRegistryPath = join(managedDir, 'projects.json');
      await writeFile(innerRegistryPath, JSON.stringify({ projects: { demo: join(projectsRoot, 'demo') } }, null, 2) + '\n');
      registryPath = join(managedDir, 'registry.json');
      const managedConfig = {
        projectsRoot,
        registryPath: innerRegistryPath,
        outputRoot: registry.outputRoot,
        assetInboxRoot,
        ...(args.browser === undefined ? {} : { browserPath: args.browser }),
      };
      await writeFile(registryPath, JSON.stringify(managedConfig, null, 2) + '\n');
      managed = {
        projectsRoot,
        assetInboxRoot,
        innerRegistryPath,
        managedConfigPath: registryPath,
        restoreRoot,
      };
    }

    // 6. Development-only Host config with snapshot-absolute paths.
    const sessionCwd = join(out, 'session-cwd');
    await mkdir(sessionCwd, { recursive: true });
    const config = {
      workerNode: args.node,
      workerCwd: workerRoot,
      registryPath,
      artifactRoot: registry.outputRoot,
      allowedProjects: Object.keys(registry.projects),
      sessionStatePath: join(out, 'session-state.json'),
      sessionCwd,
      ...(managed === null ? {} : { projectsRoot: managed.projectsRoot, assetInboxRoot: managed.assetInboxRoot }),
      ...(args.browser === undefined ? {} : { browserPath: args.browser }),
      // M1: the stable user data root. When omitted the runtime resolves
      // ~/Movies/DSH Video (or DSH_VIDEO_DATA_ROOT); it is never hardcoded to a
      // developer path here. Legacy roots are explicit build inputs plus this
      // snapshot's own fixture root so a fresh staging still shows the demo.
      ...(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot }),
      legacyDataRoots: [...new Set([...args.legacyDataRoots, out])],
    };
    const configPath = join(out, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    // A Plugin Manager link install activates the committed patch as-is, so the
    // staging snapshot also writes the trusted config into its own bundle patch.
    // JSON flow mapping is valid YAML and avoids hand-built YAML escaping.
    const patchPath = join(bundleRoot, 'cordis.patch.yml');
    const committedPatch = await readFile(patchPath, 'utf8');
    const stagedPatch = committedPatch.replace(/config:\s*\{\s*\}/, 'config: ' + JSON.stringify(config));
    if (stagedPatch === committedPatch) throw new Error('could not inject the staging-only trusted config into cordis.patch.yml');
    await writeFile(patchPath, stagedPatch);

    // 7. Prove package resolution from the staged bundle itself.
    const requireFromBundle = createRequire(pathToFileURL(join(bundleRoot, 'index.js')));
    const clientEntry = requireFromBundle.resolve('dsh-video-engine-client');
    const workerEntry = requireFromBundle.resolve('dsh-video-engine-worker/worker');
    const workerManifest = requireFromBundle.resolve('dsh-video-engine-worker/package.json');
    if (existsSync(clientEntry) === false || existsSync(workerEntry) === false || existsSync(workerManifest) === false) {
      throw new Error('staged bundle does not resolve the engine package entries');
    }

    const bundleFiles = await digestTree(bundleRoot, (rel) => rel.startsWith('node_modules/'));
    const patchSha = sha256(await readFile(patchPath));
    const clientFiles = await digestTree(clientRoot, (rel) => rel.startsWith('node_modules/'));
    const workerFiles = await digestTree(workerRoot, (rel) => rel.startsWith('node_modules/') || rel.startsWith('artifacts/') || rel.startsWith('cache/'));
    const integrity = {
      kind: 'dsh-video-development-staging-snapshot',
      createdAt: new Date().toISOString(),
      portability: 'Development-only immutable snapshot for Plugin Manager link installation; relative local dependencies are not a portable distribution tarball.',
      rootCommit,
      rootDirty: dirty.length > 0,
      engineCommit,
      versions: {
        bundle: parsedPackage.version,
        client: clientPackage.version,
        worker: workerPackage.version,
      },
      bundleVersionGate: {
        expected: bundleVersionGate.expectedVersion,
        manifest: bundleVersionGate.manifestVersion,
        source: `committed root package.json at ${rootCommit}`,
        requirement: 'explicit --bundle-version must equal the pinned committed manifest version; rejected before output/dependency work',
      },
      node: args.node,
      browser: args.browser === undefined ? null : args.browser,
      font: args.font === undefined ? null : args.font,
      fixture: { registryPath, projectIds: Object.keys(registry.projects), outputRoot: registry.outputRoot },
      localDependencies: {
        'dsh-video-engine-client': '../engine-client',
        'dsh-video-engine-worker': '../engine-worker',
        note: 'staging package.json dependencies plus node_modules relative symlinks; the root committed package.json has none of these dev paths',
      },
      resolution: { clientEntry, workerEntry, workerManifest },
      workerDependencies: { installedWith: 'npm ci --ignore-scripts', esbuildAvailable },
      files: { bundle: bundleFiles, engineClient: clientFiles, engineWorker: workerFiles },
      config: { path: configPath, sha256: sha256(await readFile(configPath)) },
      ...(managed === null ? {} : {
        managed: {
          projectsRoot: managed.projectsRoot,
          assetInboxRoot: managed.assetInboxRoot,
          registryPath: managed.managedConfigPath,
          registrySha256: sha256(await readFile(managed.managedConfigPath)),
          innerRegistryPath: managed.innerRegistryPath,
          innerRegistrySha256: sha256(await readFile(managed.innerRegistryPath)),
          restoreRoot: managed.restoreRoot,
        },
      }),
      stagedBundlePatch: { path: patchPath, sha256: patchSha, note: 'staging-only config injected into the copied patch; the committed root patch keeps config: {}' },
    };
    await writeFile(join(out, 'INTEGRITY.json'), JSON.stringify(integrity, null, 2) + '\n');

    console.log(JSON.stringify({
      staging: out,
      bundle: bundleRoot,
      config: configPath,
      integrity: join(out, 'INTEGRITY.json'),
      engineCommit,
      rootCommit,
      versions: integrity.versions,
      bundleVersionGate: integrity.bundleVersionGate,
      esbuildAvailable,
    }, null, 2));
    if (esbuildAvailable === false) {
      console.error('warning: esbuild binary not found after ignore-scripts install; record this as a staging blocker, do not run postinstall');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`stage-dev failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
