import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TimelineVisuals } from '../src/timeline-visuals.mjs';
import { timelineRevision } from '../src/timeline.mjs';
import {
  MAX_HITS,
  alignScore,
  chooseWindow,
  compileBeatLayer,
  estimateGrid,
  mergeOnsetHits,
  onsetsFromEnvelope,
  pictureHits,
} from '../src/beat.mjs';

const BUCKET = 128 / 8000; // 16ms, the finest cached peaks-v1 level

/** A square-ish impulse train: 120BPM from 1s after a quiet intro. */
function clickEnvelope({ seconds, intervalSeconds, startSeconds, level = 0.9, floor = 0.04 }) {
  const buckets = Math.round(seconds / BUCKET);
  const peaks = new Array(buckets).fill(floor);
  for (let time = startSeconds; time < seconds; time += intervalSeconds) {
    const index = Math.round(time / BUCKET);
    if (index < buckets) peaks[index] = level;
  }
  return peaks;
}

test('onset detection finds the measured grid inside 16ms buckets', () => {
  const peaks = clickEnvelope({ seconds: 20, intervalSeconds: 0.5, startSeconds: 1 });
  const onsets = onsetsFromEnvelope(peaks, { bucketSeconds: BUCKET, materialPeak: 0.9 });
  assert.equal(onsets.truncated, false);
  assert.ok(onsets.times.length >= 36, `expected ~38 clicks, got ${onsets.times.length}`);
  for (const time of onsets.times) {
    const remainder = Math.abs(((time - 1) % 0.5 + 0.5) % 0.5);
    assert.ok(
      Math.min(remainder, 0.5 - remainder) <= 2 * BUCKET + 1e-6,
      `${time} is off-grid`,
    );
  }
  assert.ok(onsets.strengths.every((strength) => strength > 0 && strength <= 1));
});

test('silence and a flat wash produce no fake pulse', () => {
  assert.deepEqual(onsetsFromEnvelope(new Array(500).fill(0), { bucketSeconds: BUCKET, materialPeak: 0.9 }), {
    times: [],
    strengths: [],
    truncated: false,
  });
  const flat = new Array(500).fill(0.5);
  assert.equal(onsetsFromEnvelope(flat, { bucketSeconds: BUCKET, materialPeak: 0.5 }).times.length, 0);
});

test('the beat grid comes back as bpm, phase and confidence', () => {
  const onsets = onsetsFromEnvelope(clickEnvelope({ seconds: 20, intervalSeconds: 0.5, startSeconds: 0.4 }), {
    bucketSeconds: BUCKET,
    materialPeak: 0.9,
  });
  const grid = estimateGrid(onsets.times);
  assert.ok(Math.abs(grid.bpm - 120) <= 1, `bpm ${grid.bpm}`);
  assert.ok(Math.abs(grid.intervalSeconds - 0.5) <= 0.01, `interval ${grid.intervalSeconds}`);
  assert.ok(grid.confidence > 0.8, `confidence ${grid.confidence}`);
  assert.ok(grid.phaseSeconds >= 0 && grid.phaseSeconds < 0.5);
  assert.deepEqual(estimateGrid([0.1, 0.2, 0.3]), {
    bpm: null,
    intervalSeconds: null,
    phaseSeconds: 0,
    confidence: 0,
  });
});

test('picture hits are the real unmutated cut frames of the range', () => {
  const tracks = [
    {
      trackId: 'tr_v',
      kind: 'video',
      muted: false,
      clips: [
        { clipId: 'cl_a', startFrame: 0, durationFrames: 90 },
        { clipId: 'cl_b', startFrame: 90, durationFrames: 60 },
        { clipId: 'cl_m', startFrame: 120, durationFrames: 30, muted: true },
      ],
    },
    { trackId: 'tr_t', kind: 'video', muted: true, clips: [{ clipId: 'cl_t', startFrame: 45, durationFrames: 30 }] },
    { trackId: 'tr_a', kind: 'audio', muted: false, clips: [{ clipId: 'cl_a1', startFrame: 60, durationFrames: 30 }] },
  ];
  const result = pictureHits({ tracks, fromFrame: 30, toFrame: 150, fps: 30 });
  assert.deepEqual(
    result.hits.map((hit) => hit.frame),
    [90, 150],
  );
  assert.deepEqual(
    result.hits.map((hit) => hit.pct),
    [50, 100],
  );
  assert.equal(result.hits[0].seconds, 2);
  assert.equal(result.truncated, false);
});

test('the hit list is capped so a reply stays inside the JSONL line limit', () => {
  const clips = Array.from({ length: 400 }, (_, index) => ({
    clipId: `cl_${index}`,
    startFrame: index + 1,
    durationFrames: 1,
  }));
  const result = pictureHits({ tracks: [{ kind: 'video', clips }], fromFrame: 0, toFrame: 401, fps: 30 });
  assert.equal(result.hits.length, MAX_HITS);
  assert.equal(result.truncated, true);
});

