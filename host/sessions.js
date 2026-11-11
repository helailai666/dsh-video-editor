/**
 * Host-owned creation-Session coordination for the video panel.
 *
 * The DSH Session Controller owns Sessions, messages, model selection and
 * titles. This service owns only the plugin-private relationship the host does
 * not model: which Sessions belong to which controlled video project, which one
 * is active, and the trusted working directory new Sessions are created in.
 * It also contributes live project context to a bound Agent's prompt assembly.
 *
 * The service never accepts a path, an arbitrary Agent identity or a Session id
 * from the UI without checking the persisted mapping first.
 */

import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { BridgeError, logSummary } from './errors.js';
import { MAX_SESSIONS_PER_PROJECT, SESSION_ID_PATTERN, SESSION_STATE_VERSION, SessionStateStore } from './session-state.js';

const require = createRequire(import.meta.url);
let bundleVersion = 'unknown';
try {
  bundleVersion = String(require('../package.json').version);
} catch (_error) {
  bundleVersion = 'unknown';
}

const PROMPT_CONTEXT_NAME = 'dsh-video:project';
const PROMPT_CONTEXT_ORDER = 4500;
/**
 * Hard upper bound for one assembled project context string. The workflow,
 * composition contract, skeleton and conflict-recovery lines always fit; the
 * page-owned "User additional instructions" block is appended whole after the
 * fixed rules (max 2000 chars of its own) or dropped whole; optional heavy
 * fact lines (many scenes/targets/images) are dropped last, so required
 * model-facing instructions are never cut. The timeline contract alone
 * measures ~5.4k chars, so the bound leaves the full 2000-char custom block
 * plus essential fact lines headroom (plan 6000 widened to 8000).
 */
const PROMPT_CONTEXT_MAX_CHARS = 8000;
/** The appended custom block is kept verbatim within this budget. */
const CUSTOM_PROMPT_MAX_CHARS = 2000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CREATE_DEDUPE = 32;
const MAX_LIST_ITEMS = 100;
/**
 * UI-composed chat messages ("send this scoring range to the conversation").
 * The request id is remembered so a lost acknowledgement can be replayed by the
 * same id instead of admitting the same message twice.
 */
const MAX_SEND_DEDUPE = 32;
const MAX_SEND_CHARS = 4000;
const SEND_TIMEOUT_MS = 30000;
/**
 * Bounded legacy-reference scan: an old shared-root file is only previewable when
 * this exact Session's own inspected events name that exact absolute path. The
 * scan never reads more than this from the newest events backwards, so a huge
 * log cannot turn one preview click into an unbounded read.
 */
const LEGACY_SCAN_MAX_EVENTS = 512;
const LEGACY_SCAN_MAX_BYTES = 256 * 1024;
const LEGACY_SCAN_MAX_DEPTH = 8;
const LEGACY_SCAN_MAX_STRING = 8192;
const LEGACY_INSPECT_TIMEOUT_MS = 3000;
/** Characters that would turn an "exact path" match into a longer path token. */
const PATH_TOKEN_CHAR = /[A-Za-z0-9._~-]/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function insidePath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel.startsWith('..') === false && isAbsolute(rel) === false);
}

/**
 * Whether one event value names the exact absolute path as a complete token.
 * Plain equality covers file-card titles; embeddings require a non-path
 * boundary on both sides so `/a/foo.png` never matches `/a/foo.png.bak`.
 */
function valueReferencesPath(value, absolutePath) {
  if (value === absolutePath) return true;
  let index = value.indexOf(absolutePath);
  while (index !== -1) {
    const before = index === 0 ? '' : value[index - 1];
    const after = value[index + absolutePath.length];
    if ((before === '' || PATH_TOKEN_CHAR.test(before) === false) && (after === undefined || PATH_TOKEN_CHAR.test(after) === false)) {
      return true;
    }
    index = value.indexOf(absolutePath, index + 1);
  }
  return false;
}

/**
 * Bounded exact-path reference scan over inspected Session events.
 *
 * @param events - `inspection.events` from `sessionController.inspect`.
 * @param absolutePathOrPaths - one canonical absolute path, or every literal form
 *   of the requested path (e.g. the pre-realpath form) whose ownership is being
 *   verified.
 * @returns true only when this Session's own log explicitly names one of them.
 */
