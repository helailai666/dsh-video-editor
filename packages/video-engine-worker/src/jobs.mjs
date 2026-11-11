import {dependencyManifest,dependencyFile} from './dependencies.mjs';
import { mkdir, mkdtemp, rm, readFile, rename, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { audioMixPlan } from "./audio.mjs";
import { runOwned } from "./process.mjs";
import { fail, number } from "./errors.mjs";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = dependencyFile("hyperframes", "dist/cli.js");
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export const MAX_FRAME_TIMES = 4;
/**
 * Worker-enforced job deadlines. A frame captures one short snapshot (120s is
 * generous); a full MP4 render scales with the composition and is capped by
 * MAX_RENDER_TIMEOUT_MS (6 hours), mirrored by the Host validator. Two measured
 * phases need that budget: the HyperFrames capture — a 20s composition measures
 * ~112s, i.e. ~187ms/frame, and 1080x1920 software capture is slower still — and
 * the post-capture validation, whose `ffprobe -count_frames` decodes every frame.
 */
export const FRAME_TIMEOUT_MS = 120000;
export const MAX_RENDER_TIMEOUT_MS = 21600000;
const RENDER_BASE_MS = 120000;
const RENDER_MS_PER_FRAME = 240;
const RENDER_MIN_MS = 300000;
const VALIDATE_BASE_MS = 10000;
const VALIDATE_MS_PER_FRAME = 25;
const VALIDATE_MIN_MS = 15000;
const MAX_RENDER_FRAMES = 108000;
const FRAME_TILE_MAX_WIDTH = 480;
const CONTACT_SHEET_TIMEOUT_MS = 30000;

/**
 * Default capture deadline for a render of `frames` frames. A composition is
 * bounded to 3600s @30fps, so 108000 frames is the largest valid input.
 */
export function renderTimeoutMs(frames) {
  number(frames, 1, MAX_RENDER_FRAMES);
  return Math.min(
    MAX_RENDER_TIMEOUT_MS,
    Math.max(RENDER_MIN_MS, RENDER_BASE_MS + RENDER_MS_PER_FRAME * frames),
  );
}

/**
 * Validation probe budget. `-count_frames` decodes the whole MP4, so the old
 * fixed 15s window silently killed every long 1080x1920 export after capture
 * had already reached progress 1. 25ms/frame budgets a worst-case 40fps decode
 * count and keeps the short-render floor unchanged.
 */
export function validateProbeTimeoutMs(frames) {
  number(frames, 1, MAX_RENDER_FRAMES);
  return Math.min(
    MAX_RENDER_TIMEOUT_MS,
    Math.max(VALIDATE_MIN_MS, VALIDATE_BASE_MS + VALIDATE_MS_PER_FRAME * frames),
  );
}

/**
 * Canonical millisecond label shared by the HyperFrames `--keep` still name
 * (`at-<label>s.png`) and the duplicate check, so two accepted `times` entries
 * can never resolve to the same still.
 */
export function frameTimeLabel(time) {
  return String(Number(time.toFixed(3)));
}

/**
 * Validate the batch `times` frame parameter: 1..MAX_FRAME_TIMES seconds,
 * canonical to millisecond precision (the `--keep` filename granularity),
 * distinct by that canonical value and ascending. Host input is already
 * normalized; normalizing again here keeps a direct JSONL caller deterministic.
 */
export function normalizeFrameTimes(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_FRAME_TIMES
  )
    fail("E_PARAMS", `times must list 1-${MAX_FRAME_TIMES} frame times`);
  const seen = new Set();
  const times = [];
  for (const entry of value) {
    number(entry, 0, 3599.999);
    const canonical = Number(entry.toFixed(3));
    if (seen.has(canonical))
      fail("E_PARAMS", "Frame times must be distinct at millisecond precision");
    seen.add(canonical);
    times.push(canonical);
  }
  times.sort((left, right) => left - right);
  return times;
}

