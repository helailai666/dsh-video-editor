/**
 * VideoBridge — the single Host business object behind both the exact Fetch
 * route and the `video_engine` Tool.
 *
 * The worker owns project content, revisions, idempotency and job state. This
 * bridge validates trusted/typed inputs, keeps one worker lifecycle per plugin
 * fiber, remembers only the job-to-project/revision ownership needed to fence
 * status/cancel/artifact reads, and publishes already-produced bytes after
 * re-verifying the worker's succeeded artifact record.
 */

import { AudioService } from './audio.js';
import { homedir } from 'node:os';
import { copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, configurationError, logSummary, toPublicError } from './errors.js';
import { allowsProject, tryNormalizeConfig } from './config.js';
import { buildWorkerEnv } from './env.js';
import { loadEngine } from './engine.js';
import { MAX_COMPOSITION_BYTES, MAX_COMPOSITION_ESCAPED_BYTES, TOOL_RESULT_BYTES } from './limits.js';
import { SessionService } from './sessions.js';
import { SESSION_ID_PATTERN } from './session-state.js';
import { readPreviewFile } from './preview.js';
import { AssetInbox, ASSET_UPLOAD_ROUTE } from './asset-inbox.js';
import { SnapshotRoutes, SNAPSHOT_ROUTE_BASE } from './snapshot.js';
import { UiStateStore } from './ui-state.js';
import { PluginSettingsStore } from './plugin-settings.js';
import { dataRootLayout, ensureDataRoot, legacyRootsFromConfig, loadManagedProjects, migrateLegacyRoots, quarantineCorruptFile, readWorkerRegistry, repairProjectsRegistry, resolveDataRoot, scanProjectsRoot, writeProjectsBackup } from './data-root.js';

export const REQUEST_METHODS = Object.freeze([
'reference.list', 'timeline.references', 'timeline.visuals.request', 'timeline.visuals.status', 'timeline.visuals.cancel', 'timeline.audioProfile',
'audio.guide','audio.recipe','audio.providers','audio.settings','audio.configure','audio.check','audio.generate','audio.status','audio.cancel',
'audio.model.save','audio.model.remove','audio.model.default',
'prompt.get','prompt.set',
'timeline.inspect',
'timeline.apply',
'timeline.resolve',
'timeline.undo',
'timeline.redo',
'scene.compose',
'scene.inspect',

  'doctor',
  'open',
  'inspect',
  'edit',
  'frame',
  'render',
  'status',
  'cancel',
  'close',
  'session.list',
  'session.create',
  'session.select',
  'session.send',
  'session.diagnose',
  'preview',
  'project.create',
  'project.rename',
  'project.path',
  'project.reveal',
  'project.compose',
  'project.source',
  'project.list',
  'asset.import',
  'asset.importMedia', 'asset.list', 'asset.remove', 'asset.derive',
  'scene.create',
  'scene.update',
  'scene.remove',
  'scene.reorder',
  'project.revise',
  'history',
  'undo',
  'redo',
  'preview.snapshot',
  'preview.release',
  'ui.state.get',
  'ui.state.set',
]);

const METHOD_PARAMS = Object.freeze({
'reference.list':['sessionId','query','offset','limit'],
'timeline.references':['projectId','query','offset','limit'],
'audio.guide': ['projectId'],
'audio.recipe': ['projectId','jobId'],
'audio.providers': ['projectId'],
'audio.settings': [],
'audio.configure': ['apiKey'],
'audio.check': ['modelId'],
'audio.model.save': ['model', 'apiKey'],
'audio.model.remove': ['modelId'],
'audio.model.default': ['modelId'],
'prompt.get': [],
'prompt.set': ['text'],
'audio.generate': ['projectId', 'operationId', 'provider', 'kind', 'text', 'voice', 'rate', 'score', 'modelId', 'durationFrames'],
'audio.status': ['projectId', 'jobId'],
'audio.cancel': ['projectId', 'jobId'],

'timeline.visuals.request': ['projectId','expectedRevision','clipId','startFrame','endFrame','count'],
 'timeline.visuals.status': ['projectId','taskId'],
 'timeline.visuals.cancel': ['projectId','taskId'],
 'timeline.audioProfile': ['projectId','fromFrame','toFrame'],
 'timeline.inspect': ['projectId', 'view', 'trackId', 'offset', 'limit'],
'timeline.apply': ['projectId', 'expectedRevision', 'operationId', 'ops', 'dryRun'],
'timeline.resolve': ['projectId', 'revision', 'refs'],
'timeline.undo': ['projectId', 'expectedRevision', 'operationId', 'expectedHistoryCursor', 'expectedOperationId'],
'timeline.redo': ['projectId', 'expectedRevision', 'operationId', 'expectedHistoryCursor', 'expectedOperationId'],
'scene.compose': ['projectId', 'expectedRevision', 'operationId', 'clipId', 'trackId', 'startFrame', 'html', 'mode', 'label'],
'scene.inspect': ['projectId', 'clipId'],

  doctor: [],
  open: ['projectId'],
  inspect: ['projectId'],
  edit: ['projectId', 'expectedRevision', 'operationId', 'ops'],
  frame: ['projectId', 'revision', 'time', 'times', 'timeoutMs', 'wait'],
  render: ['projectId', 'revision', 'timeoutMs'],
  status: ['jobId'],
  cancel: ['jobId'],
  close: ['projectId'],
  'session.list': ['projectId'],
  'session.create': ['projectId', 'requestId'],
  'session.select': ['projectId', 'sessionId'],
  'session.send': ['projectId', 'requestId', 'text'],
  'session.diagnose': [],
  preview: ['projectId', 'sessionId', 'path'],
  'project.create': ['templateId', 'title', 'width', 'height', 'fps'],
  'project.rename': ['projectId', 'title'],
  'project.path': ['projectId'],
  'project.reveal': ['projectId'],
  'project.compose': ['projectId', 'expectedRevision', 'operationId', 'html'],
  'project.source': ['projectId'],
  'project.list': [],
  'asset.importMedia': ['projectId','operationId','receiptId'],
  'asset.list': ['projectId','kind','query','cursor','limit'],
  'asset.remove': ['projectId','assetId','operationId'],
  'asset.derive': ['projectId','assetId','kind'],
  'asset.import': ['projectId', 'expectedRevision', 'operationId', 'receiptId'],
  'scene.create': ['projectId', 'expectedRevision', 'operationId', 'sceneId', 'afterSceneId', 'template'],
  'scene.update': ['projectId', 'expectedRevision', 'operationId', 'sceneId', 'template'],
  'scene.remove': ['projectId', 'expectedRevision', 'operationId', 'sceneId'],
  'scene.reorder': ['projectId', 'expectedRevision', 'operationId', 'order'],
  'project.revise': ['projectId', 'baseRevision', 'expectedRevision', 'operationId', 'sceneId', 'template'],
  history: ['projectId', 'limit'],
  undo: ['projectId', 'expectedRevision', 'operationId'],
  redo: ['projectId', 'expectedRevision', 'operationId'],
  'preview.snapshot': ['projectId', 'revision', 'ttlMs'],
  'preview.release': ['snapshotId'],
  'ui.state.get': [],
  'ui.state.set': ['patch'],
});

const SESSION_METHODS = Object.freeze(['session.list', 'session.create', 'session.select', 'session.send', 'session.diagnose']);
/** Upper bound for one UI-composed chat message admitted through `session.send`. */
const MAX_SESSION_SEND_CHARS = 4000;

const REVISION = /^[a-f0-9]{64}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|mp4)$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA = Object.freeze({ png: 'image/png', mp4: 'video/mp4' });
const MAX_REGISTRY_BYTES = 1024 * 1024;
const SNAPSHOT_ID = /^[a-f0-9]{32}$/;
const TEMPLATE_ID = 'product-launch-v1';
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUDIO_MODEL_ID = /^(qianwen|music_[a-f0-9]{16})$/;
/** P3-016: trimmed display-title bound shared with the worker manifest contract. */
const PROJECT_TITLE_MAX = 120;
/** Bounded advisory read of one worker-owned `project.json`; never throws. */
const PROJECT_MANIFEST_MAX_BYTES = 16384;
/** Frame batch bounds shared with the worker contract. */
const MAX_FRAME_TIMES = 4;
/**
 * Worker job deadlines. A frame is a short snapshot; a full MP4 render scales
 * with composition duration and legitimately needs minutes (a 20s composition
 * measures ~112s on the reviewed machine), so render accepts up to 15 minutes
 * while frame keeps the 120s bound. Both limits are enforced again by the
 * worker so a direct JSONL caller cannot widen them.
 */
const MAX_FRAME_TIMEOUT_MS = 120000;
const MAX_RENDER_TIMEOUT_MS = 21600000;
const TERMINAL_JOB_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'timed_out']);
const FRAME_WAIT_MAX_MS = 30000;
const FRAME_WAIT_INTERVAL_MS = 250;
/**
 * Host-only hand-off for a settled `frame` wait result: the re-verified PNG is
 * copied under the project Session workspace so the model can hand this fixed
 * workspace-relative path straight to `read_image`. The latest frame replaces
 * the previous one (nothing accumulates) and no Host path is ever returned.
 */
const FRAME_IMAGE_DIR = '.dsh-video-frames';
const FRAME_IMAGE_FILE = 'latest.png';
const FRAME_IMAGE_PATH = `${FRAME_IMAGE_DIR}/${FRAME_IMAGE_FILE}`;
/**
 * Frozen engine 0.3.2 scene.template text limits: title 1..2048, subtitle/badge
 * 0..2048 when present (the same contract as typed text edits). The Host keeps
 * the upper bound: valid long copy is passed through untruncated.
 */
const SCENE_TEXT_MAX = 2048;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, allowed) {
  if (isPlainObject(value) === false) return false;
  return Object.keys(value).every((key) => allowed.includes(key));
}

function fail(code, message, stage, flags) {
  throw new BridgeError(code, message, { stage, ...(flags || {}) });
}

function text(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    fail('E_PARAMS', `Invalid "${name}"`, 'params');
  }
  return value;
}

function projectId(value) {
  return text(value, 'projectId', 128);
}

/**
 * P3-016 display title: trimmed 1..120 characters, no NUL. The Host always
 * sends the normalized (trimmed) value so the worker manifest stays canonical.
 */
function projectTitle(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    fail('E_PARAMS', 'Invalid project title', 'params');
  }
  const title = value.trim();
  if (title.length < 1 || title.length > PROJECT_TITLE_MAX) {
    fail('E_PARAMS', 'Invalid project title', 'params');
  }
  return title;
}

function allowedProject(config, value) {
  const id = projectId(value);
  if (allowsProject(config, id) === false) {
    fail('E_PROJECT_NOT_FOUND', 'Project is not registered for this Host bridge', 'project');
  }
  return id;
}

function revision(value) {
  if (typeof value !== 'string' || REVISION.test(value) === false) {
    fail('E_PARAMS', 'Expected a SHA-256 revision', 'params');
  }
  return value;
}

function operationId(value) {
  if (typeof value !== 'string' || OPERATION_ID.test(value) === false) {
    fail('E_PARAMS', 'Invalid operationId', 'params');
  }
  return value;
}

/**
 * One complete HTML composition document submitted for an atomic publish.
 *
 * The Host bound is raw UTF-8 bytes because the Worker validates and stores
 * bytes; a character-count check would let a multibyte document through here
 * only to be rejected after the worker started. NUL bytes are rejected too, so
 * the document is a plain text document before it ever reaches the worker.
 *
 * Two byte budgets are enforced, both before any worker start:
 * - the raw document is at most 48 KiB (the worker's validation bound);
 * - its JSON-escaped form is at most 60 KiB, so the JSONL request frame stays
 *   under the worker's 64 KiB line limit. Quotes and backslashes double when
 *   escaped; without this bound a contract-valid quote-heavy document would
 *   overflow the frame, and the worker's uncorrelatable E_LINE_LIMIT reply would
 *   take the worker process (and every later video request) down with it.
 */
function compositionHtml(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('E_PARAMS', 'Expected a complete HTML composition document', 'params');
  }
  if (value.includes('\0')) {
    fail('E_PARAMS', 'Composition HTML must not contain NUL bytes', 'params');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_COMPOSITION_BYTES) {
    fail(
      'E_PARAMS',
      `Composition HTML is too large (${bytes} UTF-8 bytes); the limit is 48 KiB (${MAX_COMPOSITION_BYTES} bytes)`,
      'params'
    );
  }
  const escapedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (escapedBytes > MAX_COMPOSITION_ESCAPED_BYTES) {
    fail(
      'E_PARAMS',
      `Composition HTML is too large after JSON escaping (${bytes} raw UTF-8 bytes expand to ${escapedBytes} bytes; the escaped-frame limit is ${MAX_COMPOSITION_ESCAPED_BYTES} bytes). Reduce repeated quotes/backslashes or shorten the document.`,
      'params'
    );
  }
  return value;
}

function jobId(value) {
  if (typeof value !== 'string' || JOB_ID.test(value) === false) {
    fail('E_PARAMS', 'Invalid jobId', 'params');
  }
  return value;
}

function numberInRange(value, name, min, max) {
  if (typeof value !== 'number' || Number.isFinite(value) === false || value < min || value > max) {
    fail('E_PARAMS', `Invalid "${name}"`, 'params');
  }
  return value;
}

function timeoutMs(value, max) {
  if (value === undefined) return undefined;
  return numberInRange(value, 'timeoutMs', 100, max);
}

/**
 * Batch frame times: 1..MAX_FRAME_TIMES distinct seconds, canonical to the
 * worker's millisecond still-name granularity and sorted ascending before they
 * ever reach the worker. Two inputs that would name the same still are
 * duplicates.
 */
