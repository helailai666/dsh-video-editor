import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { base, client, waitJob } from "./helpers.mjs";
import { collectRefs, resolveRef, validate } from "./schema-validator.mjs";

const workerSource = resolve(base, "src/worker.mjs");
const workerReadme = resolve(base, "README.md");
const schemaPath = resolve(base, "protocol.schema.json");
const TEMPLATE = "product-launch-v1";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// A complete, self-contained free-form composition for the P3-012 methods.
const COMPOSITION_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>schema composition</title>
<style>html,body{margin:0;overflow:hidden;background:#0b1220}</style>
<script src="./assets/gsap.min.js"></script>
</head>
<body>
<div id="main" data-composition-id="main" data-width="1280" data-height="720" data-fps="30" data-start="0" data-duration="5">
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#0b1220"/>
<circle id="thing" cx="200" cy="360" r="80" fill="#4ade80"/>
</svg>
<script>
const tl = gsap.timeline({ paused: true });
tl.to("#thing", { x: 100, duration: 1 }, 0);
window.__timelines = { main: tl };
tl.seek(0);
</script>
</div>
</body>
</html>
`;

async function managed() {
  const dir = await mkdtemp(resolve(base, "artifacts/schema-"));
  const projectsRoot = resolve(dir, "projects");
  const outputRoot = resolve(dir, "output");
  const assetInboxRoot = resolve(dir, "inbox");
  const dataPath = resolve(dir, "registry-data.json");
  const configPath = resolve(dir, "registry.json");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await mkdir(assetInboxRoot, { recursive: true });
  await writeFile(dataPath, JSON.stringify({ projects: {} }));
  await writeFile(resolve(assetInboxRoot, "logo.png"), PNG);
  await writeFile(
    configPath,
    JSON.stringify({ projectsRoot, registryPath: dataPath, outputRoot, assetInboxRoot }),
  );
  const c = client(configPath);
  return {
    dir,
    c,
    async cleanup() {
      await c.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function requestFrame(method, params, id) {
  return { v: 1, id, method, params };
}

function resultSchema(schema, method) {
  const pointer = schema["x-methods"][method].result;
  return resolveRef(schema, pointer);
}

function paramsDefinition(schema, method) {
  const request = resolveRef(schema, schema["x-methods"][method].request);
  return { request, params: resolveRef(schema, request.properties.params.$ref) };
}

test("protocol schema covers every worker method, resolves all refs and matches the README table", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const source = await readFile(workerSource, "utf8");
  const readme = await readFile(workerReadme, "utf8");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "urn:dsh-video-engine-worker:v1");
  assert.deepEqual(Object.keys(schema).sort(), [
    "$comment",
    "$defs",
    "$id",
    "$schema",
    "oneOf",
    "title",
    "x-methods",
  ]);
  const methods = Object.keys(schema["x-methods"]).sort();
  const dispatched = [
    ...new Set([...source.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(methods, dispatched, "schema methods must equal worker switch cases");
  assert.equal(new Set(methods).size, methods.length);
  // Every documented result/request pointer resolves and its method is pinned.
  for (const method of methods) {
    const { request: requestDefinition, params } = paramsDefinition(schema, method);
    assert.equal(requestDefinition.properties.method.const, method);
    assert.equal(requestDefinition.properties.params.$ref, `#/$defs/params_${method.replaceAll(".", "_")}`);
    assert.equal(requestDefinition.additionalProperties, false);
    assert.deepEqual(requestDefinition.required, ["v", "id", "method", "params"]);
    assert.ok(paramsDefinition(schema, method).params);
    const result = resultSchema(schema, method);
    assert.equal(typeof result, "object");
    assert.ok(result !== null);
    // README method table / list must name every schema method in backticks.
    assert.ok(readme.includes("`" + method + "`"), `README is missing \`${method}\``);
  }
  // Every local $ref in the file must resolve (catches renamed/missing defs).
  for (const ref of collectRefs(schema)) assert.doesNotThrow(() => resolveRef(schema, ref), ref);
  // The response envelope stays strict: no unknown envelope fields.
  assert.ok(
    validate({ v: 1, id: "a", ok: true, result: {}, extra: true }, schema).length > 0,
  );
  assert.ok(validate({ v: 2, id: "a", ok: true, result: {} }, schema).length > 0);
});

