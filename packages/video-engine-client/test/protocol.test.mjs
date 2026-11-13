import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { WorkerClient } from "../src/index.mjs";

const fakeWorker = resolve(import.meta.dirname, "fixtures/protocol-worker.mjs");

async function fake(mode, timeouts) {
  const budget = timeouts || {};
  const dir = await mkdtemp(resolve(tmpdir(), "dsh-engine-client-"));
  const registry = resolve(dir, "registry.json");
  await writeFile(registry, JSON.stringify({ mode }));
  return {
    client: new WorkerClient({
      nodeExecutable: process.execPath,
      workerEntry: fakeWorker,
      registryPath: registry,
      // Timing-sensitive negative tests keep the tight 200 ms budget. The
      // env/cwd context tests spawn a real worker and assert a healthy handshake,
      // so they pass a generous budget instead of flaking on a loaded machine.
      startupTimeoutMs: budget.startupTimeoutMs ?? 200,
      requestTimeoutMs: budget.requestTimeoutMs ?? 200,
      shutdownTimeoutMs: 200,
      forceKillTimeoutMs: 200,
      maxPending: 8,
      maxLineBytes: 1024,
      maxStderrBytes: 128,
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("malformed worker stdout fails startup as a protocol error", async () => {
  const f = await fake("malformed");
  try {
    await assert.rejects(
      f.client.start(),
      (error) => error.code === "E_PROTOCOL" && error.stage === "protocol",
    );
  } finally {
    await f.client.dispose();
    await f.cleanup();
  }
});

test("client validates framing, response envelopes, limits and late writes", async () => {
  for (const mode of [
    "framing",
    "invalid",
    "oversize",
    "late",
    "exit",
    "stderr",
  ]) {
    const f = await fake(mode);
    try {
      if (["invalid", "oversize"].includes(mode)) {
        await f.client.start();
        await assert.rejects(
          f.client.inspect("demo"),
          (error) =>
            error.code ===
            (mode === "oversize" ? "E_LINE_LIMIT" : "E_PROTOCOL"),
        );
      } else {
        await f.client.start();
        if (mode === "framing") {
          assert.deepEqual(
            await Promise.all([
              f.client.request("first", {}),
              f.client.request("second", {}),
            ]),
            [{ method: "first" }, { method: "second" }],
          );
        } else if (mode === "late") {
          await assert.rejects(
            f.client.edit({ projectId: "demo" }),
            (error) =>
              error.code === "E_REQUEST_TIMEOUT" && error.uncertain === true,
          );
          await new Promise((resolve) => setTimeout(resolve, 350));
          assert.deepEqual(await f.client.inspect("demo"), {
            method: "inspect",
          });
        } else if (mode === "exit") {
          await assert.rejects(
            f.client.inspect("demo"),
            (error) => error.code === "E_PROCESS_EXIT",
          );
          assert.equal(f.client.debug().state, "failed");
        } else {
          assert.deepEqual(await f.client.inspect("demo"), {
            method: "inspect",
          });
          assert.equal(f.client.debug().stderrBytes, 128);
          assert.equal(f.client.debug().stderrTruncated, true);
        }
      }
    } finally {
      await f.client.dispose();
      await f.cleanup();
    }
  }
});

test("dispose bounds an unresponsive worker shutdown and rejects new requests", async () => {
  const f = await fake("stall");
  try {
    await f.client.start();
    const started = performance.now();
    const disposing = f.client.dispose();
    await assert.rejects(
      f.client.inspect("demo"),
      (error) => error.code === "E_CLIENT_STATE",
    );
    await disposing;
    assert.ok(
      performance.now() - started < 550,
      "dispose must force only its own worker promptly",
    );
    assert.equal(f.client.debug().pending, 0);
    assert.equal(f.client.debug().state, "disposed");
  } finally {
    await f.client.dispose();
    await f.cleanup();
  }
});

test("invalid executable returns a structured startup failure", async () => {
  const f = await fake("framing");
  f.client.options.nodeExecutable = "/definitely/not/a/node-executable";
  try {
    await assert.rejects(
      f.client.start(),
      (error) => error.code === "E_STARTUP",
    );
  } finally {
    await f.client.dispose();
    await f.cleanup();
  }
});

test("spawn uses an explicit complete env and cwd copied at construction", async () => {
  const f = await fake("context", { startupTimeoutMs: 5000, requestTimeoutMs: 5000 });
  const dir = await mkdtemp(resolve(tmpdir(), "dsh-engine-client-cwd-"));
  // The complete env below must replace process.env, so this variable must not
  // reach the child.
  process.env.DSH_PARENT_ONLY = "parent-value";
  const original = { PATH: process.env.PATH, DSH_MARK: "copied-value" };
  const client = new WorkerClient({ ...f.client.options, env: original, cwd: dir });
  original.DSH_MARK = "mutated-after-construction";
  try {
    const context = await client.start();
    assert.equal(context.cwd, realpathSync(dir));
    assert.equal(context.mark, "copied-value");
    assert.equal(context.hasMark, true);
    assert.equal(context.hasPath, true);
    assert.equal(context.parentOnly, false);
    // Only the explicit env and entries the platform injects itself may exist;
    // nothing else from the parent environment is inherited.
    assert.equal(context.home, false);
    assert.equal(context.electron, false);
  } finally {
    delete process.env.DSH_PARENT_ONLY;
    await client.dispose();
    await f.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("omitting env keeps the inherited standalone environment", async () => {
  const f = await fake("context", { startupTimeoutMs: 5000, requestTimeoutMs: 5000 });
  const client = new WorkerClient({ ...f.client.options });
  process.env.DSH_MARK = "inherited-value";
  try {
    const context = await client.start();
    assert.equal(context.mark, "inherited-value");
    assert.equal(context.hasMark, true);
    assert.equal(context.parentOnly, false);
  } finally {
    delete process.env.DSH_MARK;
    await client.dispose();
    await f.client.dispose();
    await f.cleanup();
  }
});

test("invalid env/cwd options fail before any worker process starts", async () => {
  const f = await fake("framing");
  const invalid = [
    { env: null },
    { env: "PATH=/bin" },
    { env: [] },
    { env: {} },
    { env: { "": "value" } },
    { env: { "NAME=with-equals": "value" } },
    { env: { NAME: 1 } },
    { env: { NAME: "has\0nul" } },
    { env: { "NAME\0WITH-NUL": "value" } },
    { cwd: "" },
    { cwd: null },
    { cwd: 42 },
    { cwd: "relative/path" },
    { cwd: "/tmp/has\0nul" },
  ];
  try {
    for (const overrides of invalid)
      assert.throws(
        () => new WorkerClient({ ...f.client.options, ...overrides }),
        TypeError,
        JSON.stringify(overrides),
      );
  } finally {
    await f.client.dispose();
    await f.cleanup();
  }
});

test("byte-framed UTF-8 preserves split Chinese and emoji", async () => {
  const f = await fake("unicode");
  try {
    await f.client.start();
    assert.deepEqual(await f.client.inspect("demo"), { text: "你好😀" });
  } finally {
    await f.client.dispose();
    await f.cleanup();
  }
});

test("unanswered edits remain uncertain on exit and protocol failure", async () => {
  for (const mode of ["edit-exit", "edit-bad"]) {
    const f = await fake(mode);
    try {
      await f.client.start();
      await assert.rejects(
        f.client.edit({ projectId: "demo" }),
        (error) =>
          error.uncertain === true &&
          ["E_PROCESS_EXIT", "E_PROTOCOL"].includes(error.code),
      );
      assert.equal(f.client.debug().pending, 0);
    } finally {
      await f.client.dispose();
      await f.cleanup();
    }
  }
});

test("normal dispose lets an isolated parent exit before its shutdown deadline", async () => {
  const f = await fake("framing");
  const parent = resolve(import.meta.dirname, "fixtures/dispose-parent.mjs");
  const started = performance.now();
  try {
    const child = spawn(process.execPath, [
      parent,
      fakeWorker,
      f.client.options.registryPath,
    ]);
    const exited = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("parent did not exit")),
        1000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exited, 0);
    assert.ok(
      performance.now() - started < 800,
      "must not retain shutdown timer",
    );
  } finally {
    await f.cleanup();
  }
});

test(
  "isolated parent separates sent requests from refusals after a stdin failure",
  {
    // Windows anonymous pipes swallow writes to a closed stdin instead of
    // raising EPIPE, so the parent observes request timeouts rather than the
    // POSIX transport failure this contract pins down.
    skip:
      process.platform === "win32" &&
      "EPIPE-based transport separation is POSIX pipe behavior",
  },
  async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "dsh-engine-client-epipe-"));
  const registry = resolve(dir, "registry.json");
  const parent = resolve(import.meta.dirname, "fixtures/epipe-parent.mjs");
  const worker = resolve(import.meta.dirname, "fixtures/stdin-close-worker.mjs");
  await writeFile(registry, "{}");
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"]);
  try {
    const child = spawn(process.execPath, [parent, worker, registry], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(
        () => reject(new Error("isolated parent did not exit")),
        2_000,
      );
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolveExit(exitCode);
      });
    });
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.held, 3);
    assert.deepEqual(parsed.sent, [
      {
        method: "edit",
        code: "E_TRANSPORT",
        uncertain: true,
        jobUnknown: false,
      },
      {
        method: "frame",
        code: "E_TRANSPORT",
        uncertain: false,
        jobUnknown: true,
      },
      {
        method: "render",
        code: "E_TRANSPORT",
        uncertain: false,
        jobUnknown: true,
      },
      {
        method: "inspect",
        code: "E_TRANSPORT",
        uncertain: false,
        jobUnknown: false,
      },
    ]);
    assert.deepEqual(parsed.refused, [
      "E_CLIENT_STATE",
      "E_CLIENT_STATE",
      "E_CLIENT_STATE",
      "E_CLIENT_STATE",
    ]);
    assert.ok(
      ["failed", "disposed"].includes(parsed.failureState),
      `unexpected post-failure state: ${parsed.failureState}`,
    );
    assert.deepEqual(parsed.state, {
      state: "disposed",
      pending: 0,
      stderrBytes: 0,
      stderrTruncated: false,
    });
    assert.equal(parsed.workerExited, true);
    assert.deepEqual(parsed.delivered, [
      "doctor",
      "edit",
      "frame",
      "render",
      "sync",
    ]);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
  } finally {
    sentinel.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