function frameTimes(value) {
  if (Array.isArray(value) === false || value.length < 1 || value.length > MAX_FRAME_TIMES) {
    fail('E_PARAMS', `"times" must list 1-${MAX_FRAME_TIMES} frame times`, 'params');
  }
  const seen = new Set();
  const times = [];
  for (const entry of value) {
    const time = numberInRange(entry, 'times[]', 0, 3599.999);
    const canonical = Number(time.toFixed(3));
    if (seen.has(canonical)) fail('E_PARAMS', '"times" must be distinct at millisecond precision', 'params');
    seen.add(canonical);
    times.push(canonical);
  }
  times.sort((left, right) => left - right);
  return times;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const ELEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateOps(value) {
  if (Array.isArray(value) === false || value.length === 0 || value.length > 32) {
    fail('E_PARAMS', 'Expected 1–32 typed ops', 'params');
  }
  return value.map((op) => {
    if (isPlainObject(op) === false) fail('E_PARAMS', 'Invalid edit op', 'params');
    if (op.type === 'text') {
      if (hasExactKeys(op, ['type', 'target', 'text']) === false) fail('E_PARAMS', 'Invalid text edit fields', 'params');
      const target = text(op.target, 'target', 256);
      if (typeof op.text !== 'string' || op.text.length > 2048 || op.text.includes('\0')) {
        fail('E_PARAMS', 'Invalid text edit', 'params');
      }
      return { type: 'text', target, text: op.text };
    }
    if (op.type === 'timing') {
      if (hasExactKeys(op, ['type', 'target', 'start', 'duration']) === false) fail('E_PARAMS', 'Invalid timing edit fields', 'params');
      if (op.start === undefined && op.duration === undefined) fail('E_PARAMS', 'Timing change missing', 'params');
      const next = { type: 'timing', target: text(op.target, 'target', 256) };
      if (op.start !== undefined) next.start = numberInRange(op.start, 'start', 0, 3600);
      if (op.duration !== undefined) next.duration = numberInRange(op.duration, 'duration', 1 / 240, 3600);
      return next;
    }
    if (op.type === 'layout') {
      if (hasExactKeys(op, ['type', 'target', 'unit', 'box']) === false) fail('E_PARAMS', 'Invalid layout edit fields', 'params');
      if (op.unit !== 'composition-px') fail('E_PARAMS', 'Unsupported layout unit', 'params');
      if (isPlainObject(op.box) === false) fail('E_PARAMS', 'Invalid layout box', 'params');
      const box = {};
      const allowed = ['left', 'top', 'width', 'height'];
      for (const key of Object.keys(op.box)) {
        if (allowed.includes(key) === false) fail('E_PARAMS', 'Unexpected layout field', 'params');
        if (finite(op.box[key]) === false) fail('E_PARAMS', 'Layout values must be finite numbers', 'params');
        box[key] = op.box[key];
      }
      if (Object.keys(box).length === 0) fail('E_PARAMS', 'Layout box is empty', 'params');
      if (box.left !== undefined && (box.left < 0 || box.left > 3840)) fail('E_PARAMS', 'Layout left out of range', 'params');
      if (box.top !== undefined && (box.top < 0 || box.top > 2160)) fail('E_PARAMS', 'Layout top out of range', 'params');
      if (box.width !== undefined && (box.width < 1 || box.width > 3840)) fail('E_PARAMS', 'Layout width out of range', 'params');
      if (box.height !== undefined && (box.height < 1 || box.height > 2160)) fail('E_PARAMS', 'Layout height out of range', 'params');
      return { type: 'layout', target: text(op.target, 'target', 256), unit: 'composition-px', box };
    }
    if (op.type === 'style') {
      if (hasExactKeys(op, ['type', 'target', 'styles']) === false) fail('E_PARAMS', 'Invalid style edit fields', 'params');
      if (isPlainObject(op.styles) === false) fail('E_PARAMS', 'Invalid style patch', 'params');
      const styles = {};
      for (const key of Object.keys(op.styles)) {
        if (['color', 'fontSize', 'fontWeight', 'textAlign'].includes(key) === false) fail('E_PARAMS', 'Unexpected style field', 'params');
        const value = op.styles[key];
        if (key === 'color') {
          if (typeof value !== 'string' || COLOR.test(value) === false) fail('E_PARAMS', 'Invalid style color', 'params');
          styles.color = value.toLowerCase();
        } else if (key === 'fontSize') {
          if (finite(value) === false || value < 8 || value > 256) fail('E_PARAMS', 'Invalid font size', 'params');
          styles.fontSize = value;
        } else if (key === 'fontWeight') {
          if (Number.isInteger(value) === false || value < 100 || value > 900 || value % 100 !== 0) fail('E_PARAMS', 'Invalid font weight', 'params');
          styles.fontWeight = value;
        } else {
          if (!['left', 'center', 'right'].includes(value)) fail('E_PARAMS', 'Invalid text align', 'params');
          styles.textAlign = value;
        }
      }
      if (Object.keys(styles).length === 0) fail('E_PARAMS', 'Style patch is empty', 'params');
      return { type: 'style', target: text(op.target, 'target', 256), styles };
    }
    fail('E_PARAMS', 'Unsupported edit type', 'params');
  });
}

function sceneTemplate(value, allowSceneId) {
  if (isPlainObject(value) === false) fail('E_PARAMS', 'Invalid scene template', 'params');
  const allowed = ['duration', 'title', 'subtitle', 'badge', 'color', 'accent', 'logo', 'shot'];
  if (allowSceneId === true) allowed.push('sceneId');
  for (const key of Object.keys(value)) {
    if (allowed.includes(key) === false) fail('E_PARAMS', 'Unexpected scene template field', 'params');
  }
  if (finite(value.duration) === false || value.duration < 0.5 || value.duration > 60) fail('E_PARAMS', 'Scene duration out of range', 'params');
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > SCENE_TEXT_MAX) fail('E_PARAMS', 'Scene title is invalid', 'params');
  const next = { duration: value.duration, title: value.title };
  if (value.subtitle !== undefined) {
    if (typeof value.subtitle !== 'string' || value.subtitle.length > SCENE_TEXT_MAX) fail('E_PARAMS', 'Scene subtitle is invalid', 'params');
    next.subtitle = value.subtitle;
  }
  if (value.badge !== undefined) {
    if (typeof value.badge !== 'string' || value.badge.length > SCENE_TEXT_MAX) fail('E_PARAMS', 'Scene badge is invalid', 'params');
    next.badge = value.badge;
  }
  for (const [key, pattern] of [['color', COLOR], ['accent', COLOR]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || pattern.test(value[key]) === false) fail('E_PARAMS', `Scene ${key} is invalid`, 'params');
    next[key] = value[key].toLowerCase();
  }
  for (const key of ['logo', 'shot']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g)$/i.test(value[key]) === false) {
      fail('E_PARAMS', `Scene ${key} is invalid`, 'params');
    }
    next[key] = value[key];
  }
  if (allowSceneId === true && value.sceneId !== undefined) {
    if (typeof value.sceneId !== 'string' || SCENE_ID.test(value.sceneId) === false) fail('E_PARAMS', 'Invalid sceneId', 'params');
    next.sceneId = value.sceneId;
  }
  return next;
}

