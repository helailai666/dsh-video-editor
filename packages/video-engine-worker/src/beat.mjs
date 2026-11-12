import { fail } from './errors.mjs';

/**
 * Deterministic rhythm analysis used to align generated music with the picture.
 *
 * Every function here is pure: it works on the already-cached `peaks-v1`
 * envelope pyramid (finest level = 128 samples @8kHz = 16ms buckets) or on
 * plain frame numbers, so it runs anywhere the engine sources are present and
 * is unit-testable without a browser, ffmpeg or a worker process.
 *
 * The point of this module is that a hit point stops being a word the model
 * hopes a cloud song obeys: the picture contributes measured frames, the song
 * contributes measured onsets, and the alignment is arithmetic.
 */

/** Response bounds. A worker reply travels as one JSONL line limited to 64KB. */
export const MAX_HITS = 120;
export const MAX_ONSETS = 400;
export const MAX_WINDOW_CANDIDATES = 3;
export const MAX_DRIFT_ITEMS = 20;
const MAX_INPUT_HITS = 256;
const MAX_INPUT_ONSETS = 800;
const ASSET_SECONDS_LIMIT = 7200;

const MIN_ONSET_GAP_SECONDS = 0.12;
const MEDIAN_WINDOW_SECONDS = 0.75;
const LOCAL_MAX_WINDOW_SECONDS = 0.1;
const LEVEL_FLOOR = 0.08;
const FLUX_FLOOR = 0.02;
const ONSET_ABSORB_FRAMES = 6;
const GRID_MIN_INTERVAL_SECONDS = 0.3;
const GRID_MAX_INTERVAL_SECONDS = 1.5;
const GRID_MIN_ONSETS = 6;
const GRID_MIN_INTERVALS = 4;
const TOLERANCE_FLOOR_FRAMES = 2;
const TOLERANCE_INTERVAL_RATIO = 0.33;
const SPEED_MIN = 0.9;
const SPEED_MAX = 1.12;
const BEAT_LAYER_MIN_HITS = 2;
const BEAT_LAYER_EVENT_LIMIT = 512;
const BEAT_LAYER_EVENT_SECOND_LIMIT = 900;
const BEAT_LAYER_MAX_DURATION = 180;

function median(list) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function frameWindow(fromFrame, toFrame, fps) {
  if (!Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || toFrame <= fromFrame)
    fail('E_PARAMS', 'Invalid beat window');
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) fail('E_PARAMS', 'Invalid frame rate');
  return toFrame - fromFrame;
}

/**
 * Energy-flux onset detection over an envelope level. Only positive jumps that
 * dominate a local median and clear an absolute floor count, and a greedy
 * minimum gap keeps one onset per drum hit instead of a burst of neighbours.
 */
export function onsetsFromEnvelope(peaks, { bucketSeconds, materialPeak } = {}) {
  const empty = { times: [], strengths: [], truncated: false };
  if (!Array.isArray(peaks) || peaks.length < 2) return empty;
  const bucket = Number(bucketSeconds);
  if (!Number.isFinite(bucket) || bucket <= 0 || bucket > 64) fail('E_PARAMS', 'Invalid envelope bucket size');
  if (peaks.length * bucket > ASSET_SECONDS_LIMIT) fail('E_LIMIT', 'Audio envelope too long');
  const ceiling =
    Number.isFinite(materialPeak) && materialPeak > 0 ? materialPeak : Math.max(0, ...peaks);
  if (!(ceiling > 0)) return empty;
  const flux = peaks.map((value, index) => Math.max(0, (value || 0) - (index ? peaks[index - 1] || 0 : 0)));
  const maxFlux = Math.max(...flux) || 1;
  const halfMedian = Math.max(1, Math.round(MEDIAN_WINDOW_SECONDS / bucket));
  const halfLocal = Math.max(1, Math.round(LOCAL_MAX_WINDOW_SECONDS / bucket));
  const found = [];
  for (let index = 1; index < flux.length; index += 1) {
    const jump = flux[index];
    if (jump <= 0 || peaks[index] < LEVEL_FLOOR * ceiling) continue;
    let dominant = true;
    for (let near = Math.max(1, index - halfLocal); dominant && near <= Math.min(flux.length - 1, index + halfLocal); near += 1)
      if (near !== index && flux[near] > jump) dominant = false;
    if (!dominant) continue;
    const around = flux.slice(Math.max(1, index - halfMedian), Math.min(flux.length, index + halfMedian) + 1);
    if (jump < 1.6 * median(around) + FLUX_FLOOR * ceiling) continue;
    found.push({ index, strength: jump / maxFlux });
  }
  const kept = [];
  for (const candidate of found) {
    const last = kept[kept.length - 1];
    if (!last || (candidate.index - last.index) * bucket >= MIN_ONSET_GAP_SECONDS) kept.push(candidate);
    else if (candidate.strength > last.strength) kept[kept.length - 1] = candidate;
  }
  const truncated = kept.length > MAX_ONSETS;
  const picked = truncated
    ? kept
        .slice()
        .sort((a, b) => b.strength - a.strength)
        .slice(0, MAX_ONSETS)
        .sort((a, b) => a.index - b.index)
    : kept;
  return {
    times: picked.map((onset) => round3(onset.index * bucket)),
    strengths: picked.map((onset) => Math.round(onset.strength * 10000) / 10000),
    truncated,
  };
}

