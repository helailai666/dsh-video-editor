import { TimelineVisuals } from "./timeline-visuals.mjs";
import { Timelines } from "./timeline.mjs";
import {
  MediaLibrary,
  validateImportMedia,
  validateAssetList,
  validateAssetRemove,
} from "./assets.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Projects,
  validateCompose,
  validateCreateProject,
  validateEdit,
  validateHistory,
  validateHistoryStep,
  validateImportAsset,
  validateProjectRename,
  validateRevise,
  validateSceneCreate,
  validateSceneRemove,
  validateSceneReorder,
  validateSceneUpdate,
  validateSource,
} from "./projects.mjs";
import { TEMPLATE_IDS } from "./scenes.mjs";
import { loadManagedRegistry } from "./registry.mjs";
import {
  MIN_PREVIEW_TTL_MS,
  MAX_PREVIEW_TTL_MS,
  validSnapshotId,
} from "./previews.mjs";
import {
  Jobs,
  normalizeFrameTimes,
  FRAME_TIMEOUT_MS,
  MAX_RENDER_TIMEOUT_MS,
} from "./jobs.mjs";
import {
  fail,
  keys,
  string,
  number,
  revision,
  publicError,
} from "./errors.mjs";
const MAX_LINE = 65536,
  MAX_OUTPUT = 65536,
  MAX_REQUESTS = 10000;
let media,
  store,
  jobs,
  closing = false,
  shutdownPromise,
  diagnosticBytes = 0;
