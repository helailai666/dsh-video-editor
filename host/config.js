/**
 * Trusted deployment configuration for the dsh-video Host bridge.
 *
 * There is no Schemastery dependency: values arrive through the Loader row's
 * `config` object, are validated here, and never mutate `process.env`. A missing
 * or malformed config leaves the plugin shell alive; every business request then
 * returns E_CONFIGURATION instead of guessing paths or a Node executable.
 */

import { isAbsolute } from 'node:path';
import { BridgeError, configurationError } from './errors.js';

export const CONFIG_KEYS = Object.freeze([
  'workerNode',
  'workerEntry',
  'workerCwd',
  'registryPath',
  'artifactRoot',
  'allowedProjects',
  'sessionStatePath',
  'sessionCwd',
  'startupTimeoutMs',
  'requestTimeoutMs',
  'shutdownTimeoutMs',
  'forceKillTimeoutMs',
  'maxPending',
  'maxLineBytes',
  'maxStderrBytes',
  'maxRequestBytes',
  'maxArtifactBytes',
  'maxResultBytes',
  'maxPreviewBytes',
  'projectsRoot',
  'assetInboxRoot',
  'maxAssetBytes',
  'maxProjectAssetBytes',
  'dataRoot',
  'legacyDataRoots',
  'browserPath',
]);

const DEFAULT_LIMITS = Object.freeze({
  startupTimeoutMs: 10000,
  requestTimeoutMs: 15000,
  shutdownTimeoutMs: 5000,
  forceKillTimeoutMs: 1000,
  maxPending: 16,
  maxLineBytes: 65536,
  maxStderrBytes: 16384,
  maxRequestBytes: 65536,
  // A 1080x1920 film of several minutes renders well past 64 MiB, and the Host
  // reads the published artifact fully into memory to verify its SHA-256 before
  // streaming it to the browser. Streaming download is the follow-up; until then
  // the ceiling has to cover a real long export.
  maxArtifactBytes: 192 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxPreviewBytes: 8 * 1024 * 1024,
  maxAssetBytes: 2 * 1024 * 1024 * 1024,
  maxProjectAssetBytes: 8 * 1024 * 1024 * 1024,
});

const NUMBER_RULES = Object.freeze({
  startupTimeoutMs: { min: 100, max: 120000 },
  requestTimeoutMs: { min: 100, max: 120000 },
  shutdownTimeoutMs: { min: 100, max: 60000 },
  forceKillTimeoutMs: { min: 50, max: 60000 },
  maxPending: { min: 1, max: 64 },
  maxLineBytes: { min: 1024, max: 1024 * 1024 },
  maxStderrBytes: { min: 0, max: 1024 * 1024 },
  maxRequestBytes: { min: 1024, max: 1024 * 1024 },
  maxArtifactBytes: { min: 1024, max: 256 * 1024 * 1024 },
  maxResultBytes: { min: 4096, max: 8 * 1024 * 1024 },
  maxPreviewBytes: { min: 1024, max: 8 * 1024 * 1024 },
  maxProjectAssetBytes: { min: 1024, max: 8 * 1024 * 1024 * 1024 },
  maxAssetBytes: { min: 1024, max: 2 * 1024 * 1024 * 1024 },
});

const MAX_PATH = 4096;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || value.includes('\0')) {
    throw configurationError(`"${name}" must be a non-empty path string`);
  }
  return value;
}

function optionalPath(value, name) {
  if (value === undefined || value === null) return undefined;
  return requirePath(value, name);
}

/**
 * Validate and freeze one trusted config object.
 * @param raw - Loader row config. Missing/invalid values throw E_CONFIGURATION.
 * @returns normalized config with derived `projectIds` set and limits.
 */