/**
 * Beat grid from onset spacing: a modal inter-onset interval inside the
 * danceable range, its local median as the grid, then a phase search. Fewer
 * than six onsets means "no trustworthy pulse" and the caller falls back to the
 * picture cut grid instead of pretending a tempo was found.
 */
export function estimateGrid(times) {
  const none = { bpm: null, intervalSeconds: null, phaseSeconds: 0, confidence: 0 };
  if (!Array.isArray(times) || times.length < GRID_MIN_ONSETS) return none;
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index] - times[index - 1];
    if (delta >= GRID_MIN_INTERVAL_SECONDS && delta <= GRID_MAX_INTERVAL_SECONDS) intervals.push(delta);
  }
  if (intervals.length < GRID_MIN_INTERVALS) return none;
  const bins = new Map();
  for (const delta of intervals) {
    const key = Math.round(delta * 100);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  let modalKey = null;
  let modalCount = 0;
  for (const [key, count] of bins) {
    if (count > modalCount || (count === modalCount && modalKey !== null && key > modalKey)) {
      modalKey = key;
      modalCount = count;
    }
  }
  if (modalKey === null) return none;
  const near = intervals.filter((delta) => Math.abs(delta - modalKey / 100) <= 0.05);
  const intervalSeconds = Number(median(near.length ? near : intervals).toFixed(4));
  if (!(intervalSeconds > 0)) return none;
  let bestPhase = 0;
  let bestCost = Infinity;
  let inside = 0;
  const tolerance = 0.15 * intervalSeconds;
  for (let step = 0; step < 8; step += 1) {
    const phase = (intervalSeconds * step) / 8;
    let cost = 0;
    for (const time of times) {
      const remainder = (((time - phase) % intervalSeconds) + intervalSeconds) % intervalSeconds;
      cost += Math.min(remainder, intervalSeconds - remainder);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestPhase = phase;
    }
  }
  for (const time of times) {
    const remainder = (((time - bestPhase) % intervalSeconds) + intervalSeconds) % intervalSeconds;
    if (Math.min(remainder, intervalSeconds - remainder) <= tolerance) inside += 1;
  }
  return {
    bpm: Math.round(60 / intervalSeconds),
    intervalSeconds,
    phaseSeconds: Number(bestPhase.toFixed(4)),
    confidence: Number((inside / times.length).toFixed(3)),
  };
}

function toHit(frame, fromFrame, rangeFrames, fps, source, strength) {
  return {
    frame,
    seconds: round3((frame - fromFrame) / fps),
    pct: Math.round(((frame - fromFrame) / rangeFrames) * 1000) / 10,
    source,
    strength,
  };
}

function capHits(hits) {
  if (hits.length <= MAX_HITS) return { hits, truncated: false };
  const step = hits.length / MAX_HITS;
  const picked = [];
  for (let index = 0; index < MAX_HITS; index += 1) picked.push(hits[Math.floor(index * step)]);
  return { hits: picked, truncated: true };
}

