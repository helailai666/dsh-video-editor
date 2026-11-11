import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_RENDER_TIMEOUT_MS,
  renderTimeoutMs,
  validateProbeTimeoutMs,
} from '../src/jobs.mjs';

// A long vertical film is what used to die in `validate`: the capture reached
// progress 1, then the fixed 15s `-count_frames` probe killed the job and the
// private directory was removed, so no MP4 ever existed to find.
test('render capture deadline scales with the frame count', () => {
  assert.equal(renderTimeoutMs(600), 300000); // floor for short compositions
  assert.equal(renderTimeoutMs(4794), 1270560); // 159.8s @30fps
  assert.equal(renderTimeoutMs(108000), MAX_RENDER_TIMEOUT_MS); // ceiling
});

test('validation probe budget decodes every frame instead of a fixed 15s', () => {
  assert.equal(validateProbeTimeoutMs(1), 15000);
  assert.equal(validateProbeTimeoutMs(600), 25000);
  assert.equal(validateProbeTimeoutMs(4794), 129850);
  assert.equal(validateProbeTimeoutMs(108000), 2710000);
});

test('both budgets reject frame counts outside a supported composition', () => {
  for (const bad of [0, -1, 108001, '600', NaN, Infinity]) {
    assert.throws(() => renderTimeoutMs(bad), (error) => error.code === 'E_PARAMS');
    assert.throws(
      () => validateProbeTimeoutMs(bad),
      (error) => error.code === 'E_PARAMS',
    );
  }
});

test('the count_frames probe is scaled and every timeout publishes a reason', async () => {
  const source = await readFile(
    new URL('../src/jobs.mjs', import.meta.url),
    'utf8',
  );
  const probe = source.indexOf('"-count_frames"');
  assert.ok(probe >= 0, 'the validation probe still exists');
  const window = source.slice(probe, probe + 1200);
  assert.ok(
    window.includes('timeoutMs: validateProbeTimeoutMs(frames)'),
    'the count_frames probe must use the scaled budget',
  );
  assert.ok(
    window.includes('timeoutMs: 15000') === false,
    'the fixed 15s count_frames budget must be gone',
  );
  assert.ok(
    source.includes('const frames = Math.round(doc.compositionDuration * fps);') ===
      true,
    'the frame count is computed before the probe runs',
  );
  const timeouts = source.match(/code: "E_TIMEOUT"/g) ?? [];
  assert.equal(
    timeouts.length,
    2,
    'both timed_out exits (engine and validation) must carry an error record',
  );
});