/** Validate and normalize one typed request against the worker v1 contract. */
export function validateParams(config, method, params) {
  if (REQUEST_METHODS.includes(method) === false) fail('E_METHOD', 'Unknown video action', 'params');
  if (isPlainObject(params) === false) fail('E_PARAMS', 'Expected an object of parameters', 'params');
  const allowed = METHOD_PARAMS[method];
  for (const key of Object.keys(params)) {
    if (allowed.includes(key) === false) fail('E_PARAMS', `Unexpected "${key}" parameter`, 'params');
  }

  if(method==='reference.list'){
    if(typeof params.sessionId!=='string'||!SESSION_ID_PATTERN.test(params.sessionId))fail('E_PARAMS','Invalid Session id');
    if(params.query!==undefined&&(typeof params.query!=='string'||params.query.length>120))fail('E_PARAMS','Invalid reference query');
    return {...params};
  }
  if(method.startsWith('timeline.visuals.')) {const next={...params,projectId:allowedProject(config,params.projectId)};if(method.endsWith('request')){next.expectedRevision=revision(params.expectedRevision);if(!/^cl_[a-z0-9]+$/.test(params.clipId)||![params.startFrame,params.endFrame,params.count].every(Number.isSafeInteger)||params.startFrame<0||params.endFrame<=params.startFrame||params.count<1||params.count>4)fail('E_PARAMS','Invalid visual request');}else if(!/^[a-f0-9]{24}$/.test(params.taskId))fail('E_PARAMS','Invalid visual task');return next;}
  if(method==='timeline.audioProfile'){const next={projectId:allowedProject(config,params.projectId)};if(!Number.isSafeInteger(params.fromFrame)||!Number.isSafeInteger(params.toFrame)||params.fromFrame<0||params.toFrame>108000||params.toFrame<=params.fromFrame)fail('E_PARAMS','Invalid audio profile range','params');next.fromFrame=params.fromFrame;next.toFrame=params.toFrame;return next;}
  if (['timeline.references','timeline.inspect','timeline.apply','timeline.resolve','timeline.undo','timeline.redo','scene.compose','scene.inspect'].includes(method)) {
    const next={...params,projectId:allowedProject(config,params.projectId)};
    if(['timeline.apply','timeline.undo','timeline.redo','scene.compose'].includes(method)){next.expectedRevision=revision(params.expectedRevision);next.operationId=operationId(params.operationId);}
    if(method==='timeline.apply'&&(!Array.isArray(params.ops)||!params.ops.length||params.ops.length>32))fail('E_PARAMS','Provide 1–32 operations','params');
    if(params.expectedOperationId!==undefined)operationId(params.expectedOperationId);
    if(params.expectedHistoryCursor!==undefined&&(!Number.isInteger(params.expectedHistoryCursor)||params.expectedHistoryCursor<0))fail('E_PARAMS','Invalid history cursor');
    if(params.dryRun!==undefined&&typeof params.dryRun!=='boolean')fail('E_PARAMS','dryRun must be boolean','params');
    return next;
  }
  if(method.startsWith('audio.')) {
    const next={...params};
    if(['audio.guide','audio.recipe','audio.providers','audio.generate','audio.status','audio.cancel'].includes(method))next.projectId=allowedProject(config,params.projectId);
    if(method==='audio.generate')next.operationId=operationId(params.operationId);
    if(params.jobId!==undefined&&(typeof params.jobId!=='string'||!/^audio_[a-f0-9-]{36}$/.test(params.jobId)))fail('E_PARAMS','Invalid audio job id');
    if(['audio.cancel','audio.recipe'].includes(method)&&!params.jobId)fail('E_PARAMS','Provide audio job id');
    if(params.modelId!==undefined&&(typeof params.modelId!=='string'||!AUDIO_MODEL_ID.test(params.modelId)))fail('E_PARAMS','Invalid audio model id','params');
    if(params.durationFrames!==undefined&&(Number.isInteger(params.durationFrames)===false||params.durationFrames<1||params.durationFrames>108000))fail('E_PARAMS','Invalid durationFrames','params');
    if(method.startsWith('audio.model.')){
      if(method==='audio.model.save'){
        if(isPlainObject(params.model)===false)fail('E_PARAMS','Invalid music model payload','params');
        if(params.apiKey!==undefined&&(typeof params.apiKey!=='string'||params.apiKey.length>512||/[\r\n]/.test(params.apiKey)))fail('E_PARAMS','Invalid API key','params');
      } else if(!params.modelId)fail('E_PARAMS','Provide audio model id','params');
      return next;
    }
    return next;
  }
  if (method === 'prompt.get') return {};
  if (method === 'prompt.set') {
    if (typeof params.text !== 'string' || params.text.length > 4096 || params.text.includes('\0')) fail('E_PARAMS', 'Invalid prompt text', 'params');
    return { text: params.text };
  }
  if (method === 'doctor') return {};
  if (method === 'open' || method === 'inspect' || method === 'close') {
    return { projectId: allowedProject(config, params.projectId) };
  }
  if (method === 'status' || method === 'cancel') {
    return { jobId: jobId(params.jobId) };
  }
  if (method === 'edit') {
    const next = {
      projectId: allowedProject(config, params.projectId),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
      ops: validateOps(params.ops),
    };
    return next;
  }
  if (method === 'project.compose') {
    return {
      projectId: allowedProject(config, params.projectId),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
      html: compositionHtml(params.html),
    };
  }
  if (method === 'project.source') {
    return { projectId: allowedProject(config, params.projectId) };
  }
  if (method === 'frame') {
    const next = {
      projectId: allowedProject(config, params.projectId),
      revision: revision(params.revision),
    };
    const hasTime = params.time !== undefined;
    const hasTimes = params.times !== undefined;
    if (hasTime === hasTimes) fail('E_PARAMS', 'Provide exactly one of "time" or "times"', 'params');
    if (hasTime) next.time = numberInRange(params.time, 'time', 0, 3599.999);
    else next.times = frameTimes(params.times);
    const limit = timeoutMs(params.timeoutMs, MAX_FRAME_TIMEOUT_MS);
    if (limit !== undefined) next.timeoutMs = limit;
    if (params.wait !== undefined) {
      if (typeof params.wait !== 'boolean') fail('E_PARAMS', 'Invalid "wait"', 'params');
      next.wait = params.wait;
    }
    return next;
  }
  if (method === 'render') {
    const next = {
      projectId: allowedProject(config, params.projectId),
      revision: revision(params.revision),
    };
    const limit = timeoutMs(params.timeoutMs, MAX_RENDER_TIMEOUT_MS);
    if (limit !== undefined) next.timeoutMs = limit;
    return next;
  }
  if (method === 'preview') {
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || SESSION_ID_PATTERN.test(sessionId) === false) fail('E_PARAMS', 'Invalid sessionId', 'params');
    return {
      projectId: allowedProject(config, params.projectId),
      sessionId,
      path: text(params.path, 'path', 4096),
    };
  }
  if (method === 'session.diagnose') return {};
  if (method === 'session.list') return { projectId: allowedProject(config, params.projectId) };
  if (method === 'session.create') {
    const next = { projectId: allowedProject(config, params.projectId) };
    if (params.requestId !== undefined) {
      if (typeof params.requestId !== 'string' || REQUEST_ID.test(params.requestId) === false || params.requestId.length > 128) {
        fail('E_PARAMS', 'Invalid session requestId', 'params');
      }
      next.requestId = params.requestId;
    }
    return next;
  }
  if (method === 'session.select') {
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || SESSION_ID_PATTERN.test(sessionId) === false) fail('E_PARAMS', 'Invalid sessionId', 'params');
    return { projectId: allowedProject(config, params.projectId), sessionId };
  }
  if (method === 'session.send') {
    // The UI composes one message for this project's bound Session; the Session id
    // is never accepted from the Client, only resolved from the trusted mapping.
    if (typeof params.requestId !== 'string' || REQUEST_ID.test(params.requestId) === false) {
      fail('E_PARAMS', 'Invalid session requestId', 'params');
    }
    const body = text(params.text, 'text', MAX_SESSION_SEND_CHARS);
    if (body.trim().length === 0 || body.includes('\r')) fail('E_PARAMS', 'Invalid session message', 'params');
    return {
      projectId: allowedProject(config, params.projectId),
      requestId: params.requestId,
      text: body,
    };
  }
  if (method === 'project.create') {
    if (![TEMPLATE_ID, 'blank-v1'].includes(params.templateId)) fail('E_PARAMS', 'Unsupported project template', 'params');
    const next = { templateId: params.templateId };
    if (params.title !== undefined) {
      if (typeof params.title !== 'string' || params.title.length < 1 || params.title.length > 120) fail('E_PARAMS', 'Invalid project title', 'params');
      next.title = params.title;
    }
    if (params.width !== undefined) {
      if (Number.isInteger(params.width) === false || params.width < 320 || params.width > 3840) fail('E_PARAMS', 'Invalid project width', 'params');
      next.width = params.width;
    }
    if (params.height !== undefined) {
      if (Number.isInteger(params.height) === false || params.height < 180 || params.height > 2160) fail('E_PARAMS', 'Invalid project height', 'params');
      next.height = params.height;
    }
    if (params.fps !== undefined && params.fps !== 30) fail('E_PARAMS', 'Only 30 fps is supported', 'params');
    return next;
  }
  if (method === 'project.rename') {
    return {
      projectId: allowedProject(config, params.projectId),
      title: projectTitle(params.title),
    };
  }
  if (method === 'project.path' || method === 'project.reveal') {
    return { projectId: allowedProject(config, params.projectId) };
  }
  if (method === 'ui.state.get') return {};
  if (method === 'ui.state.set') {
    if (isPlainObject(params.patch) === false) fail('E_PARAMS', 'UI state patch must be an object', 'params');
    return { patch: params.patch };
  }
  if (method === 'project.list') return {};
  if (['asset.importMedia','asset.list','asset.remove','asset.derive'].includes(method)) {
    const next={...params,projectId:allowedProject(config,params.projectId)};
    if (method==='asset.list') {
      if(params.kind!==undefined&&!['video','audio','image'].includes(params.kind)) fail('E_PARAMS','Invalid asset kind','params');
      if(params.query!==undefined) next.query=text(params.query,'query',120);
      if(params.cursor!==undefined&&(typeof params.cursor!=='string'||!/^\d{1,12}$/.test(params.cursor))) fail('E_PARAMS','Invalid cursor','params');
      if(params.limit!==undefined&&(!Number.isInteger(params.limit)||params.limit<1||params.limit>50)) fail('E_PARAMS','Invalid limit','params');
    } else if(method==='asset.importMedia') {
      if(typeof params.receiptId!=='string'||!/^[0-9a-f-]{36}$/.test(params.receiptId)) fail('E_PARAMS','Invalid receipt','params');
      next.operationId=operationId(params.operationId);
    } else {
      if(typeof params.assetId!=='string'||!/^as_[a-f0-9]{8}$/.test(params.assetId)) fail('E_PARAMS','Invalid asset id','params');
      if(method==='asset.derive'&&!['thumb','waveform','proxy'].includes(params.kind)) fail('E_PARAMS','Invalid derived kind','params');
      if(params.operationId!==undefined) next.operationId=operationId(params.operationId);
    }
    return next;
  }
  if (method === 'asset.import') {
    if (typeof params.receiptId !== 'string' || /^[0-9a-f-]{36}$/.test(params.receiptId) === false) fail('E_PARAMS', 'Invalid upload receipt', 'params');
    return {
      projectId: allowedProject(config, params.projectId),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
      receiptId: params.receiptId,
    };
  }
  if (method === 'scene.create' || method === 'scene.update' || method === 'scene.remove' || method === 'scene.reorder') {
    const next = {
      projectId: allowedProject(config, params.projectId),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
    };
    if (method === 'scene.create') {
      if (params.sceneId !== undefined) {
        if (typeof params.sceneId !== 'string' || SCENE_ID.test(params.sceneId) === false) fail('E_PARAMS', 'Invalid sceneId', 'params');
        next.sceneId = params.sceneId;
      }
      if (params.afterSceneId !== undefined) {
        if (typeof params.afterSceneId !== 'string' || SCENE_ID.test(params.afterSceneId) === false) fail('E_PARAMS', 'Invalid afterSceneId', 'params');
        next.afterSceneId = params.afterSceneId;
      }
      next.template = sceneTemplate(params.template, true);
    } else if (method === 'scene.update') {
      if (typeof params.sceneId !== 'string' || SCENE_ID.test(params.sceneId) === false) fail('E_PARAMS', 'Invalid sceneId', 'params');
      next.sceneId = params.sceneId;
      next.template = sceneTemplate(params.template, false);
    } else if (method === 'scene.remove') {
      if (typeof params.sceneId !== 'string' || SCENE_ID.test(params.sceneId) === false) fail('E_PARAMS', 'Invalid sceneId', 'params');
      next.sceneId = params.sceneId;
    } else {
      if (Array.isArray(params.order) === false || params.order.length < 1 || params.order.length > 12) fail('E_PARAMS', 'Invalid scene order', 'params');
      if (new Set(params.order).size !== params.order.length) fail('E_PARAMS', 'Scene order has duplicates', 'params');
      next.order = params.order.map((id) => {
        if (typeof id !== 'string' || SCENE_ID.test(id) === false) fail('E_PARAMS', 'Invalid scene id in order', 'params');
        return id;
      });
    }
    return next;
  }
  if (method === 'project.revise') {
    if (typeof params.sceneId !== 'string' || SCENE_ID.test(params.sceneId) === false) fail('E_PARAMS', 'Invalid sceneId', 'params');
    return {
      projectId: allowedProject(config, params.projectId),
      baseRevision: revision(params.baseRevision),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
      sceneId: params.sceneId,
      template: sceneTemplate(params.template, false),
    };
  }
  if (method === 'history') {
    const next = { projectId: allowedProject(config, params.projectId) };
    if (params.limit !== undefined) {
      if (Number.isInteger(params.limit) === false || params.limit < 1 || params.limit > 64) fail('E_PARAMS', 'Invalid history limit', 'params');
      next.limit = params.limit;
    }
    return next;
  }
  if (method === 'undo' || method === 'redo') {
    return {
      projectId: allowedProject(config, params.projectId),
      expectedRevision: revision(params.expectedRevision),
      operationId: operationId(params.operationId),
    };
  }
  if (method === 'preview.snapshot') {
    const next = { projectId: allowedProject(config, params.projectId), revision: revision(params.revision) };
    if (params.ttlMs !== undefined) {
      if (Number.isInteger(params.ttlMs) === false || params.ttlMs < 100 || params.ttlMs > 1800000) fail('E_PARAMS', 'Invalid snapshot TTL', 'params');
      next.ttlMs = params.ttlMs;
    }
    return next;
  }
  if (method === 'preview.release') {
    if (typeof params.snapshotId !== 'string' || SNAPSHOT_ID.test(params.snapshotId) === false) fail('E_PARAMS', 'Invalid snapshotId', 'params');
    return { snapshotId: params.snapshotId };
  }
  return fail('E_METHOD', 'Unknown video action', 'params');
}

function inside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === '' || (pathRelative.startsWith('..') === false && isAbsolute(pathRelative) === false);
}

async function canonicalDirectory(path, name) {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    if (info.isDirectory() === false) throw new Error('not a directory');
    return real;
  } catch (_error) {
    throw configurationError(`"${name}" must be an existing absolute directory`);
  }
}

async function canonicalFile(path, name) {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    if (info.isFile() === false) throw new Error('not a file');
    return real;
  } catch (_error) {
    throw configurationError(`"${name}" must be an existing absolute file`);
  }
}

/**
 * Best-effort advisory title from a trusted project's worker-owned manifest.
 * Display metadata only: an unreadable/corrupt/malformed/oversized manifest
 * yields null and never fails the project list. The stored value must already
 * be the canonical trimmed form written by the worker.
 */
async function readManifestTitle(directory) {
  if (typeof directory !== 'string') return null;
  try {
    const manifestPath = join(directory, 'project.json');
    const info = await stat(manifestPath);
    if (info.isFile() === false || info.size > PROJECT_MANIFEST_MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (isPlainObject(parsed) === false || typeof parsed.title !== 'string') return null;
    const title = parsed.title;
    if (title !== title.trim() || title.length < 1 || title.length > PROJECT_TITLE_MAX) return null;
    return title;
  } catch (_error) {
    return null;
  }
}

function parseRegistry(textValue) {
  let registry;
  try {
    registry = JSON.parse(textValue);
  } catch (_error) {
    throw configurationError('The worker registry is not valid JSON');
  }
  if (isPlainObject(registry) === false) throw configurationError('The worker registry must be an object');
  if (Object.prototype.hasOwnProperty.call(registry, 'projectsRoot')) {
    const managedAllowed = ['projectsRoot', 'registryPath', 'outputRoot', 'assetInboxRoot', 'browserPath'];
    for (const key of Object.keys(registry)) {
      if (managedAllowed.includes(key) === false) throw configurationError(`Unknown managed worker config key "${key}"`);
    }
    if (typeof registry.projectsRoot !== 'string' || isAbsolute(registry.projectsRoot) === false) throw configurationError('managed projectsRoot must be absolute');
    if (typeof registry.registryPath !== 'string' || isAbsolute(registry.registryPath) === false) throw configurationError('managed registryPath must be absolute');
    if (typeof registry.outputRoot !== 'string' || isAbsolute(registry.outputRoot) === false) throw configurationError('managed outputRoot must be absolute');
    if (registry.assetInboxRoot !== undefined && (typeof registry.assetInboxRoot !== 'string' || isAbsolute(registry.assetInboxRoot) === false)) {
      throw configurationError('managed assetInboxRoot must be absolute when present');
    }
    if (registry.browserPath !== undefined && (typeof registry.browserPath !== 'string' || isAbsolute(registry.browserPath) === false)) {
      throw configurationError('managed browserPath must be absolute when present');
    }
    return {
      managed: true,
      root: registry.projectsRoot,
      managedRegistryPath: registry.registryPath,
      outputRoot: registry.outputRoot,
      assetInboxRoot: registry.assetInboxRoot,
      browserPath: registry.browserPath,
    };
  }
  const allowed = ['root', 'projects', 'outputRoot', 'browserPath'];
  for (const key of Object.keys(registry)) {
    if (allowed.includes(key) === false) throw configurationError(`Unknown worker registry key "${key}"`);
  }
  if (typeof registry.root !== 'string' || isAbsolute(registry.root) === false) throw configurationError('registry.root must be absolute');
  if (typeof registry.outputRoot !== 'string' || isAbsolute(registry.outputRoot) === false) throw configurationError('registry.outputRoot must be absolute');
  if (isPlainObject(registry.projects) === false || Object.keys(registry.projects).length === 0) {
    throw configurationError('registry.projects must declare at least one controlled project');
  }
  for (const [id, path] of Object.entries(registry.projects)) {
    if (PROJECT_ID.test(id) === false) throw configurationError('registry.projects contains an invalid project id');
    if (typeof path !== 'string' || isAbsolute(path) === false) throw configurationError('registry project paths must be absolute');
  }
  if (registry.browserPath !== undefined && (typeof registry.browserPath !== 'string' || isAbsolute(registry.browserPath) === false)) {
    throw configurationError('registry.browserPath must be an absolute path when present');
  }
  return { managed: false, ...registry };
}

const MIN_EXPLICIT_SPAWN_CLIENT = Object.freeze([0, 1, 1]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Strict full semantic version core; invalid/unknown input is never coerced to 0. */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SEMVER);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Explicit env/cwd exists from client 0.1.1. The old 0.1.0 client ignores both
 * options, so it must be rejected; malformed/unknown versions are rejected
 * rather than parsed into a permissive 0.0.0.
 */
function supportsExplicitSpawn(version) {
  const parsed = parseVersion(version);
  return parsed !== null && compareVersion(parsed, MIN_EXPLICIT_SPAWN_CLIENT) >= 0;
}

function publicResult(limit, result, source) {
  const effectiveLimit = source === 'tool' ? Math.min(limit, TOOL_RESULT_BYTES) : limit;
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (_error) {
    throw new BridgeError('E_RESULT_LIMIT', 'The worker result is not bounded JSON', { stage: 'result' });
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > effectiveLimit) {
    throw new BridgeError('E_RESULT_LIMIT', 'The worker result exceeds the Host result limit', { stage: 'result' });
  }
  return result;
}

async function readManagedProjectMap(registryPath, projectsRoot, idPattern) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (_error) {
    throw configurationError('The managed project registry is not valid JSON');
  }
  if (isPlainObject(parsed) === false || isPlainObject(parsed.projects) === false) {
    throw configurationError('The managed project registry has no projects object');
  }
  const projects = new Map();
  for (const [id, value] of Object.entries(parsed.projects)) {
    if (idPattern.test(id) === false) throw configurationError('The managed registry contains an invalid project id');
    if (typeof value !== 'string' || isAbsolute(value) === false) throw configurationError('Managed project paths must be absolute');
    let real;
    try {
      real = await realpath(value);
      if ((await stat(real)).isDirectory() === false) throw new Error('not a directory');
    } catch (_error) {
      throw configurationError(`Managed project "${id}" is unavailable`);
    }
    if (inside(projectsRoot, real) === false) throw configurationError(`Managed project "${id}" escapes projectsRoot`);
    projects.set(id, real);
  }
  return projects;
}

