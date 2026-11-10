import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOperations,
  validateTimeline,
  generateComposition,
  timelineRevision,
  Timelines,
} from "../src/timeline.mjs";
const base = () => ({
  schema: "dsh-video/timeline@1",
  projectId: "demo",
  settings: {
    width: 1280,
    height: 720,
    fps: 30,
    background: "#000000",
    durationFrames: 600,
  },
  assets: [
    {
      assetId: "as_12345678",
      kind: "video",
      fps: 60,
      durationFrames: 1200,
      path: "media/12345678.mp4",
    },
    { assetId: "as_22222222", kind: "image", path: "media/22222222.png" },
  ],
  tracks: [
    {
      trackId: "tr_v1",
      kind: "video",
      name: "one",
      clips: [
        {
          clipId: "cl_one",
          kind: "media",
          assetId: "as_12345678",
          startFrame: 0,
          durationFrames: 300,
          sourceInFrame: 0,
          speed: 1,
        },
      ],
    },
    { trackId: "tr_v2", kind: "video", name: "two", clips: [] },
  ],
});
const apply = (ops, t = base()) => applyOperations(t, ops).timeline;
test("split retains left ID and converts source fps exactly", () => {
  const r = applyOperations(base(), [
    { op: "clip.split", clipId: "cl_one", atFrame: 120 },
  ]);
  assert.equal(r.timeline.tracks[0].clips[1].sourceInFrame, 240);
  assert.equal(r.lineage[0].keptClipId, "cl_one");
  assert.notEqual(r.lineage[0].createdClipId, "cl_one");
});
test("trim edges preserve source frame mapping and reject underflow", () => {
  const t = apply([
    { op: "clip.trim", clipId: "cl_one", edge: "in", deltaFrames: 30 },
  ]);
  assert.equal(t.tracks[0].clips[0].sourceInFrame, 60);
  assert.equal(t.tracks[0].clips[0].durationFrames, 270);
  assert.throws(
    () =>
      apply([
        { op: "clip.trim", clipId: "cl_one", edge: "in", deltaFrames: -1 },
      ]),
    { code: "E_RANGE" },
  );
});
test("move changes tracks, duplicate gets stable independent ID, overlap rejects", () => {
  const t = apply([
    { op: "clip.duplicate", clipId: "cl_one" },
    { op: "clip.move", clipId: "cl_one", trackId: "tr_v2", startFrame: 30 },
  ]);
  assert.equal(t.tracks[1].clips[0].startFrame, 30);
  assert.equal(t.tracks[0].clips[0].startFrame, 300);
  assert.throws(
    () => apply([{ op: "clip.duplicate", clipId: "cl_one", startFrame: 1 }]),
    { code: "E_OVERLAP" },
  );
});
test("ripple insert/delete/trim and overwrite are explicit", () => {
  let t = apply([
    {
      op: "clip.insert",
      assetId: "as_22222222",
      trackId: "tr_v1",
      startFrame: 0,
      durationFrames: 30,
      mode: "ripple",
    },
  ]);
  assert.equal(t.tracks[0].clips[1].startFrame, 30);
  t = apply(
    [{ op: "clip.delete", clipId: t.tracks[0].clips[0].clipId, ripple: true }],
    t,
  );
  assert.equal(t.tracks[0].clips[0].startFrame, 0);
  t = apply([
    {
      op: "clip.insert",
      assetId: "as_22222222",
      trackId: "tr_v1",
      startFrame: 0,
      durationFrames: 30,
      mode: "overwrite",
    },
  ]);
  assert.equal(t.tracks[0].clips.length, 1);
});
test("speed preserves source extent, replace validates source limits", () => {
  const t = apply([{ op: "clip.speed", clipId: "cl_one", speed: 2 }]);
  assert.equal(t.tracks[0].clips[0].durationFrames, 150);
  assert.throws(
    () =>
      apply([{ op: "clip.replace", clipId: "cl_one", assetId: "as_missing" }]),
    { code: "E_ASSET_NOT_FOUND" },
  );
});
test("metadata volume fade track settings validated without mutating input", () => {
  const b = base(),
    rev = timelineRevision(b);
  let t = apply(
    [
      {
        op: "clip.set",
        clipId: "cl_one",
        patch: { label: "Title", muted: true },
      },
      { op: "clip.volume", clipId: "cl_one", volumeDb: -12 },
      { op: "clip.fade", clipId: "cl_one", inFrames: 3, outFrames: 6 },
      {
        op: "track.update",
        trackId: "tr_v1",
        patch: { name: "Video", locked: true },
      },
      { op: "track.update", trackId: "tr_v1", patch: { locked: false } },
      { op: "timeline.settings", background: "#112233" },
    ],
    b,
  );
  assert.equal(t.settings.background, "#112233");
  assert.equal(t.tracks[0].clips[0].fadeOutFrames, 6);
  assert.equal(timelineRevision(b), rev);
  assert.throws(
    () =>
      apply([
        { op: "clip.set", clipId: "cl_one", patch: { unexpected: true } },
      ]),
    { code: "E_PARAMS" },
  );
});
test("track removal requires force and lock blocks edits", () => {
  assert.throws(() => apply([{ op: "track.remove", trackId: "tr_v1" }]), {
    code: "E_TRACK_NOT_EMPTY",
  });
  assert.equal(
    apply([{ op: "track.remove", trackId: "tr_v1", force: true }]).tracks
      .length,
    1,
  );
  assert.throws(
    () =>
      apply([
        { op: "track.update", trackId: "tr_v1", patch: { locked: true } },
        { op: "clip.delete", clipId: "cl_one" },
      ]),
    { code: "E_TRACK_LOCKED" },
  );
  assert.equal(
    apply([{ op: "track.add", kind: "video", afterTrackId: "tr_v1" }]).tracks
      .length,
    3,
  );
});
test("crossfade only accepts adjacent bounded clips", () => {
  let t = apply([
    { op: "clip.duplicate", clipId: "cl_one" },
    {
      op: "clip.transition",
      clipId: "cl_one",
      type: "crossfade",
      durationFrames: 15,
    },
  ]);
  assert.equal(t.tracks[0].clips[0].outTransition.durationFrames, 15);
  assert.throws(
    () =>
      apply([
        {
          op: "clip.transition",
          clipId: "cl_one",
          type: "crossfade",
          durationFrames: 10,
        },
      ]),
    { code: "E_TRANSITION_INVALID" },
  );
});
test("serializer deterministic, authored gain, safe local src and z order", () => {
  const b = base();
  assert.equal(generateComposition(b), generateComposition(structuredClone(b)));
  const html = generateComposition(b);
  assert.ok(html.includes('data-volume="1"'));
  assert.ok(html.includes("window.__timelines={main}"));
  assert.ok(html.includes("media/12345678.mp4"));
  assert.equal(/<audio/.test(html), false);
});
test("invalid schema, capacity, fps, duration, IDs reject", () => {
  for (const mutate of [
    (t) => (t.settings.fps = 60),
    (t) => (t.settings.durationFrames = 0),
    (t) => t.tracks.push(structuredClone(t.tracks[0])),
    (t) => (t.tracks[0].clips[0].durationFrames = 601),
  ]) {
    const t = base();
    mutate(t);
    assert.throws(() => validateTimeline(t));
  }
});

