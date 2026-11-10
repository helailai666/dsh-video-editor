/** Page-owned plugin settings. Secrets are deliberately stored elsewhere. */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BridgeError } from './errors.js';

export const PLUGIN_SETTINGS_VERSION = 1;
export const MAX_PLUGIN_SETTINGS_BYTES = 64 * 1024;
export const MAX_CUSTOM_MUSIC_MODELS = 20;
export const MAX_CUSTOM_SYSTEM_PROMPT = 2000;
export const MUSIC_MODEL_ID = /^music_[a-f0-9]{16}$/;
export const MUSIC_PROTOCOLS = Object.freeze(['qianwen-sync', 'qianwen-async']);

function settingsError(code, message) {
  return new BridgeError(code, message, { stage: 'plugin-settings' });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: PLUGIN_SETTINGS_VERSION,
    defaultMusicModelId: 'qianwen',
    customSystemPrompt: '',
    musicModels: [],
  };
}

export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw settingsError('E_PARAMS', 'Base URL 格式不正确');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw settingsError('E_PARAMS', 'Base URL 格式不正确');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.hostname ||
    /^(localhost|localhost\.|.*\.localhost)$/i.test(url.hostname) ||
    isNonPublicIpLiteral(url.hostname)
  ) {
    throw settingsError('E_AUDIO_ENDPOINT', '自定义服务仅支持公网 HTTPS Base URL');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `https://${url.hostname}${pathname}`;
}

/**
 * Literal IP hosts must already be public at save time; every DNS-resolved
 * hostname is re-checked against A/AAAA results before each request.
 */
function isNonPublicIpLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    if (host.split('.').some((part) => part.length > 1 && part.startsWith('0'))) return true;
    const [a, b] = host.split('.').map(Number);
    if (a > 255 || b > 255) return true;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    return false;
  }
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  const mapped = host.match(/^::ffff:((\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isNonPublicIpLiteral(mapped[1]);
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) return true;
  return false;
}

export function normalizeCustomSystemPrompt(value) {
  if (typeof value !== 'string' || value.length > MAX_CUSTOM_SYSTEM_PROMPT + 2) {
    throw settingsError('E_PARAMS', `追加提示词最多 ${MAX_CUSTOM_SYSTEM_PROMPT} 字符`);
  }
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_CUSTOM_SYSTEM_PROMPT || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw settingsError('E_PARAMS', `追加提示词最多 ${MAX_CUSTOM_SYSTEM_PROMPT} 字符，且不能包含控制字符`);
  }
  return text;
}

