import { mkdtemp, mkdir, cp, copyFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dependencyFile } from "../src/dependencies.mjs";
export const base = fileURLToPath(new URL("../", import.meta.url));
export async function fixture() {
  await mkdir(resolve(base, "artifacts"), { recursive: true });
  const dir = await mkdtemp(resolve(base, "artifacts/test-"));
  const project = resolve(dir, "projects/demo");
  await mkdir(resolve(project, "assets"), { recursive: true });
  await copyFile(
    resolve(base, "fixtures/index.html"),
    resolve(project, "index.html"),
  );
  for (const name of ["gsap.min.js", "MotionPathPlugin.min.js"])
    await copyFile(
      dependencyFile("gsap", `dist/${name}`),
      resolve(project, "assets", name),
    );
  // Same override as scripts/prepare-fixture.mjs: Windows/CI hosts provide no
  // macOS system font and no nested node_modules under the package.
  await copyFile(
    process.env.VIDEO_FONT_PATH || "/System/Library/Fonts/STHeiti Medium.ttc",
    resolve(project, "assets/Heiti.ttc"),
  );
  await writeFile(
    resolve(project, "project.json"),
    JSON.stringify({
      entry: "index.html",
      assets: [
        "assets/gsap.min.js",
        "assets/MotionPathPlugin.min.js",
        "assets/Heiti.ttc",
      ],
    }),
  );
  const config = {
    root: resolve(dir, "projects"),
    projects: { demo: project },
    outputRoot: resolve(dir, "output"),
  };
  await writeFile(resolve(dir, "registry.json"), JSON.stringify(config));
  return {
    dir,
    project,
    config,
    registry: resolve(dir, "registry.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
export function client(registry, options = {}) {
  const child = spawn(
    options.node || process.execPath,
    [options.workerEntry || resolve(base, "src/worker.mjs"), "--registry", registry],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let sequence = 0,
    buffer = "",
    stderr = "";
  const pending = new Map(),
    lines = [];
  // Decode across chunk boundaries; a CJK codepoint can straddle two writes.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (b) => {
    buffer += b;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      const r = JSON.parse(line);
      const cb = pending.get(r.id);
      if (cb) {
        pending.delete(r.id);
        cb(r);
      }
    }
  });
  child.stderr.on("data", (b) => (stderr += b));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      for (const cb of pending.values())
        cb({ ok: false, error: { code: "WORKER_EXIT", message: stderr } });
      pending.clear();
      resolve({ code, signal });
    }),
  );
  async function raw(value, id) {
    const result = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("response timeout " + id + " " + stderr)),
        150000,
      );
      pending.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
    child.stdin.write(
      typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n",
    );
    return result;
  }
  return {
    child,
    lines,
    exited,
    get stderr() {
      return stderr;
    },
    raw,
    call(method, params = {}) {
      const id = "r" + ++sequence;
      return raw({ v: 1, id, method, params }, id);
    },
    async stop() {
      if (child.exitCode === null && !child.killed) {
        await this.call("shutdown");
        await exited;
      }
    },
  };
}
export async function waitJob(
  c,
  jobId,
  predicate = (r) =>
    ["succeeded", "failed", "cancelled", "timed_out"].includes(r.state),
) {
  for (let i = 0; i < 1000; i++) {
    const r = await c.call("status", { jobId });
    if (!r.ok) throw new Error(JSON.stringify(r));
    if (predicate(r.result)) return r.result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job timeout");
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// Worker-managed (P3) fixture: projectsRoot + registry file + outputRoot +
// read-only asset inbox. Starts one worker; `restart()` replaces it.
export async function managed(label = "managed") {
  const dir = await mkdtemp(resolve(base, `artifacts/${label}-`));
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
  const clients = [];
  let current = client(configPath);
  clients.push(current);
  return {
    dir,
    projectsRoot,
    outputRoot,
    assetInboxRoot,
    dataPath,
    configPath,
    get c() {
      return current;
    },
    set c(value) {
      current = value;
      clients.push(value);
    },
    async readRegistry() {
      return JSON.parse(await readFile(dataPath, "utf8"));
    },
    async restart() {
      await current.stop();
      current = client(configPath);
      clients.push(current);
      return current;
    },
    async cleanup() {
      for (const candidate of clients) await candidate.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
