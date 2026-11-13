import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function taskkillPath() {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Kill the whole process tree below `pid` (console + detached-looking Chrome
 * helpers included). Windows has no `ps`, so taskkill /T replaces the POSIX
 * ancestry scan; failures are swallowed because the tree may already be gone
 * and the close-driven flow re-checks completion independently.
 */
function killTreeWin32(pid) {
  try {
    execFileSync(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {}
}

async function runOwnedWin32(
  argv,
  { cwd, env, signal, timeoutMs = 120000, onOutput = () => {} },
) {
  if (signal?.aborted) return { status: "cancelled", pid: null };
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid ?? null;
  let reason,
    stopping,
    output = "";
  const stop = (why) => {
    if (stopping) return;
    reason = why;
    stopping = (async () => {
      if (pid !== null) killTreeWin32(pid);
    })();
  };
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("timed_out"), timeoutMs);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      const s = b.toString();
      output = (output + s).slice(-65536);
      onOutput(s);
    });
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await stopping;
    if (pid !== null) killTreeWin32(pid);
    return {
      status: reason || (exit.code === 0 ? "complete" : "failed"),
      pid,
      ...exit,
      ownedPids: pid === null ? [] : [pid],
      survivors: [],
      output,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (pid !== null) killTreeWin32(pid);
  }
}
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
      return (
        m && {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          started: m[3],
          command: m[4],
        }
      );
    })
    .filter(Boolean);
}
export async function runOwned(
  argv,
  { temp, cwd, env, signal, timeoutMs = 120000, onOutput = () => {} } = {},
) {
  if (process.platform === "win32")
    return runOwnedWin32(argv, { cwd, env, signal, timeoutMs, onOutput });

  if (signal?.aborted) {
    return { status: "cancelled", pid: null };
  }
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identities = new Map();
  // Track ancestry while parents are alive, including detached Chrome groups.
  // A private per-job temp path also identifies reparented Chrome helpers.
  function scan() {
    const rows = processes();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (
          !identities.has(row.pid) &&
          (row.pid === child.pid ||
            (byPid.has(row.ppid) &&
              identities.get(row.ppid)?.started ===
                byPid.get(row.ppid).started &&
              identities.get(row.ppid)?.command ===
                byPid.get(row.ppid).command) ||
            row.command.includes(temp + "/"))
        ) {
          identities.set(row.pid, row);
          changed = true;
        }
      }
    } while (changed);
    return rows.filter((row) => {
      const id = identities.get(row.pid);
      return id && id.started === row.started && id.command === row.command;
    });
  }
  function killOwned(sig) {
    const rows = scan().reverse();
    for (const row of rows) {
      try {
        process.kill(row.pid, sig);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  let reason,
    stopping,
    output = "";
  const stop = (why) => {
    if (stopping) return;
    reason = why;
    stopping = (async () => {
      killOwned("SIGTERM");
      await delay(1400);
      killOwned("SIGKILL");
    })();
  };
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const tracker = setInterval(scan, 100);
  const timer = setTimeout(() => stop("timed_out"), timeoutMs);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      const s = b.toString();
      output = (output + s).slice(-65536);
      onOutput(s);
    });
  try {
    scan();
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await stopping;
    killOwned("SIGKILL");
    for (let i = 0; i < 20 && scan().length; i++) await delay(100);
    const survivors = scan();
    if (survivors.length)
      throw new Error(
        `Owned processes survived: ${survivors.map((r) => r.pid)}`,
      );
    return {
      status: reason || (exit.code === 0 ? "complete" : "failed"),
      pid: child.pid,
      ...exit,
      ownedPids: [...identities.keys()],
      survivors: [],
      output,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(tracker);
    signal?.removeEventListener("abort", abort);
    killOwned("SIGKILL");
  }
}
