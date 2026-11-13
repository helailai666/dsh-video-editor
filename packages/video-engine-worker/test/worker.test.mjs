import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture, client } from "./helpers.mjs";
test("JSONL validation, real SDK, concurrent revision conflict and idempotency", async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    assert.equal((await c.call("doctor")).ok, true);
    const opened = await c.call("open", { projectId: "demo" });
    assert.equal(opened.ok, true);
    const rev = opened.result.revision;
    const before = await c.call("inspect", { projectId: "demo" });
    assert.equal(
      before.result.elements.find((e) => e.stableId === "hf-title").timing
        .duration,
      5,
    );
    const edit = {
      projectId: "demo",
      expectedRevision: rev,
      operationId: "op1",
      ops: [
        { type: "text", target: "hf-title", text: "测试标题" },
        { type: "timing", target: "hf-title", start: 1, duration: 3 },
      ],
    };
    const [a, b] = await Promise.all([
      c.call("edit", edit),
      c.call("edit", { ...edit, operationId: "op2" }),
    ]);
    assert.equal([a,b].filter(r=>r.ok).length,1,JSON.stringify([a,b]));
    const winner=a.ok?a:b, loser=a.ok?b:a;
    const accepted={...edit,operationId:a.ok?'op1':'op2'};
    assert.equal(loser.error.code, "E_REVISION_CONFLICT");
    assert.deepEqual(
      await c.call("edit", accepted).then((r) => r.result),
      winner.result,
    );
    assert.equal(
      (
        await c.call("edit", {
          ...accepted,
          ops: [{ type: "text", target: "hf-title", text: "different" }],
        })
      ).error.code,
      "E_OPERATION_REUSED",
    );
    await c.call("close", { projectId: "demo" });
    await c.call("open", { projectId: "demo" });
    const after = await c.call("inspect", { projectId: "demo" });
    assert.equal(
      after.result.elements.find((e) => e.stableId === "hf-title").text,
      "测试标题",
    );
    await writeFile(
      resolve(f.project, "assets/gsap.min.js"),
      (await readFile(resolve(f.project, "assets/gsap.min.js"))) + "\n",
    );
    const assetRev = (await c.call("inspect", { projectId: "demo" })).result
      .revision;
    assert.notEqual(assetRev, winner.result.revision);
    assert.equal(
      (
        await c.call("edit", {
          ...edit,
          operationId: "op3",
          expectedRevision: winner.result.revision,
        })
      ).error.code,
      "E_REVISION_CONFLICT",
    );
    await writeFile(
      resolve(f.project, "index.html"),
      (await readFile(resolve(f.project, "index.html"))) + "\n",
    );
    assert.equal(
      (
        await c.call("edit", {
          ...edit,
          operationId: "op4",
          expectedRevision: assetRev,
        })
      ).error.code,
      "E_REVISION_CONFLICT",
    );
    assert.equal(
      (
        await c.call("frame", {
          projectId: "demo",
          revision: assetRev,
          time: -1,
        })
      ).error.code,
      "E_PARAMS",
    );
    assert.equal(
      (await c.call("open", { projectId: "demo", path: "/etc/passwd" })).error
        .code,
      "E_PARAMS",
    );
    assert.equal(
      (await c.call("open", { projectId: "unknown" })).error.code,
      "E_PROJECT_NOT_FOUND",
    );
    assert.equal((await c.call("nope")).error.code, "E_METHOD");
    assert.equal((await c.raw("{bad", null)).error.code, "E_JSON");
    assert.equal(
      (await c.raw("x".repeat(70000), null)).error.code,
      "E_LINE_LIMIT",
    );
    const req = { v: 1, id: "same", method: "doctor", params: {} };
    assert.equal((await c.raw(req, "same")).ok, true);
    assert.equal((await c.raw(req, "same")).error.code, "E_DUPLICATE_ID");
    assert.ok(c.lines.every((l) => JSON.parse(l).v === 1));
    assert.ok(c.stderr.length <= 16384);
  } finally {
    await c.stop();
    await f.cleanup();
  }
});
test(
  "realpath rejects escaped declared asset and entry without leaking disk paths",
  { skip: process.platform === "win32" && "symlink escape probe needs POSIX /etc/passwd" },
  async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    await symlink("/etc/passwd", resolve(f.project, "assets/escape"));
    await writeFile(
      resolve(f.project, "project.json"),
      JSON.stringify({ entry: "index.html", assets: ["assets/escape"] }),
    );
    const r = await c.call("open", { projectId: "demo" });
    assert.equal(r.error.code, "E_PATH");
    assert.ok(!JSON.stringify(r).includes("/etc/"));
  } finally {
    await c.stop();
    await f.cleanup();
  }
});

