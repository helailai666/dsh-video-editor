#!/usr/bin/env node
/**
 * Behavior regression for the P2-007 staging bundle-version gate (R1).
 *
 * The staging script must not guess which root version is reviewed: it requires
 * an explicit `--bundle-version <semver>` and accepts it only when it equals the
 * committed root package.json version of the exact commit being staged. These
 * checks exercise the pure admission logic plus the real CLI preflight. They
 * never install dependencies and never write a staging snapshot: a rejected
 * value must fail before the output directory or an `npm` call exists.
 *
 * Deliberately NOT claimed here: that a full staging succeeds. That is separate
 * delivery evidence produced with scripts/stage-dev.mjs from a committed tree
 * (`INTEGRITY.json`, package digests, real Host->worker chain).
 *
 * Run: node scripts/test-stage-version.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitBundleVersion, parseBundleVersion } from './lib/stage-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE_DEV = join(ROOT, 'scripts', 'stage-dev.mjs');
const ENGINE_COMMIT = '54f467147ae2f61e118099c4947f55e8da877500';
const REVIEWED_BUNDLE_VERSION = '1.0.3';
const NODE = process.execPath;

const passes = [];
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    const detail = fn();
    passes.push([name, detail === undefined ? 'ok' : String(detail)]);
  } catch (error) {
    failures.push([name, error instanceof Error ? error.message : String(error)]);
  }
}

function committedManifest() {
  const result = spawnSync('git', ['show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8' });
  assert(result.status === 0, `git show HEAD:package.json failed: ${(result.stderr || '').trim()}`);
  return JSON.parse(result.stdout);
}

function runStageDev(argumentsList, options) {
  return spawnSync(NODE, [STAGE_DEV, ...argumentsList], {
    cwd: ROOT,
    encoding: 'utf8',
    env: options && options.env ? options.env : process.env,
  });
}

function stageArgs(out, extra) {
  return [
    '--engine-commit', ENGINE_COMMIT,
    '--node', NODE,
    '--out', out,
    '--allow-dirty',
    ...(extra || []),
  ];
}

/** A fake `npm` earlier in PATH proves whether a dependency install was ever attempted. */
function fakeNpm(binDirectory, marker) {
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    join(binDirectory, 'npm'),
    `#!/bin/sh\n: > "${marker}"\n echo fake-npm-should-not-run >&2\n exit 91\n`,
    { mode: 0o755 },
  );
  return { ...process.env, PATH: `${binDirectory}:${process.env.PATH || ''}` };
}

const work = mkdtempSync(join(tmpdir(), 'dsh-video-stage-version-'));

