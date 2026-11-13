import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { base, client, fixture, managed } from "./helpers.mjs";
import { validateSceneSpec } from "../src/scenes.mjs";
import { validate } from "./schema-validator.mjs";
import { readFile } from "node:fs/promises";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const schema = JSON.parse(
  await readFile(resolve(base, "protocol.schema.json"), "utf8"),
);
const TEMPLATE_KEYS = ["title", "duration", "subtitle", "badge", "color", "accent", "logo", "shot"].sort();

async function managedWithAssets(label) {
  const f = await managed(label);
  await writeFile(resolve(f.assetInboxRoot, "shot.png"), PNG);
  return f;
}

async function projectWithScenes(c, label) {
  const created = await c.call("project.create", {
    templateId: "product-launch-v1",
    title: label,
    assets: [
      { inboxName: "logo.png", name: "logo.png" },
      { inboxName: "shot.png", name: "shot.png" },
    ],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  let revision = created.result.revision;
  const projectId = created.result.projectId;
  const second = await c.call("scene.create", {
    projectId,
    expectedRevision: revision,
    operationId: "template-second-scene",
    template: { sceneId: "scene-2", title: "第二幕", duration: 3 },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  revision = second.result.revision;
  return { projectId, revision, created, second };
}

function templateKeys(template) {
  return Object.keys(template).sort();
}

function normalizedTemplate(template) {
  // validateSceneSpec returns the normalized object with explicit undefined
  // sceneId/optional keys; JSON round-trip strips those, matching the wire
  // projection.
  return JSON.parse(JSON.stringify(validateSceneSpec(template)));
}

const inspect = async (c, projectId) => {
  const response = await c.call("inspect", { projectId });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};

const element = (inspected, stableId) =>
  inspected.elements.find((entry) => entry.stableId === stableId);

test("scene.template is complete, valid input and only includes existing optional fields", async () => {
  const f = await managedWithAssets("p3009-complete");
  try {
    const { projectId, revision, created, second } = await projectWithScenes(f.c, "模板完整");
    assert.ok(created.result.scenes[0].template, "project.create scenes carry template");
    assert.ok(second.result.scenes.every((scene) => scene.template), "scene.create scenes carry template");

    const updated = await f.c.call("scene.update", {
      projectId,
      expectedRevision: revision,
      operationId: "template-full-scene",
      sceneId: "scene-1",
      template: {
        title: "完整字段场景",
        duration: 4,
        subtitle: "完整副标题",
        badge: "FULL",
        color: "#123456",
        accent: "#abcdef",
        logo: "assets/logo.png",
        shot: "assets/shot.png",
      },
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const inspected = await inspect(f.c, projectId);
    const first = inspected.scenes.find((scene) => scene.sceneId === "scene-1");
    assert.deepEqual(templateKeys(first.template), TEMPLATE_KEYS);
    assert.deepEqual(first.template, {
      title: "完整字段场景",
      duration: 4,
      subtitle: "完整副标题",
      badge: "FULL",
      color: "#123456",
      accent: "#abcdef",
      logo: "assets/logo.png",
      shot: "assets/shot.png",
    });
    // The projection round-trips through the same validator as scene.update.
    assert.deepEqual(normalizedTemplate(first.template), first.template);
    // Old summary fields are untouched and no identity/path/timing fields leak.
    assert.equal(first.sceneId, "scene-1");
    assert.equal(first.order, 0);
    assert.equal(first.start, 0);
    assert.equal(first.duration, 4);
    assert.equal(first.title, "完整字段场景");
    for (const forbidden of ["sceneId", "order", "start", "elements"])
      assert.equal(forbidden in first.template, false, `template leaks ${forbidden}`);
    assert.equal(JSON.stringify(first.template).includes("/Users/"), false);

    // A scene created with only the required fields must not invent optional
    // objects/values (badge is a real empty element in the controlled template).
    const secondScene = inspected.scenes.find((scene) => scene.sceneId === "scene-2");
    assert.deepEqual(templateKeys(secondScene.template), ["badge", "color", "accent", "duration", "title"].sort());
    assert.equal("subtitle" in secondScene.template, false);
    assert.equal("logo" in secondScene.template, false);
    assert.equal("shot" in secondScene.template, false);
    assert.equal(secondScene.template.badge, "");
    // The projection is accepted as scene.update.template; only the intended
    // field is changed (an unchanged submission is a no-op the existing write
    // semantics reject, see the old E_INTERNAL guard, which we keep).
    const accepted = await f.c.call("scene.update", {
      projectId,
      expectedRevision: inspected.revision,
      operationId: "template-second-roundtrip",
      sceneId: "scene-2",
      template: { ...secondScene.template, color: "#334455" },
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const acceptedScene2 = accepted.result.scenes.find((scene) => scene.sceneId === "scene-2");
    assert.deepEqual(
      { ...acceptedScene2.template, color: secondScene.template.color },
      secondScene.template,
    );

    // scene.* result summaries all expose the same template projection.
    for (const scene of accepted.result.scenes) assert.ok(scene.template, "scene.update result template");
    const reordered = await f.c.call("scene.reorder", {
      projectId,
      expectedRevision: accepted.result.revision,
      operationId: "template-reorder",
      order: ["scene-2", "scene-1"],
    });
    assert.equal(reordered.ok, true, JSON.stringify(reordered));
    for (const scene of reordered.result.scenes) assert.ok(scene.template, "scene.reorder result template");
    const reopened = await f.c.call("close", { projectId });
    assert.equal(reopened.ok, true);
    const opened = await f.c.call("open", { projectId });
    assert.equal(opened.ok, true);
    assert.ok(opened.result.scenes.every((scene) => scene.template));
    for (const scene of opened.result.scenes)
      assert.deepEqual(normalizedTemplate(scene.template), scene.template);
  } finally {
    await f.cleanup();
  }

  // Legacy P2 composition keeps scenes=[] (no invented template).
  const legacy = await fixture();
  const legacyClient = client(legacy.registry);
  try {
    const opened = await legacyClient.call("open", { projectId: "demo" });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.deepEqual(opened.result.scenes, []);
  } finally {
    await legacyClient.stop();
    await legacy.cleanup();
  }
});

test("long human text remains round-trippable; an empty scene title is rejected", async () => {
  const f = await managedWithAssets("p3009-longtext");
  try {
    const { projectId, revision } = await projectWithScenes(f.c, "长文本模板");
    const longTitle = "长标题".repeat(100); // 300 chars, above the old template cap
    const longSubtitle = "副标题".repeat(200); // 600 chars, above the old cap
    const longBadge = "B".repeat(60); // above the old 48 cap
    let current = revision;
    const seed = await f.c.call("scene.update", {
      projectId,
      expectedRevision: current,
      operationId: "template-long-seed",
      sceneId: "scene-1",
      template: { title: "初始标题", duration: 5, subtitle: "初始副标题", badge: "INIT" },
    });
    assert.equal(seed.ok, true, JSON.stringify(seed));
    current = seed.result.revision;
    const edit = await f.c.call("edit", {
      projectId,
      expectedRevision: current,
      operationId: "template-long-text",
      ops: [
        { type: "text", target: "scene-1-title", text: longTitle },
        { type: "text", target: "scene-1-subtitle", text: longSubtitle },
        { type: "text", target: "scene-1-badge", text: longBadge },
      ],
    });
    assert.equal(edit.ok, true, JSON.stringify(edit));
    current = edit.result.revision;
    let inspected = await inspect(f.c, projectId);
    let template = inspected.scenes[0].template;
    assert.equal(template.title.length, longTitle.length);
    assert.equal(template.subtitle.length, longSubtitle.length);
    assert.equal(template.badge.length, longBadge.length);
    // The read template is valid scene.update input and schema-valid.
    assert.deepEqual(normalizedTemplate(template), template);
    assert.deepEqual(validate(inspected.scenes[0], schema.$defs.inspectScene, schema), []);
    const roundtrip = await f.c.call("scene.update", {
      projectId,
      expectedRevision: current,
      operationId: "template-long-roundtrip",
      sceneId: "scene-1",
      template: { ...template, color: "#445566" },
    });
    assert.equal(roundtrip.ok, true, JSON.stringify(roundtrip));
    assert.deepEqual(validate(roundtrip.result.scenes[0], schema.$defs.sceneSummary, schema), []);
    inspected = await inspect(f.c, projectId);
    template = inspected.scenes[0].template;
    assert.equal(template.title.length, longTitle.length);
    assert.equal(template.subtitle.length, longSubtitle.length);
    assert.equal(template.badge.length, longBadge.length);
    assert.equal(template.color, "#445566");

    // Empty/whitespace Scene titles can never be a valid template, so the text
    // edit is rejected instead of making the read projection unusable.
    const before = await inspect(f.c, projectId);
    for (const [index, text] of ["", "   "].entries()) {
      const rejected = await f.c.call("edit", {
        projectId,
        expectedRevision: before.revision,
        operationId: `template-empty-title-${index}`,
        ops: [{ type: "text", target: "scene-1-title", text }],
      });
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
      assert.equal(rejected.error.code, "E_PARAMS");
    }
    assert.equal((await inspect(f.c, projectId)).revision, before.revision);
  } finally {
    await f.cleanup();
  }
});

test("partial color/shot updates keep every other field and scene, human edits, layout and history", async () => {
  const f = await managedWithAssets("p3009-partial");
  try {
    const { projectId, revision } = await projectWithScenes(f.c, "局部更新");
    let current = revision;
    const full = await f.c.call("scene.update", {
      projectId,
      expectedRevision: current,
      operationId: "partial-full-scene",
      sceneId: "scene-1",
      template: {
        title: "局部更新标题",
        duration: 4,
        subtitle: "必须保留的副标题",
        badge: "KEEP",
        color: "#123456",
        accent: "#abcdef",
        logo: "assets/logo.png",
        shot: "assets/shot.png",
      },
    });
    assert.equal(full.ok, true, JSON.stringify(full));
    current = full.result.revision;

    // Human text + layout + style edits must be reflected by template and
    // preserved by a later partial scene.update.
    const humanEdit = await f.c.call("edit", {
      projectId,
      expectedRevision: current,
      operationId: "partial-human-edit",
      ops: [
        { type: "text", target: "scene-1-title", text: "人工改过的标题" },
        { type: "text", target: "scene-1-subtitle", text: "人工改过的副标题" },
        { type: "layout", target: "scene-1-logo", unit: "composition-px", box: { left: 900, top: 500 } },
        { type: "style", target: "scene-1-subtitle", styles: { color: "#00ff00" } },
      ],
    });
    assert.equal(humanEdit.ok, true, JSON.stringify(humanEdit));
    current = humanEdit.result.revision;
    let inspected = await inspect(f.c, projectId);
    const scene2Before = inspected.scenes.find((scene) => scene.sceneId === "scene-2").template;
    const beforeColor = inspected.scenes.find((scene) => scene.sceneId === "scene-1").template;
    assert.equal(beforeColor.title, "人工改过的标题");
    assert.equal(beforeColor.subtitle, "人工改过的副标题");
    const layoutBefore = element(inspected, "scene-1-logo").layout;
    const styleBefore = element(inspected, "scene-1-subtitle").style;

    // Only change color; everything else comes from the read projection.
    const recolor = await f.c.call("scene.update", {
      projectId,
      expectedRevision: current,
      operationId: "partial-recolor",
      sceneId: "scene-1",
      template: { ...beforeColor, color: "#ff0000" },
    });
    assert.equal(recolor.ok, true, JSON.stringify(recolor));
    current = recolor.result.revision;
    inspected = await inspect(f.c, projectId);
    const colored = inspected.scenes.find((scene) => scene.sceneId === "scene-1").template;
    assert.deepEqual({ ...colored, color: "#123456" }, beforeColor);
    assert.equal(colored.color, "#ff0000");
    assert.deepEqual(element(inspected, "scene-1-logo").layout, layoutBefore);
    assert.deepEqual(element(inspected, "scene-1-subtitle").style, styleBefore);
    assert.deepEqual(
      inspected.scenes.find((scene) => scene.sceneId === "scene-2").template,
      scene2Before,
    );

    // Snapshot HTML (not just inspect) carries the intended fields.
    const snapshot = await f.c.call("preview.snapshot", { projectId, revision: current });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    const html = await readFile(
      resolve(f.outputRoot, "previews", snapshot.result.snapshotId, "index.html"),
      "utf8",
    );
    assert.match(html, /#ff0000/);
    assert.match(html, /人工改过的副标题/);
    assert.match(html, /KEEP/);
    assert.match(html, /assets\/logo\.png/);
    assert.match(html, /assets\/shot\.png/);

    // Only change shot; all text/colors/logo/other scene stay intact.
    const reshot = await f.c.call("scene.update", {
      projectId,
      expectedRevision: current,
      operationId: "partial-reshot",
      sceneId: "scene-1",
      template: { ...colored, shot: "assets/logo.png" },
    });
    assert.equal(reshot.ok, true, JSON.stringify(reshot));
    current = reshot.result.revision;
    inspected = await inspect(f.c, projectId);
    const reshotTemplate = inspected.scenes.find((scene) => scene.sceneId === "scene-1").template;
    assert.equal(reshotTemplate.shot, "assets/logo.png");
    assert.deepEqual(
      { ...reshotTemplate, shot: "assets/shot.png" },
      colored,
    );
    assert.deepEqual(element(inspected, "scene-1-logo").layout, layoutBefore);
    assert.equal(element(inspected, "scene-1-title").text, "人工改过的标题");

    // close/reopen and a full worker restart keep the same projection.
    await f.c.call("close", { projectId });
    let opened = await f.c.call("open", { projectId });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    inspected = await inspect(f.c, projectId);
    assert.deepEqual(
      inspected.scenes.find((scene) => scene.sceneId === "scene-1").template,
      reshotTemplate,
    );
    await f.restart();
    opened = await f.c.call("open", { projectId });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    inspected = await inspect(f.c, projectId);
    assert.deepEqual(
      inspected.scenes.find((scene) => scene.sceneId === "scene-1").template,
      reshotTemplate,
    );

    // undo/redo through the partial writes keeps the read contract consistent.
    const undo = await f.c.call("undo", {
      projectId,
      expectedRevision: inspected.revision,
      operationId: "partial-undo",
    });
    assert.equal(undo.ok, true, JSON.stringify(undo));
    inspected = await inspect(f.c, projectId);
    const undone = inspected.scenes.find((scene) => scene.sceneId === "scene-1").template;
    assert.equal(undone.shot, "assets/shot.png");
    assert.equal(undone.color, "#ff0000");
    const redo = await f.c.call("redo", {
      projectId,
      expectedRevision: inspected.revision,
      operationId: "partial-redo",
    });
    assert.equal(redo.ok, true, JSON.stringify(redo));
    inspected = await inspect(f.c, projectId);
    assert.equal(
      inspected.scenes.find((scene) => scene.sceneId === "scene-1").template.shot,
      "assets/logo.png",
    );
  } finally {
    await f.cleanup();
  }
});

test("scene.template schema is required, closed and rejects malformed templates", async () => {
  const f = await managedWithAssets("p3009-schema");
  try {
    const { projectId, created, second } = await projectWithScenes(f.c, "模板 schema");
    const summary = second.result.scenes[0];
    assert.deepEqual(validate(summary, schema.$defs.sceneSummary, schema), []);
    const { template, ...withoutTemplate } = summary;
    assert.ok(validate(withoutTemplate, schema.$defs.sceneSummary, schema).length > 0);
    assert.ok(
      validate({ ...summary, template: { ...template, title: undefined } }, schema.$defs.sceneSummary, schema).length > 0,
    );
    assert.ok(
      validate({ ...summary, template: { ...template, sceneId: "scene-1" } }, schema.$defs.sceneSummary, schema).length > 0,
    );
    assert.ok(
      validate({ ...summary, template: { ...template, color: "red" } }, schema.$defs.sceneSummary, schema).length > 0,
    );
    assert.ok(
      validate({ ...summary, template: { ...template, logo: "/Users/me/logo.png" } }, schema.$defs.sceneSummary, schema).length > 0,
    );
    // inspectScene uses the same required template contract.
    const inspected = await inspect(f.c, projectId);
    for (const scene of inspected.scenes) {
      assert.deepEqual(validate(scene, schema.$defs.inspectScene, schema), []);
    }
    assert.ok(
      validate({ ...inspected.scenes[0], template: undefined }, schema.$defs.inspectScene, schema).length > 0,
    );
    // P3-012 adds project.compose/project.source; P3-016 adds project.rename;
    // the beat-alignment round adds timeline.beatmap/asset.align; all other
    // methods stay.
    assert.equal(Object.keys(schema.$defs).filter((name) => name.startsWith("request_")).length, 44);
  } finally {
    await f.cleanup();
  }
});