/**
 * Picture cut points inside the selected range. Only unmutated non-audio tracks
 * contribute; a cut is a hit the editor already committed to, which is why it
 * outranks any analysis.
 */
export function pictureHits({ tracks, fromFrame, toFrame, fps = 30 } = {}) {
  if (!Array.isArray(tracks)) fail('E_PARAMS', 'Invalid timeline tracks');
  const rangeFrames = frameWindow(fromFrame, toFrame, fps);
  const frames = new Set();
  for (const track of tracks) {
    if (!track || track.kind === 'audio' || track.muted === true || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (!clip || clip.muted === true || !Number.isInteger(clip.startFrame)) continue;
      if (clip.startFrame > fromFrame && clip.startFrame <= toFrame) frames.add(clip.startFrame);
    }
  }
  frames.add(toFrame);
  const sorted = [...frames].sort((a, b) => a - b);
  return capHits(sorted.map((frame) => toHit(frame, fromFrame, rangeFrames, fps, 'cut', 1)));
}

/** Fold measured audio events into the cut list without duplicating a cut. */
export function mergeOnsetHits(hitResult, onsets, { fromFrame, toFrame, fps = 30 } = {}) {
  const base = Array.isArray(hitResult?.hits) ? hitResult.hits : [];
  if (base.length > MAX_INPUT_HITS) fail('E_PARAMS', 'Too many picture hits');
  const rangeFrames = frameWindow(fromFrame, toFrame, fps);
  const hits = base.map((hit) => Object.assign({}, hit));
  const times = onsets?.times;
  if (!Array.isArray(times) || !Array.isArray(onsets.strengths)) fail('E_PARAMS', 'Invalid onset envelope');
  if (times.length > MAX_INPUT_ONSETS) fail('E_PARAMS', 'Too many measured onsets');
  for (let index = 0; index < times.length; index += 1) {
    const frame = fromFrame + Math.round(times[index] * fps);
    if (frame <= fromFrame || frame > toFrame) continue;
    let nearest = null;
    for (const hit of hits) {
      const distance = Math.abs(hit.frame - frame);
      if (nearest === null || distance < nearest.distance) nearest = { hit, distance };
    }
    if (nearest !== null && nearest.distance <= ONSET_ABSORB_FRAMES) {
      nearest.hit.aligned = true;
      continue;
    }
    hits.push(toHit(frame, fromFrame, rangeFrames, fps, 'onset', onsets.strengths[index] ?? 0));
  }
  hits.sort((a, b) => a.frame - b.frame);
  return capHits(hits);
}

/**
 * How well one candidate window lands on the picture. Errors are in frames so a
 * report can say "the reversal is 7 frames late" instead of adjectives.
 */
export function alignScore({
  hitFrames,
  onsetFrames,
  windowFrame,
  baseFrame,
  rangeFrames,
  speed = 1,
  gridIntervalFrames,
} = {}) {
  if (!Array.isArray(hitFrames) || !hitFrames.length) fail('E_PARAMS', 'No picture hits to align');
  if (!Array.isArray(onsetFrames)) fail('E_PARAMS', 'No song onsets to align');
  if (!Number.isFinite(speed) || speed <= 0) fail('E_PARAMS', 'Invalid tempo factor');
  const tolerance = Math.max(
    TOLERANCE_FLOOR_FRAMES,
    Number.isFinite(gridIntervalFrames) && gridIntervalFrames > 0
      ? Math.round(TOLERANCE_INTERVAL_RATIO * gridIntervalFrames)
      : TOLERANCE_FLOOR_FRAMES,
  );
  const mapped = onsetFrames
    .map((frame) => baseFrame + (frame - windowFrame) / speed)
    .filter((frame) => frame >= baseFrame && frame <= baseFrame + rangeFrames)
    .sort((a, b) => a - b);
  const drift = [];
  let total = 0;
  let worst = 0;
  let hits = 0;
  for (const frame of hitFrames) {
    let best = null;
    for (const candidate of mapped) {
      const distance = Math.abs(candidate - frame);
      if (best === null || distance < best.distance) best = { candidate, distance };
    }
    if (best === null) {
      drift.push({ hitFrame: frame, nearestOnsetFrame: null, errorFrames: null });
      continue;
    }
    const error = Math.round(best.distance * 100) / 100;
    total += error;
    if (error > worst) worst = error;
    if (error <= tolerance) hits += 1;
    else drift.push({ hitFrame: frame, nearestOnsetFrame: Math.round(best.candidate * 100) / 100, errorFrames: error });
  }
  drift.sort((a, b) => (b.errorFrames ?? 0) - (a.errorFrames ?? 0));
  return {
    hitRate: Number((hits / hitFrames.length).toFixed(3)),
    meanErrorFrames: Number((total / hitFrames.length).toFixed(2)),
    maxErrorFrames: Number(worst.toFixed(2)),
    toleranceFrames: tolerance,
    onsetCount: mapped.length,
    drift: drift.slice(0, MAX_DRIFT_ITEMS),
  };
}

