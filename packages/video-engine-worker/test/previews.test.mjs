import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { client, managed } from "./helpers.mjs";
import {
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_FILES,
  Previews,
} from "../src/previews.mjs";

const TEMPLATE = "product-launch-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesUnder(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(prefix ? resolve(root, prefix) : root, {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else files.push(path);
  }
  return files.sort();
}

async function created(c, extra = {}) {
  const response = await c.call("project.create", {
    templateId: TEMPLATE,
    title: "预览快照样例",
    assets: [{ inboxName: "logo.png", name: "logo.png" }],
    ...extra,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}

async function inspect(c, projectId) {
  const response = await c.call("inspect", { projectId });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}

function assertRelativeManifest(files) {
  assert.ok(files.length >= 2);
  const paths = new Set();
  for (const file of files) {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
    assert.equal(typeof file.path, "string");
    assert.ok(!isAbsolute(file.path), file.path);
    assert.ok(!file.path.includes("\\"), file.path);
    assert.ok(!file.path.includes(":"), file.path);
    assert.ok(!file.path.split("/").includes(".."), file.path);
    assert.ok(!file.path.split("/").includes("."), file.path);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(file.bytes) && file.bytes >= 0);
    paths.add(file.path);
  }
  return paths;
}

async function previewDirs(f) {
  try {
    return (await readdir(resolve(f.outputRoot, "previews"))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("preview.snapshot publishes a faithful private copy with relative paths only", async () => {
  const f = await managed("previews-basic");
  try {
    const project = await created(f.c);
    const projectDir = resolve(f.projectsRoot, project.projectId);
    const before = await inspect(f.c, project.projectId);
    const projectFilesBefore = await filesUnder(projectDir);

    const response = await f.c.call("preview.snapshot", {
      projectId: project.projectId,
      revision: project.revision,
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    const snapshot = response.result;
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "entry",
      "expiresAt",
      "files",
      "maxBytes",
      "projectId",
      "revision",
      "snapshotId",
    ]);
    assert.match(snapshot.snapshotId, /^[a-f0-9]{32}$/);
    assert.equal(snapshot.projectId, project.projectId);
    assert.equal(snapshot.revision, project.revision);
    assert.equal(snapshot.entry, "index.html");
    assert.equal(snapshot.maxBytes, MAX_PREVIEW_BYTES);
    const expires = Date.parse(snapshot.expiresAt);
    assert.ok(Number.isFinite(expires));
    assert.ok(Math.abs(expires - Date.now() - 10 * 60 * 1000) < 60 * 1000);
    // The manifest is exactly the read() manifest: same paths/bytes/hashes.
    assert.deepEqual(snapshot.files, before.files);
    assert.deepEqual(assertRelativeManifest(snapshot.files), new Set(before.files.map((file) => file.path)));
    assert.ok(snapshot.files.length <= MAX_PREVIEW_FILES);

    // Private copy on disk under outputRoot/previews/<snapshotId>/ only, in a
    // tree restricted to the worker user.
    const previewsRoot = resolve(f.outputRoot, "previews");
    const snapshotDir = resolve(previewsRoot, snapshot.snapshotId);
    // NTFS has no POSIX permission bits; the 0700 restriction is enforced and
    // proven on macOS/Linux only.
    if (process.platform !== "win32") {
      assert.equal((await stat(previewsRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(snapshotDir)).mode & 0o777, 0o700);
    }
    assert.deepEqual(await filesUnder(snapshotDir), before.files.map((file) => file.path).sort());
    for (const file of before.files) {
      const copied = await readFile(resolve(snapshotDir, file.path));
      assert.equal(copied.length, file.bytes);
      assert.equal(sha256(copied), file.sha256);
    }
    // Project content and revision are untouched; snapshot is not in the project.
    const after = await inspect(f.c, project.projectId);
    assert.equal(after.revision, project.revision);
    assert.deepEqual(await filesUnder(projectDir), projectFilesBefore);
    assert.ok(!snapshotDir.startsWith(projectDir + "/"));

    // Same revision may produce another independent snapshot with the same
    // manifest; releasing one must not invalidate the other.
    const second = await f.c.call("preview.snapshot", {
      projectId: project.projectId,
      revision: project.revision,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(second.result.snapshotId, snapshot.snapshotId);
    assert.deepEqual(second.result.files, snapshot.files);
    const released = await f.c.call("preview.release", { snapshotId: snapshot.snapshotId });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.deepEqual(
      { ...released.result },
      {
        snapshotId: snapshot.snapshotId,
        projectId: project.projectId,
        revision: project.revision,
        released: true,
      },
    );
    assert.equal((await previewDirs(f)).includes(snapshot.snapshotId), false);
    assert.equal((await previewDirs(f)).includes(second.result.snapshotId), true);
    const stillReadable = await readFile(
      resolve(f.outputRoot, "previews", second.result.snapshotId, before.files[0].path),
    );
    assert.equal(sha256(stillReadable), before.files[0].sha256);
  } finally {
    await f.cleanup();
  }
});

test("preview revisions are exact: stale requests fail and old snapshots stay immutable", async () => {
  const f = await managed("previews-revision");
  try {
    const project = await created(f.c);
    const projectId = project.projectId;
    const snapshot = await f.c.call("preview.snapshot", {
      projectId,
      revision: project.revision,
    });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    const snapshotId = snapshot.result.snapshotId;
    const snapshotDir = resolve(f.outputRoot, "previews", snapshotId);
    const indexBefore = await readFile(resolve(snapshotDir, "index.html"));

    const scene = await f.c.call("scene.create", {
      projectId,
      expectedRevision: project.revision,
      operationId: "preview-scene",
      template: { title: "第二幕", duration: 4 },
    });
    assert.equal(scene.ok, true, JSON.stringify(scene));
    const current = await inspect(f.c, projectId);
    assert.notEqual(current.revision, project.revision);

    const stale = await f.c.call("preview.snapshot", {
      projectId,
      revision: project.revision,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "E_REVISION_CONFLICT");
    const unknownRevision = await f.c.call("preview.snapshot", {
      projectId,
      revision: "f".repeat(64),
    });
    assert.equal(unknownRevision.error.code, "E_REVISION_CONFLICT");

    // Old snapshot is byte-identical and still reports its original revision.
    assert.deepEqual(await readFile(resolve(snapshotDir, "index.html")), indexBefore);
    const newer = await f.c.call("preview.snapshot", {
      projectId,
      revision: current.revision,
    });
    assert.equal(newer.ok, true, JSON.stringify(newer));
    assert.equal(newer.result.revision, current.revision);
    assert.notEqual(newer.result.snapshotId, snapshotId);
    assert.notDeepEqual(
      newer.result.files.find((file) => file.path === "index.html").sha256,
      snapshot.result.files.find((file) => file.path === "index.html").sha256,
    );
    // Both snapshots coexist; release of the old one does not touch the newer.
    assert.equal((await f.c.call("preview.release", { snapshotId })).ok, true);
    assert.equal(
      (await readFile(resolve(f.outputRoot, "previews", newer.result.snapshotId, "index.html"))).length > 0,
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("preview.release is idempotent in effect, rejects unknown expirations and enforces TTL bounds", async () => {
  const f = await managed("previews-ttl");
  try {
    const project = await created(f.c);
    const projectId = project.projectId;
    const make = (ttlMs) =>
      f.c.call("preview.snapshot", {
        projectId,
        revision: project.revision,
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });

    const unknown = await f.c.call("preview.release", { snapshotId: "b".repeat(32) });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "E_SNAPSHOT_NOT_FOUND");
    const malformed = await f.c.call("preview.release", { snapshotId: "not-a-snapshot" });
    assert.equal(malformed.error.code, "E_PARAMS");
    const missing = await f.c.call("preview.release", {});
    assert.equal(missing.error.code, "E_PARAMS");
    const extra = await f.c.call("preview.release", { snapshotId: "b".repeat(32), __extra: true });
    assert.equal(extra.error.code, "E_PARAMS");

    for (const ttlMs of [99, 1800001, 1000.5]) {
      const invalid = await make(ttlMs);
      assert.equal(invalid.ok, false, JSON.stringify(invalid));
      assert.equal(invalid.error.code, "E_PARAMS");
    }
    const min = await make(100);
    assert.equal(min.ok, true, JSON.stringify(min));
    const max = await make(30 * 60 * 1000);
    assert.equal(max.ok, true, JSON.stringify(max));
    assert.ok(Math.abs(Date.parse(max.result.expiresAt) - Date.now() - 1800000) < 60000);

    const released = await f.c.call("preview.release", { snapshotId: min.result.snapshotId });
    assert.equal(released.result.released, true);
    assert.equal((await previewDirs(f)).includes(min.result.snapshotId), false);
    // Releasing the same snapshot again is a safe no-op that reports the
    // now-unknown id instead of deleting or failing silently.
    const again = await f.c.call("preview.release", { snapshotId: min.result.snapshotId });
    assert.equal(again.error.code, "E_SNAPSHOT_NOT_FOUND");
    assert.notEqual((await previewDirs(f)).includes(max.result.snapshotId), false);

    // TTL expiry removes the directory and the snapshot id.
    const short = await make(120);
    assert.equal(short.ok, true, JSON.stringify(short));
    assert.equal((await previewDirs(f)).includes(short.result.snapshotId), true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal((await previewDirs(f)).includes(short.result.snapshotId), false);
    const expired = await f.c.call("preview.release", { snapshotId: short.result.snapshotId });
    assert.equal(expired.error.code, "E_SNAPSHOT_NOT_FOUND");
  } finally {
    await f.cleanup();
  }
});

test("preview snapshots require an open project and are cleaned on close", async () => {
  const f = await managed("previews-close");
  try {
    const first = await created(f.c);
    const second = await created(f.c);
    assert.equal((await f.c.call("preview.snapshot", {
      projectId: first.projectId,
      revision: first.revision,
    })).ok, true);
    assert.equal((await f.c.call("preview.snapshot", {
      projectId: second.projectId,
      revision: second.revision,
    })).ok, true);
    const firstDirs = (await previewDirs(f)).length;
    assert.equal(firstDirs, 2);

    const closed = await f.c.call("close", { projectId: first.projectId });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const remaining = await previewDirs(f);
    assert.equal(remaining.length, 1, "close must only clean that project's snapshots");
    const closedSnapshot = await f.c.call("preview.snapshot", {
      projectId: first.projectId,
      revision: first.revision,
    });
    assert.equal(closedSnapshot.error.code, "E_PROJECT_NOT_OPEN");
    const unknown = await f.c.call("preview.snapshot", {
      projectId: "proj-does-not-exist",
      revision: first.revision,
    });
    assert.equal(unknown.error.code, "E_PROJECT_NOT_OPEN");

    const reopened = await f.c.call("open", { projectId: first.projectId });
    assert.equal(reopened.ok, true);
    const fresh = await f.c.call("preview.snapshot", {
      projectId: first.projectId,
      revision: reopened.result.revision,
    });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal((await previewDirs(f)).length, 2);
    await f.c.call("close", { projectId: second.projectId });
    assert.equal((await previewDirs(f)).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("preview snapshots are cleaned by shutdown and a fresh worker discards leftovers", async () => {
  const f = await managed("previews-restart");
  try {
    const project = await created(f.c);
    const snapshot = await f.c.call("preview.snapshot", {
      projectId: project.projectId,
      revision: project.revision,
    });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal((await previewDirs(f)).length, 1);
    await f.c.call("shutdown", {});
    await f.c.exited;
    assert.deepEqual(await previewDirs(f), [], "shutdown must clean preview snapshots");

    // Simulate a crashed process: a leftover private directory. A fresh worker
    // must discard the whole preview root during startup.
    const leftover = resolve(f.outputRoot, "previews", "deadbeef".repeat(4));
    await mkdir(leftover, { recursive: true });
    await writeFile(resolve(leftover, "secret.txt"), "stale private copy");
    f.c = client(f.configPath);
    const doctor = await f.c.call("doctor", {});
    assert.equal(doctor.ok, true);
    assert.deepEqual(await previewDirs(f), []);
    const oldRelease = await f.c.call("preview.release", {
      snapshotId: snapshot.result.snapshotId,
    });
    assert.equal(oldRelease.error.code, "E_SNAPSHOT_NOT_FOUND");
    // A restart also means the project is not open until explicitly opened.
    const beforeOpen = await f.c.call("preview.snapshot", {
      projectId: project.projectId,
      revision: project.revision,
    });
    assert.equal(beforeOpen.error.code, "E_PROJECT_NOT_OPEN");
    const opened = await f.c.call("open", { projectId: project.projectId });
    assert.equal(opened.ok, true);
    const again = await f.c.call("preview.snapshot", {
      projectId: project.projectId,
      revision: opened.result.revision,
    });
    assert.equal(again.ok, true, JSON.stringify(again));
  } finally {
    await f.cleanup();
  }
});

test(
  "preview copies re-check declared paths, sizes and cleanup failures",
  { skip: process.platform === "win32" && "escape probe needs POSIX symlinks" },
  async () => {
  const f = await managed("previews-safety");
  try {
    const project = await created(f.c);
    const projectId = project.projectId;
    const { rm: remove } = await import("node:fs/promises");
    const assetPath = resolve(f.projectsRoot, projectId, "assets/logo.png");
    await remove(assetPath);
    await symlink("/etc/passwd", assetPath);
    const escaped = await f.c.call("preview.snapshot", {
      projectId,
      revision: project.revision,
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.error.code, "E_PATH");
    assert.deepEqual(await previewDirs(f), []);
    await remove(assetPath);
    await writeFile(assetPath, Buffer.alloc(65 * 1024 * 1024));
    const limited = await f.c.call("preview.snapshot", {
      projectId,
      revision: project.revision,
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.error.code, "E_LIMIT");
    assert.deepEqual(await previewDirs(f), []);

    // Cleanup failure is reported and retriable; the snapshot stays tracked.
    await remove(assetPath);
    await writeFile(assetPath, Buffer.from("logo-bytes"));
    const revision = (await inspect(f.c, projectId)).revision;
    const snapshot = await f.c.call("preview.snapshot", { projectId, revision });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    const previewsRoot = resolve(f.outputRoot, "previews");
    await chmod(previewsRoot, 0o555);
    try {
      const denied = await f.c.call("preview.release", {
        snapshotId: snapshot.result.snapshotId,
      });
      assert.equal(denied.ok, false, JSON.stringify(denied));
      assert.equal(denied.error.code, "E_PERSIST");
    } finally {
      await chmod(previewsRoot, 0o755);
    }
    const retried = await f.c.call("preview.release", {
      snapshotId: snapshot.result.snapshotId,
    });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.deepEqual(await previewDirs(f), []);
  } finally {
    await f.cleanup();
  }
});

test("preview byte/file ceilings are enforced before any private copy is written", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "preview-limit-"));
  const outputRoot = resolve(dir, "output");
  await mkdir(outputRoot, { recursive: true });
  const previews = new Previews({ outputRoot }, () => {});
  try {
    await previews.initialize();
    const entry = { path: "index.html", bytes: 5, sha256: "0".repeat(64) };
    const tooMany = Array.from({ length: MAX_PREVIEW_FILES + 1 }, (_, index) => ({
      path: `assets/f${index}.js`,
      bytes: 1,
      sha256: "0".repeat(64),
    }));
    const files = new Map([...tooMany, entry].map((file) => [file.path, Buffer.from("x")]));
    const tooManyEntries = [...tooMany, entry];
    await assert.rejects(
      previews.create({
        projectId: "p",
        revision: "a".repeat(64),
        entry: "index.html",
        files,
        entries: tooManyEntries,
        ttlMs: 1000,
      }),
      (error) => error.code === "E_LIMIT",
    );
    const bytes = 128 * 1024 * 1024 + 1;
    await assert.rejects(
      previews.create({
        projectId: "p",
        revision: "a".repeat(64),
        entry: "index.html",
        files: new Map([["index.html", Buffer.from("x")]]),
        entries: [{ path: "index.html", bytes, sha256: "0".repeat(64) }],
        ttlMs: 1000,
      }),
      (error) => error.code === "E_LIMIT",
    );
    const leftovers = await readdir(previews.root).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
    );
    assert.deepEqual(leftovers, []);
    assert.equal(relative(outputRoot, previews.root), "previews");
  } finally {
    await previews.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
