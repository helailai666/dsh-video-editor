import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  stat,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AudioService,
  QianwenProvider,
  isPrivateIp,
  isProxyFakeIp,
} from '../host/audio.js';
import { PluginSettingsStore } from '../host/plugin-settings.js';
const root = await mkdtemp(join(tmpdir(), 'm4-provider-'));
let calls = 0;
const provider = {
  id: 'fake',
  capabilities: () => ({ tts: true, sfx: true, music: false }),
  generate: async (r, { signal }) => {
    calls++;
    await new Promise((res, rej) => {
      const t = setTimeout(res, 40);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          rej(new Error('abort'));
        },
        { once: true },
      );
    });
    return {
      bytes: Buffer.from('audio'),
      extension: 'wav',
      usage: { duration: 1 },
    };
  },
};
const opts = {
  root,
  providers: [provider],
  importAudio: async (p, file) => ({
    asset: { assetId: 'as_12345678', kind: 'audio' },
  }),
};
try {
  const s = new AudioService(opts);
  await s.configure({ apiKey: 'sk-test-private' });
  if (process.platform !== 'win32')
    assert.equal(
      (await stat(join(root, 'audio-secrets.json'))).mode & 0o777,
      0o600,
    );
  assert.doesNotMatch(JSON.stringify(await s.settings()), /sk-test-private/);
  const req = {
    projectId: 'demo',
    operationId: 'op_one',
    provider: 'fake',
    kind: 'tts',
    text: '你好',
    voice: 'longanhuan_v3.1',
  };
  let j = await s.generate(req);
  assert.equal((await s.generate(req)).jobId, j.jobId);
  await assert.rejects(
    () => s.generate({ ...req, text: '不同' }),
    (e) => e.code === 'E_OPERATION_REUSED',
  );
  while (
    !['succeeded', 'failed'].includes(
      (j = await s.status('demo', j.jobId)).state,
    )
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(j.state, 'succeeded');
  assert.equal(calls, 1);
  await assert.rejects(
    () => s.status('other', j.jobId),
    (e) => e.code === 'E_JOB_NOT_FOUND',
  );
  const again = new AudioService(opts);
  assert.equal((await again.generate(req)).jobId, j.jobId);
  assert.equal(calls, 1);
  let cancel = await s.generate({ ...req, operationId: 'op_cancel' });
  await s.cancel('demo', cancel.jobId);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await s.status('demo', cancel.jobId)).state, 'cancelled');
  const q = new QianwenProvider({
    getKey: async () => 'secret',
    fetch: async () =>
      new Response(
        JSON.stringify({ code: 'AccessDenied', message: 'secret raw' }),
        { status: 403 },
      ),
  });
  await assert.rejects(
    () =>
      q.generate(
        { kind: 'music', text: 'piano' },
        { signal: new AbortController().signal },
      ),
    (e) => e.code === 'E_AUDIO_ENTITLEMENT' && !e.message.includes('secret'),
  );
  const q2 = new QianwenProvider({
    getKey: async () => 'secret',
    fetch: async () =>
      new Response(
        JSON.stringify({ output: { audio: { url: 'http://127.0.0.1/a' } } }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    () =>
      q2.generate(
        { kind: 'tts', text: 'hi' },
        { signal: new AbortController().signal },
      ),
    (e) => e.code === 'E_AUDIO_DOWNLOAD',
  );
  let upgraded = false;
  const q3 = new QianwenProvider({
    getKey: async () => 'secret',
    fetch: async (url) => {
      if (String(url).includes('SpeechSynthesizer'))
        return new Response(
          JSON.stringify({
            output: {
              audio: {
                url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav',
              },
            },
          }),
        );
      upgraded = String(url).startsWith('https:');
      return new Response('wave');
    },
  });
  await q3.generate(
    { kind: 'tts', text: 'hi' },
    { signal: new AbortController().signal },
  );
  assert.equal(upgraded, true);
  // Recovery never submits an ambiguous paid request again.
  const recoveryRoot = join(root, 'recovery');
  const recovery = new AudioService({ ...opts, root: recoveryRoot });
  await recovery.prepare();
  await writeFile(
    join(recoveryRoot, 'audio-jobs.json'),
    JSON.stringify({ jobs: [{ ...j, state: 'running', hash: 'ignored' }] }),
  );
  const interrupted = await recovery.status('demo', j.jobId);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.error.uncertain, true);
  assert.equal(calls, 2);
  const deniedRoot = join(root, 'denied');
  let deniedCalls = 0;
  const denied = new AudioService({
    ...opts,
    root: deniedRoot,
    providers: [
      {
        id: 'qianwen',
        capabilities: () => ({ music: 'invitation' }),
        generate: async () => {
          deniedCalls++;
          throw Object.assign(new Error('denied'), {
            code: 'E_AUDIO_ENTITLEMENT',
          });
        },
      },
    ],
  });
  let deniedJob = await denied.generate({
    ...req,
    operationId: 'op_music',
    provider: 'qianwen',
    kind: 'music',
  });
  while (
    ['queued', 'running'].includes(
      (deniedJob = await denied.status('demo', deniedJob.jobId)).state,
    )
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    (await denied.settings()).providers[0].capabilities.music,
    false,
  );
  await assert.rejects(
    () =>
      denied.generate({
        ...req,
        operationId: 'op_music_retry',
        provider: 'qianwen',
        kind: 'music',
      }),
    (e) => e.code === 'E_AUDIO_ENTITLEMENT',
  );
  assert.equal(deniedCalls, 1);
  if (process.platform !== 'win32') {
    await chmod(join(root, 'audio-secrets.json'), 0o644);
    await assert.rejects(
      () => s.settings(),
      (e) => e.code === 'E_AUDIO_AUTH',
    );
    await chmod(join(root, 'audio-secrets.json'), 0o600);
  }
  const timed = new AudioService({
    ...opts,
    root: join(root, 'timeout'),
    timeoutMs: 5,
  });
  let tj = await timed.generate({ ...req, operationId: 'op_timeout' });
  while (
    ['queued', 'running'].includes(
      (tj = await timed.status('demo', tj.jobId)).state,
    )
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(tj.state, 'timed_out');
  assert.equal(tj.error.code, 'E_AUDIO_TIMEOUT');
  assert.equal(tj.error.uncertain, true);
  await timed.dispose();
  await recovery.dispose();
  await denied.dispose();
  // ── Page-configured music models: sync/async protocol, recovery, fences ──
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const customRoot = join(root, 'custom');
  const customStore = new PluginSettingsStore({ path: join(customRoot, 'plugin-settings.json') });
  await customStore.prepare();
  const customSnapshot = await customStore.saveModel({
    name: '同步服务',
    protocol: 'qianwen-sync',
    baseUrl: 'https://music.example.com',
    remoteModel: 'remote-music',
  });
  const syncModelId = customSnapshot.musicModels[0].id;
  await customStore.setDefaultModel(syncModelId);
  const seen = [];
  let submissions = 0;
  const custom = new AudioService({
    root: join(customRoot, 'audio'),
    settingsStore: customStore,
    lookup: publicLookup,
    pollIntervalMs: 5,
    importAudio: async () => ({ asset: { assetId: 'as_deadbeef', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      seen.push({ url: String(url), auth: init.headers?.Authorization ?? null });
      if (init.method === 'POST') {
        submissions++;
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'remote-music');
        assert.equal(body.input.is_instrumental, true);
        assert.equal(body.input.format, 'wav');
        assert.equal(body.input.duration, 12.5);
        return new Response(JSON.stringify({ output: { audio: { url: 'https://cdn.example.com/a.wav' } } }));
      }
      return new Response(Buffer.from('RIFFwavebytes'));
    },
  });
  await custom.configure({ apiKey: 'unused-qianwen-key' });
  await custom.saveModel({ model: { id: syncModelId, name: '同步服务', protocol: 'qianwen-sync', baseUrl: 'https://music.example.com', remoteModel: 'remote-music' }, apiKey: 'sk-custom-secret' });
  let cj = await custom.generate({
    projectId: 'demo',
    operationId: 'sync_score',
    kind: 'music',
    text: '对立 对抗节奏',
    durationFrames: 375,
  });
  assert.equal(cj.provider, 'custom-music');
  assert.equal(cj.modelId, syncModelId);
  while (['queued', 'running', 'downloading'].includes((cj = await custom.status('demo', cj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(cj.state, 'succeeded', JSON.stringify(cj));
  assert.equal(submissions, 1);
  const apiCalls = seen.filter((c) => c.url.includes('music/generation'));
  const downloadCalls = seen.filter((c) => c.url.includes('cdn.example.com'));
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0].auth, /Bearer sk-custom-secret/);
  assert.ok(downloadCalls.length >= 1);
  assert.equal(downloadCalls.every((c) => c.auth === null), true, 'downloads must never carry the API key');
  // Idempotency: same operationId, different target duration is a reuse error.
  await assert.rejects(
    () => custom.generate({ projectId: 'demo', operationId: 'sync_score', kind: 'music', text: '对立 对抗节奏', durationFrames: 300 }),
    (e) => e.code === 'E_OPERATION_REUSED',
  );
  const customRecipe = await custom.recipe('demo', cj.jobId);
  assert.equal(customRecipe.provider, 'qianwen');
  assert.equal(customRecipe.modelId, syncModelId);
  assert.equal(customRecipe.durationFrames, 375);
  assert.doesNotMatch(JSON.stringify(customRecipe), /music\.example\.com|sk-custom-secret/);
  const customSettings = await custom.settings();
  assert.equal(customSettings.defaultMusicModelId, syncModelId);
  assert.doesNotMatch(JSON.stringify(customSettings), /sk-custom-secret|unused-qianwen-key/);
  assert.equal(customSettings.musicModels.find((m) => m.id === syncModelId).hasKey, true);
  assert.equal(customSettings.musicModels.find((m) => m.id === syncModelId).baseUrl, 'https://music.example.com');
  await assert.rejects(
    () => custom.generate({ projectId: 'demo', operationId: 'gone', kind: 'music', text: 'x', modelId: 'music_0000000000000000' }),
    (e) => e.code === 'E_MODEL_NOT_FOUND',
  );
  await custom.dispose();

  const asyncRoot = join(root, 'async');
  let posts = 0;
  let polls = 0;
  const asyncFetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      posts++;
      return new Response(JSON.stringify({ output: { task_id: 'task-9_XY' } }));
    }
    if (String(url).includes('/tasks/task-9_XY')) {
      polls++;
      // The second query drops: polls must retry within the deadline and
      // must never re-submit the paid generation.
      if (polls === 2) throw new Error('transient query outage');
      if (polls < 4) return new Response(JSON.stringify({ output: { task_status: 'RUNNING' } }));
      return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', audio: { url: 'https://cdn.example.com/b.wav' } } }));
    }
    return new Response(Buffer.from('wavebytes'));
  };
  const asyncStore = new PluginSettingsStore({ path: join(asyncRoot, 'plugin-settings.json') });
  await asyncStore.prepare();
  const asyncSnap = await asyncStore.saveModel({ name: '异步服务', protocol: 'qianwen-async', baseUrl: 'https://async.example.com', remoteModel: 'am' });
  const asyncModelId = asyncSnap.musicModels[0].id;
  await asyncStore.setDefaultModel(asyncModelId);
  const asyncSvc = new AudioService({
    root: join(asyncRoot, 'audio'),
    settingsStore: asyncStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_abcdef01', kind: 'audio' } }),
    fetch: asyncFetch,
  });
  await asyncSvc.writeKey(asyncModelId, 'sk-async-secret');
  let aj = await asyncSvc.generate({ projectId: 'demo', operationId: 'async_score', kind: 'music', text: '鼓点', durationFrames: 60 });
  while (['queued', 'running', 'downloading'].includes((aj = await asyncSvc.status('demo', aj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(aj.state, 'succeeded', JSON.stringify(aj));
  assert.equal(aj.remoteTaskId, 'task-9_XY');
  assert.equal(posts, 1, 'async generation submits exactly once');
  assert.ok(polls >= 4);
  await asyncSvc.dispose();

  // Simulated restart: a persisted running job with a task id resumes by
  // querying only — the paid submit is never repeated.
  const resumeRoot = join(root, 'resume');
  await mkdir(resumeRoot, { recursive: true });
  const resumeStore = new PluginSettingsStore({ path: join(resumeRoot, 'plugin-settings.json') });
  await resumeStore.prepare();
  await resumeStore.saveModel(asyncSnap.musicModels[0]);
  const resumeJobId = 'audio_' + randomUUID();
  await writeFile(join(resumeRoot, 'audio-jobs.json'), JSON.stringify({ jobs: [{ jobId: resumeJobId, projectId: 'demo', operationId: 'async2', provider: 'custom-music', kind: 'music', hash: 'x'.repeat(64), modelId: asyncModelId, remoteTaskId: 'task-9_XY', state: 'running', createdAt: new Date().toISOString() }] }));
  await writeFile(join(resumeRoot, resumeJobId + '.recipe.json'), JSON.stringify({ projectId: 'demo', operationId: 'async2', provider: 'custom-music', kind: 'music', text: '鼓点', durationFrames: 60, modelId: asyncModelId }));
  let resumePosts = 0;
  let resumePolls = 0;
  let resumeImported = 0;
  const resumed = new AudioService({
    root: resumeRoot,
    settingsStore: resumeStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => { resumeImported++; return { asset: { assetId: 'as_abcdef01', kind: 'audio' } }; },
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') { resumePosts++; return new Response('{}'); }
      if (String(url).includes('/tasks/')) { resumePolls++; return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', audio: { url: 'https://cdn.example.com/b.wav' } } })); }
      return new Response(Buffer.from('wavebytes'));
    },
  });
  await resumed.writeKey(asyncModelId, 'sk-async-secret');
  await resumed.resumeJobs();
  let rj;
  for (let i = 0; i < 200 && ['queued', 'running', 'downloading'].includes((rj = await resumed.status('demo', resumeJobId)).state); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(rj.state, 'succeeded', JSON.stringify(rj));
  assert.equal(resumePosts, 0, 'restart must not repeat the paid submit');
  assert.ok(resumePolls >= 1);
  assert.equal(resumeImported, 1);
  await resumed.dispose();

  // A deleted model is not resumed: the job stays interrupted/uncertain.
  const orphanRoot = join(root, 'orphan');
  await mkdir(orphanRoot, { recursive: true });
  const orphanJobId = 'audio_' + randomUUID();
  await writeFile(join(orphanRoot, 'audio-jobs.json'), JSON.stringify({ jobs: [{ jobId: orphanJobId, projectId: 'demo', operationId: 'async3', provider: 'custom-music', kind: 'music', hash: 'x'.repeat(64), modelId: 'music_ffffffffffffffff', remoteTaskId: 'task-9_XY', state: 'running', createdAt: new Date().toISOString() }] }));
  const orphanStore = new PluginSettingsStore({ path: join(orphanRoot, 'plugin-settings.json') });
  await orphanStore.prepare();
  const orphan = new AudioService({ root: orphanRoot, settingsStore: orphanStore, importAudio: async () => ({ asset: {} }), fetch: async () => new Response('{}') });
  const orphanView = await orphan.status('demo', orphanJobId);
  assert.equal(orphanView.state, 'interrupted');
  assert.equal(orphanView.error.uncertain, true);
  await orphan.dispose();

  // ── Vendor protocols: StepFun base64, Suno create/query, MiniMax hex ──
  const vendorRoot = join(root, 'vendor');
  const vendorStore = new PluginSettingsStore({ path: join(vendorRoot, 'plugin-settings.json') });
  await vendorStore.prepare();
  const stepSnap = await vendorStore.saveModel({ name: 'Step', protocol: 'stepfun', baseUrl: 'https://api.stepfun.com', remoteModel: '' });
  const stepId = stepSnap.musicModels.find((m) => m.name === 'Step').id;
  assert.equal(stepSnap.musicModels.find((m) => m.name === 'Step').remoteModel, 'stepaudio-3-music-preview');
  const sunoSnap = await vendorStore.saveModel({ name: 'Suno', protocol: 'suno-inspiration', baseUrl: 'https://www.suno-api.io', remoteModel: '' });
  const sunoId = sunoSnap.musicModels.find((m) => m.name === 'Suno').id;
  assert.equal(sunoSnap.musicModels.find((m) => m.name === 'Suno').remoteModel, 'suno-v6');
  const mmSnap = await vendorStore.saveModel({ name: 'MM', protocol: 'minimax', baseUrl: 'https://api.minimax.cn', remoteModel: '' });
  const mmId = mmSnap.musicModels.find((m) => m.name === 'MM').id;
  assert.equal(mmSnap.musicModels.find((m) => m.name === 'MM').remoteModel, 'music-3.0');
  const settle = async (svc, job) => {
    let view = job;
    for (let i = 0; i < 300 && ['queued', 'running', 'downloading'].includes((view = await svc.status('demo', job.jobId)).state); i++)
      await new Promise((r) => setTimeout(r, 10));
    return view;
  };
  let stepSubmits = 0;
  const stepSvc = new AudioService({
    root: join(vendorRoot, 'step'),
    settingsStore: vendorStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_step001', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      const body = JSON.parse(init.body || '{}');
      if (String(url).endsWith('/submit')) {
        stepSubmits++;
        assert.equal(body.task, 'text_to_music');
        assert.equal(body.model_id, 'stepaudio-3-music-preview');
        assert.equal(body.instrumental, true);
        assert.equal(body.caption, '对抗节奏');
        assert.match(init.headers.Authorization, /Bearer sk-step/);
        return new Response(JSON.stringify({ task_id: 'st-1' }));
      }
      assert.equal(String(url), 'https://api.stepfun.com/v1/audio/music/query');
      assert.equal(body.task_id, 'st-1');
      return new Response(JSON.stringify({ status: 'SUCCESS', audio: Buffer.from('step-audio-bytes').toString('base64') }));
    },
  });
  await stepSvc.writeKey(stepId, 'sk-step');
  let sj = await stepSvc.generate({ projectId: 'demo', operationId: 'step_score', kind: 'music', text: '对抗节奏', modelId: stepId });
  sj = await settle(stepSvc, sj);
  assert.equal(sj.state, 'succeeded', JSON.stringify(sj));
  assert.equal(stepSubmits, 1);
  assert.equal(sj.remoteTaskId, 'st-1');
  const stepRecipe = await stepSvc.recipe('demo', sj.jobId);
  assert.equal(stepRecipe.modelId, stepId);
  assert.doesNotMatch(JSON.stringify(stepRecipe), /api\.stepfun\.com|sk-step/);
  await stepSvc.dispose();
  // StepFun connection probe: 404 on the fake task proves auth+network without billing.
  const probeSvc = new AudioService({
    root: join(vendorRoot, 'probe'),
    settingsStore: vendorStore,
    lookup: publicLookup,
    importAudio: async () => ({ asset: {} }),
    fetch: async (url, init = {}) => {
      assert.equal(String(url), 'https://api.stepfun.com/v1/audio/music/query');
      assert.equal(JSON.parse(init.body).task_id, 'dsh-video-probe');
      return new Response('{}', { status: 404 });
    },
  });
  await probeSvc.writeKey(stepId, 'sk-step');
  assert.equal((await probeSvc.check(stepId)).connected, true);
  const probe401 = new AudioService({
    root: join(vendorRoot, 'probe'),
    settingsStore: vendorStore,
    lookup: publicLookup,
    importAudio: async () => ({ asset: {} }),
    fetch: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(() => probe401.check(stepId), (e) => e.code === 'E_AUDIO_AUTH');
  await probeSvc.dispose();
  let sunoPosts = 0;
  let sunoProgress = 0;
  const sunoSvc = new AudioService({
    root: join(vendorRoot, 'suno'),
    settingsStore: vendorStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_suno01', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/music/create')) {
        sunoPosts++;
        const b = JSON.parse(init.body);
        assert.equal(b.description, '轻快配乐');
        assert.equal(b.instrumental, true);
        assert.equal(b.model, 'suno-v6');
        assert.equal(b.accept_mode, 'async', 'paid submit must not hold a long connection');
        assert.equal(init.headers['Idempotency-Key'], 'suno_score', 'replay must not double-bill');
        return new Response(JSON.stringify({ success: true, data: { request_id: 'ac_probe1', status: 'queued', tasks: [] } }), { status: 202 });
      }
      if (u.includes('/api/music/requests/ac_probe1')) {
        sunoProgress++;
        if (sunoProgress === 1)
          return new Response(JSON.stringify({ success: true, data: { request_id: 'ac_probe1', status: 'queued', tasks: [] } }));
        return new Response(JSON.stringify({ success: true, data: { request_id: 'ac_probe1', status: 'processing', tasks: [{ index: 0, status: 'pending', song_id: 's1' }, { index: 1, status: 'pending', song_id: 's2' }] } }));
      }
      if (u.endsWith('/api/music/query')) {
        const b = JSON.parse(init.body);
        assert.deepEqual(b.song_ids, ['s1', 's2']);
        return new Response(JSON.stringify({ data: [{ song_id: 's1', status: 'completed', duration: 95, audio_url: 'https://cdn.example.com/s1.mp3' }] }));
      }
      assert.equal(u, 'https://cdn.example.com/s1.mp3');
      assert.equal(init.headers?.Authorization, undefined, 'suno audio download must not carry the key');
      return new Response(Buffer.from('suno-mp3-bytes'));
    },
  });
  await sunoSvc.writeKey(sunoId, 'sk-suno');
  let uj = await sunoSvc.generate({ projectId: 'demo', operationId: 'suno_score', kind: 'music', text: '轻快配乐', modelId: sunoId });
  uj = await settle(sunoSvc, uj);
  assert.equal(uj.state, 'succeeded', JSON.stringify(uj));
  assert.equal(sunoPosts, 1);
  assert.equal(sunoProgress, 2);
  assert.equal(uj.remoteTaskId, 's1,s2', 'real song ids replace the accept id once issued');
  assert.equal(uj.usage.duration, 95);
  await sunoSvc.dispose();
  // Restart before song ids exist: the persisted accept id resumes by querying
  // the free progress endpoint only — the billed submit is never repeated.
  const sunoResumeRoot = join(vendorRoot, 'suno-resume');
  await mkdir(sunoResumeRoot, { recursive: true });
  const sunoResumeJobId = 'audio_' + randomUUID();
  await writeFile(join(sunoResumeRoot, 'audio-jobs.json'), JSON.stringify({ jobs: [{ jobId: sunoResumeJobId, projectId: 'demo', operationId: 'suno_resume', provider: 'custom-music', kind: 'music', hash: 'x'.repeat(64), modelId: sunoId, remoteTaskId: 'req:ac_resume', state: 'running', createdAt: new Date().toISOString() }] }));
  await writeFile(join(sunoResumeRoot, sunoResumeJobId + '.recipe.json'), JSON.stringify({ projectId: 'demo', operationId: 'suno_resume', provider: 'custom-music', kind: 'music', text: '轻快配乐', modelId: sunoId }));
  let sunoResumePosts = 0;
  let sunoResumeProgress = 0;
  let sunoResumeQueries = 0;
  let sunoResumeImported = 0;
  const sunoResumeSvc = new AudioService({
    root: sunoResumeRoot,
    settingsStore: vendorStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => { sunoResumeImported++; return { asset: { assetId: 'as_suno02', kind: 'audio' } }; },
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/music/create') || u.endsWith('/create/custom')) { sunoResumePosts++; return new Response('{}'); }
      if (u.includes('/api/music/requests/ac_resume')) {
        sunoResumeProgress++;
        return new Response(JSON.stringify({ success: true, data: { status: 'processing', tasks: [{ index: 0, status: 'pending', song_id: 's9' }] } }));
      }
      if (u.endsWith('/api/music/query')) {
        sunoResumeQueries++;
        return new Response(JSON.stringify({ data: [{ song_id: 's9', status: 'completed', duration: 60, audio_url: 'https://cdn.example.com/s9.mp3' }] }));
      }
      assert.equal(u, 'https://cdn.example.com/s9.mp3');
      return new Response(Buffer.from('resumed-bytes'));
    },
  });
  await sunoResumeSvc.writeKey(sunoId, 'sk-suno');
  await sunoResumeSvc.resumeJobs();
  let srj;
  for (let i = 0; i < 200 && ['queued', 'running', 'downloading'].includes((srj = await sunoResumeSvc.status('demo', sunoResumeJobId)).state); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(srj.state, 'succeeded', JSON.stringify(srj));
  assert.equal(sunoResumePosts, 0, 'suno resume must never repeat the billed submit');
  assert.ok(sunoResumeProgress >= 1);
  assert.ok(sunoResumeQueries >= 1);
  assert.equal(sunoResumeImported, 1);
  assert.equal(srj.remoteTaskId, 's9', 'the accept id is replaced by the real song id');
  await sunoResumeSvc.dispose();
  // Legacy synchronous envelope (no accept id) still resolves through query.
  let legacyPosts = 0;
  let legacyQueries = 0;
  const legacySvc = new AudioService({
    root: join(vendorRoot, 'suno-legacy'),
    settingsStore: vendorStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_suno03', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/music/create')) {
        legacyPosts++;
        assert.equal(JSON.parse(init.body).accept_mode, 'async');
        return new Response(JSON.stringify([{ song_id: 'l1', status: 'pending' }]));
      }
      if (u.endsWith('/api/music/query')) {
        assert.equal(legacyQueries++, 0);
        return new Response(JSON.stringify([{ song_id: 'l1', status: 'completed', audio_url: 'https://cdn.example.com/l1.mp3' }]));
      }
      assert.equal(u, 'https://cdn.example.com/l1.mp3');
      return new Response(Buffer.from('legacy-bytes'));
    },
  });
  await legacySvc.writeKey(sunoId, 'sk-suno');
  let lj = await legacySvc.generate({ projectId: 'demo', operationId: 'suno_legacy', kind: 'music', text: '轻快配乐', modelId: sunoId });
  lj = await settle(legacySvc, lj);
  assert.equal(lj.state, 'succeeded', JSON.stringify(lj));
  assert.equal(legacyPosts, 1);
  assert.equal(legacyQueries, 1);
  assert.equal(lj.remoteTaskId, 'l1');
  await legacySvc.dispose();
  // Suno professional mode posts style_tags to /create/custom and never
  // exceeds the vendor's 1000 UTF-16-unit limit.
  const customSnap = await vendorStore.saveModel({ name: 'SunoPro', protocol: 'suno-custom', baseUrl: 'https://www.suno-api.io', remoteModel: '' });
  const customId = customSnap.musicModels.find((m) => m.name === 'SunoPro').id;
  assert.equal(customSnap.musicModels.find((m) => m.name === 'SunoPro').remoteModel, 'suno-v6');
  let customTags = '';
  const customSvc = new AudioService({
    root: join(vendorRoot, 'suno-custom'),
    settingsStore: vendorStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_suno04', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/music/create/custom')) {
        const b = JSON.parse(init.body);
        assert.equal(b.style_tags !== undefined, true);
        assert.equal(b.description, undefined, 'custom mode must not send description');
        customTags = b.style_tags;
        return new Response(JSON.stringify({ success: true, data: { request_id: 'ac_c1', status: 'queued', tasks: [] } }), { status: 202 });
      }
      if (u.includes('/api/music/requests/ac_c1'))
        return new Response(JSON.stringify({ success: true, data: { status: 'completed', tasks: [{ index: 0, status: 'completed', song_id: 'c1', audio_url: 'https://cdn.example.com/c1.mp3' }] } }));
      assert.equal(u, 'https://cdn.example.com/c1.mp3');
      return new Response(Buffer.from('custom-bytes'));
    },
  });
  await customSvc.writeKey(customId, 'sk-suno');
  const longTag = Array(240).fill('紧张弦乐').join(',');
  let scj = await customSvc.generate({ projectId: 'demo', operationId: 'suno_custom', kind: 'music', text: longTag, modelId: customId });
  scj = await settle(customSvc, scj);
  assert.equal(scj.state, 'succeeded', JSON.stringify(scj));
  assert.ok(customTags.length <= 1000, `style_tags must be clipped, got ${customTags.length}`);
  assert.equal(customTags.split(',').length, 200, 'clip must land on a tag boundary');
  assert.equal(customTags.endsWith(','), false);
  await customSvc.dispose();
  let mmPosts = 0;
  const mmSvc = new AudioService({
    root: join(vendorRoot, 'mm'),
    settingsStore: vendorStore,
    lookup: publicLookup,
    importAudio: async () => ({ asset: { assetId: 'as_mm00001', kind: 'audio' } }),
    fetch: async (url, init = {}) => {
      mmPosts++;
      assert.equal(String(url), 'https://api.minimax.cn/v1/music_generation');
      const b = JSON.parse(init.body);
      assert.equal(b.model, 'music-3.0');
      assert.equal(b.is_instrumental, true);
      assert.equal(b.output_format, 'hex');
      return new Response(JSON.stringify({ data: { audio: Buffer.from('minimax-mp3-bytes').toString('hex'), status: 2 }, extra_info: { music_duration: 12345 }, base_resp: { status_code: 0 } }));
    },
  });
  await mmSvc.writeKey(mmId, 'sk-mm');
  let mj = await mmSvc.generate({ projectId: 'demo', operationId: 'mm_score', kind: 'music', text: '民谣配乐', modelId: mmId });
  mj = await settle(mmSvc, mj);
  assert.equal(mj.state, 'succeeded', JSON.stringify(mj));
  assert.equal(mmPosts, 1);
  assert.equal(mj.usage.duration, 12.345);
  await mmSvc.dispose();
  // MiniMax business error surfaces as a typed failure, never a silent success.
  const mmErr = new AudioService({
    root: join(vendorRoot, 'mmerr'),
    settingsStore: vendorStore,
    lookup: publicLookup,
    importAudio: async () => ({ asset: {} }),
    fetch: async () => new Response(JSON.stringify({ base_resp: { status_code: 1004 } })),
  });
  await mmErr.writeKey(mmId, 'sk-mm');
  let ej = await mmErr.generate({ projectId: 'demo', operationId: 'mm_err', kind: 'music', text: 'x', modelId: mmId });
  ej = await settle(mmErr, ej);
  assert.equal(ej.state, 'failed');
  assert.equal(ej.error.code, 'E_AUDIO_PROVIDER');
  await mmErr.dispose();
  // Security fences: private DNS, API redirects, download redirects.
  const fenceRoot = join(root, 'fence');
  const fenceStore = new PluginSettingsStore({ path: join(fenceRoot, 'plugin-settings.json') });
  await fenceStore.prepare();
  const fenceSnap = await fenceStore.saveModel({ name: '内网', protocol: 'qianwen-sync', baseUrl: 'https://internal.example.com', remoteModel: 'm' });
  const fenceModelId = fenceSnap.musicModels[0].id;
  const fence = new AudioService({
    root: join(fenceRoot, 'audio'),
    settingsStore: fenceStore,
    importAudio: async () => ({ asset: {} }),
    lookup: async (hostname) => (hostname === 'internal.example.com' || hostname === 'evil.example.com'
      ? [{ address: '10.0.0.5', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }]),
    fetch: async (url, init = {}) => {
      if (init.method === 'POST')
        return new Response(JSON.stringify({ output: { audio: { url: 'https://evil.example.com/a.wav' } } }));
      return new Response(Buffer.from('bytes'));
    },
  });
  await fence.writeKey(fenceModelId, 'sk-fence');
  let fj = await fence.generate({ projectId: 'demo', operationId: 'fence1', kind: 'music', text: 'x', modelId: fenceModelId });
  while (['queued', 'running', 'downloading'].includes((fj = await fence.status('demo', fj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(fj.state, 'failed');
  assert.equal(fj.error.code, 'E_AUDIO_ENDPOINT', 'private DNS must block the API call before any bytes move');
  // Download redirect escaping to a private host is rejected mid-flight.
  let redirected = 0;
  const fence2 = new AudioService({
    root: join(fenceRoot, 'audio2'),
    settingsStore: fenceStore,
    importAudio: async () => ({ asset: {} }),
    lookup: async (hostname) => (hostname === 'evil.example.com' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]),
    fetch: async (url, init = {}) => {
      if (init.method === 'POST')
        return new Response(JSON.stringify({ output: { audio: { url: 'https://cdn.example.com/a.wav' } } }));
      redirected++;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/steal' } });
    },
  });
  await fence2.writeKey(fenceModelId, 'sk-fence');
  let f2j = await fence2.generate({ projectId: 'demo', operationId: 'fence2', kind: 'music', text: 'x', modelId: fenceModelId });
  while (['queued', 'running', 'downloading'].includes((f2j = await fence2.status('demo', f2j.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(f2j.state, 'failed');
  assert.equal(f2j.error.code, 'E_AUDIO_ENDPOINT');
  assert.equal(redirected, 1, 'redirect target is checked before the next request');
  // Local proxies that intercept DNS answer with fake-IPs from reserved
  // testing ranges; those resolved addresses must reach the vendor, while a
  // Base URL literally spelling one out (or real private space) stays blocked.
  assert.equal(isPrivateIp('198.18.0.206'), true, 'literal fake-IP stays rejected');
  assert.equal(isProxyFakeIp('198.19.255.1'), true);
  assert.equal(isProxyFakeIp('2001:2::ce'), true);
  assert.equal(isProxyFakeIp('2001:0200::5'), true);
  assert.equal(isProxyFakeIp('2001:200:abcd::1'), false, 'only the /48 blocks pass');
  assert.equal(isProxyFakeIp('fd00::1'), false);
  assert.equal(isProxyFakeIp('10.0.0.5'), false);
  const fakeStore = new PluginSettingsStore({ path: join(fenceRoot, 'fake-settings.json') });
  await fakeStore.prepare();
  const fakeSnap = await fakeStore.saveModel({ name: '代理', protocol: 'qianwen-sync', baseUrl: 'https://proxy.example.com', remoteModel: 'm' });
  const fakeModelId = fakeSnap.musicModels[0].id;
  const fakeSvc = new AudioService({
    root: join(fenceRoot, 'audio-fake'),
    settingsStore: fakeStore,
    importAudio: async () => ({ asset: { assetId: 'as_12345678', kind: 'audio' } }),
    lookup: async (hostname) => (hostname === 'proxy.example.com'
      ? [{ address: '198.18.0.206', family: 4 }, { address: '2001:2::ce', family: 6 }]
      : [{ address: '93.184.216.34', family: 4 }]),
    fetch: async (url, init = {}) => {
      if (init.method === 'POST')
        return new Response(JSON.stringify({ output: { audio: { url: 'https://proxy.example.com/a.wav' } } }));
      return new Response(Buffer.from('bytes'));
    },
  });
  await fakeSvc.writeKey(fakeModelId, 'sk-fake');
  let fkj = await fakeSvc.generate({ projectId: 'demo', operationId: 'fakeip', kind: 'music', text: 'x', modelId: fakeModelId });
  while (['queued', 'running', 'downloading'].includes((fkj = await fakeSvc.status('demo', fkj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(fkj.state, 'succeeded', 'proxy fake-IP DNS answers must not block vendor endpoints');
  await fakeSvc.dispose();
  // ULA IPv6 answers are real private space and stay blocked after the easing.
  const ulaStore = new PluginSettingsStore({ path: join(fenceRoot, 'ula-settings.json') });
  await ulaStore.prepare();
  const ulaSnap = await ulaStore.saveModel({ name: '内网v6', protocol: 'qianwen-sync', baseUrl: 'https://ula.example.com', remoteModel: 'm' });
  const ula = new AudioService({
    root: join(fenceRoot, 'audio-ula'),
    settingsStore: ulaStore,
    importAudio: async () => ({ asset: {} }),
    lookup: async () => [{ address: 'fd12:3456:7890::1', family: 6 }],
    fetch: async () => new Response('{}'),
  });
  await ula.writeKey(ulaSnap.musicModels[0].id, 'sk-ula');
  let ulaj = await ula.generate({ projectId: 'demo', operationId: 'ula1', kind: 'music', text: 'x', modelId: ulaSnap.musicModels[0].id });
  while (['queued', 'running', 'downloading'].includes((ulaj = await ula.status('demo', ulaj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(ulaj.state, 'failed');
  assert.equal(ulaj.error.code, 'E_AUDIO_ENDPOINT', 'ULA DNS answers must stay blocked');
  await ula.dispose();
  // Unknown async states are protocol errors; the submit is never repeated.
  const badStore = new PluginSettingsStore({ path: join(fenceRoot, 'bad-settings.json') });
  await badStore.prepare();
  const badSnap = await badStore.saveModel({ name: '坏协议', protocol: 'qianwen-async', baseUrl: 'https://bad.example.com', remoteModel: 'm' });
  let badPosts = 0;
  const bad = new AudioService({
    root: join(fenceRoot, 'audio3'),
    settingsStore: badStore,
    pollIntervalMs: 5,
    lookup: publicLookup,
    importAudio: async () => ({ asset: {} }),
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') { badPosts++; return new Response(JSON.stringify({ output: { task_id: 't1' } })); }
      if (String(url).includes('/tasks/')) return new Response(JSON.stringify({ output: { task_status: 'SOMETHING_ELSE' } }));
      return new Response('{}');
    },
  });
  await bad.writeKey(badSnap.musicModels[0].id, 'k');
  let bj = await bad.generate({ projectId: 'demo', operationId: 'bad1', kind: 'music', text: 'x', modelId: badSnap.musicModels[0].id });
  while (['queued', 'running', 'downloading'].includes((bj = await bad.status('demo', bj.jobId)).state))
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(bj.state, 'failed');
  assert.equal(bj.error.code, 'E_AUDIO_PROTOCOL');
  assert.equal(badPosts, 1, 'unknown status never re-submits');
  // Connection check hits the documented models endpoint without generating.
  const checkSeen = [];
  const checker = new AudioService({
    root: join(fenceRoot, 'audio4'),
    settingsStore: fenceStore,
    lookup: publicLookup,
    importAudio: async () => ({ asset: {} }),
    fetch: async (url, init = {}) => { checkSeen.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.Authorization ?? null }); return new Response('{}'); },
  });
  await checker.writeKey(fenceModelId, 'sk-check');
  const checked = await checker.check(fenceModelId);
  assert.equal(checked.connected, true);
  assert.equal(checkSeen.length, 1);
  assert.equal(checkSeen[0].url, 'https://internal.example.com/compatible-mode/v1/models');
  assert.equal(checkSeen[0].method, 'GET');
  await checker.dispose();
  await fence.dispose();
  await fence2.dispose();
  await bad.dispose();
  await custom.dispose();
  await asyncSvc.dispose();
  await s.dispose();
  await again.dispose();
  console.log(
    'audio provider: secure settings, idempotency, restart, ownership, cancellation, error redaction and URL fence passed; custom models: sync/async protocol, task-id resume, key isolation and SSRF fences passed',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
