import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PluginSettingsStore,
  normalizeBaseUrl,
  normalizeCustomSystemPrompt,
  normalizeMusicModel,
  MAX_CUSTOM_MUSIC_MODELS,
  MAX_CUSTOM_SYSTEM_PROMPT,
} from '../host/plugin-settings.js';

const root = await mkdtemp(join(tmpdir(), 'plugin-settings-'));
const path = join(root, 'plugin-settings.json');
const code = async (promise) => promise.then(
  () => null,
  (error) => error.code,
);

try {
  // 1. Fresh boot creates defaults atomically and serves a sync snapshot.
  const store = new PluginSettingsStore({ path });
  await store.prepare();
  assert.deepEqual(store.get(), {
    version: 1,
    defaultMusicModelId: 'qianwen',
    customSystemPrompt: '',
    musicModels: [],
  });
  assert.equal(store.customSystemPrompt(), '');

  // 2. Base URL fence: public HTTPS roots only.
  for (const bad of [
    'http://service.example.com',
    'https://service.example.com:8443',
    'https://user:pass@service.example.com',
    'https://service.example.com/v1?key=1',
    'https://service.example.com/#frag',
    'https://localhost',
    'https://api.localhost',
    'https://127.0.0.1',
    'not a url',
  ])
    assert.match(String(await code(Promise.resolve().then(() => normalizeBaseUrl(bad)))), /E_AUDIO_ENDPOINT|E_PARAMS/, bad);
  assert.equal(normalizeBaseUrl('https://service.example.com/v2/'), 'https://service.example.com/v2');

  // 3. Model validation and Host-generated ids.
  assert.match(String(await code(Promise.resolve().then(() => normalizeMusicModel({ name: '', protocol: 'qianwen-sync', baseUrl: 'https://a.example.com', remoteModel: 'm' })))), /E_PARAMS/);
  assert.match(String(await code(Promise.resolve().then(() => normalizeMusicModel({ id: 'qianwen', name: 'x', protocol: 'qianwen-sync', baseUrl: 'https://a.example.com', remoteModel: 'm' })))), /E_PARAMS/);
  assert.match(String(await code(Promise.resolve().then(() => normalizeMusicModel({ name: 'x', protocol: 'openai', baseUrl: 'https://a.example.com', remoteModel: 'm' })))), /E_PARAMS/);
  const created = normalizeMusicModel({ name: '我的配乐模型', protocol: 'qianwen-async', baseUrl: 'https://service.example.com', remoteModel: 'music-x' });
  assert.match(created.id, /^music_[a-f0-9]{16}$/);

  await store.saveModel(created);
  assert.equal(store.get().musicModels.length, 1);
  // Re-saving with the same id updates in place.
  await store.saveModel({ ...created, name: '改名' });
  assert.equal(store.get().musicModels.length, 1);
  assert.equal(store.get().musicModels[0].name, '改名');

  // 4. Unknown fields and duplicate ids never persist.
  assert.match(String(await code(store.saveModel({ ...created, extra: 1 }))), /E_PARAMS/);
  assert.match(String(await code(store.restore({ ...store.get(), musicModels: [created, created] }))), /E_SETTINGS_CORRUPT/);

  // 5. Default model selection + fallback when the default is removed.
  await store.setDefaultModel(created.id);
  assert.equal(store.get().defaultMusicModelId, created.id);
  assert.match(String(await code(store.setDefaultModel('music_0000000000000000'))), /E_MODEL_NOT_FOUND/);
  assert.match(String(await code(store.removeModel('qianwen'))), /E_PARAMS/);
  await store.removeModel(created.id);
  assert.equal(store.get().defaultMusicModelId, 'qianwen');
  assert.equal(store.get().musicModels.length, 0);

  // 6. Model count bound.
  const many = Array.from({ length: MAX_CUSTOM_MUSIC_MODELS }, (_unused, index) => ({
    id: `music_${index.toString(16).padStart(16, '0')}`,
    name: `m${index}`,
    protocol: 'qianwen-sync',
    baseUrl: 'https://a.example.com',
    remoteModel: 'r',
  }));
  await store.restore({ ...store.get(), musicModels: many });
  assert.match(String(await code(store.saveModel({ name: 'one too many', protocol: 'qianwen-sync', baseUrl: 'https://a.example.com', remoteModel: 'r' }))), /E_LIMIT/);
  await store.restore({ ...store.get(), musicModels: [] });

  // 7. Prompt trim, budget, control-character rejection and restore-default.
  const saved = await store.setCustomSystemPrompt('\n  配乐要突出对抗节奏  \n');
  assert.equal(saved.customSystemPrompt, '配乐要突出对抗节奏');
  assert.equal(store.customSystemPrompt(), '配乐要突出对抗节奏');
  assert.match(String(await code(store.setCustomSystemPrompt('x'.repeat(MAX_CUSTOM_SYSTEM_PROMPT + 1)))), /E_PARAMS/);
  assert.match(String(await code(store.setCustomSystemPrompt('bad\u0000char'))), /E_PARAMS/);
  await store.setCustomSystemPrompt('');
  assert.equal(store.get().customSystemPrompt, '');

  // 8. Atomic persistence survives a restart; a corrupt file is kept, not reset.
  await store.saveModel(created);
  const again = new PluginSettingsStore({ path });
  await again.prepare();
  assert.equal(again.get().musicModels[0].id, created.id);
  if (process.platform !== 'win32')
    assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, '{truncated');
  const broken = new PluginSettingsStore({ path });
  assert.match(String(await code(broken.prepare())), /E_SETTINGS_CORRUPT/);
  assert.equal((await readFile(path, 'utf8')).includes('truncated'), true, 'corrupt bytes must be preserved');
  // Writes stay unavailable until the file is fixed; the corrupt bytes are kept.
  assert.match(String(await code(broken.saveModel(created))), /E_SETTINGS_CORRUPT|E_SETTINGS_UNAVAILABLE/);
  await writeFile(path, JSON.stringify({ version: 1, defaultMusicModelId: 'qianwen', customSystemPrompt: '', musicModels: [created] }));
  const healed = new PluginSettingsStore({ path });
  await healed.prepare();
  assert.equal(healed.get().musicModels.length, 1);
  assert.equal(healed.customSystemPrompt(), '');

  // 9. Unknown top-level keys are treated as corruption, never persisted.
  await writeFile(path, JSON.stringify({ version: 1, defaultMusicModelId: 'qianwen', customSystemPrompt: '', musicModels: [], apiKey: 'leak' }));
  assert.match(String(await code(new PluginSettingsStore({ path }).prepare())), /E_SETTINGS_CORRUPT/);

  console.log('plugin settings: page-only storage contract (fence, CRUD, default fallback, prompt budget, corruption kept, atomic reload) passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