/**
 * Search the song for the window that lands most picture hits. Offsets are the
 * measured onsets themselves (plus the head of the asset, so a silent intro is
 * explicitly evaluated instead of being pasted by default), and the optional
 * tempo lock only ever nudges playback inside 0.90-1.12.
 */
export function chooseWindow({
  hitFrames,
  onsetFrames,
  baseFrame,
  rangeFrames,
  assetDurationFrames,
  grid,
  songGrid,
  tempoLock = false,
} = {}) {
  if (!Array.isArray(onsetFrames) || !onsetFrames.length) fail('E_PARAMS', 'Song has no measured onsets');
  if (!Number.isInteger(rangeFrames) || rangeFrames < 1) fail('E_PARAMS', 'Invalid range length');
  const upper = Number.isInteger(assetDurationFrames) && assetDurationFrames > 0 ? assetDurationFrames : onsetFrames.at(-1) + 1;
  const sampled = [];
  const stride = Math.max(1, Math.ceil(onsetFrames.length / 200));
  for (let index = 0; index < onsetFrames.length; index += stride) sampled.push(onsetFrames[index]);
  const offsets = [...new Set([0, ...sampled])].filter(
    (frame) => frame >= 0 && frame + rangeFrames <= upper,
  );
  const speeds = [1];
  if (tempoLock === true && grid?.bpm && songGrid?.bpm) {
    const nudged = Math.round((grid.bpm / songGrid.bpm) * 100) / 100;
    if (nudged >= SPEED_MIN && nudged <= SPEED_MAX && nudged !== 1) speeds.push(nudged);
  }
  const gridIntervalFrames = Number.isFinite(grid?.intervalSeconds)
    ? grid.intervalSeconds * 30
    : Number.isFinite(songGrid?.intervalSeconds)
      ? songGrid.intervalSeconds * 30
      : undefined;
  const scored = [];
  for (const speed of speeds) {
    for (const windowFrame of offsets) {
      if (windowFrame + rangeFrames * speed > upper) continue;
      const score = alignScore({
        hitFrames,
        onsetFrames,
        windowFrame,
        baseFrame,
        rangeFrames,
        speed,
        gridIntervalFrames,
      });
      scored.push({ sourceInFrame: windowFrame, seconds: round3(windowFrame / 30), speed, ...score });
    }
  }
  if (!scored.length) fail('E_LIMIT', 'No window inside the asset fits the range');
  scored.sort((a, b) => b.hitRate - a.hitRate || a.meanErrorFrames - b.meanErrorFrames || a.sourceInFrame - b.sourceInFrame);
  const best = scored[0];
  return {
    best,
    candidates: scored
      .slice(0, MAX_WINDOW_CANDIDATES)
      .map(({ drift, ...candidate }) => candidate),
  };
}

/**
 * Compile the picture hit list into a free, frame-accurate procedural score.
 * The cloud song owns melody; this layer owns the moment the cut happens.
 * Output shape is exactly the `host/audio-synth.js` score contract.
 */