test('a measured onset either confirms a cut or becomes its own hit', () => {
  const cuts = pictureHits({
    tracks: [{ kind: 'video', clips: [{ clipId: 'cl_a', startFrame: 60, durationFrames: 60 }] }],
    fromFrame: 0,
    toFrame: 120,
    fps: 30,
  });
  const merged = mergeOnsetHits(cuts, { times: [2.1667, 2.6667], strengths: [0.4, 0.9] }, { fromFrame: 0, toFrame: 120, fps: 30 });
  assert.equal(merged.hits.find((hit) => hit.frame === 60).aligned, true, 'the onset 5 frames away confirms the cut');
  const added = merged.hits.find((hit) => hit.source === 'onset');
  assert.ok(added, 'the onset 20 frames away survives');
  assert.equal(added.frame, 80);
  assert.equal(added.strength, 0.9);
  assert.equal(added.pct, 66.7);
});

test('alignment error is measured in frames against the candidate window', () => {
  const score = alignScore({
    hitFrames: [50, 100, 150, 200],
    onsetFrames: [50, 100, 150, 200],
    windowFrame: 0,
    baseFrame: 0,
    rangeFrames: 300,
    speed: 1,
    gridIntervalFrames: 50,
  });
  assert.equal(score.hitRate, 1);
  assert.equal(score.meanErrorFrames, 0);
  assert.equal(score.maxErrorFrames, 0);
  assert.equal(score.toleranceFrames, 17);
  assert.deepEqual(score.drift, []);
  const late = alignScore({
    hitFrames: [50, 100, 150, 200],
    onsetFrames: [70, 120, 170, 220],
    windowFrame: 0,
    baseFrame: 0,
    rangeFrames: 300,
    speed: 1,
    gridIntervalFrames: 50,
  });
  assert.equal(late.hitRate, 0);
  assert.equal(late.meanErrorFrames, 20);
  assert.equal(late.maxErrorFrames, 20);
  assert.equal(late.drift.length, 4);
  assert.equal(late.drift[0].errorFrames, 20);
  assert.equal(late.drift[0].nearestOnsetFrame !== null, true);
});

test('the window search picks the tempo lock only when it is asked for', () => {
  const hitFrames = Array.from({ length: 19 }, (_, index) => 30 + index * 15);
  const onsetFrames = Array.from({ length: 20 }, (_, index) => 30 + index * 16);
  const shared = {
    hitFrames,
    onsetFrames,
    baseFrame: 0,
    rangeFrames: 300,
    assetDurationFrames: 3000,
    grid: { bpm: 120, intervalSeconds: 0.5 },
    songGrid: { bpm: 112, intervalSeconds: 60 / 112 },
  };
  const locked = chooseWindow({ ...shared, tempoLock: true });
  assert.equal(locked.best.speed, 1.07);
  assert.equal(locked.best.hitRate, 1);
  assert.equal(locked.candidates.length <= 3, true);
  assert.ok(locked.candidates.every((candidate) => candidate.drift === undefined), 'candidates stay compact');
  const plain = chooseWindow({ ...shared, tempoLock: false });
  assert.equal(plain.best.speed, 1);
  assert.ok(plain.best.hitRate < locked.best.hitRate, 'the locked tempo must actually help');
});

test('a song longer than the range still cannot start past its own end', () => {
  const result = chooseWindow({
    hitFrames: [30, 60],
    onsetFrames: [20, 250, 280],
    baseFrame: 0,
    rangeFrames: 300,
    assetDurationFrames: 300,
    grid: { bpm: 120, intervalSeconds: 0.5 },
    songGrid: { bpm: 120, intervalSeconds: 0.5 },
    tempoLock: false,
  });
  assert.equal(result.best.sourceInFrame, 0);
  assert.throws(
    () => chooseWindow({ hitFrames: [30], onsetFrames: [0], baseFrame: 0, rangeFrames: 300, assetDurationFrames: 100 }),
    (error) => error.code === 'E_LIMIT',
  );
});