export class VideoBridge {
  /**
   * @param options.ctx - Host plugin context with connection/tools/subprocess and logger.
   * @param options.rawConfig - trusted Loader row config; invalid config keeps the shell alive.
   * @param options.engineLoader - optional injection seam for contract tests.
   * @param options.baseUrl - module base for package resolution; defaults to this module.
   */
  constructor(options) {
    const settings = options || {};
    this.ctx = settings.ctx;
    this.engineLoader = typeof settings.engineLoader === 'function' ? settings.engineLoader : loadEngine;
    this.baseUrl = settings.baseUrl;
    this.spawnImpl = typeof settings.spawn === 'function' ? settings.spawn : spawn;
    const parsed = tryNormalizeConfig(settings.rawConfig);
    this.config = parsed.ok ? parsed.config : null;
    this.configError = parsed.ok ? null : parsed.error;
    this.client = null;
    this.runtime = null;
    this.started = false;
    this.starting = null;
    this.closing = false;
    this.disposed = false;
    this.disposePromise = null;
    this.jobs = new Map();
    this.audio = null;
    this.inFlight = new Set();
    this.projectFactsById = new Map();
    this.mediaImports = new Map();
    this.mediaCounts = new Map();
    this.mediaStreams = new Set();
    this.environment = buildWorkerEnv(process.env);
    // M1-01: stable data root state. Path math is synchronous (pure) so the
    // Session store can be constructed against <dataRoot>/session-state.json;
    // directory creation and legacy migration happen on the first request.
    this.dataRootState = null;
    this.dataRootPreparing = null;
    this.registryState = null;
    this.registryBackupWritten = false;
    this.legacyRoots = [];
    this.legacyBrowserPath = undefined;
    this.registryRecovery = null;
    this.registryScanQuarantine = new Map();
    this.projectsBackupWritten = false;
    this.stateRecovery = null;
    this.uiState = null;
    this.uiStateRecovery = null;
    let sessionConfig = this.config;
    let assetInboxRoot = this.config === null ? undefined : this.config.assetInboxRoot;
    let uiStatePath = null;
    let pluginSettingsPath = null;
    if (this.config !== null) {
      try {
        const resolvedRoot = resolveDataRoot(this.config, process.env);
        const layout = dataRootLayout(resolvedRoot.root);
        sessionConfig = Object.freeze({
          ...this.config,
          sessionStatePath: layout.sessionStatePath,
          sessionCwd: layout.sessionCwd,
        });
        assetInboxRoot = layout.assetInboxRoot;
        uiStatePath = layout.uiStatePath;
        pluginSettingsPath = layout.pluginSettingsPath;
      } catch (_error) {
        sessionConfig = this.config;
      }
    }
    this.uiState = uiStatePath === null ? null : new UiStateStore({ path: uiStatePath, logger: this.ctx && this.ctx.logger });
    // Page-owned settings (music models + appended system prompt). The store
    // is constructed eagerly so SessionService can read the synchronous
    // snapshot; files are only touched on the first prepared request.
    this.pluginSettings = pluginSettingsPath === null ? null : new PluginSettingsStore({
      path: pluginSettingsPath,
      logger: this.ctx && this.ctx.logger,
    });
    this.pluginSettingsRecovery = null;
    this.sessions = new SessionService({
      ctx: this.ctx,
      bridge: this,
      config: sessionConfig,
      configError: this.configError,
    });
    this.managedProjects = null;
    this.projectDirectoryCache = null;
    const snapshotWebServer = this.ctx !== undefined && this.ctx !== null && typeof this.ctx.get === 'function'
      ? this.ctx.get('webServer')
      : undefined;
    this.snapshots = new SnapshotRoutes(
      this.ctx !== undefined && this.ctx !== null ? this.ctx.connection : undefined,
      snapshotWebServer
    );
    this.assets = new AssetInbox({
      connection: this.ctx !== undefined && this.ctx !== null ? this.ctx.connection : undefined,
      root: assetInboxRoot,
      maxBytes: this.config !== null ? this.config.maxAssetBytes : undefined,
      // The bridge owns the trusted allowlist; an upload may only land in the
      // inbox for a project this deployment has actually registered.
      isTrustedProject: (id) => this.isTrustedProject(id),
    });
  }

  /** Register the authenticated asset upload route from the plugin effect. */
  installAssetRoute() {
    this.assets.install();
    // On plugin disable the request/artifact/tool registrations are torn down
    // first; accepted uploads are drained and cleaned by VideoBridge.dispose.
    return () => {
      this.assets.close();
      this.assets.uninstall();
    };
  }

  /** Exact route handler for the authenticated asset upload. */
  async uploadAsset(request) {
    await this.ensurePrepared();
    return this.assets.handle(request);
  }

  async resolveMedia(params) {
    if (this.closing || this.disposed) throw new BridgeError('E_WORKER_DISPOSED','Service is stopping');
    await this.ensurePrepared();
    const directory=await this.requireProjectDirectory(params.projectId);
    let cursor; let asset;
    do {
      const page=await this.invoke('asset.list',{projectId:params.projectId,limit:50,...(cursor?{cursor}:{})},{source:'http'});
      asset=page.assets.find(a=>a.assetId===params.assetId);cursor=page.nextCursor;
    } while(!asset&&cursor);
    if(!asset) throw new BridgeError('E_ASSET_MISSING','Asset unavailable');
    const rel=params.kind ? join('.dsh-video','media-cache',`${asset.assetId}-${asset.sha256}-${params.kind}.${params.kind==='proxy'?(asset.kind==='audio'?'m4a':'mp4'):'png'}`) : join('media',`${asset.sha256.slice(0,8)}.${asset.ext}`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)||!['mp4','mov','m4v','webm','mp3','wav','m4a','aac','flac','png','jpg','jpeg'].includes(asset.ext)) throw new BridgeError('E_PATH','Invalid asset record');
    const path=await realpath(join(directory,rel));
    const offset=relative(directory,path);
    if(offset.startsWith('..')||isAbsolute(offset)) throw new BridgeError('E_PATH','Media escapes project');
    const info=await stat(path);if(!info.isFile()) throw new BridgeError('E_ASSET_MISSING','Media unavailable');
    const mime={mp4:'video/mp4',mov:'video/quicktime',m4v:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'};
    return {path,size:info.size,mediaType:params.kind==='proxy'?(asset.kind==='audio'?'audio/mp4':'video/mp4'):params.kind?'image/png':mime[asset.ext]};
  }

  /** Trusted data-root paths after prepare; throws E_CONFIGURATION before that. */
  requireDataRootPaths() {
    if (this.dataRootState === null) throw configurationError('The video data root is not prepared yet');
    return this.dataRootState.paths;
  }

  /**
   * Synchronous read of the page-owned appended prompt for prompt assembly.
   * Returns '' before prepare or on a corrupt file; the corrupt state is
   * surfaced by the settings UI instead of silently rewriting defaults.
   */
  customSystemPromptText() {
    if (this.pluginSettings === null || this.pluginSettings.prepared === false) return '';
    return this.pluginSettings.customSystemPrompt();
  }

  /**
   * Ensure the stable data root once per plugin lifetime (V1 M1-01).
   *
   * Single-flight and side-effect free before the first business request, so
   * activation alone never creates user data and contract tests can drive the
   * same code against a temporary HOME/dataRoot.
   */
  async ensurePrepared() {
    if (this.dataRootState !== null) return this.dataRootState;
    if (this.dataRootPreparing !== null) return this.dataRootPreparing;
    this.dataRootPreparing = (async () => {
      const config = this.requireConfig();
      const resolved = resolveDataRoot(config, process.env);
      const ensured = await ensureDataRoot(resolved.root, {
        browserPath: config.browserPath !== undefined ? config.browserPath : this.legacyBrowserPath,
      });
      this.legacyRoots = legacyRootsFromConfig(config, process.env, resolved.root);
      this.dataRootState = { ...ensured, source: resolved.source };
      if (this.uiState !== null) {
        try {
          this.uiStateRecovery = await this.uiState.prepare();
        } catch (error) {
          this.log(error, 'ui state prepare');
          this.uiStateRecovery = { recovered: false, error: 'E_UI_STATE_CORRUPT' };
        }
      }
      // Page settings must be readable (synchronously) before the first
      // prompt assembly; a corrupt file is surfaced, never silently reset.
      if (this.pluginSettings !== null) {
        try {
          await this.pluginSettings.prepare();
          this.pluginSettingsRecovery = null;
        } catch (error) {
          this.log(error, 'plugin settings prepare');
          this.pluginSettingsRecovery = { error: error instanceof BridgeError ? error.code : 'E_SETTINGS_CORRUPT' };
        }
      }
      this.stateRecovery = await this.sessions.recoverState();
      await this.runLegacyMigration();
      await this.refreshRegistry();
      return this.dataRootState;
    })();
    try {
      return await this.dataRootPreparing;
    } finally {
      this.dataRootPreparing = null;
    }
  }

  /**
   * One-time copy-only legacy migration (M1-02).
   *
   * Runs before the first successful business request and is idempotent via
   * <dataRoot>/migration.json. Old roots are never rewritten/deleted; failures
   * are recorded per source/project and retried on the next activation.
   */
  async runLegacyMigration() {
    const state = this.dataRootState;
    if (state === null || this.legacyRoots.length === 0) return null;
    let result;
    try {
      result = await migrateLegacyRoots({
        paths: state.paths,
        legacyRoots: this.legacyRoots,
        logger: this.ctx && this.ctx.logger,
      });
    } catch (error) {
      this.log(error, 'legacy migration');
      this.migrationStatus = { status: 'failed', sources: this.legacyRoots.length };
      return null;
    }
    for (const parsed of result.mergedStates) {
      try {
        await this.sessions.store.mergeLegacyState(parsed);
      } catch (error) {
        this.log(error, 'legacy session merge');
      }
    }
    const sources = result.results.length;
    const copied = result.results.reduce((sum, entry) => sum + (entry.copied ? entry.copied.length : 0), 0);
    const skipped = result.results.reduce((sum, entry) => sum + (entry.skipped ? entry.skipped.length : 0), 0);
    const errors = result.results.reduce((sum, entry) => sum + (entry.errors ? entry.errors.length : 0), 0);
    const pending = result.results.some((entry) => entry.completed === false);
    this.migrationStatus = { status: pending ? 'partial' : 'complete', sources, copied, skipped, errors };
    return this.migrationStatus;
  }

  /** Trusted project ids: available directories only (asset uploads/ads). */
  isTrustedProject(id) {
    if (this.registryState !== null) return this.registryState.projects.has(id);
    return this.config !== null && this.config.projectIds.has(id);
  }

  /** A registered project whose directory is currently unavailable. */
  isQuarantinedProject(id) {
    return this.registryState !== null && this.registryState.quarantined.has(id);
  }

  /** Quarantine reason for diagnostics, or null. */
  projectQuarantineReason(id) {
    if (this.registryState === null) return null;
    return this.registryState.quarantined.get(id) || null;
  }

