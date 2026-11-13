import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const workerRoot = resolve(import.meta.dirname, "../../video-engine-worker");
const version = "0.9.0";
const clientFiles = ["README.md", "package.json", "src/index.mjs"];
const workerFiles = [
  "README.md",
  "package.json",
  "protocol.schema.json",
  "src/assets.mjs",
  "src/audio.mjs",
  "src/beat.mjs",
  "src/browser.mjs",
  "src/composition.mjs",
  "src/dependencies.mjs",
  "src/errors.mjs",
  "src/history.mjs",
  "src/jobs.mjs",
  "src/layout.mjs",
  "src/merge.mjs",
  "src/previews.mjs",
  "src/process.mjs",
  "src/projects.mjs",
  "src/registry.mjs",
  "src/scenes.mjs",
  "src/timeline-visuals.mjs",
  "src/timeline.mjs",
  "src/visuals.mjs",
  "src/worker.mjs",
];

async function readManifest(root) {
  return JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pack(root, expectedFilename) {
  const artifacts = resolve(root, "artifacts");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    "pack",
    "--json",
    "--pack-destination",
    artifacts,
  ];
  const npmCli = process.env.npm_execpath;
  const output =
    npmCli && existsSync(npmCli)
      ? execFileSync(
          process.env.npm_node_execpath || process.execPath,
          [npmCli, ...args],
          { cwd: root, encoding: "utf8", env },
        )
      // On Windows, "npm" is an npm.cmd shim, which Node refuses to spawn
      // without a shell; shell:true keeps this test-only invocation working.
      : execFileSync("npm", args, {
          cwd: root,
          encoding: "utf8",
          env,
          shell: process.platform === "win32",
        });
  const [info] = JSON.parse(output);
  assert.equal(info.filename, expectedFilename);
  return resolve(artifacts, info.filename);
}

function extract(tarball, destination) {
  execFileSync("tar", [
    "-xzf",
    tarball,
    "-C",
    destination,
    "--strip-components=1",
  ]);
}

async function filesUnder(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else files.push(path);
  }
  return files.sort();
}