export function normalizeMusicModel(value, { allowId = true } = {}) {
  if (!exactKeys(value, ['id', 'name', 'protocol', 'baseUrl', 'remoteModel'])) {
    throw settingsError('E_PARAMS', '音乐模型包含不支持的字段');
  }
  if (!allowId && value.id !== undefined) throw settingsError('E_PARAMS', '音乐模型 ID 由 Host 生成');
  const id = value.id === undefined ? `music_${randomBytes(8).toString('hex')}` : value.id;
  if (typeof id !== 'string' || !MUSIC_MODEL_ID.test(id)) {
    throw settingsError('E_PARAMS', '音乐模型 ID 格式不正确');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const remoteModel = typeof value.remoteModel === 'string' ? value.remoteModel.trim() : '';
  if (
    !name || name.length > 80 || /[\0-\u001f\u007f]/.test(name) ||
    !remoteModel || remoteModel.length > 128 || /[\0-\u001f\u007f]/.test(remoteModel) ||
    !MUSIC_PROTOCOLS.includes(value.protocol)
  ) {
    throw settingsError('E_PARAMS', '请填写有效的模型名称、协议和远端模型 ID');
  }
  return { id, name, protocol: value.protocol, baseUrl: normalizeBaseUrl(value.baseUrl), remoteModel };
}

function validateState(value) {
  if (!exactKeys(value, ['version', 'defaultMusicModelId', 'customSystemPrompt', 'musicModels']) || value.version !== PLUGIN_SETTINGS_VERSION) {
    throw settingsError('E_SETTINGS_CORRUPT', '插件设置文件损坏或版本不受支持，原文件已保留');
  }
  if (!Array.isArray(value.musicModels) || value.musicModels.length > MAX_CUSTOM_MUSIC_MODELS) {
    throw settingsError('E_SETTINGS_CORRUPT', '插件设置中的音乐模型列表无效，原文件已保留');
  }
  const models = value.musicModels.map((model) => normalizeMusicModel(model));
  const ids = new Set(models.map((model) => model.id));
  if (ids.size !== models.length) throw settingsError('E_SETTINGS_CORRUPT', '插件设置包含重复模型 ID，原文件已保留');
  if (value.defaultMusicModelId !== 'qianwen' && !ids.has(value.defaultMusicModelId)) {
    throw settingsError('E_SETTINGS_CORRUPT', '插件设置中的默认音乐模型不存在，原文件已保留');
  }
  return {
    version: PLUGIN_SETTINGS_VERSION,
    defaultMusicModelId: value.defaultMusicModelId,
    customSystemPrompt: normalizeCustomSystemPrompt(value.customSystemPrompt),
    musicModels: models,
  };
}

export class PluginSettingsStore {
  constructor({ path, logger } = {}) {
    this.path = typeof path === 'string' && path ? path : null;
    this.logger = logger;
    this.state = defaultState();
    this.prepared = false;
    this.loadError = null;
    this.queue = Promise.resolve();
  }

  async prepare() {
    if (this.prepared) return this.get();
    if (this.path === null) throw settingsError('E_SETTINGS_UNAVAILABLE', '插件设置存储未配置');
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.loadError = settingsError('E_SETTINGS_UNAVAILABLE', '插件设置无法读取，原文件已保留');
        throw this.loadError;
      }
    }
    if (info === undefined) {
      this.state = defaultState();
      this.prepared = true;
      try {
        await this.write();
      } catch (error) {
        this.prepared = false;
        this.loadError = error;
        throw error;
      }
      this.loadError = null;
      return this.get();
    }
    try {
      if (!info.isFile() || info.size > MAX_PLUGIN_SETTINGS_BYTES) throw new Error('invalid settings file');
      this.state = validateState(JSON.parse(await readFile(this.path, 'utf8')));
      this.prepared = true;
      this.loadError = null;
      return this.get();
    } catch (error) {
      this.prepared = false;
      this.loadError = error instanceof BridgeError
        ? error
        : settingsError('E_SETTINGS_CORRUPT', '插件设置文件损坏，原文件已保留');
      throw this.loadError;
    }
  }

  ensurePrepared() {
    if (!this.prepared) throw this.loadError || settingsError('E_SETTINGS_UNAVAILABLE', '插件设置尚未准备好');
  }

  get() {
    this.ensurePrepared();
    return clone(this.state);
  }

  /** Synchronous and allocation-free enough for system-prompt assembly. */
  customSystemPrompt() {
    return this.prepared ? this.state.customSystemPrompt : '';
  }

  model(modelId) {
    this.ensurePrepared();
    return clone(this.state.musicModels.find((model) => model.id === modelId) || null);
  }

  normalizeModel(model) {
    return normalizeMusicModel(model);
  }

  locked(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }

  async commit(next) {
    const previous = this.state;
    this.state = next;
    try {
      await this.write();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return this.get();
  }

  async saveModel(model) {
    this.ensurePrepared();
    const normalized = normalizeMusicModel(model);
    return this.locked(async () => {
      const models = this.state.musicModels.slice();
      const index = models.findIndex((entry) => entry.id === normalized.id);
      if (index < 0 && models.length >= MAX_CUSTOM_MUSIC_MODELS) {
        throw settingsError('E_LIMIT', `最多可添加 ${MAX_CUSTOM_MUSIC_MODELS} 个自定义音乐模型`);
      }
      if (index < 0) models.push(normalized);
      else models[index] = normalized;
      return this.commit({ ...this.state, musicModels: models });
    });
  }

  async removeModel(modelId) {
    this.ensurePrepared();
    if (modelId === 'qianwen') throw settingsError('E_PARAMS', '内置千问模型不能删除');
    return this.locked(async () => {
      const models = this.state.musicModels.filter((model) => model.id !== modelId);
      if (models.length === this.state.musicModels.length) throw settingsError('E_MODEL_NOT_FOUND', '音乐模型不存在');
      return this.commit({
        ...this.state,
        musicModels: models,
        defaultMusicModelId: this.state.defaultMusicModelId === modelId ? 'qianwen' : this.state.defaultMusicModelId,
      });
    });
  }

  async setDefaultModel(modelId) {
    this.ensurePrepared();
    if (modelId !== 'qianwen' && !this.state.musicModels.some((model) => model.id === modelId)) {
      throw settingsError('E_MODEL_NOT_FOUND', '音乐模型不存在');
    }
    return this.locked(() => this.commit({ ...this.state, defaultMusicModelId: modelId }));
  }

  /** Internal rollback to a previously returned snapshot (never for user input). */
  async restore(state) {
    this.ensurePrepared();
    const next = validateState(clone(state));
    return this.locked(() => this.commit(next));
  }

  async setCustomSystemPrompt(text) {
    this.ensurePrepared();
    const customSystemPrompt = normalizeCustomSystemPrompt(text);
    return this.locked(() => this.commit({ ...this.state, customSystemPrompt }));
  }

  async write() {
    if (this.path === null) throw settingsError('E_SETTINGS_UNAVAILABLE', '插件设置存储未配置');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(this.state, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PLUGIN_SETTINGS_BYTES) {
      throw settingsError('E_SETTINGS_LIMIT', '插件设置超过存储上限');
    }
    const temporary = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof BridgeError) throw error;
      throw settingsError('E_SETTINGS_STORE', '插件设置保存失败，原有设置未更改');
    }
  }

  diagnose() {
    return {
      configured: this.path !== null,
      prepared: this.prepared,
      error: this.loadError === null ? null : this.loadError.code,
      musicModels: this.state.musicModels.length,
    };
  }
}