test("schema params and worker validation agree for every method; results validate against the schema", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const f = await managed();
  const c = f.c;
  let requestId = 0;
  const state = { projectId: undefined, revision: undefined, snapshotId: undefined };
  const validated = new Set();
  const reject = (response) => {
    assert.equal(response.ok, false, JSON.stringify(response));
    return response.error.code;
  };
  const validateRequest = (method, params) => {
    requestId += 1;
    const frame = requestFrame(method, params, `schema-r${requestId}`);
    const errors = validate(frame, schema);
    return { frame, errors };
  };
  const validateResponse = (method, response) => {
    if (response.ok)
      assert.deepEqual(
        validate(response.result, resultSchema(schema, method), schema),
        [],
        `${method} result does not match schema: ${JSON.stringify(response.result)}`,
      );
    assert.deepEqual(validate(response, schema), [], `${method} response envelope`);
    validated.add(method);
  };
  const sendValid = async (method, params) => {
    const { errors } = validateRequest(method, params);
    assert.deepEqual(errors, [], `${method} sample must be schema-valid`);
    const response = await c.call(method, params);
    validateResponse(method, response);
    return response;
  };
  const expectParamsRejected = async (method, params, label) => {
    const { errors } = validateRequest(method, params);
    assert.ok(errors.length > 0, `${method} ${label} must be schema-invalid`);
    const response = await c.call(method, params);
    assert.equal(response.ok, false, `${method} ${label}: ${JSON.stringify(response)}`);
    assert.equal(
      response.error.code,
      "E_PARAMS",
      `${method} ${label} should be E_PARAMS, got ${JSON.stringify(response)}`,
    );
    validateResponse(method, response);
  };
  try {
    // Build live context with real requests; each valid call is schema-checked
    // in both directions.
    await sendValid("doctor", {});
    const created = await sendValid("project.create", {
      templateId: TEMPLATE,
      title: "schema contract",
      assets: [{ inboxName: "logo.png", name: "logo.png" }],
    });
    state.projectId = created.result.projectId;
    state.revision = created.result.revision;
    await sendValid("open", { projectId: state.projectId });
    await sendValid("inspect", { projectId: state.projectId });

    // P3-016 UI-only rename: trimmed title, same content revision, idempotent.
    const renamed = await sendValid("project.rename", {
      projectId: state.projectId,
      title: "  schema rename  ",
    });
    assert.equal(renamed.result.title, "schema rename");
    assert.equal(renamed.result.changed, true);
    assert.equal(renamed.result.revision, state.revision);
    const renamedAgain = await sendValid("project.rename", {
      projectId: state.projectId,
      title: "schema rename",
    });
    assert.equal(renamedAgain.result.changed, false);
    assert.equal(renamedAgain.result.revision, state.revision);
    const titledInspect = await sendValid("inspect", { projectId: state.projectId });
    assert.equal(titledInspect.result.title, "schema rename");

    const imported = await sendValid("asset.import", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-asset",
      sourceName: "logo.png",
      name: "schema-logo.png",
    });
    state.revision = imported.result.revision;

    const media = await sendValid("asset.importMedia", {projectId:state.projectId,sourceName:"logo.png",operationId:"schema-media"});
    assert.equal(media.ok,true,JSON.stringify(media));
    await sendValid("asset.list", {projectId:state.projectId});
    await sendValid("asset.derive", {projectId:state.projectId,assetId:media.result.asset.assetId,kind:"thumb"});
    await sendValid("asset.remove", {projectId:state.projectId,assetId:media.result.asset.assetId,operationId:"schema-remove"});
    const edited = await sendValid("edit", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-edit",
      ops: [{ type: "text", target: "scene-1-title", text: "schema edit" }],
    });
    state.revision = edited.result.revision;

    const sceneCreated = await sendValid("scene.create", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-scene-create",
      template: { title: "第二幕", duration: 4 },
    });
    state.revision = sceneCreated.result.revision;
    const sceneId = sceneCreated.result.scenes.at(-1).sceneId;

    const sceneUpdated = await sendValid("scene.update", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-scene-update",
      sceneId,
      template: { title: "第二幕（改）", duration: 4 },
    });
    state.revision = sceneUpdated.result.revision;

    const reordered = await sendValid("scene.reorder", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-scene-reorder",
      order: ["scene-2", "scene-1"],
    });
    state.revision = reordered.result.revision;

    const revised = await sendValid("project.revise", {
      projectId: state.projectId,
      baseRevision: state.revision,
      expectedRevision: state.revision,
      operationId: "schema-revise",
      sceneId: "scene-1",
      template: { title: "AI 场景一", duration: 5 },
    });
    state.revision = revised.result.revision;

    await sendValid("history", { projectId: state.projectId });
    const undone = await sendValid("undo", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-undo",
    });
    state.revision = undone.result.revision;
    const redone = await sendValid("redo", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-redo",
    });
    state.revision = redone.result.revision;

    // Explicit merge conflict (successful result, written:false) is part of
    // the result schema too: both sides edited the same stableId.
    const conflictBase = state.revision;
    const humanEdit = await sendValid("edit", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-human-conflict",
      ops: [{ type: "text", target: "scene-1-title", text: "schema human" }],
    });
    state.revision = humanEdit.result.revision;
    const conflict = await sendValid("project.revise", {
      projectId: state.projectId,
      baseRevision: conflictBase,
      expectedRevision: state.revision,
      operationId: "schema-conflict",
      sceneId: "scene-1",
      template: { title: "schema AI", duration: 5 },
    });
    assert.equal(conflict.result.written, false, JSON.stringify(conflict.result));
    assert.equal(conflict.result.conflicts[0].reason, "BOTH_MODIFIED");
    assert.equal(conflict.result.changeSummary, null);
    assert.equal(
      (await inspectCurrentRevision(c, state.projectId)),
      state.revision,
      "conflict must not write",
    );

    const snapshot = await sendValid("preview.snapshot", {
      projectId: state.projectId,
      revision: state.revision,
    });
    state.snapshotId = snapshot.result.snapshotId;
    await sendValid("preview.release", { snapshotId: state.snapshotId });

    // Job methods: a failing frame (time beyond duration) and a stale render
    // fail during the worker's snapshot phase, so the schema also covers the
    // real queued/failed job shapes without launching Chrome/FFmpeg.
    const frame = await sendValid("frame", {
      projectId: state.projectId,
      revision: state.revision,
      time: 10,
    });
    const failedFrame = await waitJob(c, frame.result.jobId);
    assert.equal(failedFrame.state, "failed");
    validateResponse("status", await c.call("status", { jobId: frame.result.jobId }));
    validateResponse("cancel", await c.call("cancel", { jobId: frame.result.jobId }));

    const render = await sendValid("render", {
      projectId: state.projectId,
      revision: "0".repeat(64),
    });
    const failedRender = await waitJob(c, render.result.jobId);
    assert.equal(failedRender.state, "failed");
    validateResponse("status", await c.call("status", { jobId: render.result.jobId }));
    validateResponse("cancel", await c.call("cancel", { jobId: render.result.jobId }));

    // Unknown job ids prove status/cancel params are valid without jobs.
    validateResponse(
      "status",
      await c.call("status", { jobId: "unknown-job-id" }),
    );
    validateResponse(
      "cancel",
      await c.call("cancel", { jobId: "unknown-job-id" }),
    );

    // Every schema method gets both malformed probes: missing required field
    // and one unknown field. The schema and the worker must reject both.
    for (const method of Object.keys(schema["x-methods"])) {
      const { params } = paramsDefinition(schema, method);
      const sample = buildSample(method, state);
      const valid = validate(requestFrame(method, sample, `schema-valid-${method}`), schema);
      assert.deepEqual(valid, [], `${method} valid sample rejected by schema`);
      if (Array.isArray(params.required) && params.required.length) {
        const partial = { ...sample };
        delete partial[params.required[0]];
        await expectParamsRejected(method, partial, "missing required params");
      }
      await expectParamsRejected(method, { ...sample, __extra: true }, "extra params");
    }

    // Nested scene templates follow the same split: only scene.create owns the
    // Scene identity, so scene.update/revise must reject a nested sceneId (and
    // the schema marks it as an unknown property there).
    await expectParamsRejected(
      "scene.update",
      {
        projectId: state.projectId,
        expectedRevision: state.revision,
        operationId: "schema-nested-sceneid",
        sceneId: "scene-1",
        template: { title: "nested", duration: 3, sceneId: "scene-1" },
      },
      "template sceneId",
    );
    await expectParamsRejected(
      "project.revise",
      {
        projectId: state.projectId,
        baseRevision: state.revision,
        expectedRevision: state.revision,
        operationId: "schema-nested-sceneid",
        sceneId: "scene-1",
        template: { title: "nested", duration: 5, sceneId: "scene-1" },
      },
      "template sceneId",
    );

    // Parameter-level path/name safety is encoded in the schema too, while the
    // worker still performs the disk-dependent checks itself.
    await expectParamsRejected(
      "asset.import",
      {
        projectId: state.projectId,
        expectedRevision: state.revision,
        operationId: "schema-unsafe-source",
        sourceName: "../logo.png",
      },
      "unsafe sourceName",
    );
    await expectParamsRejected(
      "asset.import",
      {
        projectId: state.projectId,
        expectedRevision: state.revision,
        operationId: "schema-bad-name",
        sourceName: "logo.png",
        name: "logo.txt",
      },
      "non-image asset name",
    );
    await expectParamsRejected(
      "project.create",
      {
        templateId: TEMPLATE,
        assets: [{ inboxName: "../logo.png" }],
      },
      "unsafe inboxName",
    );

    // P3-012: project.source reads the current document; project.compose
    // publishes a complete validated composition; resubmitting identical bytes
    // is an explicit unchanged success. Both result shapes are schema-checked.
    const sourceBefore = await sendValid("project.source", {
      projectId: state.projectId,
    });
    assert.equal(sourceBefore.result.entry, "index.html");
    assert.equal(sourceBefore.result.revision, state.revision);
    assert.equal(
      sourceBefore.result.bytes,
      Buffer.byteLength(sourceBefore.result.html, "utf8"),
    );
    const composed = await sendValid("project.compose", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-compose",
      html: COMPOSITION_HTML,
    });
    assert.equal(composed.result.publishedRevision, composed.result.revision);
    assert.notEqual(composed.result.revision, state.revision);
    assert.equal(composed.result.written, true);
    assert.equal(composed.result.unchanged, false);
    assert.deepEqual(composed.result.scenes, []);
    assert.equal(composed.result.bytes, Buffer.byteLength(COMPOSITION_HTML, "utf8"));
    assert.deepEqual(composed.result.preview, {
      mode: "snapshot",
      status: "ready",
      checked: "composition+snapshot",
      revision: composed.result.revision,
    });
    // R1 settlement shape: a normal publish records history with a cursor.
    assert.equal(composed.result.history.status, "recorded");
    assert.ok(Number.isInteger(composed.result.history.historyCursor));
    state.revision = composed.result.revision;
    const sourceAfter = await sendValid("project.source", {
      projectId: state.projectId,
    });
    assert.equal(sourceAfter.result.html, COMPOSITION_HTML);
    assert.equal(sourceAfter.result.revision, state.revision);
    const unchanged = await sendValid("project.compose", {
      projectId: state.projectId,
      expectedRevision: state.revision,
      operationId: "schema-compose-unchanged",
      html: COMPOSITION_HTML,
    });
    assert.equal(unchanged.result.unchanged, true);
    assert.equal(unchanged.result.written, false);
    assert.equal(unchanged.result.revision, state.revision);
    assert.equal(unchanged.result.publishedRevision, state.revision);
    // R1 settlement shape: the unchanged path never writes history.
    assert.deepEqual(unchanged.result.history, { status: "unchanged" });

    await sendValid("close", { projectId: state.projectId });
    for (const method of Object.keys(schema["x-methods"]))
      assert.ok(validated.has(method), `no schema-validated response for ${method}`);
  } finally {
    await f.cleanup();
  }
});