test('the beat layer is a procedural score the synth already accepts', async () => {
  const synthSource = await readFile(new URL('../../../host/audio-synth.js', import.meta.url), 'utf8');
  const allowedKeys = synthSource.match(/keys\(score,\[([^\]]*)\]/)[1].replaceAll("'", '').split(',');
  const eventKeys = synthSource.match(/keys\(e,\[([^\]]*)\]/)[1].replaceAll("'", '').split(',');
  const sounds = synthSource.match(/SOUNDS = Object\.freeze\(\[([^\]]*)\]/)[1].replaceAll("'", '').split(',');
  const hits = [
    { frame: 30, seconds: 1, pct: 10, source: 'cut', strength: 0.9 },
    { frame: 45, seconds: 1.5, pct: 50, source: 'cut', strength: 0.6 },
    { frame: 60, seconds: 2, pct: 90, source: 'onset', strength: 0.4, aligned: true },
    { frame: 75, seconds: 2.5, pct: 100, source: 'cut', strength: 1 },
  ];
  const score = compileBeatLayer({ hits, grid: { intervalSeconds: 0.5, phaseSeconds: 0.1 }, rangeSeconds: 3 });
  assert.ok(score, 'a four-hit range must produce a layer');
  assert.deepEqual(Object.keys(score).sort(), [...allowedKeys].sort());
  assert.equal(score.duration, 3);
  assert.ok(score.events.every((event) => Object.keys(event).every((key) => eventKeys.includes(key))), 'event fields must exist in the synth contract');
  assert.ok(score.events.every((event) => sounds.includes(event.sound)), 'only synthesised sounds are used');
  assert.ok(score.events.every((event) => event.at >= 0 && event.at + event.duration <= score.duration + 1e-9));
  assert.ok(score.events.some((event) => event.sound === 'kick'));
  assert.ok(score.events.some((event) => event.sound === 'riser'), 'the strongest hit gets a lift');
  assert.ok(score.events.some((event) => event.sound === 'whoosh'), 'the fast cut pair gets a transition');
  assert.ok(score.events.some((event) => event.sound === 'hat' && event.repeat > 1));
});

test('a thin or over-long hit list degrades instead of overrunning the synth', () => {
  assert.equal(compileBeatLayer({ hits: [{ seconds: 1, source: 'cut', strength: 1 }], rangeSeconds: 5 }), null);
  assert.equal(compileBeatLayer({ hits: [], grid: null, rangeSeconds: 5 }), null);
  assert.equal(compileBeatLayer({ hits: [{ seconds: 1, source: 'cut', strength: 0.9 }], grid: null, rangeSeconds: 0 }), null);
  const crowded = Array.from({ length: 300 }, (_, index) => ({
    seconds: index * 0.1,
    source: 'cut',
    strength: 1,
  }));
  const score = compileBeatLayer({ hits: crowded, grid: { intervalSeconds: 0.1, phaseSeconds: 0 }, rangeSeconds: 30 });
  const expanded = (event) => event.repeat ?? 1;
  const count = score.events.reduce((total, event) => total + expanded(event), 0);
  const sound = score.events.reduce((total, event) => total + event.duration * expanded(event), 0);
  assert.ok(count <= 512, `event expansion ${count} exceeds the synth limit`);
  assert.ok(sound <= 900, `event seconds ${sound} exceeds the synth limit`);
});

/**
 * The engine methods combine the timeline journal with the cached peaks pyramid.
 * Only the decode is stubbed here (the real peaks-v1 cache is covered by the
 * POSIX integration run), so the frame arithmetic stays verifiable everywhere.
 */
function beatFixture() {
  const timeline = {
    projectId: 'demo',
    settings: { width: 320, height: 180, fps: 30, background: '#000000', durationFrames: 300 },
    assets: [
      { assetId: 'as_00000000', kind: 'video', fps: 30, durationFrames: 360, path: 'media/shot.mp4', sha256: 'a'.repeat(64), hasAudio: false },
      { assetId: 'as_11111111', kind: 'audio', fps: 30, durationFrames: 300, path: 'media/song.wav', sha256: 'b'.repeat(64), hasAudio: true },
    ],
    tracks: [
      {
        trackId: 'tr_v',
        kind: 'video',
        muted: false,
        clips: [
          { clipId: 'cl_00000001', assetId: 'as_00000000', startFrame: 0, durationFrames: 90, sourceInFrame: 0 },
          { clipId: 'cl_00000002', assetId: 'as_00000000', startFrame: 90, durationFrames: 90, sourceInFrame: 90 },
          { clipId: 'cl_00000003', assetId: 'as_00000000', startFrame: 150, durationFrames: 90, sourceInFrame: 180 },
          { clipId: 'cl_00000004', assetId: 'as_00000000', startFrame: 210, durationFrames: 90, sourceInFrame: 270 },
        ],
      },
      {
        trackId: 'tr_a',
        kind: 'audio',
        muted: false,
        clips: [{ clipId: 'cl_00000005', assetId: 'as_11111111', startFrame: 0, durationFrames: 300, sourceInFrame: 0 }],
      },
    ],
  };
  return { timeline, revision: timelineRevision(timeline) };
}

