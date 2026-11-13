import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { base, managed } from "./helpers.mjs";
import { Projects } from "../src/projects.mjs";
import { loadManagedRegistry } from "../src/registry.mjs";

const TEMPLATE = "product-launch-v1";

async function managedConfig(label) {
  const dir = await mkdtemp(resolve(base, `artifacts/${label}-`));
  const projectsRoot = resolve(dir, "projects");
  const outputRoot = resolve(dir, "output");
  const dataPath = resolve(dir, "registry-data.json");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(dataPath, JSON.stringify({ projects: {} }));
  const config = {
    projectsRoot,
    registryPath: dataPath,
    outputRoot,
    assetInboxRoot: resolve(dir, "inbox"),
  };
  const loaded = await loadManagedRegistry(config);
  Object.assign(config, loaded);
  return {
    dir,
    projectsRoot,
    outputRoot,
    dataPath,
    config,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    async restartState() {
      return loadManagedRegistry({
        projectsRoot,
        registryPath: dataPath,
        outputRoot,
      });
    },
  };
}

test("project.create cleans its directory and registry state when a post-copy step fails", async () => {
  const f = await managedConfig("create-injected");
  const store = new Projects(f.config);
  try {
    await store.initialize();
    let injected = false;
    store.open = async () => {
      injected = true;
      const error = new Error("injected open failure");
      error.code = "E_INTERNAL";
      throw error;
    };
    await assert.rejects(
      store.createProject({ templateId: TEMPLATE, title: "注入失败" }),
      /injected open failure/,
    );
    assert.equal(injected, true);
    // No in-memory mapping, no leftover project directory and no registry
    // entry that would make the next worker start fail with E_CONFIGURATION.
    assert.deepEqual(Object.keys(f.config.projects), []);
    assert.deepEqual(await readdir(f.projectsRoot), []);
    assert.deepEqual(JSON.parse(await readFile(f.dataPath, "utf8")).projects, {});
    assert.equal(store.handles.size, 0);
    const reloaded = await f.restartState();
    assert.deepEqual(reloaded.projects, {});
  } finally {
    await f.cleanup();
  }
});

test(
  "project.create rolls back when the registry write fails; next start stays healthy",
  { skip: process.platform === "win32" && "write fault injection needs POSIX chmod bits" },
  async () => {
  const f = await managedConfig("create-registry-failure");
  const store = new Projects(f.config);
  const registryDir = resolve(f.dataPath, "..");
  try {
    await store.initialize();
    await chmod(registryDir, 0o555);
    try {
      await assert.rejects(
        store.createProject({ templateId: TEMPLATE, title: "registry 写失败" }),
      );
    } finally {
      await chmod(registryDir, 0o755);
    }
    assert.deepEqual(Object.keys(f.config.projects), []);
    assert.deepEqual(await readdir(f.projectsRoot), []);
    assert.deepEqual(JSON.parse(await readFile(f.dataPath, "utf8")).projects, {});
    const reloaded = await f.restartState();
    assert.deepEqual(reloaded.projects, {});
    // The same worker can create normally once the failure is gone.
    const created = await store.createProject({ templateId: TEMPLATE, title: "恢复后创建" });
    assert.match(created.projectId, /^proj-/);
    const reopened = await f.restartState();
    assert.ok(reopened.projects[created.projectId]);
  } finally {
    await f.cleanup();
  }
});

test(
  "worker create keeps working and restart succeeds after a registry write fault",
  { skip: process.platform === "win32" && "write fault injection needs POSIX chmod bits" },
  async () => {
  const f = await managed("create-protocol-failure");
  const registryDir = resolve(f.dataPath, "..");
  try {
    await chmod(registryDir, 0o555);
    let response;
    try {
      response = await f.c.call("project.create", {
        templateId: TEMPLATE,
        title: "协议层故障",
      });
    } finally {
      await chmod(registryDir, 0o755);
    }
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "E_INTERNAL");
    assert.deepEqual(await readdir(f.projectsRoot), []);
    assert.deepEqual(JSON.parse(await readFile(f.dataPath, "utf8")).projects, {});
    await f.restart();
    const doctor = await f.c.call("doctor", {});
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
    const created = await f.c.call("project.create", {
      templateId: TEMPLATE,
      title: "重启后创建",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
  } finally {
    await f.cleanup();
  }
});
