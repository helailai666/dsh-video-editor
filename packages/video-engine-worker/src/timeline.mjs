import { createReadStream, constants } from "node:fs";
import { parseHTML } from "linkedom";
// Timeline truth and its transaction journal share one atomic file. Generated
// HTML is never an input to editing. Media bytes stay outside JSON/history.
import {
  open,
  readFile,
  writeFile,
  rename,
  mkdir,
  stat,
  realpath,
  link,
  copyFile,
  rm,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { runOwned } from "./process.mjs";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { buildDocument } from "@hyperframes/sdk";
import { fail, keys, string, revision as validRevision } from "./errors.mjs";
import { validateComposition } from "./composition.mjs";
import { inside } from "./registry.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const canonical = (x) =>
  JSON.stringify(x, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export const timelineRevision = (t) =>
  hash(canonical({ schema: "dsh-video/project@2", timeline: t }));
const id = (prefix) => prefix + randomBytes(8).toString("hex");
const esc = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const int = (v, min = 0, max = 108000) => {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    fail("E_RANGE", "Expected an integer frame in range", "timeline");
  return v;
};
const num = (v, min, max) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail("E_RANGE", "Number outside supported range", "timeline");
  return v;
};
const text = (v) => {
  string(v, 120);
  return v;
};
export function validateTimeline(t) {
  if (
    t?.schema !== "dsh-video/timeline@1" ||
    !Array.isArray(t.tracks) ||
    !Array.isArray(t.assets)
  )
    fail("E_TIMELINE_INVALID", "Invalid timeline schema", "timeline");
  if (!t || typeof t !== "object" || !t.settings)
    fail("E_TIMELINE_INVALID", "Timeline settings are missing", "timeline");
  const s = t.settings;
  if (
    s.loudnessTargetLufs !== undefined &&
    (!Number.isFinite(s.loudnessTargetLufs) ||
      s.loudnessTargetLufs < -70 ||
      s.loudnessTargetLufs > -5)
  )
    fail(
      "E_TIMELINE_INVALID",
      "Loudness target must be between -70 and -5 LUFS",
      "timeline",
    );
  int(s.width, 320, 3840);
  int(s.height, 180, 2160);
  int(s.durationFrames, 1);
  if (s.fps !== 30 || !/^#[a-f0-9]{6}$/i.test(s.background))
    fail("E_TIMELINE_INVALID", "Invalid settings", "timeline");
  if (
    t.assets.length > 256 ||
    t.tracks.filter((x) => x.kind === "video").length > 6 ||
    t.tracks.filter((x) => x.kind === "audio").length > 3
  )
    fail("E_LIMIT", "Timeline capacity exceeded", "timeline");
  const ids = new Set(),
    assets = new Map(t.assets.map((a) => [a.assetId, a]));
  let count = 0;
  for (const tr of t.tracks) {
    if (
      !/^tr_[a-z0-9]+$/.test(tr.trackId) ||
      ids.has(tr.trackId) ||
      !["video", "audio"].includes(tr.kind) ||
      !Array.isArray(tr.clips)
    )
      fail("E_TIMELINE_INVALID", "Invalid track", "timeline");
    if (tr.gainDb !== undefined) num(tr.gainDb, -60, 12);
    for (const flag of ["muted", "hidden", "locked"])
      if (tr[flag] !== undefined && typeof tr[flag] !== "boolean")
        fail("E_TIMELINE_INVALID", "Invalid track flag");
    ids.add(tr.trackId);
    if (tr.clips.length > 200)
      fail("E_LIMIT", "Track clip capacity exceeded", "timeline");
    let end = 0;
    for (const c of tr.clips) {
      if (!/^cl_[a-z0-9]+$/.test(c.clipId) || ids.has(c.clipId))
        fail("E_TIMELINE_INVALID", "Duplicate or invalid clip ID", "timeline");
      ids.add(c.clipId);
      count++;
      int(c.startFrame);
      int(c.durationFrames, 1);
      if (c.startFrame < end)
        fail("E_OVERLAP", "Clips overlap on one track", "timeline");
      end = c.startFrame + c.durationFrames;
      if (end > s.durationFrames)
        fail("E_RANGE", "Clip exceeds project duration", "timeline");
      if (c.kind === "composition") {
        if (
          tr.kind !== "video" ||
          !c.scene ||
          !/^scenes\/[a-f0-9]{64}\.html$/.test(c.scene.path)
        )
          fail("E_TRACK_KIND", "Scene requires a visual track", "timeline");
        int(c.sourceInFrame ?? 0);
        if ((c.sourceInFrame ?? 0) + c.durationFrames > c.scene.durationFrames)
          fail("E_RANGE", "Scene extends past its source duration", "timeline");
      } else {
        const a = assets.get(c.assetId);
        if (!a)
          fail("E_ASSET_NOT_FOUND", "Referenced asset is missing", "timeline");
        if ((tr.kind === "audio") !== (a.kind === "audio" || (c.audioOnly === true && a.kind === "video" && a.hasAudio === true)))
          fail(
            "E_TRACK_KIND",
            "Audio assets require an audio track",
            "timeline",
          );
        if ((c.kind === "image") !== (a.kind === "image"))
          fail("E_ASSET_KIND", "Clip and asset kinds differ", "timeline");
        if (c.kind !== "image") {
          int(c.sourceInFrame);
          num(c.speed, 0.25, 4);
          if (
            c.sourceInFrame + (c.durationFrames / 30) * c.speed * a.fps >
            a.durationFrames + 1
          )
            fail("E_RANGE", "Clip extends past source media", "timeline");
        }
      }
      if (c.volumeDb !== undefined) num(c.volumeDb, -60, 12);
      if (c.sourceGainDb !== undefined) {if(!c.audioOnly) fail("E_TIMELINE_INVALID","Inherited gain requires detached audio"); num(c.sourceGainDb,-60,12);}
      if (c.fadeInFrames !== undefined)
        int(c.fadeInFrames, 0, c.durationFrames);
      if (c.fadeOutFrames !== undefined)
        int(c.fadeOutFrames, 0, c.durationFrames);
      const next = tr.clips[tr.clips.indexOf(c) + 1];
      if (
        c.outTransition &&
        (!next ||
          next.startFrame !== end ||
          c.outTransition.type !== "crossfade" ||
          c.kind === "composition" ||
          next.kind === "composition" ||
          c.outTransition.durationFrames >
            Math.min(c.durationFrames, next.durationFrames) / 2 ||
          c.outTransition.durationFrames > 90 ||
          c.outTransition.durationFrames < 1)
      )
        fail(
          "E_TRANSITION_INVALID",
          "Crossfade needs adjacent clips and at most half their duration",
          "timeline",
        );
    }
  }
  if (count > 500)
    fail("E_LIMIT", "Project clip capacity exceeded", "timeline");
  return t;
}
export function applyOperations(input, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 32)
    fail("E_PARAMS", "Provide 1–32 operations", "timeline");
  const t = structuredClone(input),
    lineage = [],
    applied = [];
  const track = (x) => {
    const tr = t.tracks.find((tr) => tr.trackId === x);
    if (!tr) fail("E_TRACK_NOT_FOUND", "Track no longer exists", "timeline");
    if (tr.locked) fail("E_TRACK_LOCKED", "Track is locked", "timeline");
    return tr;
  };
  const find = (x) => {
    for (const tr of t.tracks) {
      const c = tr.clips.find((c) => c.clipId === x);
      if (c) {
        track(tr.trackId);
        return { tr, c };
      }
    }
    fail("E_CLIP_NOT_FOUND", "Clip no longer exists", "timeline");
  };
  const asset = (x) => {
    const a = t.assets.find((a) => a.assetId === x);
    if (!a) fail("E_ASSET_NOT_FOUND", "Asset no longer exists", "timeline");
    return a;
  };
  const shift = (tr, from, delta, except) =>
    tr.clips.forEach((c) => {
      if (c !== except && c.startFrame >= from) c.startFrame += delta;
    });
  const place = (tr, c, mode) => {
    if (mode === undefined || mode === "reject") {
    } else if (mode === "ripple") shift(tr, c.startFrame, c.durationFrames, c);
    else if (mode === "overwrite") {
      tr.clips = tr.clips.filter(
        (x) =>
          x === c ||
          x.startFrame >= c.startFrame + c.durationFrames ||
          x.startFrame + x.durationFrames <= c.startFrame,
      );
    } else fail("E_PARAMS", "Invalid placement mode", "timeline");
    tr.clips.push(c);
  };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (!o || typeof o.op !== "string")
      fail("E_PARAMS", `Invalid operation ${i}`, "timeline");
    string(o.op, 48);
    const targetLabel = t.tracks
      .flatMap((tr) => tr.clips)
      .find((c) => c.clipId === o.clipId)?.label;
    const detail =
      o.op === "clip.volume"
        ? `${o.volumeDb} dB`
        : o.op === "clip.fade"
          ? `${o.inFrames / 30}s → ${o.outFrames / 30}s`
          : o.op === "clip.speed"
            ? `${o.speed}×`
            : o.op === "clip.move"
              ? `${o.startFrame / 30}s`
              : o.op === "clip.trim"
                ? `${o.edge}: ${o.deltaFrames / 30}s`
                : o.op === "clip.set"
                  ? (o.patch?.label ??
                    (o.patch?.muted === true
                      ? "静音"
                      : o.patch?.muted === false
                        ? "取消静音"
                        : ""))
                  : o.op === "timeline.settings" &&
                      o.durationFrames !== undefined
                    ? `${o.durationFrames / 30}s`
                    : "";
    let affected = [],
      created = [];
    try {
      if (o.op === "track.add") {
        keys(o, ["op", "kind", "name", "afterTrackId"]);
        if (!["video", "audio"].includes(o.kind))
          fail("E_TRACK_KIND", "Invalid track kind");
        const tr = {
          trackId: id("tr_"),
          kind: o.kind,
          name: o.name
            ? text(o.name)
            : o.kind === "audio"
              ? "音频轨"
              : "视频轨",
          clips: [],
        };
        let at = o.afterTrackId
          ? t.tracks.indexOf(track(o.afterTrackId)) + 1
          : t.tracks.length;
        t.tracks.splice(at, 0, tr);
        created = [tr.trackId];
      } else if (o.op === "track.update") {
        keys(o, ["op", "trackId", "patch"]);
        keys(o.patch, ["name", "gainDb", "muted", "hidden", "locked"]);
        const tr = t.tracks.find((x) => x.trackId === o.trackId);
        if (!tr) fail("E_TRACK_NOT_FOUND", "Track no longer exists");
        if (o.patch.name !== undefined) text(o.patch.name);
        if (o.patch.gainDb !== undefined) num(o.patch.gainDb, -60, 12);
        for (const k of ["muted", "hidden", "locked"])
          if (o.patch[k] !== undefined && typeof o.patch[k] !== "boolean")
            fail("E_PARAMS", "Expected boolean");
        Object.assign(tr, o.patch);
      } else if (o.op === "track.remove") {
        keys(o, ["op", "trackId", "force"]);
        const tr = track(o.trackId);
        if (tr.clips.length && !o.force)
          fail("E_TRACK_NOT_EMPTY", "Track contains clips");
        affected = tr.clips.map((c) => c.clipId);
        t.tracks.splice(t.tracks.indexOf(tr), 1);
      } else if (o.op === "timeline.settings") {
        keys(o, [
          "op",
          "durationFrames",
          "durationMode",
          "background",
          "loudnessTargetLufs",
          "width",
          "height",
        ]);
        const { op, ...patch } = o;
        Object.assign(t.settings, patch);
        if (o.durationFrames !== undefined && o.durationMode === undefined)
          t.settings.durationMode = "fixed";
        if (
          t.settings.durationMode !== undefined &&
          !["auto", "fixed"].includes(t.settings.durationMode)
        )
          fail("E_PARAMS", "Invalid duration mode");
      } else if (o.op === "clip.insert" || o.op === "scene.insert") {
        keys(o, [
          "op",
          "assetId",
          "trackId",
          "startFrame",
          "durationFrames",
          "sourceInFrame",
          "mode",
          "label",
          "scene",
        ]);
        const tr = track(o.trackId);
        int(o.startFrame);
        const a = o.op === "clip.insert" ? asset(o.assetId) : null;
        const c = {
          clipId: id("cl_"),
          kind: a ? (a.kind === "image" ? "image" : "media") : "composition",
          startFrame: o.startFrame,
          durationFrames:
            o.durationFrames ??
            (a?.kind === "image"
              ? 150
              : a
                ? Math.floor(
                    ((a.durationFrames - (o.sourceInFrame ?? 0)) / a.fps) * 30,
                  )
                : o.scene.durationFrames),
          label: o.label ?? a?.name ?? "场景",
          ...(a ? { assetId: a.assetId } : { scene: o.scene }),
          sourceInFrame: o.sourceInFrame ?? 0,
          speed: 1,
        };
        place(tr, c, o.mode);
        created = affected = [c.clipId];
      } else if (o.op === "clip.reorder") {
        keys(o, ["op", "trackId", "clipIds"]);
        const tr = track(o.trackId);
        if (
          !Array.isArray(o.clipIds) ||
          new Set(o.clipIds).size !== o.clipIds.length ||
          o.clipIds.length !== tr.clips.length ||
          o.clipIds.some((x) => !tr.clips.some((c) => c.clipId === x))
        )
          fail(
            "E_PARAMS",
            "Reorder must name every clip on the track exactly once",
          );
        let at = tr.clips[0]?.startFrame ?? 0;
        tr.clips = o.clipIds.map((x) => {
          const c = tr.clips.find((c) => c.clipId === x);
          c.startFrame = at;
          at += c.durationFrames;
          return c;
        });
        affected = [...o.clipIds];
      } else {
        const { tr, c } = find(o.clipId);
        affected = [c.clipId];
        const oldEnd = c.startFrame + c.durationFrames,
          oldDur = c.durationFrames;
        switch (o.op) {
          case "clip.detachAudio": {
            keys(o, ["op", "clipId"]);
            const a = t.assets.find(x => x.assetId === c.assetId);
            if (tr.kind !== "video" || c.kind !== "media" || !a?.hasAudio)
              fail("E_NO_AUDIO", "此视频无音频");
            if (t.tracks.some(x => x.clips.some(y => y.detachedFrom === c.clipId)))
              fail("E_AUDIO_DETACHED", "此片段原声已分离");
            let target = t.tracks.find(x => x.kind === "audio" && !x.locked && !x.muted && !(x.gainDb ?? 0) && x.clips.length < 200 && x.clips.every(y => y.startFrame >= c.startFrame + c.durationFrames || y.startFrame + y.durationFrames <= c.startFrame));
            if (!target) {
              if (t.tracks.filter(x => x.kind === "audio").length >= 3)
                fail("E_LIMIT", "音频轨已满，请先腾出一条可用音轨");
              target = {trackId:id("tr_"),kind:"audio",name:"音频轨",clips:[]};
              t.tracks.push(target);
            }
            const audio = {...c, clipId:id("cl_"), audioOnly:true, detachedFrom:c.clipId,
              label:((c.label ?? a.name ?? "视频").slice(0,110) + " · 原声"),
              volumeDb:c.volumeDb ?? 0, sourceGainDb:tr.gainDb ?? 0,
              muted:!!(c.muted || tr.muted)};
            delete audio.outTransition;
            target.clips.push(audio);
            c.muted = true;
            created = [audio.clipId]; affected.push(audio.clipId);
            break;
          }
          case "clip.split": {
            keys(o, ["op", "clipId", "atFrame"]);
            int(o.atFrame, c.startFrame + 1, oldEnd - 1);
            const right = structuredClone(c);
            right.clipId = id("cl_");
            right.startFrame = o.atFrame;
            right.durationFrames = oldEnd - o.atFrame;
            const fps = c.kind === "media" ? asset(c.assetId).fps : 30;
            right.sourceInFrame =
              (c.sourceInFrame ?? 0) +
              Math.round(
                ((o.atFrame - c.startFrame) * (c.speed ?? 1) * fps) / 30,
              );
            c.durationFrames = o.atFrame - c.startFrame;
            if (c.fadeInFrames !== undefined)
              c.fadeInFrames = Math.min(c.fadeInFrames, c.durationFrames);
            if (right.fadeOutFrames !== undefined)
              right.fadeOutFrames = Math.min(
                right.fadeOutFrames,
                right.durationFrames,
              );
            c.fadeOutFrames = 0;
            right.fadeInFrames = 0;
            delete c.outTransition;
            tr.clips.push(right);
            created = [right.clipId];
            affected.push(right.clipId);
            lineage.push({
              sourceClipId: c.clipId,
              keptClipId: c.clipId,
              createdClipId: right.clipId,
              atFrame: o.atFrame,
            });
            break;
          }
          case "clip.trim": {
            keys(o, ["op", "clipId", "edge", "deltaFrames", "ripple"]);
            int(Math.abs(o.deltaFrames));
            if (o.edge === "in") {
              c.startFrame += o.deltaFrames;
              c.durationFrames -= o.deltaFrames;
              if (c.kind !== "image")
                c.sourceInFrame += Math.round(
                  (o.deltaFrames *
                    (c.speed ?? 1) *
                    (c.kind === "media" ? asset(c.assetId).fps : 30)) /
                    30,
                );
            } else if (o.edge === "out") c.durationFrames += o.deltaFrames;
            else fail("E_PARAMS", "Trim edge must be in or out");
            if (c.fadeInFrames !== undefined)
              c.fadeInFrames = Math.min(c.fadeInFrames, c.durationFrames);
            if (c.fadeOutFrames !== undefined)
              c.fadeOutFrames = Math.min(c.fadeOutFrames, c.durationFrames);
            if (o.ripple)
              shift(tr, oldEnd, c.startFrame + c.durationFrames - oldEnd, c);
            break;
          }
          case "clip.delete":
            keys(o, ["op", "clipId", "ripple"]);
            tr.clips.splice(tr.clips.indexOf(c), 1);
            if (o.ripple) shift(tr, oldEnd, -c.durationFrames);
            break;
          case "clip.move": {
            keys(o, ["op", "clipId", "startFrame", "trackId", "mode"]);
            int(o.startFrame);
            const dest = o.trackId ? track(o.trackId) : tr;
            tr.clips.splice(tr.clips.indexOf(c), 1);
            if (o.mode === "ripple") shift(tr, oldEnd, -c.durationFrames);
            c.startFrame = o.startFrame;
            place(dest, c, o.mode);
            break;
          }
          case "clip.duplicate": {
            keys(o, ["op", "clipId", "startFrame", "trackId", "mode"]);
            const copy = {
              ...structuredClone(c),
              clipId: id("cl_"),
              startFrame: o.startFrame ?? oldEnd,
            };
            delete copy.outTransition;
            place(o.trackId ? track(o.trackId) : tr, copy, o.mode);
            created = [copy.clipId];
            break;
          }
          case "clip.replace": {
            keys(o, ["op", "clipId", "assetId", "keepTiming"]);
            const a = asset(o.assetId);
            c.assetId = a.assetId;
            c.kind = a.kind === "image" ? "image" : "media";
            delete c.scene;
            c.sourceInFrame = 0;
            c.speed = 1;
            if (o.keepTiming === false)
              c.durationFrames =
                a.kind === "image"
                  ? 150
                  : Math.floor((a.durationFrames / a.fps) * 30);
            break;
          }
          case "clip.speed":
            keys(o, ["op", "clipId", "speed", "ripple"]);
            if (c.kind !== "media")
              fail("E_ASSET_KIND", "Speed requires a video clip");
            num(o.speed, 0.25, 4);
            c.durationFrames = Math.max(
              1,
              Math.round((c.durationFrames * c.speed) / o.speed),
            );
            c.speed = o.speed;
            if (c.fadeInFrames !== undefined)
              c.fadeInFrames = Math.min(c.fadeInFrames, c.durationFrames);
            if (c.fadeOutFrames !== undefined)
              c.fadeOutFrames = Math.min(c.fadeOutFrames, c.durationFrames);
            if (o.ripple) shift(tr, oldEnd, c.durationFrames - oldDur, c);
            break;
          case "clip.volume":
            keys(o, ["op", "clipId", "volumeDb"]);
            c.volumeDb = num(o.volumeDb, -60, 12);
            break;
          case "clip.fade":
            keys(o, ["op", "clipId", "inFrames", "outFrames"]);
            c.fadeInFrames = int(o.inFrames, 0, c.durationFrames);
            c.fadeOutFrames = int(o.outFrames, 0, c.durationFrames);
            break;
          case "clip.set":
            keys(o, ["op", "clipId", "patch"]);
            keys(o.patch, ["label", "muted"]);
            if (o.patch.label !== undefined) text(o.patch.label);
            if (
              o.patch.muted !== undefined &&
              typeof o.patch.muted !== "boolean"
            )
              fail("E_PARAMS", "Expected boolean");
            Object.assign(c, o.patch);
            break;
          case "clip.transition":
            keys(o, ["op", "clipId", "type", "durationFrames"]);
            if (o.durationFrames === 0) delete c.outTransition;
            else
              c.outTransition = {
                type: o.type,
                durationFrames: int(o.durationFrames, 1, 90),
              };
            break;
          case "scene.replace":
            keys(o, ["op", "clipId", "scene"]);
            if (c.kind !== "composition")
              fail("E_ASSET_KIND", "Scene replacement requires a scene clip");
            c.scene = o.scene;
            break;
          default:
            fail(
              "E_OP_UNSUPPORTED",
              `Unsupported operation: ${o.op}`,
              "timeline",
            );
        }
      }
      for (const tr of t.tracks)
        tr.clips.sort(
          (a, b) =>
            a.startFrame - b.startFrame || a.clipId.localeCompare(b.clipId),
        );
      if (
        (o.op !== "timeline.settings" && t.settings.durationMode !== "fixed") ||
        o.durationMode === "auto"
      )
        t.settings.durationFrames = Math.max(
          1,
          ...t.tracks.flatMap((tr) =>
            tr.clips.map((c) => c.startFrame + c.durationFrames),
          ),
        );
      validateTimeline(t);
      applied.push({
        index: i,
        op: o.op,
        affectedClipIds: affected,
        createdIds: created,
        summary: `${{ "clip.detachAudio": "分离音频", "clip.split": "切分片段", "clip.trim": "调整片段边缘", "clip.delete": "删除片段", "clip.move": "移动片段", "clip.reorder": "重排片段", "clip.insert": "加入素材", "clip.duplicate": "复制片段", "clip.speed": "调整速度", "clip.replace": "替换素材", "clip.set": "更新片段", "clip.volume": "调整音量", "clip.fade": "调整淡入淡出", "clip.transition": "调整转场", "track.add": "添加轨道", "track.update": "更新轨道", "track.remove": "删除轨道", "timeline.settings": "调整作品设置", "scene.insert": "加入 AI 场景", "scene.replace": "更新 AI 场景" }[o.op]}（${affected.length || created.length || 1} 个对象）${targetLabel ? ` · ${targetLabel}` : ""}${detail ? ` · ${detail}` : ""}`,
      });
    } catch (e) {
      e.message = `Operation ${i} (${o.op}): ${e.message}`;
      throw e;
    }
  }
  return { timeline: t, lineage, applied };
}
export function generateComposition(t) {
  const s = t.settings,
    d = s.durationFrames / 30;
  let body = "",
    animations = "";
  for (const [z, tr] of t.tracks.entries()) {
    // The first (uppermost) UI track is the foreground. Preserve track indices.
    const layer = t.tracks.length - z;
    for (const c of tr.clips) {
      let tag,
        attrs = "";
      const a = t.assets.find((a) => a.assetId === c.assetId);
      if (
        tr.hidden &&
        tr.kind !== "audio" &&
        !(c.kind === "media" && a?.hasAudio)
      )
        continue;
      if (c.kind === "media") {
        tag = a.kind === "audio" || c.audioOnly || tr.hidden ? "audio" : "video";
        const gain =
          tr.muted || c.muted
            ? 0
            : 10 ** (((tr.gainDb ?? 0) + (c.volumeDb ?? 0) + (c.sourceGainDb ?? 0)) / 20);
        attrs = `src="${esc(a.path)}" crossorigin="anonymous" playsinline preload="auto" data-media-start="${c.sourceInFrame / a.fps}" data-playback-rate="${c.speed}" data-volume="${gain}" data-has-audio="${a.kind === "audio" || a.hasAudio === true}" data-fade-in="${(c.fadeInFrames ?? 0) / 30}" data-fade-out="${(c.fadeOutFrames ?? 0) / 30}"`;
      } else if (c.kind === "image") {
        tag = "img";
        attrs = `src="${esc(a.path)}"`;
      } else {
        tag = "div";
        attrs = `data-composition-src="scene-${c.clipId}.html" data-composition-id="${c.clipId}" data-media-start="${(c.sourceInFrame ?? 0) / 30}" data-scene-offset="${(c.sourceInFrame ?? 0) / 30}"`;
      }
      const prev = tr.clips[tr.clips.indexOf(c) - 1];
      if (prev?.outTransition && !tr.hidden) {
        const fade = prev.outTransition.durationFrames / 30,
          at = c.startFrame / 30 - fade,
          ref = c.kind === "image" ? a.path : `transition-${c.clipId}.png`;
        body += `<img id="transition-${c.clipId}" data-start="${at}" data-duration="${fade}" src="${esc(ref)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${layer};opacity:0">`;
        animations += `main.fromTo('#transition-${c.clipId}',{opacity:0},{opacity:1,duration:${fade},ease:'none'},${at});`;
      }
      const start = c.startFrame / 30,
        duration = c.durationFrames / 30;
      body += `<${tag} id="${c.clipId}" data-hf-id="${c.clipId}" data-start="${start}" data-duration="${duration}" data-track-index="${z}" ${attrs} style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${layer}">${tag === "div" ? "" : ""}</${tag}>`;
    }
  }
  // A real GSAP timeline is registered even for a static film. A custom sync
  // method is shared by the preview runtime and renderer time traversal.
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${s.background}}#main{position:relative;width:${s.width}px;height:${s.height}px;overflow:hidden}</style><script src="assets/gsap.min.js"></script></head><body><div id="main" data-composition-id="main" data-width="${s.width}" data-height="${s.height}" data-duration="${d}">${body}</div><script>const main=gsap.timeline({paused:true});main.to({}, {duration:${d}});${animations}window.__timelines={main};</script></body></html>`;
}
async function safeDir(root, rel) {
  const target = resolve(root, rel);
  await mkdir(target, { recursive: true });
  if (!inside(root, await realpath(target)))
    fail("E_PATH", "Directory escapes project");
  return target;
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    const bytes = canonical(
      value.timeline
        ? {
            ...value.timeline,
            _history: value.history,
            _cursor: value.cursor,
            _operations: value.operations,
          }
        : value,
    );
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024)
      fail("E_LIMIT", "Timeline history capacity exceeded");
    const fd = await open(tmp, "wx", 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
export class Timelines {
  constructor(store, media) {
    this.store = store;
    this.media = media;
    this.proxyHashes = new Map();
  }
  dir(projectId) {
    this.store.assertActive(projectId);
    return this.store.handles.get(projectId);
  }
  async createEmpty(projectId, { width, height }) {
    const legacy = await this.store.readLegacy(projectId);
    const timeline = {
      schema: "dsh-video/timeline@1",
      projectId,
      settings: {
        width,
        height,
        fps: 30,
        sampleRate: 48000,
        background: "#000000",
        durationFrames: 150,
      },
      assets: [],
      legacyAssets: legacy.entries.filter(
        (x) => x.path !== legacy.manifest.entry,
      ),
      tracks: [
        { trackId: "tr_v1", kind: "video", name: "视频轨 1", clips: [] },
      ],
    };
    validateTimeline(timeline);
    await atomic(resolve(this.dir(projectId), "timeline.json"), {
      timeline,
      history: [],
      cursor: 0,
      operations: [],
    });
  }
  async load(projectId, { create = false } = {}) {
    const dir = this.dir(projectId),
      path = resolve(dir, "timeline.json");
    let journal;
    try {
      const actual = await realpath(path);
      if (!inside(dir, actual) || (await stat(actual)).size > 32 * 1024 * 1024)
        fail("E_PATH", "Invalid timeline path");
      journal = JSON.parse(await readFile(actual, "utf8"));
      if (journal.schema === "dsh-video/timeline@1") {
        const { _history, _cursor, _operations, ...timeline } = journal;
        journal = {
          timeline,
          history: _history,
          cursor: _cursor,
          operations: _operations,
        };
      }
    } catch (e) {
      if (e instanceof SyntaxError)
        fail(
          "E_TIMELINE_INVALID",
          "时间线文件损坏，请保留文件并恢复备份",
          "timeline",
        );
      if (e.code !== "ENOENT") throw e;
      if (!create) return null;
      const legacy = await this.store.readLegacy(projectId),
        html = legacy.files.get(legacy.manifest.entry).toString(),
        doc = buildDocument(html);
      const scenePath = `scenes/${hash(html)}.html`;
      await safeDir(dir, "scenes");
      await writeFile(resolve(dir, scenePath), html, { flag: "wx" }).catch(
        (e) => {
          if (e.code !== "EEXIST") throw e;
        },
      );
      await safeDir(dir, ".dsh-video");
      await safeDir(dir, ".dsh-video/legacy");
      await safeDir(dir, ".dsh-video/legacy/" + legacy.revision);
      for (const name of ["index.html", "project.json"]) {
        for (const rel of [
          ".dsh-video/legacy/" + legacy.revision + "/" + name,
          ".dsh-video/legacy/" + name,
        ])
          await copyFile(
            resolve(dir, name),
            resolve(dir, rel),
            constants.COPYFILE_EXCL,
          ).catch((e) => {
            if (e.code !== "EEXIST") throw e;
          });
      }
      const timeline = {
        schema: "dsh-video/timeline@1",
        projectId,
        settings: {
          width: doc.width,
          height: doc.height,
          fps: 30,
          sampleRate: 48000,
          background: "#000000",
          durationFrames: Math.max(3, Math.round(doc.compositionDuration * 30)),
        },
        assets: [],
        legacyAssets: legacy.entries.filter(
          (x) => x.path !== legacy.manifest.entry,
        ),
        tracks: [
          {
            trackId: "tr_v1",
            kind: "video",
            name: "视频轨 1",
            clips: [
              {
                clipId: id("cl_"),
                kind: "composition",
                startFrame: 0,
                durationFrames: Math.max(
                  3,
                  Math.round(doc.compositionDuration * 30),
                ),
                sourceInFrame: 0,
                scene: {
                  path: scenePath,
                  durationFrames: Math.round(doc.compositionDuration * 30),
                },
                label: "原作品",
              },
            ],
          },
        ],
      };
      journal = { timeline, history: [], cursor: 0, operations: [] };
      validateTimeline(timeline);
      await atomic(path, journal);
    }
    validateTimeline(journal.timeline);
    if (
      journal.timeline.projectId !== projectId ||
      !Array.isArray(journal.history) ||
      !Array.isArray(journal.operations) ||
      !Number.isInteger(journal.cursor) ||
      journal.cursor < 0 ||
      journal.cursor > journal.history.length
    )
      fail("E_TIMELINE_INVALID", "Invalid timeline journal");
    return journal;
  }
  async inspect(p) {
    const j = await this.load(p.projectId, { create: true }),
      t = j.timeline;
    const offset = int(p.offset ?? 0, 0, 500),
      limit = int(p.limit ?? 50, 1, 100);
    const all = t.tracks.flatMap((tr) => tr.clips);
    const shown = new Set(
      all
        .filter(
          (c) =>
            !p.trackId ||
            t.tracks.find((tr) => tr.trackId === p.trackId)?.clips.includes(c),
        )
        .slice(offset, offset + limit)
        .map((c) => c.clipId),
    );
    return {
      projectId: p.projectId,
      revision: timelineRevision(t),
      schema: t.schema,
      settings: t.settings,
      assets: t.assets.map(({ assetId, kind, fps, durationFrames, hasAudio }) => ({
        assetId,
        kind,
        fps,
        durationFrames,
        hasAudio,
      })),
      tracks: t.tracks.map((tr) => ({
        ...tr,
        clipCount: tr.clips.length,
        clips: tr.clips.filter((c) => shown.has(c.clipId)),
      })),
      totalClips: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
      historyCursor: j.cursor,
      lastChange: j.operations.length
        ? (() => {
            const r = j.operations.at(-1).result;
            return {
              operationId: j.operations.at(-1).operationId,
              revision: r.revision,
              beforeRevision: r.beforeRevision,
              written: r.written,
              changeSummary: r.changeSummary,
              undoHint: r.undoHint,
              step: r.step,
            };
          })()
        : null,
      undoHint: { canUndo: j.cursor > 0, canRedo: j.cursor < j.history.length },
    };
  }
  async syncAssets(t, { prune = false } = {}) {
    const dir = this.dir(t.projectId);
    let index;
    try {
      index = JSON.parse(
        await readFile(resolve(dir, "asset-index.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return;
    }
    if (prune)
      t.assets = t.assets.filter((a) =>
        index.assets.some((current) => current.assetId === a.assetId),
      );
    for (const a of index.assets) {
      const existing = t.assets.find((x) => x.assetId === a.assetId);
      if (existing) {
        if (existing.hasAudio === undefined)
          existing.hasAudio = a.kind === "audio" || a.media?.hasAudio === true;
        continue;
      }
      const fps = a.media?.fps || 30;
      t.assets.push({
        assetId: a.assetId,
        kind: a.kind,
        name: a.name,
        path: `media/${a.sha256.slice(0, 8)}.${a.ext}`,
        sha256: a.sha256,
        bytes: a.bytes,
        fps,
        durationFrames: Math.round((a.media?.durationSec ?? 0) * fps),
        hasAudio: a.kind === "audio" || a.media?.hasAudio === true,
        videoCodec: a.media?.videoCodec,
        width: a.media?.width,
        height: a.media?.height,
      });
    }
  }
  async apply(p, step) {
    string(p.operationId, 128);
    validRevision(p.expectedRevision);
    const dir = this.dir(p.projectId),
      j = await this.load(p.projectId, { create: true }),
      sig = hash(canonical({ step: step ?? null, ...p }));
    const prior = j.operations.find((x) => x.operationId === p.operationId);
    if (prior) {
      if (prior.signature !== sig)
        fail("E_OPERATION_REUSED", "operationId has a different request");
      return prior.result;
    }
    if (p.dryRun !== undefined && typeof p.dryRun !== "boolean")
      fail("E_PARAMS", "dryRun must be boolean");
    const before = timelineRevision(j.timeline);
    if (p.expectedOperationId !== undefined) {
      string(p.expectedOperationId, 128);
      if (p.expectedOperationId !== j.operations.at(-1)?.operationId)
        fail("E_REVISION_CONFLICT", "修改回执已过期，请查看当前修改");
    }
    if (
      p.expectedHistoryCursor !== undefined &&
      p.expectedHistoryCursor !== j.cursor
    )
      fail("E_REVISION_CONFLICT", "编辑历史已更新，请重新查看修改");
    if (before !== p.expectedRevision)
      fail("E_REVISION_CONFLICT", "作品已更新，请刷新时间线后重试", "timeline");
    if (j.operations.length >= 2048)
      fail("E_LIMIT", "Operation history is full");
    let next,
      applied = [],
      lineage = [];
    if (step) {
      if (step === "undo") {
        if (!j.cursor) fail("E_HISTORY_EMPTY", "没有可撤销的操作");
        next = structuredClone(j.history[--j.cursor].before);
      } else {
        if (j.cursor >= j.history.length)
          fail("E_HISTORY_EMPTY", "没有可重做的操作");
        next = structuredClone(j.history[j.cursor++].after);
      }
    } else {
      next = structuredClone(j.timeline);
      await this.syncAssets(next);
      ({ timeline: next, applied, lineage } = applyOperations(next, p.ops));
    }
    const after = timelineRevision(next),
      changed = before !== after;
    const result = {
      projectId: p.projectId,
      operationId: p.operationId,
      beforeRevision: before,
      step: step ?? "apply",
      dryRun: p.dryRun === true,
      revision: p.dryRun ? before : after,
      written: !p.dryRun && changed,
      timeline: true,
      settings: next.settings,
      applied,
      lineage,
      changeSummary: {
        opCount: applied.length,
        summary:
          step === "undo"
            ? "已撤销上一步"
            : step === "redo"
              ? "已重做上一步"
              : applied.map((x) => x.summary).join("；"),
        affectedClipIds: [
          ...new Set(applied.flatMap((x) => x.affectedClipIds)),
        ],
        durationBefore: j.timeline.settings.durationFrames,
        durationAfter: next.settings.durationFrames,
      },
      undoHint: {
        historyCursor: step || !changed ? j.cursor : Math.min(50, j.cursor + 1),
        canUndo: step ? j.cursor > 0 : changed || j.cursor > 0,
        canRedo: step || !changed ? j.cursor < j.history.length : false,
      },
    };
    if (p.dryRun) return result;
    if (!step && changed) {
      j.history = j.history.slice(0, j.cursor);
      j.history.push({
        before: j.timeline,
        after: next,
        summary: result.changeSummary,
      });
      j.cursor++;
      if (j.history.length > 50) {
        j.history.shift();
        j.cursor--;
      }
    }
    await this.validateSources(next);
    j.timeline = next;
    j.operations.push({ operationId: p.operationId, signature: sig, result });
    await atomic(resolve(dir, "timeline.json"), j);
    return result;
  }
  async references(p) {
    const j = await this.load(p.projectId, { create: true }),
      t = structuredClone(j.timeline);
    await this.syncAssets(t, { prune: true });
    const revision = timelineRevision(j.timeline),
      items = [];
    const token = (kind, id) =>
      `dshvideo:v1/${p.projectId}/${kind}/${id}/${revision}`;
    for (const tr of t.tracks)
      for (const c of tr.clips) {
        const label = c.label || c.clipId,
          detail = `${(c.startFrame / 30).toFixed(2)}–${((c.startFrame + c.durationFrames) / 30).toFixed(2)}s · ${tr.name || tr.trackId}`;
        items.push({
          kind: "clip",
          clipId: c.clipId,
          label,
          detail,
          token: token("clip", c.clipId),
        });
        if (c.kind === "composition")
          items.push({
            kind: "scene",
            clipId: c.clipId,
            label,
            detail,
            token: token("scene", c.clipId),
          });
        const rangeToken = token(
          "range",
          `${c.startFrame}-${c.startFrame + c.durationFrames}`,
        );
        if (!items.some((item) => item.token === rangeToken))
          items.push({
            kind: "range",
            label: `${(c.startFrame / 30).toFixed(2)}–${((c.startFrame + c.durationFrames) / 30).toFixed(2)}s`,
            detail: "全部轨道",
            token: rangeToken,
          });
      }
    for (const a of t.assets)
      items.push({
        kind: "asset",
        assetId: a.assetId,
        label: a.name || a.assetId,
        detail: a.kind,
        token: token("asset", a.assetId),
      });
    if (typeof (p.query ?? "") !== "string" || (p.query ?? "").length > 120)
      fail("E_PARAMS", "Invalid reference query");
    const query = (p.query ?? "").trim().toLowerCase(),
      limit = int(p.limit ?? 50, 1, 100),
      offset = int(p.offset ?? 0, 0, 3000);
    const filtered = items.filter(
      (x) =>
        !query ||
        `${x.label} ${x.detail} ${x.clipId || x.assetId || ""}`
          .toLowerCase()
          .includes(query),
    );
    return {
      projectId: p.projectId,
      revision,
      durationFrames: t.settings.durationFrames,
      items: filtered.slice(offset, offset + limit),
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
      total: filtered.length,
    };
  }
  async resolve(p) {
    const j = await this.load(p.projectId, { create: true }),
      t = structuredClone(j.timeline);
    await this.syncAssets(t, { prune: true });
    const revision = timelineRevision(j.timeline);
    if (p.revision && p.revision !== revision)
      fail("E_REVISION_CONFLICT", "作品已更新，请重新选择引用");
    if (!Array.isArray(p.refs) || !p.refs.length || p.refs.length > 32)
      fail("E_PARAMS", "Provide 1–32 references");
    const clips = t.tracks
      .flatMap((tr) => tr.clips.map((c) => ({ ...c, trackId: tr.trackId })))
      .sort(
        (a, b) =>
          a.startFrame - b.startFrame || a.trackId.localeCompare(b.trackId),
      );
    return {
      projectId: p.projectId,
      revision,
      matches: p.refs.map((input, i) => {
        if (!input || typeof input !== "object" || Array.isArray(input))
          fail("E_PARAMS", "Invalid reference");
        let ref = input;
        const empty = (status) => ({
          ref: i,
          status,
          clipIds: [],
          assetIds: [],
          message: {
            missing: "引用已失效，请重新选择",
            foreign: "引用属于其它作品，请重新选择",
            invalid: "引用格式无效，请重新选择",
            stale: "区间已更新，请重新选择",
          }[status],
        });
        if (ref.kind === "token") {
          const parsed =
            /^`?(@?dshvideo:v1)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(clip|scene|asset|range)\/([A-Za-z0-9_.-]{1,128})\/([a-f0-9]{64})`?$/.exec(
              typeof ref.token === "string" ? ref.token : "",
            );
          if (!parsed) return empty("invalid");
          if (parsed[2] !== p.projectId) return empty("foreign");
          ref = {
            kind: parsed[3],
            ...(parsed[3] === "asset"
              ? { assetId: parsed[4] }
              : { clipId: parsed[4] }),
          };
          if (ref.kind === "range") {
            if (parsed[5] !== revision) return empty("stale");
            const range = /^(\d+)-(\d+)$/.exec(parsed[4]);
            if (!range) return empty("invalid");
            ref = {
              kind: "range",
              fromFrame: Number(range[1]),
              toFrame: Number(range[2]),
            };
          }
        }
        if (ref.kind === "asset") {
          const a = t.assets.find((a) => a.assetId === ref.assetId);
          return {
            ref: i,
            status: a ? "resolved" : "missing",
            clipIds: [],
            assetIds: a ? [a.assetId] : [],
            ...(a ? { kind: a.kind } : {}),
            message: a ? undefined : "引用已失效，请重新选择",
          };
        }
        let matches = clips.filter(
          (c) => !ref.trackId || c.trackId === ref.trackId,
        );
        if (ref.kind === "index") {
          int(ref.index, 1, 500);
          matches = t.tracks
            .filter((tr) => !ref.trackId || tr.trackId === ref.trackId)
            .flatMap((tr) => {
              const c = [...tr.clips].sort(
                (a, b) => a.startFrame - b.startFrame,
              )[ref.index - 1];
              return c ? [{ ...c, trackId: tr.trackId }] : [];
            });
        } else if (ref.kind === "clip" || ref.kind === "scene")
          matches = matches.filter(
            (c) =>
              c.clipId === ref.clipId &&
              (ref.kind !== "scene" || c.kind === "composition"),
          );
        else if (ref.kind === "label")
          matches = matches.filter((c) => c.label === ref.label);
        else if (ref.kind === "range") {
          int(ref.fromFrame);
          int(ref.toFrame, ref.fromFrame + 1, t.settings.durationFrames);
          matches = matches.filter(
            (c) =>
              c.startFrame < ref.toFrame &&
              c.startFrame + c.durationFrames > ref.fromFrame,
          );
        } else fail("E_PARAMS", "Unknown reference kind");
        // A validated range names a time interval, not a clip set: an empty
        // interval is resolved with zero candidates (scoring a gap between
        // clips is a legitimate target). Other kinds keep missing/ambiguous.
        const status = !matches.length
          ? ref.kind === "range"
            ? "resolved"
            : "missing"
          : (ref.kind === "label" || ref.kind === "index") && matches.length > 1
            ? "ambiguous"
            : "resolved";
        return {
          ref: i,
          status,
          clipIds: matches.map((c) => c.clipId),
          assetIds: [],
          candidates: matches.map((c) => ({
            clipId: c.clipId,
            label: c.label || c.clipId,
            trackId: c.trackId,
            startFrame: c.startFrame,
            durationFrames: c.durationFrames,
          })),
          ...(ref.kind === "range"
            ? { fromFrame: ref.fromFrame, toFrame: ref.toFrame }
            : {}),
          message:
            status === "missing"
              ? "引用已失效，请重新选择"
              : status === "ambiguous"
                ? "有多个匹配片段，请选择轨道或目标"
                : undefined,
        };
      }),
    };
  }
  async scene(p) {
    const j = await this.load(p.projectId, { create: true });
    if (p.html === undefined) {
      const c = j.timeline.tracks
        .flatMap((tr) => tr.clips)
        .find((c) => c.clipId === p.clipId);
      if (!c || c.kind !== "composition")
        fail("E_CLIP_NOT_FOUND", "Scene clip not found");
      return {
        projectId: p.projectId,
        revision: timelineRevision(j.timeline),
        clipId: c.clipId,
        html: await readFile(
          resolve(this.dir(p.projectId), c.scene.path),
          "utf8",
        ),
      };
    }
    const legacy = await this.store.readLegacy(p.projectId, {
      ignoreEntry: true,
      assetNames: j.timeline.legacyAssets?.map((x) => x.path),
    });
    await validateComposition({
      html: p.html,
      assets: legacy.entries.map((x) => x.path),
    });
    const doc = buildDocument(p.html),
      scene = {
        path: `scenes/${hash(p.html)}.html`,
        durationFrames: Math.round(doc.compositionDuration * 30),
      };
    await safeDir(this.dir(p.projectId), "scenes");
    await writeFile(resolve(this.dir(p.projectId), scene.path), p.html, {
      flag: "wx",
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    return this.apply({
      projectId: p.projectId,
      expectedRevision: p.expectedRevision,
      operationId: p.operationId,
      ops: [
        p.clipId
          ? { op: "scene.replace", clipId: p.clipId, scene }
          : {
              op: "scene.insert",
              trackId: p.trackId ?? "tr_v1",
              startFrame: p.startFrame ?? 0,
              durationFrames: scene.durationFrames,
              scene,
              mode: p.mode ?? "ripple",
              label: p.label ?? "AI 场景",
            },
      ],
    });
  }
  needsProxy(a) {
    return (
      a.kind === "video" &&
      a.videoCodec &&
      !["h264", "vp8", "vp9", "av1"].includes(a.videoCodec)
    );
  }
  async proxy(projectId, a) {
    try {
      return await this.media.resolveFile({
        projectId,
        assetId: a.assetId,
        kind: "proxy",
      });
    } catch {
      fail(
        "E_MEDIA_PROXY_REQUIRED",
        "请先在素材库生成兼容副本，再将该视频加入时间线",
        "timeline",
      );
    }
  }
  async proxyHash(path) {
    const info = await stat(path),
      key = path + ":" + info.size + ":" + info.mtimeMs;
    if (this.proxyHashes.has(key)) return this.proxyHashes.get(key);
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    const digest = sha.digest("hex");
    if (this.proxyHashes.size >= 512)
      this.proxyHashes.delete(this.proxyHashes.keys().next().value);
    this.proxyHashes.set(key, digest);
    return digest;
  }
  async validateSources(t) {
    const dir = this.dir(t.projectId);
    for (const tr of t.tracks)
      for (const c of tr.clips) {
        if (c.kind === "composition") {
          const actual = await realpath(resolve(dir, c.scene.path)).catch(
            () => null,
          );
          if (!actual || !inside(dir, actual))
            fail("E_ASSET_MISSING", "Scene source unavailable");
          const info = await stat(actual);
          if (info.size > 64 * 1024 * 1024)
            fail("E_LIMIT", "Scene source too large");
          if (hash(await readFile(actual)) !== c.scene.path.slice(7, -5))
            fail("E_ASSET_MISSING", "Scene source changed");
        } else {
          const a = t.assets.find((a) => a.assetId === c.assetId);
          if (this.needsProxy(a)) await this.proxy(t.projectId, a);
          const actual = await realpath(resolve(dir, a.path)).catch(() => null);
          if (
            !actual ||
            !inside(dir, actual) ||
            (await stat(actual)).size !== a.bytes
          )
            fail("E_ASSET_MISSING", "Source media unavailable");
          if ((await this.proxyHash(actual)) !== a.sha256)
            fail(
              "E_ASSET_CHANGED",
              "素材文件已被外部修改，请重新导入",
              "timeline",
            );
        }
      }
  }
  async read(projectId) {
    const j = await this.load(projectId);
    if (!j) return null;
    const dir = this.dir(projectId),
      t = j.timeline,
      renderTimeline = structuredClone(t),
      legacy = await this.store.readLegacy(projectId, {
        ignoreEntry: true,
        assetNames: t.legacyAssets?.map((x) => x.path),
      }),
      files = new Map(
        [...legacy.files].filter(([name]) => name !== legacy.manifest.entry),
      );
    for (const expected of t.legacyAssets ?? []) {
      const actual = legacy.entries.find((x) => x.path === expected.path);
      if (
        !actual ||
        actual.sha256 !== expected.sha256 ||
        actual.bytes !== expected.bytes
      )
        fail(
          "E_ASSET_CHANGED",
          "旧工程引用的素材已被外部修改，请恢复备份",
          "timeline",
        );
    }
    files.set("index.html", Buffer.from(generateComposition(t)));
    for (const tr of t.tracks)
      for (const c of tr.clips)
        if (c.kind === "composition" && !files.has(`scene-${c.clipId}.html`)) {
          const path = await realpath(resolve(dir, c.scene.path));
          if (!inside(dir, path)) fail("E_PATH", "Scene escapes project");
          if ((await stat(path)).size > 64 * 1024 * 1024)
            fail("E_LIMIT", "Scene source exceeds limit");
          const raw = await readFile(path, "utf8");
          if (hash(raw) !== c.scene.path.slice(7, -5))
            fail("E_ASSET_CHANGED", "Scene source changed", "timeline");
          const offset = (c.sourceInFrame ?? 0) / 30;
          const { document } = parseHTML(raw);
          const root = document.querySelector("[data-composition-id]");
          if (!root)
            fail("E_TIMELINE_INVALID", "Scene has no composition root");
          const authoredId = root.getAttribute("data-composition-id");
          root.setAttribute("data-composition-id", c.clipId);
          // SDK executes scripts under the composition root. Legacy documents
          // can legally keep scripts after it; move those nodes in the derived
          // copy so they are executed and scoped per instance rather than inert.
          for (const script of [...document.body.querySelectorAll("script")])
            if (!root.contains(script)) root.appendChild(script);
          for (const script of root.querySelectorAll("script")) {
            if (script.hasAttribute("src")) continue;
            script.textContent = script.textContent.replace(
              /(window\s*(?:\.\s*__timelines|\[\s*["']__timelines["']\s*\])\s*=\s*\{)([\s\S]*?)(\})/g,
              (all, open, contents, close) => {
                const key = authoredId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return (
                  open.slice(0, -1) +
                  "Object.assign(window.__timelines||{}, {" +
                  contents.replace(
                    new RegExp(
                      "(^|[,\\s])(?:" + key + "|[\"']" + key + "[\"'])\\s*:",
                    ),
                    (_, prefix) => prefix + JSON.stringify(c.clipId) + ":",
                  ) +
                  close +
                  ")"
                );
              },
            );
          }
          const helper = document.createElement("script");
          helper.textContent = `(()=>{const tl=window.__timelines?.[${JSON.stringify(c.clipId)}]||window.__timelines?.[${JSON.stringify(authoredId)}]||Object.values(window.__timelines||{}).at(-1);if(!tl)return;window.__timelines[${JSON.stringify(c.clipId)}]=tl;tl.pause();tl.totalTime(${offset});if(parent!==window)parent.postMessage({type:'dsh-scene-ready',clipId:${JSON.stringify(c.clipId)}},'*');const root=document.querySelector('[data-composition-id]');function fit(){if(root&&window.parent!==window){root.style.transformOrigin='0 0';root.style.transform='scale('+innerWidth/Number(root.dataset.width)+','+innerHeight/Number(root.dataset.height)+')';}}fit();addEventListener('resize',fit);addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='dsh-scene-time'&&Number.isFinite(e.data.time)){tl.pause();tl.totalTime(Math.max(0,e.data.time));}});})();`;
          root.appendChild(helper);
          files.set(`scene-${c.clipId}.html`, Buffer.from(document.toString()));
        }
    const used = new Set(
        t.tracks
          .flatMap((tr) => tr.clips.map((c) => c.assetId))
          .filter(Boolean),
      ),
      refs = [];
    for (const a of t.assets.filter((a) => used.has(a.assetId))) {
      if (!/^media\/[a-f0-9]{8}\.[a-z0-9]+$/.test(a.path))
        fail("E_PATH", "Invalid media path");
      const path = await realpath(resolve(dir, a.path));
      if (!inside(dir, path) || (await stat(path)).size !== a.bytes)
        fail("E_ASSET_MISSING", "Media changed or is unavailable");
      if ((await this.proxyHash(path)) !== a.sha256)
        fail("E_ASSET_CHANGED", "素材文件已被外部修改，请重新导入", "timeline");
      if (a.hasAudio === undefined) {
        const source = await this.media.resolveFile({
          projectId,
          assetId: a.assetId,
        });
        renderTimeline.assets.find((x) => x.assetId === a.assetId).hasAudio =
          source.asset.kind === "audio" ||
          source.asset.media?.hasAudio === true;
      }
      if (this.needsProxy(a)) {
        const proxy = await this.proxy(projectId, a),
          digest = await this.proxyHash(proxy.path),
          renderPath = `media/${digest.slice(0, 8)}.mp4`;
        renderTimeline.assets.find((x) => x.assetId === a.assetId).path =
          renderPath;
        refs.push({
          path: renderPath,
          source: proxy.path,
          bytes: proxy.size,
          sha256: digest,
          media: true,
        });
        continue;
      }
      refs.push({
        path: a.path,
        source: path,
        bytes: a.bytes,
        sha256: a.sha256,
        media: true,
      });
    }
    for (const tr of t.tracks)
      for (let i = 1; i < tr.clips.length; i++) {
        const c = tr.clips[i];
        if (!tr.clips[i - 1].outTransition || c.kind !== "media") continue;
        const a = t.assets.find((a) => a.assetId === c.assetId),
          cache = await safeDir(dir, ".dsh-video"),
          cacheDir = await safeDir(dir, ".dsh-video/timeline-cache"),
          name = `${a.sha256}-${c.sourceInFrame}.png`,
          target = resolve(cacheDir, name);
        try {
          await stat(target);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          const temp = await mkdtemp(resolve(tmpdir(), "dsh-transition-"));
          try {
            const output = resolve(temp, "frame.png");
            const result = await runOwned(
              [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                String(c.sourceInFrame / a.fps),
                "-i",
                resolve(dir, a.path),
                "-frames:v",
                "1",
                output,
              ],
              { temp, cwd: temp, env: process.env, timeoutMs: 30000 },
            );
            if (result.status !== "complete")
              fail("E_MEDIA_DERIVE", "Transition frame unavailable");
            await copyFile(output, target);
          } finally {
            await rm(temp, { recursive: true, force: true });
          }
        }
        files.set(`transition-${c.clipId}.png`, await readFile(target));
      }
    files.set("index.html", Buffer.from(generateComposition(renderTimeline)));
    const entries = [...files].map(([path, b]) => ({
      path,
      bytes: b.length,
      sha256: hash(b),
    }));
    return {
      ...legacy,
      files,
      entries,
      manifest: {
        ...legacy.manifest,
        entry: "index.html",
        assets: [...files.keys()].filter((x) => x !== "index.html"),
      },
      revision: timelineRevision(t),
      mediaRefs: refs,
      timeline: renderTimeline,
    };
  }
}
export async function linkMedia(refs, dest) {
  for (const r of refs ?? []) {
    const target = resolve(dest, r.path);
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(r.source, target);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      await copyFile(r.source, target);
    }
  }
}