test("automatic duration follows ripple while explicit duration retains a tail", () => {
  let t = apply([{ op: "clip.duplicate", clipId: "cl_one" }]);
  const right = t.tracks[0].clips[1].clipId;
  t = apply([{ op: "clip.delete", clipId: "cl_one", ripple: true }], t);
  assert.equal(t.settings.durationFrames, 300);
  assert.equal(t.tracks[0].clips[0].clipId, right);
  t = apply(
    [
      { op: "timeline.settings", durationFrames: 600 },
      { op: "clip.trim", clipId: right, edge: "out", deltaFrames: -30 },
    ],
    t,
  );
  assert.equal(t.settings.durationFrames, 600);
});

test('upper timeline tracks cover lower tracks, including crossfade overlays', () => {
  const t=base();
  t.tracks=[{trackId:'tr_top',kind:'video',clips:[{clipId:'cl_top',kind:'image',assetId:'as_22222222',startFrame:0,durationFrames:60,outTransition:{durationFrames:15}},{clipId:'cl_top_next',kind:'image',assetId:'as_22222222',startFrame:60,durationFrames:60}]},{trackId:'tr_bottom',kind:'video',clips:[{clipId:'cl_bottom',kind:'media',assetId:'as_12345678',startFrame:0,durationFrames:120,sourceInFrame:0,speed:1}]}];
  const html=generateComposition(t);
  const layer=id=>Number(html.match(new RegExp('<[^>]*id="'+id+'"[^>]*z-index:(\\d+)'))?.[1]);
  assert(layer('cl_top')>layer('cl_bottom'),'upper visual track must win');
  assert.equal(layer('transition-cl_top_next'),layer('cl_top'));
  assert.match(html,/id="cl_top"[^>]*data-track-index="0"/,'track identity must not change with visual layering');
});