test("fixed tarballs expose runtime entries and resolve from staging", async (t) => {
  const clientManifest = await readManifest(clientRoot);
  const workerManifest = await readManifest(workerRoot);

  for (const manifest of [clientManifest, workerManifest]) {
    assert.equal(manifest.version, version);
    assert.equal(manifest.private, true);
  }
  assert.deepEqual(clientManifest.exports, {
    ".": "./src/index.mjs",
    "./package.json": "./package.json",
  });
  assert.deepEqual(clientManifest.files, ["src/", "README.md"]);
  assert.deepEqual(workerManifest.exports, {
    "./worker": "./src/worker.mjs",
    "./package.json": "./package.json",
  });
  assert.deepEqual(workerManifest.files, [
    "src/",
    "protocol.schema.json",
    "README.md",
  ]);

  const clientTarball = resolve(
    clientRoot,
    "artifacts",
    `${clientManifest.name}-${version}.tgz`,
  );
  const workerTarball = resolve(
    workerRoot,
    "artifacts",
    `${workerManifest.name}-${version}.tgz`,
  );
  await mkdir(resolve(clientRoot, "artifacts"), { recursive: true });
  await mkdir(resolve(workerRoot, "artifacts"), { recursive: true });
  await rm(clientTarball, { force: true });
  await rm(workerTarball, { force: true });

  assert.equal(pack(clientRoot, `${clientManifest.name}-${version}.tgz`), clientTarball);
  assert.equal(pack(workerRoot, `${workerManifest.name}-${version}.tgz`), workerTarball);

  const clientHash = sha256(await readFile(clientTarball));
  const workerHash = sha256(await readFile(workerTarball));
  t.diagnostic(`client tarball: ${clientTarball} sha256=${clientHash}`);
  t.diagnostic(`worker tarball: ${workerTarball} sha256=${workerHash}`);

  // Repacking the same tree must produce identical bytes, so the recorded
  // digest identifies this fixed commit's packages.
  pack(clientRoot, `${clientManifest.name}-${version}.tgz`);
  pack(workerRoot, `${workerManifest.name}-${version}.tgz`);
  assert.equal(sha256(await readFile(clientTarball)), clientHash);
  assert.equal(sha256(await readFile(workerTarball)), workerHash);

  const extracted = await mkdtemp(join(tmpdir(), "dsh-engine-pack-"));
  const staging = await mkdtemp(join(tmpdir(), "dsh-engine-staging-"));
  try {
    await mkdir(join(extracted, "client"));
    await mkdir(join(extracted, "worker"));
    extract(clientTarball, join(extracted, "client"));
    extract(workerTarball, join(extracted, "worker"));

    assert.deepEqual(await filesUnder(join(extracted, "client")), clientFiles);
    assert.deepEqual(await filesUnder(join(extracted, "worker")), workerFiles);
    for (const file of [...clientFiles, ...workerFiles])
      assert.doesNotMatch(file, /\.(ttc|ttf|otf|woff2?)$/i);

    assert.equal((await readManifest(join(extracted, "client"))).version, version);
    assert.equal((await readManifest(join(extracted, "worker"))).version, version);
    for (const file of [
      "src/index.mjs",
      "src/assets.mjs",
      "src/audio.mjs",
      "src/beat.mjs",
      "src/browser.mjs",
      "src/composition.mjs",
      "src/dependencies.mjs",
      "src/errors.mjs",
      "src/history.mjs",
      "src/jobs.mjs",
      "src/layout.mjs",
      "src/merge.mjs",
      "src/previews.mjs",
      "src/process.mjs",
      "src/projects.mjs",
      "src/registry.mjs",
      "src/scenes.mjs",
      "src/timeline.mjs",
      "src/timeline-visuals.mjs",
      "src/visuals.mjs",
      "src/worker.mjs",
      "protocol.schema.json",
    ]) {
      const root =
        file === "src/index.mjs" ? join(extracted, "client") : join(extracted, "worker");
      assert.deepEqual(
        await readFile(join(root, file)),
        await readFile(join(file === "src/index.mjs" ? clientRoot : workerRoot, file)),
        `${file} bytes changed in the tarball`,
      );
    }

    const modules = join(staging, "node_modules");
    await mkdir(join(modules, clientManifest.name), { recursive: true });
    await mkdir(join(modules, workerManifest.name), { recursive: true });
    extract(clientTarball, join(modules, clientManifest.name));
    extract(workerTarball, join(modules, workerManifest.name));
    await writeFile(
      join(staging, "consumer.mjs"),
      `import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const clientEntry = require.resolve("dsh-video-engine-client");
const clientManifestPath = require.resolve("dsh-video-engine-client/package.json");
const workerEntry = require.resolve("dsh-video-engine-worker/worker");
const workerManifestPath = require.resolve("dsh-video-engine-worker/package.json");
const client = await import(pathToFileURL(clientEntry).href);
if (typeof client.WorkerClient !== "function")
  throw new Error("WorkerClient export is missing");
process.stdout.write(JSON.stringify({
  clientEntry,
  clientVersion: JSON.parse(readFileSync(clientManifestPath, "utf8")).version,
  workerEntry,
  workerManifestPath,
  workerVersion: JSON.parse(readFileSync(workerManifestPath, "utf8")).version,
}));
`,
    );
    const resolved = JSON.parse(
      execFileSync(process.execPath, [join(staging, "consumer.mjs")], {
        cwd: staging,
        encoding: "utf8",
      }),
    );
    assert.equal(resolved.clientVersion, version);
    assert.equal(resolved.workerVersion, version);
    // require.resolve reports native separators; compare platform-neutrally.
    const posix = (path) => path.split(/[\\/]/).join("/");
    assert.ok(posix(resolved.clientEntry).endsWith("/src/index.mjs"));
    assert.ok(posix(resolved.workerEntry).endsWith("/src/worker.mjs"));
    assert.ok(posix(resolved.workerManifestPath).endsWith("/package.json"));
  } finally {
    await rm(extracted, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});