function stubVisuals(timeline, peaks) {
  const visuals = Object.create(TimelineVisuals.prototype);
  visuals.priority = () => false;
  visuals.timelines = {
    load: async () => ({ timeline }),
    media: {
      resolveFile: async ({ assetId }) => {
        const asset = timeline.assets.find((entry) => entry.assetId === assetId);
        return asset ? { path: asset.path, asset } : null;
      },
    },
  };
  visuals.cacheRoot = async () => 'cache';
  visuals.envelope = async () => ({ peak: 0.9, levels: [{ seconds: BUCKET, peaks, rms: peaks }] });
  return visuals;
}

test('timeline.beatmap merges journal cuts with measured onsets', async () => {
  const { timeline, revision } = beatFixture();
  const visuals = stubVisuals(timeline, clickEnvelope({ seconds: 10, intervalSeconds: 0.5, startSeconds: 1 }));
  const beat = await visuals.beatmapOf({ projectId: 'demo', revision, fromFrame: 60, toFrame: 300 });
  assert.equal(beat.revision, revision);
  assert.equal(beat.fps, 30);
  assert.equal(beat.rangeFrames, 240);
  assert.equal(beat.cutCount, 4);
  assert.equal(beat.sampledClips, 1);
  assert.equal(beat.unsampledClips, 0);
  assert.equal(beat.truncated, false);
  const cut = beat.hits.find((hit) => hit.frame === 90);
  assert.equal(cut.source, 'cut');
  assert.equal(cut.aligned, true, 'an onset on a cut confirms it instead of duplicating it');
  assert.equal(beat.hits.some((hit) => hit.frame === 75 && hit.source === 'onset'), true, 'onsets between cuts survive');
  assert.equal(beat.hits.at(-1).frame, 300);
  assert.equal(beat.hits.at(-1).pct, 100);
  assert.ok(beat.onsetCount >= 10, `onsetCount ${beat.onsetCount}`);
  assert.ok(Math.abs(beat.grid.bpm - 120) <= 1, `grid ${JSON.stringify(beat.grid)}`);
  await assert.rejects(
    () => visuals.beatmapOf({ projectId: 'demo', revision: 'f'.repeat(64), fromFrame: 60, toFrame: 300 }),
    (error) => error.code === 'E_REVISION_CONFLICT',
  );
});

test('asset.align returns a frame-accurate window and only suggests a beat layer when it must', async () => {
  const { timeline, revision } = beatFixture();
  const visuals = stubVisuals(timeline, clickEnvelope({ seconds: 10, intervalSeconds: 0.5, startSeconds: 1 }));
  const aligned = await visuals.alignOf({ projectId: 'demo', revision, assetId: 'as_11111111', fromFrame: 60, toFrame: 300 });
  assert.equal(aligned.tempoLock, true);
  assert.equal(aligned.hitCount, 16);
  assert.equal(aligned.best.hitRate, 1);
  assert.equal(aligned.best.sourceInFrame, 30, 'the window starts on the song onset that lands on the first cut');
  assert.equal(aligned.beatLayer, null);
  assert.equal(aligned.beatLayerReason, 'aligned');
  assert.ok(aligned.candidates.length <= 3 && aligned.candidates.length >= 1);
  assert.equal(aligned.candidates.every((candidate) => candidate.drift === undefined), true);
  assert.ok(Math.abs(aligned.song.bpm - 120) <= 1, `song ${JSON.stringify(aligned.song)}`);
  assert.ok(JSON.stringify(aligned).length < 48000, 'a reply must stay inside the JSONL line limit');

  const drifted = await visuals.alignOf({
    projectId: 'demo',
    revision,
    assetId: 'as_11111111',
    fromFrame: 60,
    toFrame: 300,
    hitFrames: [97, 270],
    tempoLock: false,
  });
  assert.equal(drifted.hitCount, 2);
  assert.equal(drifted.tempoLock, false);
  assert.equal(drifted.best.toleranceFrames, 5, 'one third of the song beat grid is still a hit');
  assert.equal(drifted.best.hitRate, 0.5, `hitRate ${drifted.best.hitRate}`);
  assert.equal(drifted.best.maxErrorFrames >= 6, true, 'the off-grid hit is out of tolerance');
  assert.equal(drifted.beatLayerReason, 'drift');
  assert.equal(drifted.best.drift.length, 1, 'only the missed hit is reported');
  assert.equal(drifted.beatLayer.score.duration, 8);
  assert.equal(drifted.beatLayer.score.events.filter((event) => event.sound === 'kick').length, 2);
  assert.equal(drifted.beatLayer.score.events.every((event) => event.at + event.duration <= 8 + 1e-9), true);

  await assert.rejects(
    () => visuals.alignOf({ projectId: 'demo', revision, assetId: 'as_00000000', fromFrame: 60, toFrame: 300 }),
    (error) => error.code === 'E_PARAMS',
    'a silent asset cannot be aligned',
  );
});