test('detach audio preserves source timing and effective gain in one transaction', () => {
  const t=base(); t.assets[0].hasAudio=true;
  Object.assign(t.tracks[0],{gainDb:-3,muted:true});
  Object.assign(t.tracks[0].clips[0],{sourceInFrame:120,speed:1.5,volumeDb:-4,fadeInFrames:12,label:'Video'});
  const r=applyOperations(t,[{op:'clip.detachAudio',clipId:'cl_one'}]).timeline;
  const v=r.tracks[0].clips[0], a=r.tracks.find(x=>x.kind==='audio').clips[0];
  assert.equal(v.muted,true); assert.equal(a.audioOnly,true);
  assert.equal(a.assetId,v.assetId); assert.equal(a.sourceInFrame,120);
  assert.equal(a.speed,1.5); assert.equal(a.volumeDb+a.sourceGainDb,-7);
  assert.equal(a.muted,true); assert.equal(a.fadeInFrames,12);
  assert.equal(a.durationFrames,v.durationFrames);
  assert.match(generateComposition(r), /<audio[^>]*data-media-start="2"/);
  assert.throws(()=>applyOperations(r,[{op:'clip.detachAudio',clipId:'cl_one'}]),{code:'E_AUDIO_DETACHED'});
  assert.equal(t.tracks.length,2);
});
test('detach rejects videos without an audio stream',()=>{
  assert.throws(()=>applyOperations(base(),[{op:'clip.detachAudio',clipId:'cl_one'}]),{code:'E_NO_AUDIO'});
});
test('detach preserves summed gains outside the clip fader range',()=>{
 const t=base();t.assets[0].hasAudio=true;t.tracks[0].gainDb=12;t.tracks[0].clips[0].volumeDb=12;
 const r=applyOperations(t,[{op:'clip.detachAudio',clipId:'cl_one'}]).timeline;
 const a=r.tracks.find(x=>x.kind==='audio').clips[0];
 assert.equal(a.volumeDb+a.sourceGainDb,24);
});
test('detach leaves the export audio mix exactly equivalent',async()=>{
 const {audioMixPlan}=await import('../src/audio.mjs');const t=base();t.settings.durationMode='fixed';
 t.assets[0].hasAudio=true;t.tracks[0].gainDb=-3;
 Object.assign(t.tracks[0].clips[0],{sourceInFrame:120,speed:1.5,volumeDb:-4,fadeInFrames:12,fadeOutFrames:20});
 const before=audioMixPlan(t,'/test');const r=applyOperations(t,[{op:'clip.detachAudio',clipId:'cl_one'}]).timeline;
 assert.deepEqual(audioMixPlan(r,'/test'),before);
});
test('detach refuses full audio tracks atomically and allows recreating a deleted result',()=>{
 const t=base();t.assets[0].hasAudio=true;
 for(let i=0;i<3;i++)t.tracks.push({trackId:'tr_a'+i,kind:'audio',muted:true,clips:[]});
 const before=structuredClone(t);
 assert.throws(()=>applyOperations(t,[{op:'clip.detachAudio',clipId:'cl_one'}]),{code:'E_LIMIT'});assert.deepEqual(t,before);
 t.tracks.splice(2);const detached=applyOperations(t,[{op:'clip.detachAudio',clipId:'cl_one'}]).timeline;
 const audio=detached.tracks.find(x=>x.kind==='audio').clips[0];
 const deleted=applyOperations(detached,[{op:'clip.delete',clipId:audio.clipId}]).timeline;
 assert.equal(deleted.tracks[0].clips[0].muted,true);
 const again=applyOperations(deleted,[{op:'clip.detachAudio',clipId:'cl_one'}]).timeline;
 assert.ok(again.tracks.flatMap(x=>x.clips).some(x=>x.detachedFrom==='cl_one'));
});
test('range references resolve time intervals, empty selections included', async () => {
  const t = base();
  const revision = timelineRevision(t);
  const tl = new Timelines({}, {});
  tl.load = async () => ({ timeline: t });
  tl.syncAssets = async () => {};
  const empty = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'range', fromFrame: 320, toFrame: 400 }] });
  assert.equal(empty.matches[0].status, 'resolved');
  assert.deepEqual(empty.matches[0].clipIds, []);
  assert.deepEqual(empty.matches[0].candidates, []);
  assert.equal(empty.matches[0].fromFrame, 320);
  assert.equal(empty.matches[0].toFrame, 400);
  const overlap = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'range', fromFrame: 250, toFrame: 400 }] });
  assert.deepEqual(overlap.matches[0].clipIds, ['cl_one']);
  const whole = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'range', fromFrame: 0, toFrame: 600 }] });
  assert.equal(whole.matches[0].status, 'resolved');
  const token = 'dshvideo:v1/demo/range/320-400/' + revision;
  const tokenView = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'token', token }] });
  assert.equal(tokenView.matches[0].status, 'resolved');
  assert.equal(tokenView.matches[0].fromFrame, 320);
  const stale = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'token', token: 'dshvideo:v1/demo/range/320-400/' + 'f'.repeat(64) }] });
  assert.equal(stale.matches[0].status, 'stale');
  assert.equal(stale.matches[0].message, '区间已更新，请重新选择');
  const foreign = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'token', token: 'dshvideo:v1/other/range/320-400/' + revision }] });
  assert.equal(foreign.matches[0].status, 'foreign');
  const label = await tl.resolve({ projectId: 'demo', refs: [{ kind: 'label', label: '不存在' }] });
  assert.equal(label.matches[0].status, 'missing');
  await assert.rejects(() => tl.resolve({ projectId: 'demo', refs: [{ kind: 'range', fromFrame: 500, toFrame: 700 }] }), (e) => ['E_PARAMS', 'E_RANGE'].includes(e.code));
});