const projectClosures = new Map();
function diagnostic(stage) {
  const line = `[worker] ${stage}\n`;
  if (diagnosticBytes + line.length <= 16384) {
    diagnosticBytes += line.length;
    process.stderr.write(line);
  }
}
function send(id, response) {
  let line = JSON.stringify({ v: 1, id, ...response });
  if (Buffer.byteLength(line) > MAX_OUTPUT)
    line = JSON.stringify({
      v: 1,
      id,
      ok: false,
      error: {
        code: "E_OUTPUT_LIMIT",
        message: "Response exceeds limit",
        stage: "protocol",
      },
    });
  return new Promise((resolve) => process.stdout.write(line + "\n", resolve));
}
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  if (jobs) jobs.closing = true;
  shutdownPromise = (async () => {
    await jobs?.drain();
    await store?.visuals?.drain();
    await Promise.all([...(store?.queues.values() || [])]);
    // Private preview snapshots must not survive worker shutdown/EOF/signal.
    await store?.shutdown();
  })();
  return shutdownPromise;
}
function closeProject(projectId) {
  const existing = projectClosures.get(projectId);
  if (existing) return existing;
  // This is intentionally synchronous before the first await. All subsequent
  // stdin requests observe the lifecycle gate while the old jobs drain.
  store.beginClose(projectId);
  const closingProject = (async () => {
    await jobs.drain(projectId);
    await store.visuals?.drain(projectId);
    await store.queue(projectId, () => store.completeClose(projectId));
    return { projectId, closed: true };
  })();
  projectClosures.set(projectId, closingProject);
  closingProject.then(
    () => projectClosures.delete(projectId),
    () => projectClosures.delete(projectId),
  );
  return closingProject;
}
async function method(name, p) {
  if (closing && name !== "shutdown")
    fail("E_SHUTDOWN", "Worker is shutting down");
  switch (name) {
    case "doctor":
      keys(p, []);
      return { ...jobs.tools, templates: TEMPLATE_IDS };
    case "open":
      keys(p, ["projectId"], ["projectId"]);
      string(p.projectId);
      return store.requestOpen(p.projectId);
    case "inspect":
      keys(p, ["projectId"], ["projectId"]);
      string(p.projectId);
      return store.requestInspect(p.projectId);
    case "edit":
      validateEdit(p);
      return store.edit(p.projectId, p);
    case "project.compose":
      validateCompose(p);
      return store.compose(p.projectId, p);
    case "project.source":
      validateSource(p);
      return store.source(p.projectId);
    case "project.create":
      validateCreateProject(p);
      return store.createProject(p);
    case "project.rename":
      validateProjectRename(p);
      return store.rename(p);
    case "timeline.visuals.request":
    case "timeline.visuals.status":
    case "timeline.visuals.cancel": {
      keys(p, name.endsWith('request') ? ['projectId','expectedRevision','clipId','startFrame','endFrame','count'] : ['projectId','taskId'], ['projectId']);
      string(p.projectId);store.assertNotClosing(p.projectId);
      await store.requestOpen(p.projectId);
      const timelines=store.timelines??(store.timelines=new Timelines(store,media));
      const visuals=store.visuals??(store.visuals=new TimelineVisuals(timelines,()=>[...jobs.jobs.values()].some(job=>!["succeeded","failed","cancelled","timed_out"].includes(job.state))));
      return visuals[name.split('.').at(-1)](p);
    }
    case "timeline.inspect":
    case "timeline.apply":
    case "timeline.references":
    case "timeline.resolve":
    case "timeline.undo":
    case "timeline.redo":
    case "scene.compose":
    case "scene.inspect": {
      const fields = {
        "timeline.references": ["query", "offset", "limit"],
        "timeline.inspect": ["view", "trackId", "offset", "limit"],
        "timeline.apply": ["expectedRevision", "operationId", "ops", "dryRun"],
        "timeline.resolve": ["revision", "refs"],
        "timeline.undo": [
          "expectedRevision",
          "operationId",
          "expectedHistoryCursor",
          "expectedOperationId",
        ],
        "timeline.redo": [
          "expectedRevision",
          "operationId",
          "expectedHistoryCursor",
          "expectedOperationId",
        ],
        "scene.compose": [
          "expectedRevision",
          "operationId",
          "clipId",
          "trackId",
          "startFrame",
          "html",
          "mode",
          "label",
        ],
        "scene.inspect": ["clipId"],
      };
      keys(p, ["projectId", ...fields[name]], ["projectId"]);
      string(p.projectId);
      store.assertNotClosing(p.projectId);
      const timelines =
        store.timelines ?? (store.timelines = new Timelines(store, media));
      return store.queue(p.projectId, () =>
        name === "timeline.inspect"
          ? timelines.inspect(p)
          : name === "timeline.references"
            ? timelines.references(p)
            : name === "timeline.resolve"
              ? timelines.resolve(p)
              : name.startsWith("scene.")
                ? timelines.scene(p)
                : timelines.apply(
                    p,
                    name === "timeline.undo"
                      ? "undo"
                      : name === "timeline.redo"
                        ? "redo"
                        : undefined,
                  ),
      );
    }
    case "asset.importMedia":
      validateImportMedia(p);
      store.assertNotClosing(p.projectId);
      return store.queue(p.projectId, () => media.importMedia(p));
    case "asset.list":
      validateAssetList(p);
      store.assertNotClosing(p.projectId);
      return store.queue(p.projectId, () => media.list(p));
    case "asset.remove":
      validateAssetRemove(p);
      store.assertNotClosing(p.projectId);
      return store.queue(p.projectId, () => media.remove(p));
    case "asset.derive":
      keys(
        p,
        ["projectId", "assetId", "kind"],
        ["projectId", "assetId", "kind"],
      );
      validateAssetRemove({ projectId: p.projectId, assetId: p.assetId });
      store.assertNotClosing(p.projectId);
      return store.queue(p.projectId, () => media.derive(p));
    case "asset.envelope": {
      keys(p, ["projectId", "assetId"], ["projectId", "assetId"]);
      validateAssetRemove({ projectId: p.projectId, assetId: p.assetId });
      store.assertNotClosing(p.projectId);
      await store.requestOpen(p.projectId);
      const timelines =
        store.timelines ?? (store.timelines = new Timelines(store, media));
      const visuals =
        store.visuals ??
        (store.visuals = new TimelineVisuals(timelines, () =>
          [...jobs.jobs.values()].some(
            (job) =>
              !["succeeded", "failed", "cancelled", "timed_out"].includes(
                job.state,
              ),
          ),
        ));
      return visuals.envelopeOf(p);
    }
    case "timeline.beatmap":
    case "asset.align": {
      // Read-only rhythm analysis. Both answers are bounded so one JSONL reply
      // stays far below the client line limit, and both need the timeline
      // journal plus the cached peaks pyramid rather than a fresh decode.
      keys(
        p,
        name === "asset.align"
          ? ["projectId", "revision", "assetId", "fromFrame", "toFrame", "hitFrames", "tempoLock"]
          : ["projectId", "revision", "fromFrame", "toFrame"],
        ["projectId", "revision", "fromFrame", "toFrame"],
      );
      string(p.projectId);
      revision(p.revision);
      number(p.fromFrame, 0, 108000);
      number(p.toFrame, p.fromFrame + 1, 108000);
      if (!Number.isInteger(p.fromFrame) || !Number.isInteger(p.toFrame) || p.toFrame - p.fromFrame > 10800)
        fail("E_PARAMS", "Beat window must be integer frames within six minutes");
      if (name === "asset.align") {
        validateAssetRemove({ projectId: p.projectId, assetId: p.assetId });
        if (p.hitFrames !== undefined) {
          if (!Array.isArray(p.hitFrames) || p.hitFrames.length > 256 || p.hitFrames.some((frame) => !Number.isInteger(frame)))
            fail("E_PARAMS", "hitFrames needs up to 256 integer timeline frames");
        }
        if (p.tempoLock !== undefined && typeof p.tempoLock !== "boolean")
          fail("E_PARAMS", "tempoLock must be a boolean");
      }
      store.assertNotClosing(p.projectId);
      await store.requestOpen(p.projectId);
      const timelines =
        store.timelines ?? (store.timelines = new Timelines(store, media));
      const visuals =
        store.visuals ??
        (store.visuals = new TimelineVisuals(timelines, () =>
          [...jobs.jobs.values()].some(
            (job) =>
              !["succeeded", "failed", "cancelled", "timed_out"].includes(
                job.state,
              ),
          ),
        ));
      return name === "asset.align" ? visuals.alignOf(p) : visuals.beatmapOf(p);
    }
    case "asset.import":
      validateImportAsset(p);
      return store.importAsset(p);
    case "scene.create":
      validateSceneCreate(p);
      return store.sceneCreate(p);
    case "scene.update":
      validateSceneUpdate(p);
      return store.sceneUpdate(p);
    case "scene.remove":
      validateSceneRemove(p);
      return store.sceneRemove(p);
    case "scene.reorder":
      validateSceneReorder(p);
      return store.sceneReorder(p);
    case "project.revise":
      validateRevise(p);
      return store.revise(p);
    case "history":
      validateHistory(p);
      if (await store.timelines.load(p.projectId))
        fail("E_TIMELINE_MODE", "Use timeline.inspect for timeline history");
      return store.history(p);
    case "undo":
      validateHistoryStep(p);
      if (await store.timelines.load(p.projectId))
        fail("E_TIMELINE_MODE", "Use timeline.undo for this project");
      return store.undo(p);
    case "redo":
      validateHistoryStep(p);
      if (await store.timelines.load(p.projectId))
        fail("E_TIMELINE_MODE", "Use timeline.redo for this project");
      return store.redo(p);
    case "frame":
    case "render":
      keys(
        p,
        name === "frame"
          ? ["projectId", "revision", "time", "times", "timeoutMs"]
          : ["projectId", "revision", "time", "timeoutMs"],
        ["projectId", "revision"],
      );
      string(p.projectId);
      revision(p.revision);
      if (name === "frame") {
        // Exactly one of the legacy single `time` or the batch `times` list.
        if (p.time !== undefined && p.times !== undefined)
          fail("E_PARAMS", "Provide exactly one of time or times");
        if (p.time !== undefined) number(p.time, 0, 3599.999);
        else if (p.times !== undefined) p.times = normalizeFrameTimes(p.times);
        else fail("E_PARAMS", "Provide exactly one of time or times");
      } else if (p.time !== undefined)
        fail("E_PARAMS", "Render has no time parameter");
      if (p.timeoutMs !== undefined)
        number(
          p.timeoutMs,
          100,
          name === "render" ? MAX_RENDER_TIMEOUT_MS : FRAME_TIMEOUT_MS,
        );
      return jobs.start(name, p);
    case "status":
      keys(p, ["jobId"], ["jobId"]);
      string(p.jobId);
      return jobs.view(jobs.get(p.jobId));
    case "cancel":
      keys(p, ["jobId"], ["jobId"]);
      string(p.jobId);
      return jobs.cancel(jobs.get(p.jobId));
    case "preview.snapshot":
      keys(p, ["projectId", "revision", "ttlMs"], ["projectId", "revision"]);
      string(p.projectId);
      revision(p.revision);
      if (p.ttlMs !== undefined) {
        number(p.ttlMs, MIN_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS);
        if (!Number.isInteger(p.ttlMs))
          fail("E_PARAMS", "ttlMs must be an integer");
      }
      return store.previewSnapshot(p);
    case "preview.files": {
      keys(p, ["snapshotId", "offset"], ["snapshotId", "offset"]);
      if (
        !validSnapshotId(p.snapshotId) ||
        !Number.isSafeInteger(p.offset) ||
        p.offset < 0
      )
        fail("E_PARAMS", "Invalid snapshot page");
      const snapshot = store.previews.entries.get(p.snapshotId);
      if (!snapshot) fail("E_SNAPSHOT_NOT_FOUND", "Snapshot expired");
      return {
        snapshotId: p.snapshotId,
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        files: snapshot.files.slice(p.offset, p.offset + 100),
        fileCount: snapshot.files.length,
        nextOffset:
          p.offset + 100 < snapshot.files.length ? p.offset + 100 : null,
      };
    }
    case "preview.release":
      keys(p, ["snapshotId"], ["snapshotId"]);
      string(p.snapshotId, 64);
      if (!validSnapshotId(p.snapshotId))
        fail("E_PARAMS", "Invalid snapshotId");
      return store.previewRelease(p);
    case "close":
      keys(p, ["projectId"], ["projectId"]);
      string(p.projectId);
      return closeProject(p.projectId);
    case "shutdown":
      keys(p, []);
      await shutdown();
      return { shutdown: true };
    default:
      fail("E_METHOD", "Unknown method");
  }
}
const seen = new Set(),
  pending = new Set();