try {
  test('committed manifest still pins the reviewed delivery version', () => {
    const manifest = committedManifest();
    assert(manifest.version === REVIEWED_BUNDLE_VERSION, `committed root package version is ${JSON.stringify(manifest.version)}, expected ${REVIEWED_BUNDLE_VERSION}; update this regression deliberately with a release`);
    return manifest.version;
  });

  test('committed manifest + the same explicit version passes version admission', () => {
    const admitted = admitBundleVersion({ expectedVersion: REVIEWED_BUNDLE_VERSION, manifestVersion: committedManifest().version });
    assert(admitted.expectedVersion === REVIEWED_BUNDLE_VERSION && admitted.manifestVersion === REVIEWED_BUNDLE_VERSION, 'admission did not return the matching version pair');
    return `${admitted.manifestVersion}`;
  });

  test('explicit mismatch is rejected with both versions named', () => {
    let error;
    try {
      admitBundleVersion({ expectedVersion: '9.9.9', manifestVersion: '0.2.2' });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, 'mismatched version was admitted');
    assert(error.message.includes('root bundle version is 0.2.2, expected 9.9.9'), `mismatch message is not actionable: ${error.message}`);
    return error.message;
  });

  test('invalid expected versions are rejected instead of coerced', () => {
    const invalid = ['', '0.2', '0.2.2.0', '02.2.2', 'v0.2.2', '0.2.2-01', '0.2.2-', '0.2.2+', ' 0.2.2', '0.2.2 ', '1.2.x', 'release', null, undefined, 202];
    for (const value of invalid) {
      let rejected = false;
      try {
        parseBundleVersion(value, '--bundle-version');
      } catch (error) {
        rejected = true;
        assert(error instanceof Error && error.message.includes('--bundle-version'), `invalid ${JSON.stringify(value)} error does not name the flag: ${error && error.message}`);
      }
      assert(rejected, `invalid value ${JSON.stringify(value)} was coerced or admitted`);
    }
    return `${invalid.length} invalid values rejected`;
  });

  test('invalid committed manifest version is rejected', () => {
    for (const manifestVersion of ['0.2', 'unknown', null, undefined]) {
      let rejected = false;
      try {
        admitBundleVersion({ expectedVersion: '0.2.2', manifestVersion: manifestVersion });
      } catch (error) {
        rejected = true;
        assert(error instanceof Error && error.message.includes('committed root package.json version'), `bad manifest error does not name the source: ${error && error.message}`);
      }
      assert(rejected, `manifest ${JSON.stringify(manifestVersion)} was admitted`);
    }
    return '4 malformed manifests rejected';
  });

  test('valid semver prerelease/build parses, but only exact identity is admitted', () => {
    parseBundleVersion('0.3.0-rc.1', '--bundle-version');
    parseBundleVersion('0.2.2+build.5', '--bundle-version');
    const prerelease = admitBundleVersion({ expectedVersion: '0.3.0-rc.1', manifestVersion: '0.3.0-rc.1' });
    assert(prerelease.expectedVersion === '0.3.0-rc.1', 'valid prerelease version was not admitted against the same manifest');
    let mismatch;
    try {
      admitBundleVersion({ expectedVersion: '0.2.2+build.5', manifestVersion: '0.2.2' });
    } catch (error) {
      mismatch = error;
    }
    assert(mismatch instanceof Error, 'build metadata was treated as the same reviewed version');
    return 'semver syntax accepted; exact identity required';
  });

  test('CLI rejects a malformed --bundle-version before creating output', () => {
    const out = join(work, 'malformed-out');
    const result = runStageDev(stageArgs(out, ['--bundle-version', '0.2']));
    assert(result.status === 2, `expected usage exit 2, got ${result.status}`);
    assert((result.stderr || '').includes('invalid --bundle-version "0.2"'), `stderr does not explain the invalid value: ${(result.stderr || '').trim()}`);
    assert((result.stderr || '').includes('usage:'), 'usage line missing from the rejection');
    assert(existsSync(out) === false, 'output directory was created for a malformed version');
    return 'exit 2 before output';
  });

  test('CLI requires an explicit --bundle-version', () => {
    const out = join(work, 'missing-out');
    const result = runStageDev(['--engine-commit', ENGINE_COMMIT, '--node', NODE, '--out', out]);
    assert(result.status === 2, `expected usage exit 2, got ${result.status}`);
    assert((result.stderr || '').includes('--bundle-version is required'), `stderr does not require the flag: ${(result.stderr || '').trim()}`);
    assert(existsSync(out) === false, 'output directory was created without a declared version');
    return 'exit 2 before output';
  });

  test('CLI mismatch fails before output directory or dependency install', () => {
    const out = join(work, 'mismatch-out');
    const marker = join(work, 'mismatch-npm-ran');
    const env = fakeNpm(join(work, 'fake-npm-mismatch'), marker);
    const result = runStageDev(stageArgs(out, ['--bundle-version', '9.9.9']), { env });
    const manifestVersion = committedManifest().version;
    assert(result.status === 1, `expected failure exit 1, got ${result.status}`);
    assert((result.stderr || '').includes(`stage-dev failed: root bundle version is ${manifestVersion}, expected 9.9.9`), `mismatch was not reported at the gate: ${(result.stderr || '').trim()}`);
    assert(existsSync(out) === false, 'output directory was created before the mismatch was rejected');
    assert(existsSync(marker) === false, 'npm was invoked despite the rejected version (dependency install started too early)');
    return 'exit 1 before output/npm';
  });

  test('CLI matching version passes admission and the immutable-output guard still rejects', () => {
    // The version gate admits 0.2.2, then the pre-existing non-empty-output guard
    // must reject. This proves admission wiring without claiming a full staging
    // success and without installing dependencies.
    const out = join(work, 'immutable-out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'user data that must not be replaced\n');
    const marker = join(work, 'matching-npm-ran');
    const env = fakeNpm(join(work, 'fake-npm-matching'), marker);
    const result = runStageDev(stageArgs(out, ['--bundle-version', REVIEWED_BUNDLE_VERSION]), { env });
    assert(result.status === 1, `expected failure exit 1, got ${result.status}`);
    const stderr = result.stderr || '';
    assert(stderr.includes('is not empty'), `matching version did not reach the immutable-output guard: ${stderr.trim()}`);
    assert(stderr.includes('root bundle version') === false, `matching version was still rejected by the version gate: ${stderr.trim()}`);
    assert(readFileSync(join(out, 'keep.txt'), 'utf8').includes('must not be replaced'), 'immutable-output guard modified existing data');
    assert(existsSync(marker) === false, 'npm was invoked before the output guard');
    return 'admission passed; output guard enforced; no npm';
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

for (const [name, detail] of passes) console.log(`PASS  ${name}${detail === 'ok' ? '' : `  [${detail}]`}`);
for (const [name, message] of failures) console.error(`FAIL  ${name}: ${message}`);
console.log(`\n${passes.length} passed, ${failures.length} failed`);
console.log('note: version-admission regression only; full staging evidence is delivered separately by the committed staging snapshot.');
if (failures.length > 0) process.exitCode = 1;