async function inspectCurrentRevision(c, projectId) {
  const response = await c.call("inspect", { projectId });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result.revision;
}

function buildSample(method, state) {
  const projectId = state.projectId;
  switch (method) {
    case "timeline.inspect":return {projectId};
    case "timeline.apply":return {projectId,expectedRevision:state.revision,operationId:'schema-timeline',ops:[{op:'timeline.settings',background:'#000000'}]};
    case "timeline.resolve":return {projectId,refs:[{kind:'index',index:1}]};
    case "timeline.undo":case "timeline.redo":return {projectId,expectedRevision:state.revision,operationId:'schema-step'};
    case "scene.compose":return {projectId,expectedRevision:state.revision,operationId:'schema-compose',html:COMPOSITION_HTML};
    case "scene.inspect":return {projectId,clipId:'cl_00000000'};
    case "doctor":
    case "shutdown":
      return {};
    case "open":
    case "inspect":
      return { projectId };
    case "edit":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-edit",
        ops: [{ type: "text", target: "scene-1-title", text: "probe" }],
      };
    case "frame":
      return { projectId, revision: state.revision, time: 1 };
    case "render":
      return { projectId, revision: state.revision };
    case "status":
    case "cancel":
      return { jobId: "11111111-1111-1111-1111-111111111111" };
    case "close":
      return { projectId };
    case "project.create":
      return { templateId: TEMPLATE, title: "probe", assets: [{ inboxName: "logo.png" }] };
    case "project.rename":
      return { projectId, title: "probe title" };
    case "project.compose":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-compose",
        html: COMPOSITION_HTML,
      };
    case "project.source":
      return { projectId };
    case "timeline.visuals.request":return {projectId,expectedRevision:state.revision,clipId:"cl_probe",startFrame:0,endFrame:30,count:2};
    case "timeline.visuals.status":
    case "timeline.visuals.cancel":return {projectId,taskId:"a".repeat(24)};
    case "timeline.references":return {projectId,query:"",limit:50};
    case "asset.importMedia": return {projectId,sourceName:"logo.png",operationId:"probe-media"};
    case "asset.list": return {projectId};
    case "asset.derive": return {projectId,assetId:"as_00000000",kind:"thumb"};
    case "asset.envelope": return {projectId,assetId:"as_00000000"};
    case "asset.remove": return {projectId,assetId:"as_00000000",operationId:"probe-remove"};
    case "asset.import":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-asset",
        sourceName: "logo.png",
      };
    case "scene.create":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-scene-create",
        template: { title: "probe", duration: 3 },
      };
    case "scene.update":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-scene-update",
        sceneId: "scene-1",
        template: { title: "probe", duration: 3 },
      };
    case "scene.remove":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-scene-remove",
        sceneId: "scene-1",
      };
    case "scene.reorder":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-scene-reorder",
        order: ["scene-2", "scene-1"],
      };
    case "project.revise":
      return {
        projectId,
        baseRevision: state.revision,
        expectedRevision: state.revision,
        operationId: "probe-revise",
        sceneId: "scene-1",
        template: { title: "probe", duration: 5 },
      };
    case "history":
      return { projectId, limit: 10 };
    case "undo":
    case "redo":
      return {
        projectId,
        expectedRevision: state.revision,
        operationId: "probe-history-step",
      };
    case "preview.snapshot":
      return { projectId, revision: state.revision, ttlMs: 60000 };
    case "preview.files":return {snapshotId:"a".repeat(32),offset:0};
    case "preview.release":
      return { snapshotId: "a".repeat(32) };
    default:
      throw new Error(`No sample for ${method}`);
  }
}