export function compileBeatLayer({ hits, grid, rangeSeconds } = {}) {
  if (!Array.isArray(hits)) fail('E_PARAMS', 'Invalid beat layer hits');
  const usable = hits.filter((hit) => Number.isFinite(hit?.seconds));
  if (usable.length < BEAT_LAYER_MIN_HITS) return null;
  const duration = Math.min(BEAT_LAYER_MAX_DURATION, round3(rangeSeconds));
  if (!(duration > 0)) return null;
  const ordered = usable
    .filter((hit) => hit.seconds >= 0 && hit.seconds < duration)
    .sort((a, b) => a.seconds - b.seconds);
  const events = [];
  let previousCut = null;
  ordered.forEach((hit, index) => {
    const strong = hit.strength >= 0.6 || hit.aligned === true;
    if (!strong) return;
    const at = round3(hit.seconds);
    events.push({ sound: 'kick', at, duration: 0.16, note: 36, gainDb: -6 });
    if (index % 4 === 0)
      events.push({ sound: 'bass', at, duration: 0.5, note: 29, gainDb: -9 });
    if (hit.strength >= 0.85 && at >= 0.5)
      events.push({ sound: 'riser', at: round3(at - 0.5), duration: 0.5, gainDb: -15 });
    if (hit.source === 'cut' && previousCut !== null && at - previousCut < 1)
      events.push({ sound: 'whoosh', at: round3(Math.max(0, at - 0.2)), duration: 0.2, gainDb: -18 });
    if (hit.source === 'cut') previousCut = at;
  });
  if (!events.length) return null;
  if (Number.isFinite(grid?.intervalSeconds) && duration <= 90) {
    const every = grid.intervalSeconds;
    const start = Math.min(Math.max(0, grid.phaseSeconds || 0), duration - every);
    const repeat = start >= 0 ? Math.floor((duration - start) / every) : 0;
    if (repeat >= 2 && repeat <= 128)
      events.push({
        sound: 'hat',
        at: round3(start),
        duration: 0.03,
        note: 72,
        gainDb: -26,
        repeat,
        every,
      });
  }
  // `validateScore` expands repeats and caps both the event count and the total
  // rendered sound, so trim the least important hits before the call ever fails.
  const expanded = (event) => (event.repeat ?? 1);
  const weight = (event) => (event.sound === 'hat' ? 0 : event.sound === 'kick' ? event.gainDb : -3);
  let count = events.reduce((total, event) => total + expanded(event), 0);
  let sound = events.reduce((total, event) => total + event.duration * expanded(event), 0);
  while ((count > BEAT_LAYER_EVENT_LIMIT || sound > BEAT_LAYER_EVENT_SECOND_LIMIT) && events.length > 1) {
    const droppable = events
      .filter((event) => event.sound !== 'hat')
      .sort((a, b) => weight(a) - weight(b))[0];
    if (!droppable) break;
    events.splice(events.indexOf(droppable), 1);
    count = events.reduce((total, event) => total + expanded(event), 0);
    sound = events.reduce((total, event) => total + event.duration * expanded(event), 0);
  }
  const hat = events.find((event) => event.sound === 'hat');
  if (hat && (count > BEAT_LAYER_EVENT_LIMIT || sound > BEAT_LAYER_EVENT_SECOND_LIMIT)) {
    const room = Math.max(0, Math.min(BEAT_LAYER_EVENT_LIMIT, Math.floor(BEAT_LAYER_EVENT_SECOND_LIMIT / hat.duration)) - (count - expanded(hat)));
    if (room < 2) events.splice(events.indexOf(hat), 1);
    else hat.repeat = Math.min(hat.repeat, room);
  }
  if (events.length < BEAT_LAYER_MIN_HITS) return null;
  // `validateScore` refuses any event that reaches past the score duration, so
  // a hit landing in the last 16ms of the range must not emit a tail.
  const inside = events.filter((event) => event.at >= 0 && event.at + event.duration <= duration + 1e-9);
  if (inside.length < BEAT_LAYER_MIN_HITS) return null;
  return { duration, seed: 7, masterDb: -6, events: inside.sort((a, b) => a.at - b.at) };
}