/**
 * Horizontal contact-sheet geometry. Every tile is downscaled to
 * width = min(480, doc.width) with a proportional even height, then tiled
 * side by side: sheet width = tile width * count, sheet height = tile height.
 * Four 3840-wide tiles stay well under the 3840-wide sheet bound.
 */
export function contactSheetLayout(width, height, count) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isInteger(count) ||
    count < 2 ||
    count > MAX_FRAME_TIMES
  )
    fail("E_PARAMS", "Invalid contact-sheet geometry");
  const tileWidth = Math.min(FRAME_TILE_MAX_WIDTH, width);
  let tileHeight = Math.round((height * tileWidth) / width);
  if (tileHeight % 2 === 1) tileHeight -= 1;
  if (tileHeight < 2) tileHeight = 2;
  return {
    tileWidth,
    tileHeight,
    sheetWidth: tileWidth * count,
    sheetHeight: tileHeight,
  };
}

/** ffmpeg argv that tiles already-captured same-size PNG stills horizontally. */
export function contactSheetArgs(frames, layout, output) {
  const args = ["ffmpeg", "-y", "-v", "error"];
  for (const frame of frames) args.push("-i", frame);
  const filters = frames.map(
    (_, index) =>
      `[${index}:v]scale=${layout.tileWidth}:${layout.tileHeight}:flags=lanczos,setsar=1[v${index}]`,
  );
  filters.push(
    `${frames.map((_, index) => `[v${index}]`).join("")}hstack=inputs=${frames.length}[sheet]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[sheet]",
    "-frames:v",
    "1",
    output,
  );
  return args;
}

/** PNG signature plus IHDR dimensions must match the expected frame size. */
function validPng(bytes, width, height) {
  return (
    bytes.length >= 24 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(16) === width &&
    bytes.readUInt32BE(20) === height
  );
}

/**
 * SHA-256 of the exact published bytes (the same digest as projects.mjs `sha`).
 * Kept local so this job module — and its pure unit tests — import no
 * HyperFrames SDK dependency.
 */
function artifactHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export class Jobs {
  constructor(projects, config) {
    this.tools = versions(config);
    this.projects = projects;
    this.config = config;
    this.jobs = new Map();
    this.closing = false;
  }
  view(job) {
    const { controller, promise, temp, ...publicFields } = job;
    // An artifact is public only after the job reaches its terminal success
    // state. This keeps cancel during the final cleanup from exposing a file
    // that the worker must subsequently retract.
    if (job.state !== "succeeded") delete publicFields.artifact;
    return publicFields;
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) fail("E_JOB_NOT_FOUND", "Unknown worker job", "status");
    return job;
  }
  async start(kind, p) {
    if (this.closing) fail("E_SHUTDOWN", "Worker is shutting down", "job");
    this.projects.assertActive(p.projectId);
    if (
      [...this.jobs.values()].filter((j) => !terminal.has(j.state)).length >=
        4 ||
      this.jobs.size >= 256
    )
      fail("E_LIMIT", "Job limit reached", "job");
    const job = {
      jobId: randomUUID(),
      projectId: p.projectId,
      revision: p.revision,
      kind,
      tools: this.tools,
      state: "queued",
      stage: "snapshot",
      controller: new AbortController(),
      progress: 0,
    };
    this.jobs.set(job.jobId, job);
    // Register promise before returning: shutdown/EOF can always drain it.
    job.promise = new Promise((r) => setImmediate(r)).then(() =>
      this.run(job, p),
    );
    return this.view(job);
  }
  cancel(job) {
    if (!terminal.has(job.state)) {
      job.state = "cancelling";
      job.controller.abort();
    }
    return this.view(job);
  }
  async drain(projectId) {
    for (const j of this.jobs.values())
      if (!projectId || j.projectId === projectId) this.cancel(j);
    await Promise.all(
      [...this.jobs.values()]
        .filter((j) => !projectId || j.projectId === projectId)
        .map((j) => j.promise),
    );
  }
  env(temp, kind) {
    return {
      ...process.env,
      TMPDIR: resolve(temp, "tmp"),
      HYPERFRAMES_BROWSER_PATH:
        this.config.browserPath ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      PRODUCER_BROWSER_GPU_MODE: "software",
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      HEYGEN_CONFIG_DIR: resolve(temp, "auth"),
      XDG_STATE_HOME: resolve(temp, "state"),
      HYPERFRAMES_FONT_CACHE_DIR: resolve(temp, "fonts"),
      HYPERFRAMES_EXTRACT_CACHE_DIR: "off",
      // BUG-001: HyperFrames' static-frame-dedup verification opens a second
      // page, after which the primary capture page silently loses its
      // 1280x720 device-metrics override (innerHeight falls to the real
      // headless window content height). The render then keeps CDP's
      // captureBeyondViewport=false and clips the bottom rows black. Our
      // controlled adapter disables dedup for render jobs only; capture frames
      // stay the same revision/HTML and the composition is never cropped,
      // stretched or filled. Revisit when the upstream page lifecycle is fixed.
      ...(kind === "render" ? { HF_STATIC_DEDUP: "false" } : {}),
    };
  }
  async run(job, p) {
    let final = "failed";
    try {
      await mkdir(this.config.outputRoot, { recursive: true });
      job.temp = await mkdtemp(resolve(this.config.outputRoot, ".job-"));
      const snapshot = resolve(job.temp, "project");
      const meta = await this.projects.snapshot(
        job.projectId,
        job.revision,
        snapshot,
      );
      if (job.controller.signal.aborted) {
        final = "cancelled";
        return;
      }
      const { buildDocument } = await import("@hyperframes/sdk");
      const doc = buildDocument(
        (await readFile(resolve(snapshot, meta.entry))).toString(),
      );
      if (
        !(
          doc.width > 0 &&
          doc.width <= 3840 &&
          doc.height > 0 &&
          doc.height <= 2160 &&
          doc.compositionDuration > 0 &&
          doc.compositionDuration <= 3600
        )
      )
        fail(
          "E_PROJECT",
          "Unsupported composition dimensions/duration",
          "snapshot",
        );
      const fps = 30;
      let args, produced;
      if (job.kind === "frame") {
        if (p.time !== undefined && p.times !== undefined)
          fail("E_PARAMS", "Provide exactly one of time or times");
        const times =
          p.time !== undefined ? [p.time] : normalizeFrameTimes(p.times);
        for (const time of times)
          number(time, 0, doc.compositionDuration - 1 / 30);
        if (times.length === 1) {
          // A single time behaves exactly like the legacy frame contract: one
          // full-size PNG, metadata time/frame, no sheet.
          job.time = times[0];
          job.frame = times[0] * fps;
        } else {
          // One HyperFrames launch captures every still; the published artifact
          // is the single horizontally tiled contact sheet built below.
          job.times = times.slice();
        }
        const frames = resolve(job.temp, "frames");
        const at =
          p.time !== undefined
            ? String(p.time)
            : times.map(frameTimeLabel).join(",");
        args = [
          "snapshot",
          snapshot,
          "--at",
          at,
          "--no-end",
          "--keep",
          "--describe",
          "false",
          "--no-browser-gpu",
          "-o",
          frames,
        ];
        if (times.length === 1)
          produced = resolve(frames, `at-${frameTimeLabel(times[0])}s.png`);
      } else {
        produced = resolve(job.temp, "render.mp4");
        args = [
          "render",
          snapshot,
          "-c",
          meta.entry,
          "-o",
          produced,
          "--fps",
          "30",
          "--format",
          "mp4",
          "--quality",
          "standard",
          "--workers",
          "1",
          "--no-browser-gpu",
        ];
      }
      await mkdir(resolve(job.temp, "tmp"));
      job.state = "running";
      job.stage = "engine";
      const result = await runOwned([process.execPath, cli, ...args], {
        temp: job.temp,
        cwd: packageRoot,
        env: this.env(job.temp, job.kind),
        signal: job.controller.signal,
        timeoutMs:
          p.timeoutMs ??
          (job.kind === "render"
            ? renderTimeoutMs(Math.round(doc.compositionDuration * 30))
            : FRAME_TIMEOUT_MS),
        onOutput: (s) => {
          const m = s.match(/Streaming frame (\d+)\/(\d+)/);
          if (m) {
            job.stage = "capture";
            job.progress = Number(m[1]) / Number(m[2]);
          }
        },
      });
      job.ownedPids = result.ownedPids || [];
      job.survivors = result.survivors || [];
      if (result.status === "cancelled" || job.controller.signal.aborted) {
        final = "cancelled";
        return;
      }
      if (result.status === "timed_out") {
        // `stage:"finished"` is set unconditionally in the finally block, so a
        // timed-out job is only explainable through its error record.
        job.error = {
          code: "E_TIMEOUT",
          message: "渲染或校验超出时间预算，未发布任何产物",
          stage: job.stage,
        };
        final = "timed_out";
        return;
      }
      if (result.status !== "complete")
        fail("E_RENDER", "Upstream engine failed", "engine");
      if (job.kind === "render" && meta.timeline) {
        const mix = audioMixPlan(meta.timeline, snapshot);
        if (mix.sources.length) {
          job.stage = "audio";
          const mixed = resolve(job.temp, "mixed.mp4");
          const mixArgs = [
            "-i",
            produced,
            ...mix.sources.flatMap((p) => ["-i", p]),
          ];
          const measure = await runOwned(
            [
              "ffmpeg",
              "-hide_banner",
              "-nostats",
              ...mixArgs,
              "-filter_complex",
              mix.filter.replace(
                `loudnorm=I=${mix.targetLufs}:TP=-1.5:LRA=11`,
                `loudnorm=I=${mix.targetLufs}:TP=-1.5:LRA=50:print_format=json`,
              ),
              "-map",
              "[aout]",
              "-f",
              "null",
              "-",
            ],
            {
              temp: job.temp,
              cwd: packageRoot,
              env: this.env(job.temp, job.kind),
              signal: job.controller.signal,
              timeoutMs: Math.min(
                MAX_RENDER_TIMEOUT_MS,
                Math.max(120000, mix.duration * 2000),
              ),
            },
          );
          if (measure.status === "cancelled") {
            final = "cancelled";
            return;
          }
          if (measure.status !== "complete")
            fail("E_AUDIO_MIX", "Audio loudness measurement failed", "audio");
          const report = measure.output.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
          if (!report)
            fail("E_AUDIO_MIX", "Audio loudness measurement missing", "audio");
          const levels = JSON.parse(report);
          if (Number.isFinite(Number(levels.input_i))) {
            const norm = `loudnorm=I=${mix.targetLufs}:TP=-1.5:LRA=50:measured_I=${levels.input_i}:measured_TP=${levels.input_tp}:measured_LRA=${levels.input_lra}:measured_thresh=${levels.input_thresh}:offset=${levels.target_offset}:linear=true`;
            mix.filter = mix.filter.replace(
              `loudnorm=I=${mix.targetLufs}:TP=-1.5:LRA=11`,
              norm,
            );
          }
          const run = await runOwned(
            [
              "ffmpeg",
              "-v",
              "error",
              "-y",
              "-i",
              produced,
              ...mix.sources.flatMap((p) => ["-i", p]),
              "-filter_complex",
              mix.filter,
              "-map",
              "0:v:0",
              "-map",
              "[aout]",
              "-c:v",
              "copy",
              "-c:a",
              "aac",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-b:a",
              "192k",
              "-t",
              String(mix.duration),
              "-movflags",
              "+faststart",
              mixed,
            ],
            {
              temp: job.temp,
              cwd: packageRoot,
              env: this.env(job.temp, job.kind),
              signal: job.controller.signal,
              timeoutMs: Math.min(
                MAX_RENDER_TIMEOUT_MS,
                Math.max(120000, mix.duration * 2000),
              ),
            },
          );
          job.ownedPids.push(...(run.ownedPids || []));
          if (run.status === "cancelled") {
            final = "cancelled";
            return;
          }
          if (run.status !== "complete") {
            job.audioFailures = [
              {
                code: "E_AUDIO_MIX",
                message: "音频混音失败，未发布静音替代品",
              },
            ];
            fail("E_AUDIO_MIX", "Audio mixing failed", "audio");
          }
          const probe = await runOwned(
            [
              "ffprobe",
              "-v",
              "error",
              "-select_streams",
              "a:0",
              "-show_entries",
              "stream=codec_name,sample_rate,channels",
              "-of",
              "json",
              mixed,
            ],
            {
              temp: job.temp,
              cwd: packageRoot,
              env: this.env(job.temp, job.kind),
              signal: job.controller.signal,
              timeoutMs: 15000,
            },
          );
          const stream =
            probe.status === "complete"
              ? JSON.parse(probe.output).streams?.[0]
              : null;
          if (
            stream?.codec_name !== "aac" ||
            Number(stream.sample_rate) !== 48000 ||
            stream.channels !== 2
          )
            fail("E_AUDIO_MIX", "Audio stream validation failed", "audio");
          job.audio = {
            codec: "aac",
            sampleRate: 48000,
            channels: 2,
            targetLufs: meta.timeline.settings.loudnessTargetLufs ?? -16,
            sources: mix.sources.length,
          };
          await rename(mixed, produced);
        }
      }
      job.stage = "validate";
      let bytes;
      let metadata;
      if (job.kind === "render") {
        bytes = await readFile(produced);
        const frames = Math.round(doc.compositionDuration * fps);
        const probeRun = await runOwned(
          [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration",
            "-of",
            "json",
            produced,
          ],
          {
            temp: job.temp,
            cwd: packageRoot,
            env: this.env(job.temp, job.kind),
            signal: job.controller.signal,
            timeoutMs: validateProbeTimeoutMs(frames),
          },
        );
        job.ownedPids.push(...(probeRun.ownedPids || []));
        if (probeRun.status === "cancelled" || job.controller.signal.aborted) {
          final = "cancelled";
          return;
        }
        if (probeRun.status === "timed_out") {
          job.error = {
            code: "E_TIMEOUT",
            message: "渲染或校验超出时间预算，未发布任何产物",
            stage: job.stage,
          };
          final = "timed_out";
          return;
        }
        if (probeRun.status !== "complete")
          fail("E_METADATA", "Metadata probe failed", "validate");
        const probe = JSON.parse(probeRun.output);
        const stream = probe.streams?.[0];
        if (
          stream?.codec_name !== "h264" ||
          stream.width !== doc.width ||
          stream.height !== doc.height ||
          stream.r_frame_rate !== "30/1" ||
          Number(stream.nb_read_frames) !== frames ||
          Math.abs(Number(probe.format.duration) - doc.compositionDuration) >
            1 / fps
        )
          fail("E_METADATA", "MP4 metadata validation failed", "validate");
        metadata = { ...stream, duration: Number(probe.format.duration) };
      } else if (job.times !== undefined) {
        // Every still from the single snapshot run must be a valid full-size
        // PNG before it is tiled; a skipped or clipped capture fails the job.
        const frames = job.times.map((time) =>
          resolve(job.temp, "frames", `at-${frameTimeLabel(time)}s.png`),
        );
        for (const frame of frames) {
          let frameBytes;
          try {
            frameBytes = await readFile(frame);
          } catch {
            fail("E_METADATA", "PNG validation failed", "validate");
          }
          if (!validPng(frameBytes, doc.width, doc.height))
            fail("E_METADATA", "PNG validation failed", "validate");
        }
        const layout = contactSheetLayout(doc.width, doc.height, frames.length);
        const sheet = resolve(job.temp, "contact-sheet.png");
        job.stage = "sheet";
        const sheetRun = await runOwned(
          contactSheetArgs(frames, layout, sheet),
          {
            temp: job.temp,
            cwd: packageRoot,
            env: this.env(job.temp, job.kind),
            signal: job.controller.signal,
            timeoutMs: CONTACT_SHEET_TIMEOUT_MS,
          },
        );
        job.ownedPids.push(...(sheetRun.ownedPids || []));
        if (sheetRun.status === "cancelled" || job.controller.signal.aborted) {
          final = "cancelled";
          return;
        }
        if (sheetRun.status === "timed_out") {
          final = "timed_out";
          return;
        }
        if (sheetRun.status !== "complete")
          fail("E_RENDER", "Contact sheet composition failed", "sheet");
        job.stage = "validate";
        produced = sheet;
        bytes = await readFile(produced);
        if (!validPng(bytes, layout.sheetWidth, layout.sheetHeight))
          fail("E_METADATA", "PNG validation failed", "validate");
        metadata = {
          width: layout.sheetWidth,
          height: layout.sheetHeight,
          times: job.times.slice(),
          tileWidth: layout.tileWidth,
          tileHeight: layout.tileHeight,
          sheetWidth: layout.sheetWidth,
          sheetHeight: layout.sheetHeight,
        };
      } else {
        bytes = await readFile(produced);
        if (!validPng(bytes, doc.width, doc.height))
          fail("E_METADATA", "PNG validation failed", "validate");
        metadata = {
          width: doc.width,
          height: doc.height,
          time: job.time,
          frame: job.frame,
        };
      }
      if (job.controller.signal.aborted) {
        final = "cancelled";
        return;
      }
      const name = job.jobId + (job.kind === "render" ? ".mp4" : ".png");
      await rename(produced, resolve(this.config.outputRoot, name));
      job.artifact = {
        projectId: job.projectId,
        revision: job.revision,
        jobId: job.jobId,
        name,
        hash: artifactHash(bytes),
        bytes: bytes.length,
        metadata,
        tools: this.tools,
      };
      final = "succeeded";
    } catch (e) {
      if (job.stage === "audio")
        job.audioFailures ??= [
          {
            code: "E_AUDIO_MIX",
            message: "音频混音或校验失败，未发布静音替代品",
          },
        ];
      job.error = {
        code: e.code?.startsWith("E_") ? e.code : "E_RENDER",
        message: "Job failed without publishing an artifact",
        stage: job.stage,
      };
    } finally {
      try {
        if (job.temp) await rm(job.temp, { recursive: true, force: true });
        job.cleaned = true;
      } catch {
        final = "failed";
        job.error = {
          code: "E_CLEANUP",
          message: "Private job cleanup failed",
          stage: "cleanup",
        };
      }
      // A cancellation can arrive while the private directory is being
      // removed. The UUID output belongs exclusively to this job, so retract
      // it before publishing a terminal cancelled/failed result.
      if (final !== "succeeded" || job.controller.signal.aborted) {
        if (job.artifact) {
          try {
            await rm(resolve(this.config.outputRoot, job.artifact.name), {
              force: true,
            });
            delete job.artifact;
          } catch {
            final = "failed";
            job.error = {
              code: "E_CLEANUP",
              message: "Published artifact cleanup failed",
              stage: "cleanup",
            };
          }
        }
        if (job.controller.signal.aborted && job.error?.code !== "E_CLEANUP")
          final = "cancelled";
      }
      job.state = final;
      job.stage = "finished";
    }
  }
}
export function versions(config = {}) {
  const version = (exe, args) => {
    try {
      return execFileSync(exe, args, {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\n")[0]
        .trim();
    } catch {
      return "unavailable";
    }
  };
  const pkg = (name) =>
    JSON.parse(
      readFileSync(dependencyManifest(name)),
    ).version;
  return {
    node: process.version,
    platform: process.platform,
    hyperframes: pkg("hyperframes"),
    sdk: pkg("@hyperframes/sdk"),
    gsap: pkg("gsap"),
    fps: 30,
    browser: version(
      config.browserPath ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--version"],
    ),
    ffmpeg: version("ffmpeg", ["-version"]),
    ffprobe: version("ffprobe", ["-version"]),
  };
}