export function sessionEventsReferencePath(events, absolutePathOrPaths) {
  const candidates = (Array.isArray(absolutePathOrPaths) ? absolutePathOrPaths : [absolutePathOrPaths])
    .filter((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096 && path.includes('\0') === false);
  if (candidates.length === 0) return false;
  if (Array.isArray(events) === false || events.length === 0) return false;
  let budget = LEGACY_SCAN_MAX_BYTES;
  const start = Math.max(0, events.length - LEGACY_SCAN_MAX_EVENTS);
  for (let index = events.length - 1; index >= start; index -= 1) {
    if (budget <= 0) return false;
    const event = events[index];
    if (event === null || typeof event !== 'object') continue;
    const found = scanValue(event.data, candidates, budget, 0);
    budget -= found.scanned;
    if (found.matched) return true;
  }
  return false;
}

/** Depth/budget-bounded string walk; only string leaves can be path references. */
function scanValue(value, paths, budget, depth) {
  if (budget <= 0) return { matched: false, scanned: 0 };
  if (depth > LEGACY_SCAN_MAX_DEPTH) return { matched: false, scanned: 0 };
  if (typeof value === 'string') {
    if (value.length > LEGACY_SCAN_MAX_STRING) return { matched: false, scanned: Math.min(value.length, budget) };
    for (const path of paths) {
      if (valueReferencesPath(value, path)) return { matched: true, scanned: value.length };
    }
    return { matched: false, scanned: value.length };
  }
  if (Array.isArray(value)) {
    let scanned = 0;
    for (const item of value) {
      const result = scanValue(item, paths, budget - scanned, depth + 1);
      scanned += result.scanned;
      if (result.matched) return { matched: true, scanned };
    }
    return { matched: false, scanned };
  }
  if (value !== null && typeof value === 'object') {
    let scanned = 0;
    for (const key of Object.keys(value)) {
      const result = scanValue(value[key], paths, budget - scanned, depth + 1);
      scanned += result.scanned;
      if (result.matched) return { matched: true, scanned };
    }
    return { matched: false, scanned };
  }
  return { matched: false, scanned: 0 };
}

function sessionError(code, message, details) {
  return new BridgeError(code, message, { stage: 'session', details });
}

/**
 * Resolve the trusted Agent's Session identity for a Tool execution.
 *
 * The shipped tool pipeline passes `exec.agent.session.id` (verified in the
 * installed tool runtime's execute path); the public projected Agent type also
 * exposes `agent.id`. Accept either real
 * shape, require an exact match when both exist, and never guess from tool
 * arguments.
 *
 * @param exec - Tool execution context.
 * @returns the Session id, or null when the execution has no Agent.
 */
export function agentSessionIdFromToolExec(exec) {
  if (exec === null || typeof exec !== 'object') return null;
  const agent = exec.agent;
  if (agent === null || agent === undefined) return null;
  if (typeof agent !== 'object') throw sessionError('E_AGENT_IDENTITY', 'The tool execution Agent is not an object');
  const direct = typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : undefined;
  let nested;
  if (agent.session !== null && typeof agent.session === 'object') {
    if (typeof agent.session.id === 'string' && agent.session.id.length > 0) nested = agent.session.id;
  }
  if (direct !== undefined && nested !== undefined && direct !== nested) {
    throw sessionError('E_AGENT_IDENTITY', 'The tool execution Agent identity is inconsistent');
  }
  const id = nested !== undefined ? nested : direct;
  if (id === undefined) return null;
  if (id.length > 192) throw sessionError('E_AGENT_IDENTITY', 'The tool execution Agent identity is invalid');
  return id;
}

/** One Host-owned session coordinator. */
export class SessionService {
  /**
   * @param options.ctx - Host plugin context.
   * @param options.bridge - VideoBridge for project facts and logging.
   * @param options.config - normalized trusted config, or null when invalid.
   * @param options.configError - bridge configuration error, when present.
   */
  constructor(options) {
    const settings = options || {};
    this.ctx = settings.ctx;
    this.bridge = settings.bridge;
    this.config = settings.config === undefined ? null : settings.config;
    this.configError = settings.configError === undefined ? null : settings.configError;
    this.logger = this.ctx && this.ctx.logger;
    this.store = new SessionStateStore({
      path: this.config === null ? null : this.config.sessionStatePath,
      allowedProjects: this.config === null ? [] : this.config.projectIds,
      logger: this.logger,
    });
    this.ready = this.store.ready;
    this.contextDispose = null;
    this.creating = new Map();
    this.created = new Map();
    this.sent = new Map();
    this.cwdPromise = null;
    this.projectSessionRoots = new Map();
    this.closing = false;
    this.disposed = false;
    this.disposePromise = null;
  }

  service(name) {
    try {
      if (this.ctx && typeof this.ctx.get === 'function') return this.ctx.get(name);
      if (this.ctx) return this.ctx[name];
    } catch (_error) {
      return undefined;
    }
    return undefined;
  }

  report(error, context) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(`dsh-video session ${context}: ${logSummary(error)}`);
    } catch (_ignored) {
      /* diagnostics must not break a request */
    }
  }

  /** Configuration failure that disables session features without breaking preview. */
  configurationError() {
    if (this.configError !== null) return this.configError;
    if (this.config === null) return sessionError('E_SESSION_CONFIG', 'Session features need a valid Host configuration');
    if (typeof this.config.sessionStatePath !== 'string' || this.config.sessionStatePath.length === 0) {
      return sessionError('E_SESSION_CONFIG', 'Session features are disabled: "sessionStatePath" is not configured');
    }
    if (typeof this.config.sessionCwd !== 'string' || this.config.sessionCwd.length === 0) {
      return sessionError('E_SESSION_CONFIG', 'Session features are disabled: "sessionCwd" is not configured');
    }
    return null;
  }

  requireEnabled() {
    const error = this.configurationError();
    if (error !== null) throw error;
    return this.config;
  }

  /** Refuse work admitted after shutdown began; accepted work drains instead. */
  requireActive() {
    if (this.closing || this.disposed) throw sessionError('E_SESSION_STATE_DISPOSED', 'The video session service is stopping');
    return true;
  }

  controller() {
    const controller = this.service('sessionController');
    if (controller === null || typeof controller !== 'object' || typeof controller.create !== 'function') {
      throw sessionError('E_SESSION_CONFIG', 'The DSH Session Controller is unavailable');
    }
    return controller;
  }

  async sessionCwd() {
    const config = this.requireEnabled();
    if (this.cwdPromise === null) {
      this.cwdPromise = (async () => {
        if (isAbsolute(config.sessionCwd) === false) throw sessionError('E_SESSION_CONFIG', '"sessionCwd" must be absolute');
        try {
          const real = await realpath(config.sessionCwd);
          if ((await stat(real)).isDirectory() === false) throw new Error('not a directory');
          return real;
        } catch (_error) {
          throw sessionError('E_SESSION_CONFIG', '"sessionCwd" is not an existing directory');
        }
      })();
    }
    return this.cwdPromise;
  }

  /**
   * Trusted per-project Session working directory (`<sessionCwd>/<projectId>`).
   *
   * New creation Sessions are started here so their files are owned by exactly
   * one project; the same canonical root is what the preview provenance check
   * treats as this project's own Session files. It is created by the Host, not
   * taken from UI input.
   */
  async projectSessionRoot(projectId) {
    this.requireEnabled();
    if (typeof projectId !== 'string' || PROJECT_ID_PATTERN.test(projectId) === false) {
      throw sessionError('E_PARAMS', 'Invalid project id for the Session root');
    }
    const cached = this.projectSessionRoots.get(projectId);
    if (cached !== undefined) return cached;
    const base = await this.sessionCwd();
    const candidate = join(base, projectId);
    if (insidePath(base, candidate) === false) {
      throw sessionError('E_SESSION_CONFIG', 'The per-project Session root escapes "sessionCwd"');
    }
    try {
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      const real = await realpath(candidate);
      if (insidePath(base, real) === false) throw new Error('escaped root');
      if ((await stat(real)).isDirectory() === false) throw new Error('not a directory');
      this.projectSessionRoots.set(projectId, real);
      return real;
    } catch (_error) {
      throw sessionError('E_SESSION_CONFIG', 'The per-project Session root is unavailable');
    }
  }

  /**
   * Whether this bound Session's own inspected events explicitly name one exact
   * absolute path (or one of the accepted literal forms of it). Only used for
   * legacy files under the old shared Session root. Unavailable
   * controller/events deny instead of widening the root.
   */
  async sessionReferencesPath(sessionId, absolutePathOrPaths) {
    if (this.closing || this.disposed) return false;
    const controller = this.service('sessionController');
    if (controller === null || typeof controller !== 'object' || typeof controller.inspect !== 'function') return false;
    let inspection;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      try {
        abort.abort();
      } catch (_error) {
        /* abort is best effort */
      }
    }, LEGACY_INSPECT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      inspection = await controller.inspect(sessionId, abort.signal);
    } catch (_error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (inspection === null || typeof inspection !== 'object' || Array.isArray(inspection.events) === false) return false;
    return sessionEventsReferencePath(inspection.events, absolutePathOrPaths);
  }

  /** Observe archived Sessions without activating their Agents, when available. */
  archivedSessionIds() {
    const registry = this.service('workspaceRegistry');
    if (registry !== null && typeof registry === 'object' && Array.isArray(registry.archivedSessionIds)) {
      return new Set(registry.archivedSessionIds);
    }
    return new Set();
  }

  async sessionStatus(sessionId, archived) {
    if (archived.has(sessionId)) return 'archived';
    const controller = this.service('sessionController');
    if (controller === null || typeof controller !== 'object' || typeof controller.inspect !== 'function') return 'unknown';
    try {
      const inspection = await controller.inspect(sessionId);
      return inspection === null || inspection === undefined ? 'unavailable' : 'available';
    } catch (_error) {
      return 'unavailable';
    }
  }

  mappingSync(sessionId) {
    const state = this.store.state;
    if (state === null || this.store.loadError !== null) return null;
    const record = state.sessions[sessionId];
    return record === undefined ? null : record.projectId;
  }

  /**
   * Rebuild a corrupt persisted mapping once per activation (M1-03). Never
   * throws: a failure keeps the typed state error visible in diagnose().
   */
  async recoverState() {
    const error = this.configurationError();
    if (error !== null) return { recovered: false, error: error.code };
    try {
      return await this.store.recoverIfNeeded();
    } catch (recoveryError) {
      this.report(recoveryError, 'state recovery');
      return { recovered: false, error: recoveryError && recoveryError.code ? recoveryError.code : 'E_SESSION_STATE_CORRUPT' };
    }
  }

  /** Read-only preflight used by the panel and installation acceptance. */
  async diagnose() {
    const error = this.configurationError();
    const controller = this.service('sessionController');
    const systemPrompt = this.service('systemPrompt');
    return {
      contract: SESSION_STATE_VERSION,
      bundleVersion,
      enabled: error === null,
      error: error === null ? null : error.code,
      controller: controller !== null && typeof controller === 'object' && typeof controller.create === 'function',
      promptContext: systemPrompt !== null && typeof systemPrompt === 'object' && typeof systemPrompt.context === 'function',
      contextRegistered: this.contextDispose !== null,
      store: this.store.diagnose(),
    };
  }

  /** Register the live project-context contribution once; safe to call repeatedly. */
  ensurePromptContext() {
    if (this.contextDispose !== null || this.closing || this.disposed) return;
    const systemPrompt = this.service('systemPrompt');
    if (systemPrompt === null || typeof systemPrompt !== 'object' || typeof systemPrompt.context !== 'function') return;
    try {
      this.contextDispose = systemPrompt.context({
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        text: (assembly) => this.contextText(assembly),
      });
    } catch (error) {
      this.report(error, 'prompt context');
    }
  }

  /**
   * Fresh, bounded project facts for one assembly; never paths or messages.
   *
   * The workflow + composition-contract block is the model-facing product
   * contract: it is required for the Agent to know how to create/change a video
   * without a manual editor, how the whole document is replaced atomically, and
   * that it must never write project files through shell/file tools. It also
   * states the fast edit path (revision is already known -> source then compose),
   * a hard visual-verification budget (one frameImage-guided read_image at most),
   * the ban on local render/debug loops and the step budget, because each extra
   * serial Agent step costs a model turn.
   * Facts lines stay as before; free-form composition projects also get the
   * project.source + project.compose edit path line, ordered before the heavy
   * optional scene/image/target facts so it survives the bounded line budget.
   */
  contextText(assembly) {
    try {
      const agent = assembly !== null && typeof assembly === 'object' ? assembly.agent : undefined;
      if (agent === null || agent === undefined) return '';
      let sessionId;
      try {
        sessionId = agentSessionIdFromToolExec({ agent });
      } catch (_error) {
        return '';
      }
      if (sessionId === null) return '';
      const projectId = this.mappingSync(sessionId);
      if (projectId === null) return '';
      const facts = this.bridge && typeof this.bridge.projectFacts === 'function' ? this.bridge.projectFacts(projectId) : null;
      const lines = [
        `This conversation is bound to the video project "${projectId}".`,
        'Use the video_engine Tool for every project read or write; the Host checks the Session/project mapping on each call.',
        'To create or change the video:',
        `1. Fast path: when the project facts include a Last known project revision, skip inspect and call video_engine {"action":"project.source","projectId":"${projectId}"} once for the full HTML (the reliable base), then compose. Use {"action":"inspect","projectId":"${projectId}"} only without a revision or when you need scene/element facts.`,
        `2. Produce the COMPLETE HTML document and submit it once with {"action":"project.compose","projectId":"${projectId}","expectedRevision":"<current revision>","operationId":"<unique id>","html":"<!doctype html>..."}. Never poll status/close/history/undo/redo; publishedRevision is authoritative and the preview follows automatically.`,
        '3. Report the video updated only after project.compose returns publishedRevision; on error fix and retry. Never claim success from intent.',
        '3b. history: {status:"degraded"} means only edit history failed; publishedRevision is still authoritative: report the video as updated and history temporarily unavailable; do not rewrite the document.',
        '4. On E_REVISION_CONFLICT, call project.source again, apply your change to that newer HTML and resubmit with its revision; never retry with the stale revision or overwrite blindly.',
        'Visual verification budget: simple changes (color, material, text, layout, size, duration) need none. If needed, after compose make ONE video_engine frame call (wait:true, up to 3 times inside it), then at most ONE correction; never re-compose for marginal polish.',
        'A succeeded frame wait result includes frameImage, the workspace-relative path of the contact sheet: pass that path to ONE read_image. Never render, crop, sample colors, probe Chrome/ffmpeg/PIL, write scratch HTML, browse the plugin source or read a second image, and never use glob, ls or bash to find it.',
        'Step budget: aim for 3-5 Tool calls per change and at most 6 per turn; publish, report publishedRevision, explain briefly; add nothing unrequested.',
        'Duration: when the user gives a length, data-duration and the timeline total must equal it; the 5 in the skeleton is a placeholder, not a default.',
        'Composition contract (Host-validated before publishing; invalid input rejected atomically):',
        '- one complete HTML document of 1..49152 UTF-8 bytes;',
        '- exactly one #main element carrying data-composition-id plus numeric data-width (320..3840), data-height (180..2160), data-duration (0.1..3600);',
        '- expose the timeline as window.__timelines = { main: <gsap timeline> }; GSAP is available at ./assets/gsap.min.js;',
        '- no <iframe>/<object>/<embed>/<base>/<link>/<video>/<audio>/<source>/<track>, no external http(s)/file/blob/javascript URLs; only relative assets declared in the project; draw artwork with inline SVG/HTML/CSS;',
        '- modifications must keep what the user did not ask to change; the document is replaced atomically.',
        'Skeleton (keep these markers exact):',
        '<!doctype html><html><head><script src="./assets/gsap.min.js"></script></head><body><div id="main" data-composition-id="main" data-width="1280" data-height="720" data-fps="30" data-start="0" data-duration="5">...inline SVG/HTML artwork...<script>const tl = gsap.timeline(); /* tweens */ window.__timelines = { main: tl }; tl.seek(0);</script></div></body></html>',
        'Never write project files (index.html, project.json, assets) with shell or file tools, and never search the plugin source repository to satisfy a normal creative request. If a request cannot be expressed, say so briefly instead of faking completion.',
      ];
      if(facts?.mode==='timeline'){
        lines.splice(2, lines.length-2,
          'Timeline project: use timeline.inspect first for revision, tracks, clip IDs and settings. Never use project.compose/project.source or legacy scene writes here.',
          'Audio requests: FIRST audio.guide(projectId) for the bundled skill. AI composes procedural scores locally (free), then polls audio.status and inserts the real asset on an audio track in the same turn. Uploads stay in Materials until asked to place. Music models are configured ONLY on the plugin settings page; never configure providers or ask for API keys, and call a cloud model only when the user explicitly asks for generated voice/music. audio.providers lists safe model IDs with the default; audio.generate accepts modelId/durationFrames for music. Revise scores with audio.recipe. Only claim added after written:true.',
          'Range scoring: when the user attaches a dshvideo:v1 range token with a description (mood, rhythm, story), resolve it via timeline.resolve, write an instrumental music prompt from the range length plus their words (never invent unseen footage), then audio.generate kind music with durationFrames=toFrame-fromFrame using the default or the modelId they named. Poll audio.status until succeeded; re-inspect, pick an unlocked non-overlapping audio track (track.add when needed), insert with clip.insert startFrame=fromFrame, durationFrames=range length, sourceInFrame:0, mode:"reject" using the freshest revision and a new operationId. A generated asset shorter than the range stays in Materials with an honest note; never loop, move, ripple or overwrite existing clips. Cloud calls bill per provider usage; report ids only after written:true.',
          'Every write REQUIRES projectId, expectedRevision (the inspected SHA-256) and a unique operationId. They are not optional; revision/baseRevision are NOT substitutes. Undo/redo also require these fields.',
          `Create a scene: {"action":"scene.compose","projectId":"${projectId}","expectedRevision":"<revision>","operationId":"scene-1","trackId":"tr_v1","startFrame":0,"html":"<complete HTML>"}. For replacement, use clipId instead of trackId/startFrame; read scene.inspect first and preserve other clips. A new empty project has no clipId: insert the first scene.`,
          'timeline.apply requires ops with exact names: clip.insert, clip.split, clip.trim, clip.delete, clip.move, clip.reorder, clip.duplicate, clip.speed, clip.replace, clip.set, clip.fade, clip.volume, clip.transition; track.add, track.update, track.remove; timeline.settings. Use integer frames @30fps. Never send bare trim/move/delete or nested settings.',
          'Examples: ops:[{op:"timeline.settings",durationMode:"auto"},{op:"clip.trim",clipId:"<id>",edge:"out",deltaFrames:450}]. clip.split uses atFrame; clip.move uses startFrame/trackId/mode; clip.reorder uses ALL clipIds on that track. Insert media with clip.insert(assetId,trackId,startFrame,mode). scene.compose replacement preserves clip length: use clip.trim to change it. Keep durationMode:"auto": film duration follows the latest clip end across all tracks, including audio; do not pad with a fixed durationFrames.',
          'Resolve supplied dshvideo:v1 reference tokens with timeline.resolve refs:[{kind:"token",token:"..."}] at the current revision. Resolve ordinals/labels/ranges too; missing/foreign/stale/ambiguous means ask briefly to reselect, do not guess. A token alone is not an edit request.',
          'Use dryRun:true for complex batches, then confirm/apply. On E_REVISION_CONFLICT inspect/resolve again and preserve the user edits. Targeted timeline.undo/redo additionally use expectedHistoryCursor and expectedOperationId from timeline.inspect.lastChange. Success requires written:true; summarize actual changed clip IDs.',
          'HTML: complete document 1..49152 UTF-8 bytes AND JSON-escaped <=61440 bytes; one #main with data-hf-root, data-composition-id="main", data-width 320..3840, data-height 180..2160, data-duration 0.1..3600 seconds. Keep requested length, not the starter length. data-hf-root belongs ONLY on #main (SDK otherwise may select nested id="stage"). Expose window.__timelines={main:tl}; use ./assets/gsap.min.js. No external URLs or iframe/object/embed/base/link/video/audio/source/track tags; draw with HTML/inline SVG/CSS.',
          'Skeleton: <!doctype html><html><head><script src="./assets/gsap.min.js"></script></head><body><div id="main" data-hf-root data-composition-id="main" data-width="1280" data-height="720" data-duration="20">...</div><script>const tl=gsap.timeline({paused:true});tl.to({}, {duration:20});window.__timelines={main:tl};</script></body></html>',
          'Optional visual check: frame(projectId,revision,times:[seconds],wait:true), at most 3 times in ONE call; read_image(frameImage) once. Frame/render status/cancel take jobId only. No shell/file probing or local renders. Fix returned errors honestly.'
        );
      }
      const factsLines = [];
      if (facts !== null) {
        factsLines.push(`Last known project revision: ${facts.revision}.`);
        if (Number.isFinite(facts.duration)) factsLines.push(`Project duration: ${facts.duration}s.`);
        if (Number.isFinite(facts.width) && Number.isFinite(facts.height)) factsLines.push(`Frame: ${facts.width}x${facts.height}.`);
        if (facts.mode === 'composition') {
          factsLines.push('This project is a free-form composition: use project.source to read the document and project.compose to replace it.');
        }
        if (Array.isArray(facts.scenes) && facts.scenes.length > 0) {
          const scenes = facts.scenes.slice(0, 12).map((scene) => `${scene.sceneId} \"${scene.title}\" ${scene.start ?? '?'}-${scene.start !== null && scene.duration !== null ? Math.round((scene.start + scene.duration) * 1000) / 1000 : '?'}s`);
          factsLines.push(`Scenes: ${scenes.join('; ')}.`);
        }
        if (Array.isArray(facts.images) && facts.images.length > 0) {
          factsLines.push(`Imported images: ${facts.images.slice(0, 16).join(', ')}.`);
        }
        if (Array.isArray(facts.targets) && facts.targets.length > 0) {
          const targets = facts.targets.slice(0, 12).map((target) => `${target.stableId} [${target.capabilities.join(',')}]`);
          factsLines.push(`Known editable targets: ${targets.join('; ')}.`);
          factsLines.push('Prefer typed edit ops on a stableId for text/layout/style so human layout and colors are preserved; use scene.update only for scene-level defaults.');
        }
      } else {
        factsLines.push('Inspect the project before editing so the revision and target ids are current.');
      }
      factsLines.push('Imported media: query video_engine asset.list (projectId, kind/query/cursor/limit); place video/image/audio with timeline.apply clip.insert. Generate procedural audio via audio.guide, poll audio.status and place it. Music models are page-configured; audio.providers shows them, and the Tool only calls a cloud model when the user explicitly asks.');
      const mediaCount=this.bridge?.mediaCounts?.get(projectId);
      if(Number.isSafeInteger(mediaCount))factsLines.splice(1,0,`Imported media: ${mediaCount} assets. Use video_engine asset.list for paginated metadata.`);
      // Whole-line budget: the fixed instructions above are never truncated;
      // the page-owned block is appended verbatim after them (or dropped whole),
      // then optional fact lines fill whatever remains in priority order.
      let text = lines.join('\n');
      const custom =
        typeof this.bridge?.customSystemPromptText === 'function'
          ? String(this.bridge.customSystemPromptText() ?? '').slice(0, CUSTOM_PROMPT_MAX_CHARS)
          : '';
      if (custom.length > 0) {
        const block =
          `\nUser additional instructions (appended from the plugin settings page; lower priority than the fixed safety, credential, project-ownership, revision and Tool-contract rules above, which they can never override):\n${custom}`;
        if (text.length + block.length <= PROMPT_CONTEXT_MAX_CHARS) text += block;
      }
      for (const line of factsLines) {
        if (text.length + 1 + line.length > PROMPT_CONTEXT_MAX_CHARS) break;
        text += `\n${line}`;
      }
      return text;
    } catch (_error) {
      return '';
    }
  }

  dedupeKey(projectId, requestId) {
    return `${projectId}\u0000${requestId}`;
  }

  rememberCreated(projectId, requestId, value) {
    if (requestId === undefined) return;
    this.created.set(this.dedupeKey(projectId, requestId), { value, at: Date.now() });
    while (this.created.size > MAX_CREATE_DEDUPE) {
      const oldest = this.created.keys().next().value;
      this.created.delete(oldest);
    }
  }

  async list(projectId) {
    this.requireEnabled();
    this.requireActive();
    const project = await this.store.project(projectId);
    const archived = this.archivedSessionIds();
    const items = [];
    for (const sessionId of project.sessionIds.slice(0, MAX_LIST_ITEMS)) {
      items.push({ sessionId, status: await this.sessionStatus(sessionId, archived) });
    }
    this.ensurePromptContext();
    return {
      enabled: true,
      contract: SESSION_STATE_VERSION,
      projectId,
      activeSessionId: project.activeSessionId,
      sessions: items,
    };
  }

  async create(projectId, requestId) {
    this.requireEnabled();
    this.requireActive();
    if (requestId !== undefined && (typeof requestId !== 'string' || REQUEST_ID_PATTERN.test(requestId) === false)) {
      throw sessionError('E_PARAMS', 'Invalid session create request id');
    }
    // Every known, unrecoverable mapping fault must be rejected before the Host
    // creates anything: a corrupt file, an unknown version, an unregistered
    // project or the per-project cap cannot be repaired by an extra Session.
    const project = await this.store.project(projectId);
    if (project.sessionIds.length >= MAX_SESSIONS_PER_PROJECT) {
      throw sessionError('E_SESSION_STATE_LIMIT', 'This project has too many creation Sessions');
    }
    if (requestId !== undefined) {
      const previous = this.created.get(this.dedupeKey(projectId, requestId));
      if (previous !== undefined) {
        if (previous.value.projectId !== projectId) {
          throw sessionError('E_SESSION_ALREADY_BOUND', 'This create request id belongs to another project');
        }
        return previous.value;
      }
    }
    const existing = this.creating.get(projectId);
    if (existing !== undefined) return existing;
    const ordinal = project.sessionIds.length + 1;
    const task = (async () => {
      // New Sessions start in the trusted per-project Session root so their own
      // files stay attributable to exactly this project (not the shared root).
      const cwd = await this.projectSessionRoot(projectId);
      const controller = this.controller();
      let created;
      try {
        created = await controller.create({ cwd });
      } catch (error) {
        this.report(error, 'create');
        throw sessionError('E_SESSION_CREATE', 'The Host could not create a creation Session');
      }
      const sessionId = created !== null && typeof created === 'object' ? created.sessionId : undefined;
      if (typeof sessionId !== 'string' || SESSION_ID_PATTERN.test(sessionId) === false) {
        throw sessionError('E_SESSION_RESPONSE', 'The Host returned an invalid Session identity');
      }
      // The mapping publish happens only after the durable write committed
      // (SessionStateStore copy-on-write). A disk failure here is reported
      // honestly; the Host Session may already exist and is not claimed rolled back.
      const mapping = await this.store.addSession(projectId, sessionId, true);
      const value = {
        enabled: true,
        contract: SESSION_STATE_VERSION,
        projectId,
        sessionId,
        activeSessionId: mapping.activeSessionId === null ? sessionId : mapping.activeSessionId,
      };
      try {
        if (typeof controller.rename === 'function') {
          const title = `${projectId} · 创作 ${ordinal}`;
          await controller.rename({ sessionId, title });
        }
      } catch (error) {
        this.report(error, 'rename');
      }
      this.rememberCreated(projectId, requestId, value);
      this.ensurePromptContext();
      return value;
    })();
    this.creating.set(projectId, task);
    try {
      return await task;
    } finally {
      this.creating.delete(projectId);
    }
  }

  async select(projectId, sessionId) {
    this.requireEnabled();
    this.requireActive();
    const mapping = await this.store.selectSession(projectId, sessionId);
    this.ensurePromptContext();
    return {
      enabled: true,
      contract: SESSION_STATE_VERSION,
      projectId,
      sessionId,
      activeSessionId: mapping.activeSessionId,
    };
  }

  /**
   * Admit one UI-composed message into this project's bound Session through the
   * public DSH `sessionController.prompt` API (queue mode: the Session's own
   * inbox orders it, nothing here bypasses the Agent).
   *
   * The plugin never accepts a Session id from the UI — the target is always the
   * persisted mapping for this project. A `(projectId, requestId)` pair that was
   * already accepted replays its acknowledgement instead of sending twice, so the
   * Client can retry a lost response with the same id.
   */
  async send(projectId, requestId, text) {
    this.requireEnabled();
    this.requireActive();
    if (typeof requestId !== 'string' || REQUEST_ID_PATTERN.test(requestId) === false) {
      throw sessionError('E_PARAMS', 'Invalid session send request id');
    }
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > MAX_SEND_CHARS ||
      /[\0\r]/.test(text)
    ) {
      throw sessionError('E_PARAMS', 'Invalid session send content');
    }
    const project = await this.store.project(projectId);
    const sessionId =
      typeof project.activeSessionId === 'string'
        ? project.activeSessionId
        : project.sessionIds.length > 0
          ? project.sessionIds[project.sessionIds.length - 1]
          : null;
    if (sessionId === null) {
      throw sessionError('E_SESSION_NOT_BOUND', 'This project has no creation Session yet');
    }
    const hash = createHash('sha256')
      .update(requestId + '\n' + text)
      .digest('hex');
    const key = this.dedupeKey(projectId, requestId);
    const previous = this.sent.get(key);
    if (previous !== undefined) {
      if (previous.hash !== hash) {
        throw sessionError('E_OPERATION_REUSED', 'This send request id belongs to different content');
      }
      return previous.value;
    }
    const controller = this.service('sessionController');
    if (controller === null || typeof controller !== 'object' || typeof controller.prompt !== 'function') {
      throw sessionError('E_SESSION_CONFIG', 'The DSH Session Controller cannot accept prompts');
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      try {
        abort.abort();
      } catch (_error) {
        /* the acknowledgement already settled */
      }
    }, SEND_TIMEOUT_MS);
    let value;
    try {
      value = await controller.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        abort.signal,
      );
    } catch (error) {
      this.report(error, 'session send');
      // Admission may already have happened before the transport failed, so this
      // is reported as uncertain: the Client must not silently resend.
      throw sessionError('E_SESSION_SEND', 'The Session did not confirm this message; check the conversation before sending again');
    } finally {
      clearTimeout(timer);
    }
    if (value === null || typeof value !== 'object' || value.accepted !== true) {
      throw sessionError('E_SESSION_SEND', 'The Session returned an invalid prompt acknowledgement');
    }
    const result = {
      enabled: true,
      contract: SESSION_STATE_VERSION,
      projectId,
      sessionId,
      accepted: true,
    };
    this.sent.set(key, { hash, value: result, at: Date.now() });
    while (this.sent.size > MAX_SEND_DEDUPE) {
      const oldest = this.sent.keys().next().value;
      this.sent.delete(oldest);
    }
    return result;
  }

  /** Async project lookup used by tool scope checks. */
  async projectForSession(sessionId) {
    const error = this.configurationError();
    if (error !== null) throw error;
    return this.store.projectForSession(sessionId);
  }

  /** Route one session.* bridge method after parameter validation. */
  async handle(method, params) {
    if (method === 'session.diagnose') return this.diagnose();
    if (method === 'session.list') return this.list(params.projectId);
    if (method === 'session.create') return this.create(params.projectId, params.requestId);
    if (method === 'session.select') return this.select(params.projectId, params.sessionId);
    if (method === 'session.send') return this.send(params.projectId, params.requestId, params.text);
    throw sessionError('E_METHOD', 'Unknown session action');
  }

  dispose() {
    if (this.disposePromise !== null) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      // Accepted, non-cancellable creates (and their renames) must settle and
      // persist before the store or prompt context is torn down. Otherwise a
      // late write would fail against a disposed store and the real Host would
      // keep an unbound Session outside this plugin lifetime.
      await Promise.allSettled([...this.creating.values()]);
      try {
        await this.store.dispose();
      } catch (error) {
        this.report(error, 'state dispose');
      }
      if (this.contextDispose !== null) {
        const dispose = this.contextDispose;
        this.contextDispose = null;
        try {
          dispose();
        } catch (error) {
          this.report(error, 'prompt context cleanup');
        }
      }
      this.disposed = true;
    })();
    return this.disposePromise;
  }
}