async function accept(line) {
  let id = null,
    request;
  try {
    try {
      request = JSON.parse(line);
    } catch {
      fail("E_JSON", "Malformed JSON", "protocol");
    }
    if (typeof request?.id === "string" && request.id.length <= 128)
      id = request.id;
    keys(
      request,
      ["v", "id", "method", "params"],
      ["v", "id", "method", "params"],
    );
    string(request.id);
    id = request.id;
    if (request.v !== 1)
      fail("E_VERSION", "Unsupported protocol version", "protocol");
    string(request.method, 32);
    if (seen.has(id))
      fail("E_DUPLICATE_ID", "Request id was already used", "protocol");
    if (seen.size >= MAX_REQUESTS)
      fail("E_LIMIT", "Request budget exhausted", "protocol");
    seen.add(id);
    const result = await method(request.method, request.params);
    await send(id, { ok: true, result });
    if (request.method === "shutdown") {
      process.stdin.pause();
      setImmediate(() => process.exit(0));
    }
  } catch (e) {
    diagnostic("request failed");
    await send(id, { ok: false, error: publicError(e) });
  }
}
try {
  const index = process.argv.indexOf("--registry");
  if (index < 0) throw Error("registry");
  const config = JSON.parse(await readFile(process.argv[index + 1], "utf8"));
  if (Object.hasOwn(config, "projectsRoot")) {
    keys(
      config,
      [
        "projectsRoot",
        "registryPath",
        "outputRoot",
        "assetInboxRoot",
        "browserPath",
      ],
      ["projectsRoot", "registryPath", "outputRoot"],
    );
    string(config.projectsRoot, 4096);
    string(config.registryPath, 4096);
    string(config.outputRoot, 4096);
    if (config.assetInboxRoot !== undefined)
      string(config.assetInboxRoot, 4096);
    config.projectsRoot = resolve(config.projectsRoot);
    config.registryPath = resolve(config.registryPath);
    config.outputRoot = resolve(config.outputRoot);
    if (config.assetInboxRoot !== undefined)
      config.assetInboxRoot = resolve(config.assetInboxRoot);
    await mkdir(dirname(config.registryPath), { recursive: true });
    await mkdir(config.outputRoot, { recursive: true });
    const loaded = await loadManagedRegistry(config);
    config.root = loaded.root;
    config.projects = loaded.projects;
    config.managed = true;
  } else {
    keys(
      config,
      ["root", "projects", "outputRoot", "browserPath"],
      ["root", "projects", "outputRoot"],
    );
    string(config.root, 4096);
    string(config.outputRoot, 4096);
    keys(config.projects, Object.keys(config.projects));
    config.root = resolve(config.root);
    config.outputRoot = resolve(config.outputRoot);
    for (const path of Object.values(config.projects)) string(path, 4096);
    config.managed = false;
    await mkdir(config.outputRoot, { recursive: true });
  }
  // Export the configured browser so in-process puppeteer fallbacks resolve
  // the same Chrome as the HyperFrames child environment (Windows especially).
  if (typeof config.browserPath === "string" && config.browserPath)
    process.env.CHROME_PATH = config.browserPath;
  store = new Projects(config, { diagnostic });
  jobs = new Jobs(store, config);
  media = new MediaLibrary({ config: store.config, diagnostic });
  store.timelines = new Timelines(store, media);
  // Discards private preview copies left behind by a previous process before
  // serving the first request.
  await store.initialize();
  let buffered = Buffer.alloc(0),
    dropping = false;
  process.stdin.on("data", (chunk) => {
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i === chunk.length || chunk[i] === 10) {
        const part = chunk.subarray(start, i);
        if (!dropping) {
          if (buffered.length + part.length > MAX_LINE) {
            dropping = true;
            buffered = Buffer.alloc(0);
            send(null, {
              ok: false,
              error: {
                code: "E_LINE_LIMIT",
                message: "Input line exceeds limit",
                stage: "protocol",
              },
            });
          } else buffered = Buffer.concat([buffered, part]);
        }
        if (i < chunk.length) {
          if (!dropping && buffered.length) {
            const promise = accept(buffered.toString("utf8"));
            pending.add(promise);
            promise.finally(() => pending.delete(promise));
          }
          buffered = Buffer.alloc(0);
          dropping = false;
        }
        start = i + 1;
      }
    }
  });
  process.stdin.on("end", () => {
    void (async () => {
      closing = true;
      await Promise.all([...pending]);
      await shutdown();
      process.exit(0);
    })();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void shutdown().then(() => process.exit(0));
    });
  process.on("uncaughtException", () => {
    diagnostic("uncaught exception");
    void shutdown().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", () => {
    diagnostic("unhandled rejection");
    void shutdown().finally(() => process.exit(1));
  });
} catch (error) {
  // Surface the real cause on stderr; the Host keeps a stderr ring buffer, so
  // a swallowed exception must never be the only trace of a failed startup.
  diagnostic(`startup failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