export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) throw configurationError('Host bridge configuration is missing');
  for (const key of Object.keys(raw)) {
    if (CONFIG_KEYS.includes(key) === false) throw configurationError(`Unknown configuration key "${key}"`);
  }

  const workerNode = requirePath(raw.workerNode, 'workerNode');
  const workerEntry = optionalPath(raw.workerEntry, 'workerEntry');
  const workerCwd = requirePath(raw.workerCwd, 'workerCwd');
  const registryPath = requirePath(raw.registryPath, 'registryPath');
  const artifactRoot = requirePath(raw.artifactRoot, 'artifactRoot');
  const sessionStatePath = optionalPath(raw.sessionStatePath, 'sessionStatePath');
  const sessionCwd = optionalPath(raw.sessionCwd, 'sessionCwd');
  const projectsRoot = optionalPath(raw.projectsRoot, 'projectsRoot');
  const assetInboxRoot = optionalPath(raw.assetInboxRoot, 'assetInboxRoot');
  const dataRoot = optionalPath(raw.dataRoot, 'dataRoot');
  const browserPath = optionalPath(raw.browserPath, 'browserPath');
  let legacyDataRoots = [];
  if (raw.legacyDataRoots !== undefined) {
    if (Array.isArray(raw.legacyDataRoots) === false || raw.legacyDataRoots.length > 16) {
      throw configurationError('"legacyDataRoots" must be an array of at most 16 absolute paths');
    }
    const seenRoots = new Set();
    for (const value of raw.legacyDataRoots) {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || value.includes('\0') || isAbsolute(value) === false) {
        throw configurationError('"legacyDataRoots" entries must be absolute path strings');
      }
      if (seenRoots.has(value)) throw configurationError('"legacyDataRoots" contains a duplicate path');
      seenRoots.add(value);
      legacyDataRoots.push(value);
    }
  }
  for (const [name, value] of [['workerEntry', workerEntry], ['workerCwd', workerCwd], ['registryPath', registryPath], ['artifactRoot', artifactRoot], ['sessionStatePath', sessionStatePath], ['sessionCwd', sessionCwd], ['projectsRoot', projectsRoot], ['assetInboxRoot', assetInboxRoot], ['dataRoot', dataRoot], ['browserPath', browserPath]]) {
    if (value !== undefined && isAbsolute(value) === false) throw configurationError(`"${name}" must be an absolute path`);
  }

  if (Array.isArray(raw.allowedProjects) === false || raw.allowedProjects.length === 0) {
    throw configurationError('"allowedProjects" must be a non-empty array of controlled project ids');
  }
  if (raw.allowedProjects.length > 64) throw configurationError('"allowedProjects" holds too many project ids');
  const projectIds = new Set();
  for (const projectId of raw.allowedProjects) {
    if (typeof projectId !== 'string' || PROJECT_ID.test(projectId) === false) {
      throw configurationError('"allowedProjects" entries must be controlled project ids');
    }
    if (projectIds.has(projectId)) throw configurationError(`Duplicate allowed project "${projectId}"`);
    projectIds.add(projectId);
  }

  const limits = Object.assign({}, DEFAULT_LIMITS);
  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isFinite(value) === false || value < rule.min || value > rule.max) {
      throw configurationError(`"${key}" must be a number between ${rule.min} and ${rule.max}`);
    }
    limits[key] = value;
  }

  return Object.freeze({
    workerNode,
    ...(workerEntry === undefined ? {} : { workerEntry }),
    workerCwd,
    registryPath,
    artifactRoot,
    ...(sessionStatePath === undefined ? {} : { sessionStatePath }),
    ...(sessionCwd === undefined ? {} : { sessionCwd }),
    ...(projectsRoot === undefined ? {} : { projectsRoot }),
    ...(assetInboxRoot === undefined ? {} : { assetInboxRoot }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(browserPath === undefined ? {} : { browserPath }),
    ...(legacyDataRoots.length === 0 ? {} : { legacyDataRoots: Object.freeze(legacyDataRoots) }),
    projectIds,
    allowedProjects: Object.freeze([...projectIds]),
    ...limits,
  });
}

/** Whether a request project id belongs to the trusted allowlist. */
export function allowsProject(config, projectId) {
  return typeof projectId === 'string' && config.projectIds.has(projectId);
}

/** Parse a config for status/diagnostics without throwing. */
export function tryNormalizeConfig(raw) {
  try {
    return { ok: true, config: normalizeConfig(raw) };
  } catch (error) {
    if (error instanceof BridgeError) return { ok: false, error };
    return { ok: false, error: configurationError('Host bridge configuration is invalid', undefined) };
  }
}
