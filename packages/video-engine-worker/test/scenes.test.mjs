import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  buildDocumentHtml,
  defaultScene,
  parseDocument,
  sceneSummaries,
  validateDocumentHtml,
} from "../src/scenes.mjs";
import { base } from "./helpers.mjs";
import { dependencyFile } from "../src/dependencies.mjs";

const fixtureScenes = (overrides = {}) =>
  [0, 1, 2, 3].map((index) => ({
    ...defaultScene(index),
    duration: [4, 4, 4, 3][index],
    title: `场景 ${index + 1}`,
    subtitle: `副标题 ${index + 1}`,
    badge: `SCENE 0${index + 1}`,
    ...(overrides[index] ?? {}),
  }));

test("generator builds a 15s four-scene document that parses back", () => {
  const html = buildDocumentHtml({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    scenes: fixtureScenes(),
  });
  validateDocumentHtml(html, {
    expectedScenes: ["scene-1", "scene-2", "scene-3", "scene-4"],
  });
  const parsed = parseDocument(html);
  assert.equal(parsed.duration, 15);
  assert.deepEqual(
    parsed.scenes.map((scene) => [scene.sceneId, scene.duration]),
    [
      ["scene-1", 4],
      ["scene-2", 4],
      ["scene-3", 4],
      ["scene-4", 3],
    ],
  );
  assert.deepEqual(
    sceneSummaries(parsed).map((scene) => [scene.sceneId, scene.order, scene.start]),
    [
      ["scene-1", 0, 0],
      ["scene-2", 1, 4],
      ["scene-3", 2, 8],
      ["scene-4", 3, 12],
    ],
  );
  // Timed children use global composition time, not scene-local time.
  assert.match(html, /data-hf-id="scene-2-title" data-start="4"/);
  assert.match(html, /data-hf-id="scene-2-subtitle" data-start="4.4"/);
  assert.equal((html.match(/data-scene-id=/g) ?? []).length, 4);
});

test("generator rejects invalid scene specs and duplicate ids", () => {
  const scenes = fixtureScenes();
  assert.throws(
    () =>
      buildDocumentHtml({
        width: 1280,
        height: 720,
        scenes: [...scenes, ...scenes.map((scene) => ({ ...scene }))],
      }),
    (error) => error.code === "E_PARAMS",
  );
  assert.throws(
    () =>
      buildDocumentHtml({
        width: 1280,
        height: 720,
        scenes: scenes.map((scene, index) =>
          index === 0 ? { ...scene, duration: 0.1 } : scene,
        ),
      }),
    (error) => error.code === "E_PARAMS",
  );
  assert.throws(
    () =>
      buildDocumentHtml({
        width: 1280,
        height: 720,
        scenes: scenes.map((scene, index) =>
          index === 1 ? { ...scene, sceneId: scenes[0].sceneId } : scene,
        ),
      }),
    (error) => error.code === "E_PARAMS",
  );
  assert.throws(
    () =>
      buildDocumentHtml({
        width: 1280,
        height: 720,
        scenes: scenes.map((scene, index) =>
          index === 0 ? { ...scene, logo: "../escape.png" } : scene,
        ),
      }),
    (error) => error.code === "E_PARAMS",
  );
});

test("generated document passes CLI lint without errors or StaticGuard warning", () => {
  const html = buildDocumentHtml({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    scenes: fixtureScenes(),
  });
  const dir = mkdtempSync(resolve(tmpdir(), "p3-lint-"));
  try {
    mkdirSync(resolve(dir, "assets"), { recursive: true });
    writeFileSync(resolve(dir, "index.html"), html);
    writeFileSync(
      resolve(dir, "project.json"),
      JSON.stringify({ entry: "index.html", assets: ["assets/gsap.min.js"] }),
    );
    copyFileSync(
      dependencyFile("gsap", "dist/gsap.min.js"),
      resolve(dir, "assets/gsap.min.js"),
    );
    let parsed;
    try {
      parsed = JSON.parse(
        execFileSync(
          process.execPath,
          [dependencyFile("hyperframes", "dist/cli.js"), "lint", dir, "--json"],
          { encoding: "utf8" },
        ),
      );
    } catch (error) {
      parsed = JSON.parse(error.stdout);
    }
    assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
    assert.ok(
      !parsed.findings.some(
        (finding) =>
          /StaticGuard/i.test(finding.message) ||
          /starts visible before its first GSAP opacity tween/.test(finding.message),
      ),
      JSON.stringify(parsed.findings),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parse rejects a document whose root duration does not match scenes", () => {
  const html = buildDocumentHtml({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    scenes: fixtureScenes(),
  }).replace('data-duration="15"', 'data-duration="14"');
  assert.throws(() => parseDocument(html), (error) => error.code === "E_TEMPLATE");
});