  /**
   * Re-read the data-root worker registry + project map.
   *
   * The worker registry is derived bookkeeping (paths only) and can be rebuilt
   * when missing; the project map is user data and is only ever read (a corrupt
   * map yields a typed error + empty table, never a rewrite/delete).
   */
  async refreshRegistry() {
    if (this.dataRootState === null) return null;
    const config = this.requireConfig();
    const paths = this.dataRootState.paths;
    let worker = await readWorkerRegistry(paths.registryPath);
    if (worker.ok === false) {
      // Derived worker registry: keep the corrupt bytes aside (never delete),
      // then rebuild the path-only managed config from the data-root layout.
      this.registryRecovery = { ...(this.registryRecovery || {}), workerRegistry: 'rebuilt', workerRegistryError: worker.error };
      await quarantineCorruptFile(paths.registryPath);
      await ensureDataRoot(paths.root, {
        browserPath: config.browserPath !== undefined ? config.browserPath : this.legacyBrowserPath,
      });
      worker = await readWorkerRegistry(paths.registryPath);
    }
    const workerBrowser = worker.ok && typeof worker.value.browserPath === 'string' ? worker.value.browserPath : undefined;
    if (workerBrowser !== undefined) this.legacyBrowserPath = workerBrowser;
    let loaded = await loadManagedProjects(paths.projectsRegistryPath, paths.projectsRoot);
    let scanQuarantined = null;
    if (loaded.error !== null && loaded.error !== 'E_PROJECTS_ROOT') {
      // Corrupt project map: readProjectsRegistry already tried .bak / atomic
      // temp residue. Last resort before starting empty: rebuild the map from
      // the project directories actually present on disk (user data is never
      // touched; incomplete directories are quarantined).
      const scan = await scanProjectsRoot(paths);
      const recovered = scan.projects.size > 0
        ? scan.projects
        : (loaded.recoveredProjects === undefined ? new Map() : loaded.recoveredProjects);
      if (scan.quarantined.size > 0) {
        scanQuarantined = scan.quarantined;
        for (const [id, reason] of scan.quarantined) this.registryScanQuarantine.set(id, reason);
      }
      await repairProjectsRegistry(paths, recovered);
      this.registryRecovery = {
        ...(this.registryRecovery || {}),
        projectsRegistry: scan.projects.size > 0 ? 'scanned' : 'repaired',
        projectsRegistryError: loaded.error,
        recoveredProjects: recovered.size,
        ...(scan.quarantined.size > 0 ? { scanQuarantined: [...scan.quarantined.keys()].sort() } : {}),
      };
      loaded = await loadManagedProjects(paths.projectsRegistryPath, paths.projectsRoot);
    } else if (loaded.error === null && loaded.source !== null && loaded.source !== 'file') {
      // The current map was unreadable but a .bak/temp copy was usable: keep the
      // corrupt bytes aside and restore the recovered map atomically.
      await repairProjectsRegistry(paths, loaded.recoveredProjects);
      this.registryRecovery = { ...(this.registryRecovery || {}), projectsRegistry: 'restored', projectsRegistrySource: loaded.source };
      loaded = await loadManagedProjects(paths.projectsRegistryPath, paths.projectsRoot);
    } else if (loaded.error === null && loaded.source === 'file' && this.projectsBackupWritten === false) {
      // Keep one last-known-good project map for recovery (advisory, best effort).
      try {
        await writeProjectsBackup(paths, loaded.recoveredProjects);
        this.projectsBackupWritten = true;
      } catch (_error) {
        /* recovery copy is advisory; never fail a request for it */
      }
    }
    if (scanQuarantined !== null) {
      for (const [id, reason] of scanQuarantined) {
        if (loaded.projects.has(id) === false) loaded.quarantined.set(id, reason);
      }
    }
    // Keep scan-quarantined directories visible for this plugin lifetime even
    // after the repaired map makes the corruption invisible on later refreshes.
    for (const [id, reason] of this.registryScanQuarantine) {
      if (loaded.projects.has(id) === true) {
        this.registryScanQuarantine.delete(id);
        continue;
      }
      if (loaded.quarantined.has(id) === false) loaded.quarantined.set(id, reason);
    }
    this.registryState = {
      projects: loaded.projects,
      quarantined: loaded.quarantined,
      rejected: loaded.rejected,
      error: worker.ok === false ? worker.error : loaded.error,
      registrySource: loaded.source,
      recovery: this.registryRecovery,
    };
    for (const id of loaded.projects.keys()) config.projectIds.add(id);
    for (const id of loaded.quarantined.keys()) config.projectIds.add(id);
    if (this.registryState.error === null && worker.ok === true && this.registryBackupWritten === false) {
      // Keep one last-known-good worker registry for M1-03 recovery; best effort.
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(paths.registryPath + '.bak', JSON.stringify(worker.value, null, 2) + '\n', { mode: 0o600 });
        this.registryBackupWritten = true;
      } catch (_error) {
        /* recovery copy is advisory; never fail a request for it */
      }
    }
    return this.registryState;
  }

  /**
   * Re-read the data-root project registry and add trusted ids to the allowlist.
   * Kept as the named discovery seam used by request dispatch and the static
   * contract checks.
   */
  async discoverManagedProjects() {
    await this.ensurePrepared();
    return this.refreshRegistry();
  }

  /** Trusted project ids from the data-root registry (legacy allowlist fallback). */
  listProjects() {
    const config = this.requireConfig();
    if (this.registryState !== null) {
      return [...this.registryState.projects.keys(), ...this.registryState.quarantined.keys()].sort();
    }
    return [...config.projectIds].sort();
  }

  /**
   * UI-only project picker payload.
   *
   * Every trusted project is listed with the modification time of its entry
   * composition (`index.html`) so the client can auto-open the most recently
   * updated managed project, plus the optional P3-016 manifest `title` (null
   * for legacy projects without one). Ids outside the trusted allowlist are
   * never returned; a project whose directory/entry/manifest cannot be read
   * keeps updatedAt 0 / title null instead of failing the whole list. The
   * legacy fixture demo project is included here and filtered by the client.
   */
  async projectList() {
    const directories = await this.projectDirectories();
    const projects = [];
    for (const projectId of this.listProjects()) {
      const directory = directories.get(projectId);
      let updatedAt = 0;
      let title = null;
      if (typeof directory === 'string') {
        try {
          const info = await stat(join(directory, 'timeline.json')).catch(()=>stat(join(directory, 'index.html')));
          updatedAt = Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0;
        } catch (_error) {
          updatedAt = 0;
        }
        // P3-016: the display title is optional metadata; old projects report
        // null and the client keeps its content-derived fallback.
        title = await readManifestTitle(directory);
      }
      const quarantined = this.isQuarantinedProject(projectId);
      projects.push({ projectId, updatedAt, title });
      if (quarantined) {
        Object.assign(projects[projects.length - 1], { quarantined: true, error: 'E_PROJECT_UNAVAILABLE' });
      }
    }
    projects.sort((left, right) => right.updatedAt - left.updatedAt || (left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0));
    return { projects, defaultProjectId: projects.length > 0 ? projects[0].projectId : null };
  }

  /** Root directory the worker writes private preview snapshots under. */
  previewRoot() {
    const runtime = this.runtime;
    if (runtime === null) return null;
    return join(runtime.artifactRoot, 'previews');
  }

  /**
   * Canonical per-project content directories from the trusted worker registry.
   *
   * Managed mode reads the worker-managed registry once discovered; legacy mode
   * resolves `registry.projects` directly, bounded to this deployment's trusted
   * id allowlist. Never starts the worker.
   */
  async projectDirectories() {
    if (this.registryState !== null) return this.registryState.projects;
    const config = this.requireConfig();
    if (this.managedProjects !== null) return this.managedProjects.projects;
    if (this.projectDirectoryCache !== null) return this.projectDirectoryCache;
    let registry;
    try {
      registry = parseRegistry(await readFile(config.registryPath, 'utf8'));
    } catch (_error) {
      return new Map();
    }
    const map = new Map();
    try {
      if (registry.managed === true) {
        const projectsRoot = await canonicalDirectory(registry.root, 'registry.projectsRoot');
        const managedRegistryPath = await canonicalFile(registry.managedRegistryPath, 'registry.registryPath');
        for (const [id, projectPath] of await readManagedProjectMap(managedRegistryPath, projectsRoot, PROJECT_ID)) {
          if (config.projectIds.has(id)) map.set(id, projectPath);
        }
      } else {
        const registryRoot = await canonicalDirectory(registry.root, 'registry.root');
        for (const [id, projectPath] of Object.entries(registry.projects)) {
          if (config.projectIds.has(id) === false) continue;
          try {
            const real = await realpath(projectPath);
            if ((await stat(real)).isDirectory() === false) continue;
            if (inside(registryRoot, real) === false) continue;
            map.set(id, real);
          } catch (_error) {
            /* an unavailable registered project simply has no previewable root */
          }
        }
      }
    } catch (_error) {
      return new Map();
    }
    this.projectDirectoryCache = map;
    return map;
  }

  /** Canonical directory root, or null when it is missing/not a directory. */
  async canonicalPreviewRoot(path) {
    if (typeof path !== 'string' || path.length === 0) return null;
    try {
      const real = await realpath(path);
      return (await stat(real)).isDirectory() ? real : null;
    } catch (_error) {
      return null;
    }
  }

  /** Whether one canonical artifact file is a recorded output of this project's job. */
  artifactOwnedBy(projectId, artifactRoot, canonical) {
    if (typeof projectId !== 'string' || typeof canonical !== 'string') return false;
    if (dirname(canonical) !== artifactRoot) return false;
    const match = basename(canonical).match(ARTIFACT_NAME);
    if (match === null) return false;
    const record = this.jobs.get(match[1]);
    return record !== undefined && record.projectId === projectId;
  }

  /**
   * Provenance roots for previewing one bound project/Session pair (R3).
   *
   * Unrestricted roots are owned outright by this project: its trusted content
   * directory and its per-project Session working directory. Artifact, upload
   * receipt and legacy shared-Session-root files carry an exact ownership probe.
   */
  async previewRoots(projectId, sessionId, requestedPath) {
    const config = this.requireConfig();
    const roots = [];
    let projectDirectory = null;
    try {
      projectDirectory = (await this.projectDirectories()).get(projectId) || null;
    } catch (_error) {
      projectDirectory = null;
    }
    if (projectDirectory !== null) roots.push({ kind: 'project', path: projectDirectory });

    let sessionCwd = null;
    try {
      sessionCwd = await this.sessions.sessionCwd();
    } catch (_error) {
      sessionCwd = null;
    }
    if (sessionCwd !== null) {
      let projectSessionRoot = null;
      try {
        projectSessionRoot = await this.sessions.projectSessionRoot(projectId);
      } catch (_error) {
        projectSessionRoot = null;
      }
      if (projectSessionRoot !== null && inside(sessionCwd, projectSessionRoot)) {
        roots.push({ kind: 'session', path: projectSessionRoot });
      }
      // The user-visible form may differ from the canonical form (for example a
      // `/var` vs `/private/var` prefix on macOS); the Session log names whatever
      // the native chat rendered, so accept the literal requested form too. Both
      // forms are only honored when the real canonical file is inside this root.
      const literalForms = [];
      if (typeof requestedPath === 'string' && requestedPath.length > 0 && requestedPath.length <= 4096) {
        let literal = requestedPath;
        if (literal.startsWith('file://')) {
          try {
            literal = fileURLToPath(literal);
          } catch (_error) {
            literal = null;
          }
        }
        if (typeof literal === 'string' && isAbsolute(literal) && literal.includes('\0') === false) {
          literalForms.push(literal);
        } else if (typeof literal === 'string' && typeof config.sessionCwd === 'string' && isAbsolute(config.sessionCwd)) {
          literalForms.push(join(config.sessionCwd, literal));
        }
      }
      const ownedSessionRoots = [...config.projectIds].map((id) => join(sessionCwd, id));
      roots.push({
        kind: 'legacy',
        path: sessionCwd,
        // The old shared root holds several projects' files; only the bound
        // Session's own inspected events can prove one exact path. Files under a
        // per-project Session root stay owned by that project and never qualify.
        verify: (canonical) => {
          for (const owned of ownedSessionRoots) {
            if (inside(owned, canonical)) return false;
          }
          const forms = literalForms.filter((form) => form !== canonical);
          return this.sessions.sessionReferencesPath(sessionId, [canonical, ...forms]);
        },
      });
    }

    const artifactRoot = await this.canonicalPreviewRoot(
      this.runtime !== null ? this.runtime.artifactRoot : config.artifactRoot
    );
    if (artifactRoot !== null) {
      roots.push({
        kind: 'artifact',
        path: artifactRoot,
        verify: (canonical) => this.artifactOwnedBy(projectId, artifactRoot, canonical),
      });
    }
    if (typeof this.assets.root === 'string' && this.assets.root.length > 0) {
      const inboxRoot = await this.canonicalPreviewRoot(this.assets.root);
      if (inboxRoot !== null) {
        roots.push({
          kind: 'receipt',
          path: inboxRoot,
          verify: (canonical) => this.assets.ownsFile(projectId, canonical),
        });
      }
    }
    return roots;
  }

  /** Bounded diagnostic state; never includes paths, environment values or stderr. */
  state() {
    return {
      configured: this.config !== null,
      started: this.started,
      starting: this.starting !== null,
      closing: this.closing,
      jobs: this.jobs.size,
      inFlight: this.inFlight.size,
      sessions: this.sessions.diagnose(),
      dataRoot: this.dataRootState === null
        ? null
        : {
            source: this.dataRootState.source,
            projects: this.registryState === null ? 0 : this.registryState.projects.size,
            quarantined: this.registryState === null ? 0 : this.registryState.quarantined.size,
            registryError: this.registryState === null ? null : this.registryState.error,
            registryRecovery: this.registryState === null || this.registryState.recovery === undefined ? null : this.registryState.recovery,
            migration: this.migrationStatus === undefined ? null : this.migrationStatus,
            sessionRecovery: this.stateRecovery === undefined ? null : this.stateRecovery,
            uiState: this.uiState === null ? null : this.uiState.diagnose(),
            pluginSettings: this.pluginSettings === null ? null : { ...this.pluginSettings.diagnose(), recovery: this.pluginSettingsRecovery },
          },
    };
  }

  log(error, context) {
    try {
      const logger = this.ctx && this.ctx.logger;
      if (logger && typeof logger.warn === 'function') logger.warn(`dsh-video host ${context}: ${logSummary(error)}`);
    } catch (_ignored) {
      /* diagnostics must never break a request */
    }
  }

  requireConfig() {
    if (this.configError !== null) throw this.configError;
    if (this.config === null) throw configurationError('Host bridge configuration is missing');
    return this.config;
  }

  /**
   * Resolve one registered project directory from the data-root registry and
   * re-verify it with realpath + projectsRoot containment. Never accepts a path
   * from the caller; a missing/quarantined project is a typed unavailable error.
   */
  async requireProjectDirectory(projectId) {
    const directories = await this.projectDirectories();
    const directory = directories.get(projectId);
    if (typeof directory !== 'string') {
      throw new BridgeError('E_PROJECT_UNAVAILABLE', 'The project directory is currently unavailable', { stage: 'project' });
    }
    let real;
    try {
      real = await realpath(directory);
      if ((await stat(real)).isDirectory() === false) throw new Error('not a directory');
    } catch (_error) {
      throw new BridgeError('E_PROJECT_UNAVAILABLE', 'The project directory is currently unavailable', { stage: 'project' });
    }
    if (this.dataRootState !== null) {
      let rootReal;
      try {
        rootReal = await realpath(this.dataRootState.paths.projectsRoot);
      } catch (_error) {
        throw new BridgeError('E_PROJECT_UNAVAILABLE', 'The project directory is currently unavailable', { stage: 'project' });
      }
      if (inside(rootReal, real) === false) {
        throw new BridgeError('E_PROJECT_UNAVAILABLE', 'The project directory is currently unavailable', { stage: 'project' });
      }
    }
    return real;
  }

  /**
   * Open one project folder in the platform file browser (M1-04).
   *
   * argv form only — project paths may contain spaces/CJK, so no shell string is
   * ever composed. The child is detached and unref-ed so the worker/fiber can be
   * disposed while the OS window stays open; a spawn failure is a typed error.
   */
  async revealProjectDirectory(directory) {
    const platform = process.platform;
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const child = this.spawnImpl(command, [directory], { detached: true, stdio: 'ignore' });
        if (child === null || typeof child !== 'object') throw new Error('spawn returned no child');
        if (typeof child.unref === 'function') child.unref();
        if (typeof child.once === 'function') {
          child.once('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
          child.once('spawn', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
        } else {
          resolve();
        }
      });
    } catch (_error) {
      throw new BridgeError('E_REVEAL_FAILED', 'The project folder could not be opened', { stage: 'reveal' });
    }
  }

  /**
   * Resolve the authoritative data-root paths, validate the worker managed
   * registry against them and load the reviewed engine packages once.
   *
   * The data root (not the old staging directory) is the single authority:
   * projects live in <dataRoot>/projects, artifacts in <dataRoot>/cache/output
   * and the worker is started with <dataRoot>/registry.json. Legacy config keys
   * (registryPath/artifactRoot/projectsRoot/...) are tolerated for upgrade and
   * migration but never override the data root.
   */
  async prepareRuntime() {
    const config = this.requireConfig();
    const prepared = await this.ensurePrepared();
    const paths = prepared.paths;
    const subprocess = this.ctx && this.ctx.subprocess;
    if (!subprocess || typeof subprocess.resolveExecutable !== 'function') {
      throw configurationError('Host subprocess.resolveExecutable is unavailable');
    }

    const workerCwd = await canonicalDirectory(config.workerCwd, 'workerCwd');
    let nodeExecutable;
    try {
      nodeExecutable = await subprocess.resolveExecutable(config.workerNode, this.environment);
    } catch (_error) {
      throw configurationError('"workerNode" could not be resolved from the trusted configuration');
    }
    if (typeof nodeExecutable !== 'string' || isAbsolute(nodeExecutable) === false) {
      throw configurationError('"workerNode" did not resolve to an absolute executable');
    }
    const nodeReal = await canonicalFile(nodeExecutable, 'workerNode');

    const registryPath = await canonicalFile(paths.registryPath, 'dataRoot/registry.json');
    const registryStat = await stat(registryPath);
    if (registryStat.size > MAX_REGISTRY_BYTES) throw configurationError('The worker registry exceeds the size limit');
    const registry = parseRegistry(await readFile(registryPath, 'utf8'));
    if (registry.managed !== true) {
      throw configurationError('The data root worker registry is not a managed registry');
    }
    const artifactRoot = await canonicalDirectory(paths.outputRoot, 'dataRoot/cache/output');
    const projectsRoot = await canonicalDirectory(registry.root, 'dataRoot/projects');
    const managedRegistryPath = await canonicalFile(registry.managedRegistryPath, 'dataRoot/projects.json');
    if (projectsRoot !== (await canonicalDirectory(paths.projectsRoot, 'dataRoot/projects'))) {
      throw configurationError('The data root worker registry points at another projects root');
    }
    if (managedRegistryPath !== (await canonicalFile(paths.projectsRegistryPath, 'dataRoot/projects.json'))) {
      throw configurationError('The data root worker registry points at another project registry');
    }
    const registryOutputRoot = await canonicalDirectory(registry.outputRoot, 'dataRoot/cache/output');
    if (registryOutputRoot !== artifactRoot) {
      throw configurationError('The data root worker registry output root is inconsistent');
    }
    let assetInboxRoot = null;
    if (registry.assetInboxRoot !== undefined) {
      assetInboxRoot = await canonicalDirectory(registry.assetInboxRoot, 'dataRoot/asset-inbox');
      if (assetInboxRoot !== (await canonicalDirectory(paths.assetInboxRoot, 'dataRoot/asset-inbox'))) {
        throw configurationError('The data root worker registry points at another asset inbox');
      }
    }
    if (registry.browserPath !== undefined) {
      // A missing configured browser is reported by the worker doctor; it must
      // not make the shell unusable before the first request.
      this.legacyBrowserPath = registry.browserPath;
      await stat(registry.browserPath).catch(() => {});
    }
    const projects = this.registryState !== null ? this.registryState.projects : new Map();
    const managed = { projectsRoot, registryPath: managedRegistryPath, assetInboxRoot, projects };

    const engine = await this.engineLoader({ baseUrl: this.baseUrl, workerEntry: config.workerEntry });
    if (typeof engine === 'object' && engine !== null && typeof engine.WorkerClient !== 'function') {
      throw configurationError('The installed engine client does not export WorkerClient');
    }
    if (typeof engine === 'object' && engine !== null && supportsExplicitSpawn(engine.clientVersion) === false) {
      throw configurationError(`The installed engine client version ${JSON.stringify(engine.clientVersion)} does not support explicit worker environment/cwd (requires >= 0.1.1)`);
    }
    const workerEntry = engine.workerEntry;
    if (typeof workerEntry !== 'string' || isAbsolute(workerEntry) === false) {
      throw configurationError('The worker entry did not resolve to an absolute file');
    }
    const workerEntryReal = await canonicalFile(workerEntry, 'workerEntry');

    return {
      config,
      nodeExecutable: nodeReal,
      workerEntry: workerEntryReal,
      workerCwd,
      registryPath,
      artifactRoot,
      dataRoot: paths.root,
      managed,
      WorkerClient: engine.WorkerClient,
      workerVersion: engine.workerVersion,
      clientVersion: engine.clientVersion,
    };
  }

  async startOnce() {
    const runtime = await (this.runtime === null ? this.prepareRuntime() : Promise.resolve(this.runtime));
    this.runtime = runtime;

    let client;
    try {
      client = new runtime.WorkerClient({
        nodeExecutable: runtime.nodeExecutable,
        workerEntry: runtime.workerEntry,
        registryPath: runtime.registryPath,
        cwd: runtime.workerCwd,
        env: Object.assign({}, this.environment),
        startupTimeoutMs: runtime.config.startupTimeoutMs,
        requestTimeoutMs: runtime.config.requestTimeoutMs,
        shutdownTimeoutMs: runtime.config.shutdownTimeoutMs,
        forceKillTimeoutMs: runtime.config.forceKillTimeoutMs,
        maxPending: runtime.config.maxPending,
        maxLineBytes: runtime.config.maxLineBytes,
        maxStderrBytes: runtime.config.maxStderrBytes,
      });
    } catch (error) {
      this.log(error, 'worker client construction');
      throw new BridgeError('E_WORKER_START', 'The video engine could not start', { stage: 'start', cause: error });
    }
    this.client = client;
    try {
      await client.start();
      this.started = true;
      return client;
    } catch (error) {
      this.started = false;
      this.client = null;
      try {
        await client.dispose();
      } catch (_ignored) {
        /* startup failure is reported below; teardown is best effort */
      }
      if (error instanceof BridgeError) throw error;
      const publicError = toPublicError(error);
      this.log(error, 'worker start');
      throw new BridgeError(
        publicError.error.code === 'E_INTERNAL' ? 'E_WORKER_START' : publicError.error.code,
        'The video engine could not start',
        { stage: 'start', cause: error }
      );
    }
  }

  /** Single-flight lazy startup; no import/apply side effect and no per-panel restart. */
  async ensureClient() {
    if (this.closing || this.disposed) {
      throw new BridgeError('E_WORKER_DISPOSED', 'The video service is stopping', { stage: 'lifecycle' });
    }
    if (this.started && this.client !== null) {
      const debug = typeof this.client.debug === 'function' ? this.client.debug() : null;
      if (debug && (debug.state === 'failed' || debug.state === 'disposed')) {
        throw new BridgeError('E_WORKER_EXITED', 'The video engine is no longer running', { stage: 'lifecycle' });
      }
      return this.client;
    }
    if (this.starting !== null) {
      await this.starting;
      return this.client;
    }
    this.starting = this.startOnce();
    try {
      const client = await this.starting;
      return client;
    } finally {
      this.starting = null;
    }
  }

  async callClient(method, params) {
    const config = this.requireConfig();
    const client = await this.ensureClient();
    try {
      return await client.request(method, params, { timeoutMs: method.startsWith('asset.') ? Math.max(config.requestTimeoutMs,120000) : config.requestTimeoutMs });
    } catch (error) {
      const publicError = toPublicError(error);
      this.log(error, `worker ${method}`);
      throw new BridgeError(publicError.error.code, publicError.error.message, {
        stage: publicError.error.stage,
        uncertain: publicError.error.uncertain === true,
        jobUnknown: publicError.error.jobUnknown === true,
        cause: error,
      });
    }
  }

  /**
   * Best-effort worker cleanup that must still run after `closing` is set (for
   * example releasing a snapshot the worker produced for a request that was
   * already accepted). It talks to the live client directly, never starts one.
   */
  async releaseWorkerSnapshot(snapshotId) {
    const client = this.client !== null ? this.client : null;
    if (client === null || typeof client.request !== 'function') return false;
    try {
      const config = this.config;
      const options = config !== null ? { timeoutMs: config.requestTimeoutMs } : undefined;
      await client.request('preview.release', { snapshotId }, options);
      return true;
    } catch (error) {
      this.log(error, 'late snapshot release');
      return false;
    }
  }

  validate(method, params) {
    const config = this.requireConfig();
    if (REQUEST_METHODS.includes(method) === false) fail('E_METHOD', 'Unknown video action', 'params');
    return validateParams(config, method, params);
  }

  /**
   * Admit one accepted request synchronously, then run it.
   *
   * Every request that passes the closing gate enters the single `inFlight` set
   * before any await inside the dispatcher. Dispose therefore drains exactly the
   * work it accepted — including the early-return branches (project.list,
   * project.create, project.rename, asset.import, preview snapshots, preview,
   * session.*) — and nothing they publish can outlive the teardown.
   */
  invoke(method, params, options) {
    if (this.closing || this.disposed) {
      return Promise.reject(new BridgeError('E_WORKER_DISPOSED', 'The video service is stopping', { stage: 'lifecycle' }));
    }
    const task = this.dispatch(method, params, options || {});
    this.inFlight.add(task);
    const settle = () => {
      this.inFlight.delete(task);
    };
    task.then(settle, settle);
    return task;
  }

  /**
   * Read-only per-bucket loudness curve of a timeline range, built from the
   * same cached waveform envelope the UI draws: every audible unmuted clip
   * overlapping [fromFrame,toFrame) is sampled through the existing visuals
   * queue and the 256 window peaks are folded onto whole seconds. Range
   * scoring uses this to feel the scene's noise without hearing the media.
   */
  async audioProfile(params) {
    const { projectId, fromFrame, toFrame } = params;
    const timeline = await this.callClient('timeline.inspect', { projectId });
    this.rememberFacts({ ...timeline, timeline: true });
    const revision = timeline.revision;
    const assets = new Map(
      (Array.isArray(timeline.assets) ? timeline.assets : []).map((a) => [a.assetId, a]),
    );
    const windows = [];
    for (const track of Array.isArray(timeline.tracks) ? timeline.tracks : []) {
      for (const clip of Array.isArray(track.clips) ? track.clips : []) {
        const start = Math.max(clip.startFrame, fromFrame);
        const end = Math.min(clip.startFrame + clip.durationFrames, toFrame);
        if (end <= start) continue;
        const asset = assets.get(clip.assetId);
        if (!asset || (asset.kind !== 'audio' && asset.hasAudio !== true)) continue;
        if (track.muted === true || clip.muted === true) continue;
        windows.push({ clipId: clip.clipId, start, end });
      }
    }
    if (windows.length > 16)
      throw new BridgeError('E_LIMIT', '选区内可听片段过多，请缩短范围后重试', { stage: 'profile' });
    const seconds = Math.ceil((toFrame - fromFrame) / 30);
    const bucketSeconds = seconds > 600 ? Math.ceil(seconds / 600) : 1;
    const curve = new Array(Math.ceil(seconds / bucketSeconds)).fill(0);
    const sampled = [];
    let unsampled = 0;
    const deadline = Date.now() + 60000;
    for (const window of windows) {
      const wave = await this.sampleClipWaveform(projectId, revision, window, deadline);
      if (!wave) { unsampled++; continue; }
      sampled.push(window.clipId);
      const span = window.end - window.start;
      for (let i = 0; i < wave.peaks.length; i++) {
        const frame = window.start + ((i + 0.5) / wave.peaks.length) * span;
        const slot = Math.floor((frame - fromFrame) / (30 * bucketSeconds));
        if (slot >= 0 && slot < curve.length)
          curve[slot] = Math.max(curve[slot], Number(wave.peaks[i]) || 0);
      }
    }
    return {
      projectId,
      fromFrame,
      toFrame,
      revision,
      bucketSeconds,
      curve: curve.map((value) => Math.round(value * 100) / 100),
      sampledClips: sampled,
      unsampledClips: unsampled,
      note:
        sampled.length === 0
          ? 'no audible sampled audio inside the range'
          : 'max waveform peak per bucket, 0..1 of full scale; muted tracks and silent scenes are excluded',
    };
  }
  /** One visuals window -> waveform peaks, or null when it cannot be sampled. */
  async sampleClipWaveform(projectId, revision, window, deadline) {
    let task = await this.callClient('timeline.visuals.request', {
      projectId,
      expectedRevision: revision,
      clipId: window.clipId,
      startFrame: window.start,
      endFrame: window.end,
      count: 1,
    });
    const stop = Math.min(Date.now() + 20000, deadline);
    while (['complete', 'failed', 'cancelled'].includes(task.status) === false) {
      if (Date.now() > stop || this.closing === true || this.disposed === true) {
        await this.callClient('timeline.visuals.cancel', { projectId, taskId: task.taskId }).catch(() => {});
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      task = await this.callClient('timeline.visuals.status', { projectId, taskId: task.taskId });
    }
    if (task.status !== 'complete') return null;
    const wave = task.result && task.result.waveform;
    return Array.isArray(wave?.peaks) && wave.peaks.length > 0 ? wave : null;
  }

  async dispatch(method, params, settings) {
    const config = this.requireConfig();
    await this.ensurePrepared();
    try {
      await this.refreshRegistry();
    } catch (error) {
      // A transient registry read failure keeps the last known good project
      // table; it must not take the whole shell down. The user-data file is
      // never rewritten here.
      this.log(error, 'registry refresh');
    }
    const normalized = this.validate(method, params);
    if (normalized.projectId !== undefined && this.isQuarantinedProject(normalized.projectId)) {
      throw new BridgeError('E_PROJECT_UNAVAILABLE', 'The project directory is currently unavailable', { stage: 'project' });
    }
    if(method.startsWith('timeline.visuals.') && settings.source==='tool') throw new BridgeError('E_METHOD','Timeline visuals are UI-only');
    if(method==='timeline.audioProfile'){
      // Read-only loudness profile for range scoring; the model may call it,
      // but the underlying visuals queue stays UI-only behind this facade.
      if(settings.source==='tool')await this.assertToolScope(method,normalized,settings.agentSessionId);
      const result=await this.audioProfile(normalized);
      return publicResult(config.maxResultBytes,result,settings.source);
    }
    if(method==='reference.list'){
      if(settings.source==='tool')throw new BridgeError('E_METHOD','Reference menu is UI-only');
      const projectId=await this.sessions.projectForSession(normalized.sessionId);
      if(!projectId)throw new BridgeError('E_SESSION_NOT_BOUND','请先打开作品的创作会话');
      if(!config.projectIds.has(projectId)||this.isQuarantinedProject(projectId))throw new BridgeError('E_PROJECT_SCOPE','作品不可用，请重新选择');
      const {sessionId,...query}=normalized;
      await this.callClient('open',{projectId});
      const result=await this.callClient('timeline.references',{projectId,...query});
      this.rememberFacts({...result,timeline:true});
      return publicResult(config.maxResultBytes,result,settings.source);
    }
    if(method.startsWith('audio.')) {
      if(['audio.configure','audio.settings','audio.check','audio.model.save','audio.model.remove','audio.model.default'].includes(method)&&settings.source==='tool')throw new BridgeError('E_METHOD','Audio credentials are UI-only');
      if(settings.source==='tool')await this.assertToolScope(method,normalized,settings.agentSessionId);
      if(!this.audio){const paths=this.requireDataRootPaths();this.audio=new AudioService({root:join(paths.root,'audio'),settingsStore:this.pluginSettings,legacySecrets:join(homedir(),'.dsh/dsh-video/secrets.env'),importAudio:async(projectId,file,request)=>{
        const sourceName='generated-'+randomBytes(12).toString('hex')+file.slice(file.lastIndexOf('.'));
        const target=join(paths.assetInboxRoot,sourceName);await copyFile(file,target);
        try {return await this.callClient('asset.importMedia',{projectId,sourceName,name:(request.kind==='tts'?'旁白':request.kind==='music'?'配乐':'音效')+' · '+request.text.slice(0,32),limits:{maxBytes:this.config.maxAssetBytes,maxProjectBytes:this.config.maxProjectAssetBytes}});}finally{await unlink(target).catch(()=>{});}
      }});void this.audio.resumeJobs().catch(error=>this.log(error,'audio resume'));}
      let result;
      if(method==='audio.configure')result=await this.audio.configure(normalized);
      else if(method==='audio.settings')result=await this.audio.settings();
      else if(method==='audio.providers'){const s=await this.audio.settings();result={models:s.musicModels.map(({baseUrl,remoteModel,hasKey,...safe})=>safe),defaultMusicModelId:s.defaultMusicModelId,providers:s.providers,limits:s.limits,billing:s.billing};}
      else if(method==='audio.model.save')result=await this.audio.saveModel({model:normalized.model,...(normalized.apiKey!==undefined?{apiKey:normalized.apiKey}:{})});
      else if(method==='audio.model.remove')result=await this.audio.removeModel(normalized.modelId);
      else if(method==='audio.model.default')result=await this.audio.setDefaultModel(normalized.modelId);
      else if(method==='audio.check')result=await this.audio.check(normalized.modelId);
      else if(method==='audio.guide')result={skill:await readFile(new URL('../skills/audio-creation/SKILL.md',import.meta.url),'utf8')};
      else if(method==='audio.recipe')result=await this.audio.recipe(normalized.projectId,normalized.jobId);
      else if(method==='audio.generate')result=await this.audio.generate(normalized);
      else if(method==='audio.cancel')result=await this.audio.cancel(normalized.projectId,normalized.jobId);
      else result=await this.audio.status(normalized.projectId,normalized.jobId);
      return publicResult(config.maxResultBytes,result,settings.source);
    }
    if (method === 'prompt.get' || method === 'prompt.set') {
      // Page-owned prompt assembly settings: never readable or writable by
      // the model tool surface, and never stored anywhere else.
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Prompt settings are UI-only', { stage: 'params' });
      if (this.pluginSettings === null) throw new BridgeError('E_SETTINGS_UNAVAILABLE', '插件设置存储未配置', { stage: 'plugin-settings' });
      this.pluginSettings.ensurePrepared();
      if (method === 'prompt.get') return { text: this.pluginSettings.customSystemPrompt(), maxCharacters: 2000, recovery: this.pluginSettingsRecovery };
      const next = await this.pluginSettings.setCustomSystemPrompt(normalized.text);
      return publicResult(this.requireConfig().maxResultBytes, { text: next.customSystemPrompt }, settings.source);
    }
    if (method === 'project.list') {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Project listing is a UI-only action', { stage: 'params' });
      return this.projectList();
    }
    if (method === 'project.create') {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Project creation is a UI-only action', { stage: 'params' });
      const created = await this.callClient('project.create', normalized);
      await this.discoverManagedProjects();
      if (this.config === null || this.config.projectIds.has(created.projectId) === false) {
        throw new BridgeError('E_PROJECT', 'The created project was not published to the trusted registry', { stage: 'project' });
      }
      return publicResult(this.requireConfig().maxResultBytes, created, settings.source);
    }
    if (method === 'project.rename') {
      // P3-016: display-title metadata only. It never touches the composition,
      // revision or history and stays out of the model Tool surface.
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Project renaming is a UI-only action', { stage: 'params' });
      const renamed = await this.callClient('project.rename', normalized);
      if (
        isPlainObject(renamed) === false ||
        renamed.projectId !== normalized.projectId ||
        typeof renamed.title !== 'string' ||
        typeof renamed.revision !== 'string' ||
        REVISION.test(renamed.revision) === false
      ) {
        throw new BridgeError('E_WORKER_RESPONSE', 'The worker returned an invalid rename result', { stage: 'response' });
      }
      return publicResult(this.requireConfig().maxResultBytes, renamed, settings.source);
    }
    if (method === 'project.path' || method === 'project.reveal') {
      // UI-only, data-root-authoritative: the path is resolved from the trusted
      // registry + realpath, never accepted from the UI/Tool.
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Project folders are a UI-only action', { stage: 'params' });
      const directory = await this.requireProjectDirectory(normalized.projectId);
      if (method === 'project.path') {
        return publicResult(this.requireConfig().maxResultBytes, { projectId: normalized.projectId, path: directory }, settings.source);
      }
      await this.revealProjectDirectory(directory);
      return publicResult(this.requireConfig().maxResultBytes, { projectId: normalized.projectId, opened: true }, settings.source);
    }
    if (method === 'ui.state.get' || method === 'ui.state.set') {
      // UI-only panel state (last project / layout); it never enters a project
      // revision and is never part of the model Tool surface.
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Panel state is a UI-only action', { stage: 'params' });
      if (this.uiState === null) throw new BridgeError('E_UI_STATE_UNAVAILABLE', 'Panel state persistence is not configured', { stage: 'ui-state' });
      if (method === 'ui.state.get') {
        return publicResult(this.requireConfig().maxResultBytes, this.uiState.get(), settings.source);
      }
      const updated = await this.uiState.set(normalized.patch);
      return publicResult(this.requireConfig().maxResultBytes, updated, settings.source);
    }
    if (method === 'asset.import' || method === 'asset.importMedia') {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Asset import is a UI-only action', { stage: 'params' });
      const { receiptId, ...request } = normalized;
      const importKey = normalized.projectId + "\0" + normalized.operationId;
      if (method === 'asset.importMedia') {
        const previous=this.mediaImports.get(importKey);
        if(previous){
          if(previous.receiptId!==receiptId) throw new BridgeError('E_OPERATION_REUSED','Import id already used with a different receipt');
          return previous.promise;
        }
        if(this.mediaImports.size>=1024) throw new BridgeError('E_LIMIT','Import operation limit reached');
      }
      const receipt = this.assets.take(normalized.projectId, receiptId);
      if(receipt.importing) throw new BridgeError('E_ASSET_RECEIPT','Upload is already being imported');
      receipt.importing=true;
      const promise=(async()=>{
        let imported;
        try { imported = await this.callClient(method, {
          ...request, sourceName:receipt.sourceName, name:receipt.originalName,
          ...(method==='asset.import'?{mediaType:receipt.mediaType}:{limits:{maxBytes:this.config.maxAssetBytes,maxProjectBytes:this.config.maxProjectAssetBytes}}),
        }); } finally { await this.assets.finish(receipt); }
        if(method==='asset.importMedia'){try{const page=await this.callClient('asset.list',{projectId:normalized.projectId,limit:1});this.mediaCounts.set(normalized.projectId,page.total);}catch{this.mediaCounts.delete(normalized.projectId);}}
        return publicResult(this.requireConfig().maxResultBytes,imported,settings.source);
      })();
      if(method==='asset.importMedia') {
        this.mediaImports.set(importKey,{receiptId,promise});
        promise.catch(()=>{this.mediaImports.delete(importKey);});
      }
      return promise;
    }
    if (['asset.remove','asset.derive'].includes(method) && settings.source==='tool') throw new BridgeError('E_METHOD','Media writes are UI-only',{stage:'params'});
    if (method === 'preview.snapshot') {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Preview snapshot is a UI-only action', { stage: 'params' });
      const snapshot = await this.callClient('preview.snapshot', normalized);
      while(snapshot.nextOffset!==undefined&&snapshot.nextOffset!==null){const offset=snapshot.nextOffset;const page=await this.callClient('preview.files',{snapshotId:snapshot.snapshotId,offset});if(page.snapshotId!==snapshot.snapshotId||page.revision!==snapshot.revision||!Array.isArray(page.files)||page.files.length>100||page.nextOffset!==null&&page.nextOffset<=offset||snapshot.files.length+page.files.length>1280)throw new BridgeError('E_SNAPSHOT','Invalid snapshot file page',{stage:'preview'});snapshot.files.push(...page.files);snapshot.nextOffset=page.nextOffset;}

      // A worker result that arrives after disable began must not publish routes;
      // release the private snapshot instead of registering it.
      if (this.closing || this.disposed) {
        const snapshotId = snapshot !== null && typeof snapshot === 'object' ? snapshot.snapshotId : undefined;
        if (typeof snapshotId === 'string' && SNAPSHOT_ID.test(snapshotId)) {
          await this.releaseWorkerSnapshot(snapshotId);
        }
        throw new BridgeError('E_WORKER_DISPOSED', 'The video service is stopping', { stage: 'lifecycle' });
      }
      const root = this.previewRoot();
      if (root === null) throw new BridgeError('E_WORKER_START', 'The preview root is unavailable before worker startup', { stage: 'preview' });
      try {
        const registered = await this.snapshots.register(normalized.projectId, snapshot, root);
        const published={...snapshot,...registered,routeBase:SNAPSHOT_ROUTE_BASE};if(published.files.length>100){published.fileCount=published.files.length;published.files=published.files.slice(0,100);published.filesTruncated=true;}return publicResult(this.requireConfig().maxResultBytes,published,settings.source);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        try {
          await this.callClient('preview.release', { snapshotId: snapshot.snapshotId });
        } catch (_ignored) {
          /* the failed registration must still surface */
        }
        throw new BridgeError('E_SNAPSHOT', 'The worker preview snapshot could not be published', { stage: 'preview', cause: error });
      }
    }
    if (method === 'preview.release') {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Preview release is a UI-only action', { stage: 'params' });
      // Revoke the Host route even when the worker snapshot is already gone
      // (TTL expiry / duplicate release): cleanup stays idempotent and no stale
      // route is left behind. Other worker failures still surface after cleanup.
      let released;
      try {
        released = await this.callClient('preview.release', normalized);
      } catch (error) {
        this.snapshots.revoke(normalized.snapshotId);
        if (error instanceof BridgeError && error.code === 'E_SNAPSHOT_NOT_FOUND') {
          return publicResult(this.requireConfig().maxResultBytes, { snapshotId: normalized.snapshotId, released: false }, settings.source);
        }
        throw error;
      }
      this.snapshots.revoke(normalized.snapshotId);
      return publicResult(this.requireConfig().maxResultBytes, released, settings.source);
    }
    if (method === 'preview') {
      if (settings.source === 'tool') {
        throw new BridgeError('E_METHOD', 'Preview is a UI-only action, not a model tool action', { stage: 'params' });
      }
      const ownerProject = await this.sessions.projectForSession(normalized.sessionId);
      if (ownerProject === null) {
        throw new BridgeError('E_SESSION_NOT_BOUND', 'This Session is not bound to a video project', { stage: 'scope' });
      }
      if (ownerProject !== normalized.projectId) {
        throw new BridgeError('E_PROJECT_SCOPE', 'The preview targets a Session outside this project', { stage: 'scope' });
      }
      const roots = await this.previewRoots(normalized.projectId, normalized.sessionId, normalized.path);
      return readPreviewFile({
        roots,
        path: normalized.path,
        maxBytes: config.maxPreviewBytes,
      });
    }
    if (SESSION_METHODS.includes(method)) {
      if (settings.source === 'tool') throw new BridgeError('E_METHOD', 'Session management is not a model tool action', { stage: 'params' });
      return this.sessions.handle(method, normalized);
    }
    if (method === 'status' || method === 'cancel') {
      const record = this.jobs.get(normalized.jobId);
      if (record === undefined) throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });
    }

    if (settings.source === 'tool' && method !== 'doctor') {
      await this.assertToolScope(method, normalized, settings.agentSessionId);
    }
    // `wait` is Host-only semantics: the worker contract never receives it.
    let workerParams = normalized;
    let wait = false;
    if (method === 'frame' && normalized.wait !== undefined) {
      const { wait: requestedWait, ...request } = normalized;
      workerParams = request;
      wait = requestedWait === true;
    }
    const result = await this.callClient(method, workerParams);
    if(method==='asset.list' && normalized.kind===undefined && normalized.query===undefined)this.mediaCounts.set(normalized.projectId,result.total);
    if(method==='asset.remove')this.mediaCounts.delete(normalized.projectId);
    if (method === 'frame' || method === 'render') {
      this.rememberJob(method, workerParams, result);
    } else if (method === 'inspect' || method === 'open' || method === 'project.compose' || method.startsWith('timeline.') || method === 'scene.compose') {
      // inspect/open and project.compose results both carry the authoritative
      // revision for the next prompt assembly; a free-form composition project
      // reports `scenes: []`, which is how the composition mode is detected.
      this.rememberFacts(result);
    } else if (method === 'status' || method === 'cancel') {
      const record = this.jobs.get(normalized.jobId);
      if (record === undefined) throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });
      if (result !== null && typeof result === 'object' && result.projectId !== undefined && result.projectId !== record.projectId) {
        throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });
      }
    }
    if (method === 'close' && result !== null && typeof result === 'object' && result.closed === true) {
      this.snapshots.revokeProject(normalized.projectId);
    }
    if (wait) {
      const settled = await this.waitForFrameJob(result, normalized);
      const published = await this.publishFrameImage(settled, normalized);
      return publicResult(this.requireConfig().maxResultBytes, published, settings.source);
    }
    return publicResult(this.requireConfig().maxResultBytes, result, settings.source);
  }

  /**
   * Host-level `wait` for one frame job: rememberJob already fenced ownership,
   * so this polls the worker's own status view at a fixed interval until a
   * terminal state, the wait deadline (30s or the request timeoutMs, whichever
   * is smaller) or plugin shutdown. On deadline the current queued/running
   * view is returned and the job stays queryable through `status`/`cancel`.
   */
  async waitForFrameJob(started, params) {
    const budget = Math.min(FRAME_WAIT_MAX_MS, params.timeoutMs !== undefined ? params.timeoutMs : FRAME_WAIT_MAX_MS);
    const deadline = Date.now() + budget;
    let view = started;
    while (TERMINAL_JOB_STATES.includes(view.state) === false) {
      // Never hold dispose/closing open for the poll interval or the deadline.
      if (this.closing || this.disposed) {
        throw new BridgeError('E_WORKER_DISPOSED', 'The video service is stopping', { stage: 'lifecycle' });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(FRAME_WAIT_INTERVAL_MS, remaining)));
      view = await this.callClient('status', { jobId: started.jobId });
      if (
        view === null ||
        typeof view !== 'object' ||
        view.jobId !== started.jobId ||
        view.projectId !== params.projectId ||
        view.revision !== params.revision
      ) {
        throw new BridgeError('E_WORKER_RESPONSE', 'The worker returned an invalid job status', { stage: 'response' });
      }
    }
    return view;
  }

  /**
   * Hand a settled successful frame to the Agent workspace: re-read the
   * artifact through readArtifact (so name/hash/bytes/realpath are verified
   * again), then replace the fixed workspace-relative PNG used by read_image.
   * Only `wait:true` succeeded views with an artifact are eligible.
   *
   * The replacement goes through a same-directory exclusive temporary file and
   * `rename`, so a pre-existing `latest.png` symlink is replaced as a directory
   * entry instead of being followed, and the published file always has the
   * 0600 mode regardless of the previous file's mode. A disabled Session, an
   * unavailable root or any copy failure is logged and leaves the successful
   * job view untouched, so the Tool contract never turns a good render into an
   * error just because the convenience copy failed.
   */
  async publishFrameImage(view, params) {
    if (view === null || typeof view !== 'object' || view.state !== 'succeeded') return view;
    const artifact = view.artifact;
    if (artifact === null || typeof artifact !== 'object' || typeof artifact.jobId !== 'string') return view;
    if (artifact.jobId !== view.jobId) return view;
    // Never touch the worker or the workspace while the plugin is stopping.
    if (this.closing || this.disposed) return view;
    let temporary = null;
    try {
      const published = await this.readArtifact(artifact.jobId);
      const sessionRoot = await this.sessions.projectSessionRoot(params.projectId);
      const directory = join(sessionRoot, FRAME_IMAGE_DIR);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The Session workspace is agent-writable: refuse a symlinked directory
      // that resolves outside the trusted per-project root.
      const realDirectory = await realpath(directory);
      if (inside(sessionRoot, realDirectory) === false) throw new Error('frame image directory escaped the Session root');
      // Never publish a convenience copy while the plugin is stopping.
      if (this.closing || this.disposed) return view;
      temporary = join(realDirectory, `.latest-${randomBytes(8).toString('hex')}.tmp`);
      await writeFile(temporary, published.bytes, { mode: 0o600, flag: 'wx' });
      // rename(2) replaces the directory entry itself: it never follows a
      // symlink planted at latest.png, and the new inode keeps mode 0600.
      await rename(temporary, join(realDirectory, FRAME_IMAGE_FILE));
      temporary = null;
      return { ...view, frameImage: FRAME_IMAGE_PATH };
    } catch (error) {
      if (temporary !== null) {
        try {
          await unlink(temporary);
        } catch (_ignored) {
          /* best-effort private temp cleanup */
        }
      }
      this.log(error, 'frame image publish');
      return view;
    }
  }

  /**
   * A Tool call may only touch the project bound to the trusted Agent Session.
   * Doctor is read-only diagnosis and needs no binding; every project or job
   * action does. The mapping is authoritative on the Host, never in tool args.
   */
  async assertToolScope(method, normalized, agentSessionId) {
    if (typeof agentSessionId !== 'string' || agentSessionId.length === 0) {
      throw new BridgeError('E_AGENT_REQUIRED', 'This video action needs a trusted Agent Session', { stage: 'scope' });
    }
    const projectId = await this.sessions.projectForSession(agentSessionId);
    if (projectId === null) {
      throw new BridgeError('E_SESSION_NOT_BOUND', 'This Agent Session is not bound to a video project', { stage: 'scope' });
    }
    let targetProject = normalized.projectId;
    if (targetProject === undefined && (method === 'status' || method === 'cancel')) {
      const record = this.jobs.get(normalized.jobId);
      if (record === undefined) throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });
      targetProject = record.projectId;
    }
    if (targetProject !== projectId) {
      throw new BridgeError('E_PROJECT_SCOPE', 'The video action targets a project outside this Agent Session binding', { stage: 'scope' });
    }
    return projectId;
  }

  /**
   * Bounded, non-sensitive project facts for live prompt context.
   *
   * inspect/open and project.compose results both carry `scenes`; a free-form
   * composition project reports an empty scene list, which is the composition
   * mode the prompt context turns into the project.source + project.compose
   * edit path.
   */
  rememberFacts(result) {
    if (result === null || typeof result !== 'object') return;
    const projectId = result.projectId;
    if (typeof projectId !== 'string' || this.config === null || this.config.projectIds.has(projectId) === false) return;
    const revision = typeof result.revision === 'string' && REVISION.test(result.revision) ? result.revision : null;
    if (revision === null) return;
    const priorFacts=this.projectFactsById.get(projectId);
    const elements = Array.isArray(result.elements) ? result.elements : [];
    const targets = [];
    for (const element of elements.slice(0, 40)) {
      if (element === null || typeof element !== 'object' || typeof element.stableId !== 'string') continue;
      const capabilities = Array.isArray(element.capabilities) ? element.capabilities.filter((value) => typeof value === 'string').slice(0, 8) : [];
      targets.push({ stableId: element.stableId.slice(0, 128), capabilities });
    }
    const scenes = Array.isArray(result.scenes)
      ? result.scenes.slice(0, 12).map((scene) => ({
          sceneId: typeof scene.sceneId === 'string' ? scene.sceneId.slice(0, 64) : '',
          title: typeof scene.title === 'string' ? scene.title.slice(0, 200) : '',
          start: Number.isFinite(Number(scene.start)) ? Number(scene.start) : null,
          duration: Number.isFinite(Number(scene.duration)) ? Number(scene.duration) : null,
        })).filter((scene) => scene.sceneId !== '')
      : [];
    const images = Array.isArray(result.files)
      ? result.files
          .filter((file) => file !== null && typeof file.path === 'string' && /\.(png|jpe?g)$/i.test(file.path))
          .slice(0, 16)
          .map((file) => file.path.slice(0, 256))
      : [];
    // A free-form composition is a project whose worker result has an empty
    // scene list (`scenes: []`), both for inspect and for a compose publish.
    const mode = result.timeline===true || result.schema==='dsh-video/timeline@1' ? 'timeline' : Array.isArray(result.scenes) ? (result.scenes.length === 0 ? 'composition' : 'scenes') : priorFacts?.mode??null;
    this.projectFactsById.set(projectId, {
      revision,
      width: Number.isFinite(Number(result.width)) ? Number(result.width) : result.settings?.width??priorFacts?.width??null,
      height: Number.isFinite(Number(result.height)) ? Number(result.height) : result.settings?.height??priorFacts?.height??null,
      duration: Number.isFinite(Number(result.duration)) ? Number(result.duration) : result.settings?.durationFrames/30||priorFacts?.duration||null,
      targets,
      scenes,
      images,
      mode,
    });
  }

  /** Read the last inspected project facts; never starts or resumes the worker. */
  projectFacts(projectId) {
    const facts = this.projectFactsById.get(projectId);
    if (facts === undefined) return null;
    return {
      revision: facts.revision,
      width: facts.width,
      height: facts.height,
      duration: facts.duration,
      targets: facts.targets.map((target) => ({ stableId: target.stableId, capabilities: target.capabilities.slice() })),
      scenes: facts.scenes.map((scene) => ({ ...scene })),
      images: facts.images.slice(),
      mode: facts.mode,
    };
  }

  rememberJob(method, params, result) {
    if (result === null || typeof result !== 'object' || JOB_ID.test(String(result.jobId)) === false) {
      throw new BridgeError('E_WORKER_RESPONSE', 'The worker returned an invalid job', { stage: 'response' });
    }
    if (result.projectId !== params.projectId || result.revision !== params.revision) {
      throw new BridgeError('E_WORKER_RESPONSE', 'The worker job does not match the request', { stage: 'response' });
    }
    this.jobs.set(result.jobId, {
      projectId: params.projectId,
      revision: params.revision,
      kind: method,
    });
  }

  async readArtifact(requestedJobId) {
    const config = this.requireConfig();
    const id = jobId(requestedJobId);
    const record = this.jobs.get(id);
    if (record === undefined) throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });

    const job = await this.callClient('status', { jobId: id });
    if (job === null || typeof job !== 'object' || job.projectId !== record.projectId || job.revision !== record.revision) {
      throw new BridgeError('E_JOB_NOT_FOUND', 'Unknown video job', { stage: 'job' });
    }
    if (job.state !== 'succeeded' || job.artifact === undefined || job.artifact === null) {
      throw new BridgeError('E_ARTIFACT_NOT_READY', 'The video artifact is not ready', { stage: 'artifact' });
    }
    const artifact = job.artifact;
    if (typeof artifact.name !== 'string' || ARTIFACT_NAME.test(artifact.name) === false) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact record is invalid', { stage: 'artifact' });
    }
    const match = artifact.name.match(ARTIFACT_NAME);
    const kind = match[2];
    if (artifact.jobId !== id || artifact.projectId !== record.projectId || artifact.revision !== record.revision) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact record is invalid', { stage: 'artifact' });
    }
    if (typeof artifact.hash !== 'string' || REVISION.test(artifact.hash) === false) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact record is invalid', { stage: 'artifact' });
    }
    if (typeof artifact.bytes !== 'number' || Number.isFinite(artifact.bytes) === false || artifact.bytes < 0) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact record is invalid', { stage: 'artifact' });
    }
    if (artifact.bytes > config.maxArtifactBytes) {
      throw new BridgeError('E_ARTIFACT_LIMIT', 'The video artifact exceeds the Host size limit', { stage: 'artifact' });
    }

    const artifactRoot = this.runtime !== null ? this.runtime.artifactRoot : config.artifactRoot;
    const path = join(artifactRoot, artifact.name);
    let filePath;
    try {
      filePath = await realpath(path);
      if (inside(artifactRoot, filePath) === false) throw new Error('escaped root');
      const info = await stat(filePath);
      if (info.isFile() === false) throw new Error('not a regular file');
      if (info.size !== artifact.bytes) throw new Error('size mismatch');
    } catch (_error) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact failed validation', { stage: 'artifact' });
    }
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (_error) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact failed validation', { stage: 'artifact' });
    }
    if (bytes.length !== artifact.bytes || bytes.length > config.maxArtifactBytes) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact failed validation', { stage: 'artifact' });
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== artifact.hash) {
      throw new BridgeError('E_ARTIFACT_INTEGRITY', 'The video artifact failed validation', { stage: 'artifact' });
    }
    return {
      bytes,
      mediaType: MEDIA[kind],
      size: bytes.length,
      hash,
      filename: artifact.name,
    };
  }

  /**
   * Refuse new work, abort pending uploads, drain every accepted request, then
   * tear down the worker, Sessions, snapshot routes and inbox receipts. Nothing
   * accepted or published can outlive the resolved dispose promise.
   */
  dispose() {
    if (this.disposePromise !== null) return this.disposePromise;
    this.closing = true;
    // Streams are not in inFlight; closing the inbox rejects new bytes and
    // cancels active readers before the drain below waits on accepted work.
    try {
      this.assets.close();
    } catch (error) {
      this.log(error, 'asset inbox close');
    }
    const mediaDrain=Promise.all([...this.mediaStreams].map(stream=>new Promise(resolveDrain=>{
      if(stream.closed){resolveDrain();return;}
      stream.once('close',resolveDrain);stream.destroy();
    })));
    const startTask = this.starting;
    this.disposePromise = (async () => {
      await mediaDrain;
      if(this.audio)await this.audio.dispose();
      if (startTask !== null) {
        try {
          await startTask;
        } catch (_ignored) {
          /* a failed start has no live worker left to stop */
        }
      }
      // Accepted requests may still need the worker; drain them before teardown.
      await Promise.allSettled([...this.inFlight]);
      const client = this.client;
      this.client = null;
      this.started = false;
      if (client !== null && typeof client.dispose === 'function') {
        try {
          await client.dispose();
        } catch (error) {
          this.log(error, 'worker dispose');
        }
      }
      try {
        await this.sessions.dispose();
      } catch (error) {
        this.log(error, 'session dispose');
      }
      try {
        this.snapshots.dispose();
      } catch (error) {
        this.log(error, 'preview routes dispose');
      }
      try {
        await this.assets.dispose();
      } catch (error) {
        this.log(error, 'asset inbox dispose');
      }
      this.disposed = true;
    })();
    return this.disposePromise;
  }
}