test(
  "parameter and output limits, entry escape and SDK filesystem persistence failure",
  { skip: process.platform === "win32" && "persistence fault needs POSIX chmod bits" },
  async () => {
  const { chmod, unlink } = await import("node:fs/promises");
  const f = await fixture(),
    c = client(f.registry);
  try {
    for (const value of [null, [], { projectId: 9 }])
      assert.equal((await c.call("inspect", value)).error.code, "E_PARAMS");
    assert.equal(
      (
        await c.raw(
          { v: 2, id: "version", method: "doctor", params: {} },
          "version",
        )
      ).error.code,
      "E_VERSION",
    );
    const rev = (await c.call("open", { projectId: "demo" })).result.revision;
    const original = await readFile(resolve(f.project, "index.html"), "utf8");
    await chmod(f.project, 0o555);
    const saved = await c.call("edit", {
      projectId: "demo",
      expectedRevision: rev,
      operationId: "fs-failure",
      ops: [{ type: "text", target: "hf-title", text: "Must fail saving" }],
    });
    assert.equal(saved.error.code, "E_PERSIST", JSON.stringify(saved));
    assert.equal(
      await readFile(resolve(f.project, "index.html"), "utf8"),
      original,
    );
    await chmod(f.project, 0o755);
    await writeFile(
      resolve(f.project, "index.html"),
      original.replace(
        "</main>",
        Array.from(
          { length: 40 },
          (_, i) => `<p data-hf-id="large-${i}">${"中".repeat(2000)}</p>`,
        ).join("") + "</main>",
      ),
    );
    assert.equal(
      (await c.call("inspect", { projectId: "demo" })).error.code,
      "E_OUTPUT_LIMIT",
    );
    await unlink(resolve(f.project, "index.html"));
    await symlink("/etc/passwd", resolve(f.project, "index.html"));
    assert.equal(
      (await c.call("inspect", { projectId: "demo" })).error.code,
      "E_PATH",
    );
    assert.ok(c.lines.every((line) => Buffer.byteLength(line) <= 65536));
  } finally {
    await chmod(f.project, 0o755);
    await c.stop();
    await f.cleanup();
  }
});
test("frame upper boundary fails structurally and incomplete input EOF exits", async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    const rev = (await c.call("open", { projectId: "demo" })).result.revision;
    const r = await c.call("frame", {
      projectId: "demo",
      revision: rev,
      time: 5,
    });
    const { waitJob } = await import("./helpers.mjs");
    const done = await waitJob(c, r.result.jobId);
    assert.equal(done.state, "failed");
    assert.equal(done.error.code, "E_PARAMS");
    assert.equal(done.cleaned, true);
    c.child.stdin.write("{incomplete");
    c.child.stdin.end();
    assert.equal((await c.exited).code, 0);
  } finally {
    await c.stop();
    await f.cleanup();
  }
});
test("non-index entry is rejected instead of frame silently sampling another file", async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    await writeFile(
      resolve(f.project, "project.json"),
      JSON.stringify({ entry: "other.html", assets: [] }),
    );
    await writeFile(resolve(f.project, "other.html"), "<p>not supported</p>");
    const r = await c.call("open", { projectId: "demo" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "E_PROJECT");
  } finally {
    await c.stop();
    await f.cleanup();
  }
});
test("combined timing edits are validated as a batch before SDK writes", async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    const rev = (await c.call("open", { projectId: "demo" })).result.revision;
    const original = await readFile(resolve(f.project, "index.html"), "utf8");
    const r = await c.call("edit", {
      projectId: "demo",
      expectedRevision: rev,
      operationId: "combined",
      ops: [
        { type: "timing", target: "hf-title", start: 4, duration: 1 },
        { type: "timing", target: "hf-title", duration: 4 },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "E_PARAMS");
    assert.equal(
      await readFile(resolve(f.project, "index.html"), "utf8"),
      original,
    );
  } finally {
    await c.stop();
    await f.cleanup();
  }
});
test("operation retry ignores JSON object key order", async () => {
  const f = await fixture(),
    c = client(f.registry);
  try {
    const rev = (await c.call("open", { projectId: "demo" })).result.revision;
    const a = await c.call("edit", {
      projectId: "demo",
      expectedRevision: rev,
      operationId: "ordered",
      ops: [{ type: "text", target: "hf-title", text: "幂等" }],
    });
    const b = await c.call("edit", {
      ops: [{ text: "幂等", target: "hf-title", type: "text" }],
      operationId: "ordered",
      expectedRevision: rev,
      projectId: "demo",
    });
    assert.equal(b.ok, true);
    assert.deepEqual(a.result, b.result);
  } finally {
    await c.stop();
    await f.cleanup();
  }
});
