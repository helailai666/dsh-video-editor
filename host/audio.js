/** Host-only audio providers. Credentials and provider URLs never cross into Tool results. */
import {
  readFile,
  open,
  writeFile,
  mkdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { BridgeError } from './errors.js';
import { ProceduralProvider, validateScore } from './audio-synth.js';
const error = (code, message, uncertain = false) =>
  new BridgeError(code, message, { stage: 'audio', uncertain });
const digest = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const MUSIC_MODEL_ID = /^(qianwen|music_[a-f0-9]{16})$/;
const REMOTE_TASK_ID = /^[A-Za-z0-9._:,-]{1,160}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
// StepFun (base64) and MiniMax (hex) return the audio inside the JSON body.
const MAX_INLINE_AUDIO_BYTES = 96 * 1024 * 1024;
const VENDOR_POLL_MS = { stepfun: 5000, 'suno-inspiration': 2000, 'suno-custom': 2000 };
const VENDOR_TIMEOUT_MS = { stepfun: 600000, 'suno-inspiration': 600000, 'suno-custom': 600000, minimax: 420000 };
// Suno counts style_tags in UTF-16 units and answers an over-long value with
// HTTP 400 before any billing, so the field is clipped on a separator instead.
const SUNO_STYLE_TAGS_LIMIT = 1000;
/** Trim a string to `limit` UTF-16 units, preferring a nearby list separator. */
function clipUnits(value, limit) {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf(','),
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf(';'),
    head.lastIndexOf('；'),
  );
  return cut > 20 ? head.slice(0, cut) : head;
}
async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    // Directory fsync is best-effort: Windows rejects it with EPERM and the
    // rename itself is already atomic on every supported platform.
    const directory = await open(dirname(path), 'r').catch(() => null);
    if (directory) {
      try {
        await directory.sync();
      } catch {}
      finally {
        await directory.close().catch(() => {});
      }
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function json(path, fallback) {
  try {
    if ((await stat(path)).size > 8 * 1024 * 1024)
      throw error('E_AUDIO_STORE', '音频记录超过上限');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw error('E_AUDIO_STORE', '音频配置或记录损坏，已保留原文件');
  }
}
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray(value) === false
  );
}
export function mapAudioError(status, code) {
  if (status === 401)
    return error('E_AUDIO_AUTH', 'API Key 无效，请在设置页重新配置');
  if (status === 402)
    return error('E_AUDIO_ENTITLEMENT', '账户额度不足，请充值后重试');
  if (status === 403)
    return error('E_AUDIO_ENTITLEMENT', '该模型未开通，请申请权限或导入音频');
  if (status === 429)
    return error('E_AUDIO_RATE_LIMIT', '供应商限流，请稍后手动重试');
  if (status === 451 || /Inspection|inspection/.test(code ?? ''))
    return error('E_AUDIO_CONTENT', '生成内容未通过审核，请修改描述');
  if (status === 400)
    return error('E_AUDIO_PARAMS', '供应商不接受本次参数，请缩短或修改描述');
  return error(
    'E_AUDIO_PROVIDER',
    '供应商暂时不可用，请检查任务后手动重试',
    true,
  );
}
function isIpv4(value) {
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split('.').every((part) => Number(part) <= 255)
  );
}
function isIpv6(value) {
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}
/** Whether an address must never be reached from the plugin's HTTPS services. */
export function isPrivateIp(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (isIpv4(value)) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 0 && value.split('.')[2] === 119) return true;
    return false;
  }
  const ip = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip === '::' || ip === '::1') return true;
  const mapped = ip.match(/^::ffff:((\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  if (/^ff[0-9a-f]{2}:|^ff/i.test(ip)) return true;
  return false;
}
/** Expand an IPv6 text form into eight 16-bit groups, or null if malformed. */
function expandIpv6(value) {
  const ip = String(value).toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/.test(ip)) return null;
  const dbl = ip.indexOf('::');
  if (dbl >= 0 && ip.indexOf('::', dbl + 1) >= 0) return null;
  const head = dbl < 0 ? ip : ip.slice(0, dbl);
  const tail = dbl < 0 ? '' : ip.slice(dbl + 2);
  const hp = head === '' ? [] : head.split(':');
  const tp = tail === '' ? [] : tail.split(':');
  if (dbl < 0 ? hp.length !== 8 : hp.length + tp.length > 7) return null;
  const filled = [...hp, ...Array(8 - hp.length - tp.length).fill('0'), ...tp];
  const groups = [];
  for (const part of filled) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}
/**
 * Reserved-for-testing ranges a local proxy hands back as fake-IPs when it
 * intercepts DNS (Clash/sing-box style 198.18.0.0/15 and 2001:0002::/48
 * answers, plus RFC 2917's 2001:0200::/48 benchmark block). They are not
 * routable to internal services, so a *resolved* DNS answer may use them; a
 * Base URL that literally spells one out stays rejected through isPrivateIp.
 */
export function isProxyFakeIp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (isIpv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 198 && (b === 18 || b === 19);
  }
  const ip = value.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:((\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isProxyFakeIp(mapped[1]);
  const groups = expandIpv6(ip);
  if (!groups) return false;
  return (
    groups[0] === 0x2001 &&
    (groups[1] === 0x0002 || groups[1] === 0x0200) &&
    groups[2] === 0
  );
}
/** DNS answers: real local ranges stay blocked, proxy fake-IP ranges pass. */
function isBlockedResolvedIp(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  return isPrivateIp(value) && !isProxyFakeIp(value);
}
async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}
/**
 * Public HTTPS only: no userinfo, non-default port, private/link-local scope.
 * Literal IP hosts are checked strictly; resolved DNS answers may additionally
 * use proxy fake-IP ranges so local interception does not break vendors.
 */
async function assertPublicHttps(value, lookupImpl, { allowQuery = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw error('E_AUDIO_ENDPOINT', '服务地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '443') ||
    url.hash ||
    (allowQuery === false && url.search)
  )
    throw error('E_AUDIO_ENDPOINT', '仅支持公网 HTTPS 服务地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpv4(host) || isIpv6(host)) {
    if (isPrivateIp(host))
      throw error('E_AUDIO_ENDPOINT', '服务地址指向不允许的网络范围');
    return url;
  }
  let records;
  try {
    records = await lookupImpl(url.hostname);
  } catch {
    throw error('E_AUDIO_DNS', '服务域名无法解析');
  }
  const addresses = Array.isArray(records)
    ? records.map((entry) =>
        typeof entry === 'string' ? entry : entry?.address,
      )
    : [];
  if (
    addresses.length === 0 ||
    addresses.some((address) => !address || isBlockedResolvedIp(address))
  )
    throw error('E_AUDIO_ENDPOINT', '服务地址指向不允许的网络范围');
  return url;
}
const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      res();
    };
    const onAbort = () => {
      clearTimeout(timer);
      rej(new Error('aborted'));
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
async function responseText(response, maxBytes = MAX_JSON_BYTES) {
  let text;
  try {
    text = await response.text();
  } catch {
    throw error('E_AUDIO_PROVIDER', '供应商返回格式异常', true);
  }
  if (text.length > maxBytes)
    throw error('E_AUDIO_PROTOCOL', '供应商响应超过上限', true);
  return text;
}
async function parseJsonResponse(response, { maxBytes = MAX_JSON_BYTES } = {}) {
  const text = await responseText(response, maxBytes);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok) throw mapAudioError(response.status, data?.code);
  if (data === null)
    throw error('E_AUDIO_PROVIDER', '供应商返回格式异常', true);
  return data;
}
export class QianwenProvider {
  constructor({ getKey, fetch: fetchImpl = globalThis.fetch }) {
    this.id = 'qianwen';
    this.getKey = getKey;
    this.fetch = fetchImpl;
  }
  capabilities() {
    return {
      tts: true,
      sfx: true,
      music: 'invitation',
      voiceDesign: false,
      asr: false,
    };
  }
  async check() {
    const key = await this.getKey();
    if (!key) throw error('E_AUDIO_AUTH', '请配置千问云 API Key');
    const r = await this.fetch(
      'https://maas.qianwenaiapi.com/compatible-mode/v1/models',
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw mapAudioError(r.status);
    return {
      connected: true,
      note: '连接成功；具体音频模型权限以生成结果为准',
    };
  }
  async generate(req, { signal }) {
    const key = await this.getKey();
    if (!key) throw error('E_AUDIO_AUTH', '请配置千问云 API Key');
    const music = req.kind === 'music',
      sfx = req.kind === 'sfx';
    const body = music
      ? {
          model: 'fun-music-v1',
          input: { prompt: req.text, is_instrumental: true, format: 'wav' },
        }
      : sfx
        ? {
            model: 'qwen-audio-3.1-tts-next',
            input: {
              text_prompt: req.text,
              format: 'wav',
              sample_rate: 48000,
              channels: 2,
            },
          }
        : {
            model: 'qwen-audio-3.1-tts-flash',
            input: {
              text: req.text,
              voice: req.voice || 'longanhuan_v3.1',
              format: 'wav',
              sample_rate: 48000,
              rate: req.rate ?? 1,
            },
          };
    let r;
    try {
      r = await this.fetch(
        `https://maas.qianwenaiapi.com/api/v1/services/audio/${music ? 'music/generation' : 'tts/SpeechSynthesizer'}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch {
      throw error(
        'E_AUDIO_NETWORK',
        '连接中断；供应商可能已受理，请勿连续重试',
        true,
      );
    }
    let data;
    try {
      const text = await r.text();
      if (text.length > 4 * 1024 * 1024) throw 0;
      data = JSON.parse(text);
    } catch {
      throw error('E_AUDIO_PROVIDER', '供应商返回格式异常', true);
    }
    if (!r.ok) throw mapAudioError(r.status, data.code);
    let address = data.output?.audio?.url;
    // This provider currently emits HTTP OSS URLs; upgrade only its documented
    // artifact host to TLS, without sending credentials to the artifact server.
    try {
      const u = new URL(address);
      if (
        u.protocol === 'http:' &&
        u.hostname === 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com' &&
        !u.port
      ) {
        u.protocol = 'https:';
        address = u.href;
      }
    } catch {}
    // Only the documented HTTPS artifact domains; never follow an unchecked redirect.
    const allowed = (value) => {
      try {
        const u = new URL(value);
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.port &&
          (/^[a-z0-9.-]+\.aliyuncs\.com$/.test(u.hostname) ||
            u.hostname === 'maas.qianwenaiapi.com')
        );
      } catch {
        return false;
      }
    };
    if (!allowed(address))
      throw error('E_AUDIO_DOWNLOAD', '生成结果下载地址不受信任', true);
    let url = address,
      response;
    for (let i = 0; i < 4; i++) {
      response = await this.fetch(url, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        url = new URL(response.headers.get('location'), url).href;
        if (!allowed(url))
          throw error('E_AUDIO_DOWNLOAD', '生成结果重定向不受信任', true);
        continue;
      }
      break;
    }
    if (!response.ok)
      throw error(
        'E_AUDIO_DOWNLOAD',
        '音频已生成，但下载失败；请勿重复生成',
        true,
      );
    const chunks = [];
    let size = 0;
    for await (const b of response.body) {
      size += b.length;
      if (size > 64 * 1024 * 1024)
        throw error('E_AUDIO_DOWNLOAD', '生成文件超过 64 MiB，未导入', true);
      chunks.push(b);
    }
    if (!size) throw error('E_AUDIO_DOWNLOAD', '供应商返回空音频', true);
    return {
      bytes: Buffer.concat(chunks),
      extension: 'wav',
      usage: {
        duration: data.usage?.duration ?? data.output?.audio?.duration ?? null,
        characters: data.usage?.characters ?? null,
        inputTokens: data.usage?.input_tokens ?? null,
        outputTokens: data.usage?.output_tokens ?? null,
      },
      model: body.model,
    };
  }
}
/**
 * Page-configured music service. Protocols: qianwen-compatible sync/async,
 * StepFun (submit/query + base64), Suno (create + song query + audio URL),
 * MiniMax (synchronous hex). API requests carry the key; artifact downloads
 * never do and re-validate every URL/redirect against the public-HTTPS fence.
 */
export class CustomMusicProvider {
  constructor({
    model,
    getKey,
    fetch: fetchImpl = globalThis.fetch,
    lookup = defaultLookup,
    pollIntervalMs = 2000,
  }) {
    this.id = 'custom-music';
    this.model = model;
    this.getKey = getKey;
    this.fetch = fetchImpl;
    this.lookup = lookup;
    this.pollIntervalMs = Math.max(
      pollIntervalMs,
      VENDOR_POLL_MS[model.protocol] || 0,
    );
    this.requestTimeoutMs = VENDOR_TIMEOUT_MS[model.protocol] ?? null;
  }
  capabilities() {
    return { tts: false, sfx: false, music: true };
  }
  async authorizedHeaders() {
    const key = await this.getKey();
    if (!key) throw error('E_AUDIO_AUTH', '请先在设置页为该模型配置 API Key');
    return { Authorization: `Bearer ${key}` };
  }
  async apiUrl(path) {
    return assertPublicHttps(`${this.model.baseUrl}${path}`, this.lookup);
  }
  /** POST a JSON body to the configured service origin. */
  async postJson(path, body, { signal, queryRetry = false, headers = null } = {}) {
    const url = await this.apiUrl(path);
    const auth = await this.authorizedHeaders();
    try {
      return await this.fetch(url.href, {
        method: 'POST',
        headers: { ...auth, ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
    } catch {
      if (queryRetry)
        throw error('E_AUDIO_QUERY_RETRY', '任务查询网络异常，稍后自动重试');
      throw error(
        'E_AUDIO_NETWORK',
        '连接中断；供应商可能已受理，请勿连续重试',
        true,
      );
    }
  }
  /** Authenticated GET used by the free Suno request-progress endpoint. */
  async getPath(path, { signal, queryRetry = false } = {}) {
    const url = await this.apiUrl(path);
    const headers = await this.authorizedHeaders();
    try {
      return await this.fetch(url.href, {
        method: 'GET',
        headers,
        signal,
        redirect: 'manual',
      });
    } catch {
      if (queryRetry)
        throw error('E_AUDIO_QUERY_RETRY', '任务查询网络异常，稍后自动重试');
      throw error(
        'E_AUDIO_NETWORK',
        '连接中断；供应商可能已受理，请勿连续重试',
        true,
      );
    }
  }
  /** Billed-submit-free probe used by the settings page "test connection". */
  async probe(path, { method = 'POST', body } = {}) {
    const url = await this.apiUrl(path);
    const headers = await this.authorizedHeaders();
    let r;
    try {
      r = await this.fetch(url.href, {
        method,
        headers:
          body === undefined
            ? headers
            : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw error('E_AUDIO_NETWORK', '无法连接所选音乐模型服务');
    }
    if (r.status >= 300 && r.status < 400)
      throw error('E_AUDIO_ENDPOINT', '服务连接发生重定向，请检查 Base URL');
    if (r.status === 401 || r.status === 403) throw mapAudioError(r.status);
    // 400/404 on the probe payload prove auth and network are reachable.
    if (!(r.ok || r.status === 400 || r.status === 404))
      throw mapAudioError(r.status);
    return {
      connected: true,
      note: '连接与密钥可用；具体音乐模型权限以生成结果为准',
    };
  }
  async check() {
    const protocol = this.model.protocol;
    if (protocol === 'stepfun')
      return this.probe('/v1/audio/music/query', {
        body: { task_id: 'dsh-video-probe' },
      });
    if (protocol === 'suno-inspiration' || protocol === 'suno-custom')
      return this.probe('/api/music/requests/dsh-video-probe', {
        method: 'GET',
      });
    if (protocol === 'minimax')
      return this.probe('/v1/music_generation', { body: {} });
    const headers = await this.authorizedHeaders();
    const url = await this.apiUrl('/compatible-mode/v1/models');
    let r;
    try {
      r = await this.fetch(url.href, {
        headers,
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
    } catch {
      throw error('E_AUDIO_NETWORK', '无法连接所选音乐模型服务');
    }
    if (r.status >= 300 && r.status < 400)
      throw error('E_AUDIO_ENDPOINT', '服务连接发生重定向，请检查 Base URL');
    if (!r.ok) throw mapAudioError(r.status);
    return {
      connected: true,
      note: '连接成功；具体音乐模型权限以生成结果为准',
    };
  }
  /**
   * `resumeTaskId` skips the paid submit and only queries/downloads — used
   * after a restart for jobs whose task id was persisted before.
   */
  async generate(req, { signal, onTaskId, resumeTaskId }) {
    const protocol = this.model.protocol;
    if (protocol === 'stepfun')
      return this.generateStepfun(req, { signal, onTaskId, resumeTaskId });
    if (protocol === 'suno-inspiration' || protocol === 'suno-custom')
      return this.generateSuno(req, { signal, onTaskId, resumeTaskId });
    if (protocol === 'minimax') return this.generateMinimax(req, { signal });
    return this.generateQianwen(req, { signal, onTaskId, resumeTaskId });
  }
  async generateStepfun(req, { signal, onTaskId, resumeTaskId }) {
    let taskId =
      typeof resumeTaskId === 'string' && REMOTE_TASK_ID.test(resumeTaskId)
        ? resumeTaskId
        : null;
    if (taskId === null) {
      const r = await this.postJson(
        '/v1/audio/music/submit',
        {
          task: 'text_to_music',
          model_id: this.model.remoteModel,
          caption: req.text,
          instrumental: true,
          response_format: 'mp3',
        },
        { signal },
      );
      const data = await parseJsonResponse(r);
      taskId =
        typeof data?.task_id === 'string' && REMOTE_TASK_ID.test(data.task_id)
          ? data.task_id
          : null;
      if (taskId === null)
        throw error(
          'E_AUDIO_PROTOCOL',
          '异步提交未返回任务 ID，请勿盲目重试',
          true,
        );
      // Persist the paid task id before the first poll.
      if (typeof onTaskId === 'function') await onTaskId(taskId);
    }
    for (;;) {
      let r;
      try {
        r = await this.postJson(
          '/v1/audio/music/query',
          { task_id: taskId },
          { signal, queryRetry: true },
        );
      } catch (e) {
        if (e.code === 'E_AUDIO_QUERY_RETRY') {
          if (signal.aborted) throw e;
          await sleep(this.pollIntervalMs, signal);
          continue;
        }
        throw e;
      }
      if (r.status === 429 || r.status >= 500) {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      const data = await parseJsonResponse(r, {
        maxBytes: MAX_INLINE_AUDIO_BYTES,
      });
      const status = data?.status;
      if (status === 'SUCCESS') {
        if (typeof data.audio !== 'string' || !data.audio)
          throw error('E_AUDIO_PROTOCOL', '异步任务成功但未返回音频', true);
        const bytes = Buffer.from(data.audio, 'base64');
        if (!bytes.length)
          throw error('E_AUDIO_DOWNLOAD', '供应商返回空音频', true);
        if (bytes.length > MAX_AUDIO_BYTES)
          throw error('E_AUDIO_DOWNLOAD', '生成文件超过 64 MiB，未导入', true);
        return {
          bytes,
          extension: 'mp3',
          usage: null,
          model: this.model.remoteModel,
        };
      }
      if (status === 'FAILED') {
        if (data?.error?.stage === 'censor')
          throw error('E_AUDIO_CONTENT', '生成内容未通过审核，请修改描述');
        throw error('E_AUDIO_PROVIDER', '供应商任务生成失败，请调整描述后重试');
      }
      if (status === 'PENDING' || status === 'RUNNING') {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      throw error(
        'E_AUDIO_PROTOCOL',
        '异步任务状态无法识别，请查看供应商任务记录',
        true,
      );
    }
  }
  async generateSuno(req, { signal, onTaskId, resumeTaskId }) {
    const custom = this.model.protocol === 'suno-custom';
    const resume =
      typeof resumeTaskId === 'string' && REMOTE_TASK_ID.test(resumeTaskId)
        ? resumeTaskId
        : null;
    // `req:<request_id>` = accepted but song ids not issued yet;
    // `s1,s2` = real song ids. Both resume paths only query, never re-submit.
    let requestId = resume?.startsWith('req:') ? resume.slice(4) : null;
    let songIds =
      resume && !resume.startsWith('req:')
        ? resume.split(',').filter(Boolean)
        : [];
    if (requestId === null && songIds.length === 0) {
      // Accept mode returns 202 immediately: the paid submit never has to hold
      // a multi-minute connection, and Idempotency-Key makes a lost response
      // safe to replay without a second charge.
      const body = custom
        ? {
            model: this.model.remoteModel,
            style_tags: clipUnits(req.text, SUNO_STYLE_TAGS_LIMIT),
            instrumental: true,
            accept_mode: 'async',
          }
        : {
            model: this.model.remoteModel,
            description: req.text,
            instrumental: true,
            accept_mode: 'async',
          };
      const r = await this.postJson(
        custom ? '/api/music/create/custom' : '/api/music/create',
        body,
        {
          signal,
          ...(typeof req.operationId === 'string' && req.operationId.length <= 128
            ? { headers: { 'Idempotency-Key': req.operationId } }
            : {}),
        },
      );
      const data = await parseJsonResponse(r);
      const accepted = [data?.data?.request_id, data?.request_id].find(
        (id) => typeof id === 'string' && REMOTE_TASK_ID.test(id),
      );
      if (accepted) {
        requestId = accepted;
        if (typeof onTaskId === 'function') await onTaskId(`req:${requestId}`);
      } else {
        songIds = sunoSongList(data)
          .map((song) => song.song_id || song.id)
          .filter((id) => typeof id === 'string' && id)
          .slice(0, 2);
        if (songIds.length === 0)
          throw error(
            'E_AUDIO_PROTOCOL',
            '提交响应未返回受理号或歌曲任务 ID，请勿盲目重试',
            true,
          );
        if (typeof onTaskId === 'function') await onTaskId(songIds.join(','));
      }
    }
    for (;;) {
      if (requestId !== null && songIds.length === 0) {
        let r;
        try {
          r = await this.getPath(
            `/api/music/requests/${encodeURIComponent(requestId)}`,
            { signal, queryRetry: true },
          );
        } catch (e) {
          if (e.code === 'E_AUDIO_QUERY_RETRY') {
            if (signal.aborted) throw e;
            await sleep(this.pollIntervalMs, signal);
            continue;
          }
          throw e;
        }
        if (r.status === 429 || r.status >= 500) {
          await sleep(this.pollIntervalMs, signal);
          continue;
        }
        const progress = await parseJsonResponse(r);
        const state = String(progress?.data?.status ?? '').toLowerCase();
        if (state === 'failed')
          throw error(
            'E_AUDIO_PROVIDER',
            `供应商受理失败：${progress?.data?.error_message || '请检查账户额度或描述内容'}`,
          );
        const tasks = Array.isArray(progress?.data?.tasks)
          ? progress.data.tasks
          : [];
        const early = tasks.find(
          (task) => typeof task?.audio_url === 'string' && task.audio_url,
        );
        if (early) return this.finish(early, signal);
        songIds = tasks
          .map((task) => task?.song_id)
          .filter((id) => typeof id === 'string' && id)
          .slice(0, 2);
        if (songIds.length > 0) {
          if (typeof onTaskId === 'function')
            await onTaskId(songIds.join(','));
          continue;
        }
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      let r;
      try {
        r = await this.postJson(
          '/api/music/query',
          { song_ids: songIds, model: this.model.remoteModel },
          { signal, queryRetry: true },
        );
      } catch (e) {
        if (e.code === 'E_AUDIO_QUERY_RETRY') {
          if (signal.aborted) throw e;
          await sleep(this.pollIntervalMs, signal);
          continue;
        }
        throw e;
      }
      if (r.status === 429 || r.status >= 500) {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      const data = await parseJsonResponse(r);
      const list = sunoSongList(data);
      const done = list.find(
        (song) => typeof song?.audio_url === 'string' && song.audio_url,
      );
      if (done) return this.finish(done, signal);
      if (
        list.length > 0 &&
        list.every((song) =>
          ['failed', 'error', 'rejected'].includes(
            String(song?.status || '').toLowerCase(),
          ),
        )
      )
        throw error('E_AUDIO_PROVIDER', '供应商任务生成失败，请调整描述后重试');
      await sleep(this.pollIntervalMs, signal);
    }
  }
  /** Downloads a finished Suno song and keeps its reported duration. */
  async finish(song, signal) {
    const result = await this.download(song.audio_url, signal);
    const seconds = Number(song.duration);
    if (Number.isFinite(seconds) && seconds > 0)
      result.usage = { duration: seconds };
    return result;
  }
  async generateMinimax(req, { signal }) {
    const r = await this.postJson(
      '/v1/music_generation',
      {
        model: this.model.remoteModel,
        prompt: req.text,
        is_instrumental: true,
        output_format: 'hex',
        audio_setting: {
          format: 'mp3',
          sample_rate: 44100,
          bitrate: 256000,
        },
      },
      { signal },
    );
    const data = await parseJsonResponse(r, {
      maxBytes: MAX_INLINE_AUDIO_BYTES,
    });
    const code = data?.base_resp?.status_code;
    if (code !== undefined && code !== 0)
      throw error(
        'E_AUDIO_PROVIDER',
        `供应商返回错误（状态码 ${code}），请检查账户权限或调整描述`,
        true,
      );
    const hex = data?.data?.audio;
    if (typeof hex !== 'string' || !hex)
      throw error('E_AUDIO_PROVIDER', '供应商未返回音频数据', true);
    const bytes = Buffer.from(hex, 'hex');
    if (!bytes.length)
      throw error('E_AUDIO_DOWNLOAD', '供应商返回空音频', true);
    if (bytes.length > MAX_AUDIO_BYTES)
      throw error('E_AUDIO_DOWNLOAD', '生成文件超过 64 MiB，未导入', true);
    return {
      bytes,
      extension: 'mp3',
      usage: {
        duration: Number.isFinite(data?.extra_info?.music_duration)
          ? data.extra_info.music_duration / 1000
          : null,
      },
      model: this.model.remoteModel,
    };
  }
  async generateQianwen(req, { signal, onTaskId, resumeTaskId }) {
    const headers = await this.authorizedHeaders();
    let address;
    let taskId =
      typeof resumeTaskId === 'string' && REMOTE_TASK_ID.test(resumeTaskId)
        ? resumeTaskId
        : null;
    if (taskId === null) {
      const input = {
        prompt: req.text,
        is_instrumental: true,
        format: 'wav',
      };
      if (Number.isInteger(req.durationFrames))
        input.duration = Math.round((req.durationFrames / 30) * 100) / 100;
      const r = await this.postJson(
        '/api/v1/services/audio/music/generation',
        { model: this.model.remoteModel, input },
        { signal },
      );
      if (r.status >= 300 && r.status < 400)
        throw error(
          'E_AUDIO_ENDPOINT',
          '提交响应发生重定向，已停止且不会重复提交',
          true,
        );
      const data = await parseJsonResponse(r);
      if (this.model.protocol === 'qianwen-async') {
        taskId =
          typeof data?.output?.task_id === 'string' &&
          REMOTE_TASK_ID.test(data.output.task_id)
            ? data.output.task_id
            : null;
        if (taskId === null)
          throw error(
            'E_AUDIO_PROTOCOL',
            '异步提交未返回任务 ID，请勿盲目重试',
            true,
          );
        // Persist the paid task id before the first poll.
        if (typeof onTaskId === 'function') await onTaskId(taskId);
      } else {
        if (typeof data?.output?.audio?.url !== 'string')
          throw error(
            'E_AUDIO_PROTOCOL',
            '同步响应缺少音频地址，请勿盲目重试',
            true,
          );
        address = data.output.audio.url;
      }
    }
    if (address === undefined) address = await this.poll(taskId, signal);
    return this.download(address, signal);
  }
  async poll(taskId, signal) {
    const headers = await this.authorizedHeaders();
    const url = await this.apiUrl(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    for (;;) {
      let r;
      try {
        r = await this.fetch(url.href, {
          headers,
          signal,
          redirect: 'manual',
        });
      } catch {
        // Query failures are retried within the overall deadline; the
        // generation itself is never re-submitted automatically.
        if (signal.aborted) throw error('E_AUDIO_TIMEOUT', '任务查询已超时');
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      if (r.status >= 300 && r.status < 400)
        throw error('E_AUDIO_ENDPOINT', '任务查询返回重定向，已停止');
      if (r.status === 429 || r.status >= 500) {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      const data = await parseJsonResponse(r);
      const status = data?.output?.task_status;
      if (status === 'SUCCEEDED') {
        if (typeof data.output?.audio?.url !== 'string')
          throw error('E_AUDIO_PROTOCOL', '异步任务成功但未返回音频地址', true);
        return data.output.audio.url;
      }
      if (status === 'FAILED') throw mapAudioError(400, data?.code ?? 'FAILED');
      if (status === 'CANCELED')
        throw error('E_AUDIO_CANCELLED', '供应商任务已取消');
      if (status === 'PENDING' || status === 'RUNNING') {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      throw error(
        'E_AUDIO_PROTOCOL',
        '异步任务状态无法识别，请查看供应商任务记录',
        true,
      );
    }
  }
  async download(address, signal) {
    let url = await assertPublicHttps(address, this.lookup, {
      allowQuery: true,
    });
    let response;
    for (let i = 0; i < 4; i++) {
      response = await this.fetch(url.href, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const next = new URL(response.headers.get('location') || '', url.href);
        url = await assertPublicHttps(next.href, this.lookup, {
          allowQuery: true,
        });
        continue;
      }
      break;
    }
    if (!response?.ok)
      throw error(
        'E_AUDIO_DOWNLOAD',
        '音频已生成，但下载失败；请勿重复生成',
        true,
      );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES)
        throw error('E_AUDIO_DOWNLOAD', '生成文件超过 64 MiB，未导入', true);
      chunks.push(chunk);
    }
    if (!size) throw error('E_AUDIO_DOWNLOAD', '供应商返回空音频', true);
    const extension =
      url.pathname.toLowerCase().match(/\.(wav|mp3|m4a|aac|flac)$/)?.[1] ??
      'wav';
    return {
      bytes: Buffer.concat(chunks),
      extension,
      usage: null,
      model: this.model.remoteModel,
    };
  }
}
/** Suno returns either a bare array or a {data|songs:[...]} envelope. */
function sunoSongList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.songs)) return payload.songs;
  if (payload?.song_id || payload?.id) return [payload];
  return [];
}
export class LocalSayProvider {
  constructor() {
    this.id = 'local';
  }
  capabilities() {
    return {
      tts: process.platform === 'darwin',
      sfx: false,
      music: false,
      voiceDesign: false,
      asr: false,
    };
  }
  async generate(req, { signal, directory }) {
    if (process.platform !== 'darwin')
      throw error(
        'E_AUDIO_UNSUPPORTED',
        '本地旁白仅支持 macOS，请使用千问云或导入',
      );
    const output = join(directory, randomUUID() + '.aiff');
    const converted = output + '.m4a';
    try {
      await new Promise((res, rej) => {
        const p = spawn(
          '/usr/bin/say',
          [
            '-v',
            ['Tingting', 'Meijia', 'Sinji'].includes(req.voice)
              ? req.voice
              : 'Tingting',
            '-r',
            String(Math.round(180 * (req.rate ?? 1))),
            '-o',
            output,
            '--',
            req.text,
          ],
          { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' }, signal },
        );
        p.on('error', () =>
          rej(error('E_AUDIO_LOCAL', '本地旁白不可用，请检查系统音色')),
        );
        p.on('exit', (code) =>
          code === 0 ? res() : rej(error('E_AUDIO_LOCAL', '本地旁白生成失败')),
        );
      });
      await new Promise((res, rej) => {
        const p = spawn(
          'ffmpeg',
          [
            '-v',
            'error',
            '-y',
            '-i',
            output,
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-ac',
            '2',
            converted,
          ],
          { stdio: 'ignore', env: { PATH: process.env.PATH }, signal },
        );
        p.on('error', () => rej(error('E_AUDIO_LOCAL', '本地音频转换不可用')));
        p.on('exit', (code) =>
          code === 0 ? res() : rej(error('E_AUDIO_LOCAL', '本地音频转换失败')),
        );
      });
      return {
        bytes: await readFile(converted),
        extension: 'm4a',
        model: 'macOS-say',
      };
    } finally {
      await unlink(output).catch(() => {});
      await unlink(converted).catch(() => {});
    }
  }
}
export class AudioService {
  constructor({
    root,
    importAudio,
    providers,
    legacySecrets,
    timeoutMs = 300000,
    settingsStore = null,
    fetch: fetchImpl = globalThis.fetch,
    lookup = defaultLookup,
    pollIntervalMs = 2000,
  }) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.importAudio = importAudio;
    this.legacySecrets = legacySecrets;
    this.settingsStore = settingsStore;
    this.fetch = fetchImpl;
    this.lookup = lookup;
    this.pollIntervalMs = pollIntervalMs;
    this.providers = new Map(
      (
        providers ?? [
          new QianwenProvider({ getKey: () => this.key('qianwen') }),
          new LocalSayProvider(),
          new ProceduralProvider(),
        ]
      ).map((p) => [p.id, p]),
    );
    this.running = new Map();
    this.serial = Promise.resolve();
    this.closed = false;
  }
  async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  requireSettingsStore() {
    if (
      this.settingsStore === null ||
      this.settingsStore.prepared === false
    )
      throw error('E_SETTINGS_UNAVAILABLE', '插件设置尚未准备好，请稍后重试');
    return this.settingsStore;
  }
  settingsSnapshot() {
    if (this.settingsStore !== null && this.settingsStore.prepared)
      return this.settingsStore.get();
    return { defaultMusicModelId: 'qianwen', musicModels: [] };
  }
  async readSecrets() {
    const file = join(this.root, 'audio-secrets.json');
    const s = await json(file, {});
    if (Object.keys(s).length > 0) {
      let mode;
      try {
        mode = (await stat(file)).mode;
      } catch (error_) {
        if (error_.code === 'ENOENT') return s;
        throw error('E_AUDIO_AUTH', '密钥文件无法读取');
      }
      // NTFS reports 0o666 for ordinary files; the POSIX permission fence
      // only means something on POSIX platforms and is enforced there.
      if (
        process.platform !== 'win32' &&
        (mode & 0o077) !== 0
      )
        throw error('E_AUDIO_AUTH', '密钥文件权限必须为 0600');
    }
    return s;
  }
  async key(modelId = 'qianwen') {
    const s = await this.readSecrets();
    if (modelId !== 'qianwen')
      return isPlainObject(s.models) ? (s.models[modelId] ?? null) : null;
    if (Object.hasOwn(s, 'qianwen')) return s.qianwen;
    if (this.legacySecrets) {
      try {
        const st = await stat(this.legacySecrets);
        if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null;
        const text = await readFile(this.legacySecrets, 'utf8');
        return (
          text.match(/^QIANWEN_API_KEY\s*=\s*["']?([^\s"']+)/m)?.[1] ?? null
        );
      } catch {}
    }
    return null;
  }
  /** Raw write of one model key (null removes); callers hold the serial lock. */
  async writeKey(modelId, value) {
    await this.prepare();
    const file = join(this.root, 'audio-secrets.json');
    const s = await this.readSecrets();
    const models = isPlainObject(s.models) ? { ...s.models } : {};
    if (value === null) delete models[modelId];
    else models[modelId] = value;
    await atomic(file, {
      ...(Object.hasOwn(s, 'qianwen') ? { qianwen: s.qianwen } : {}),
      ...(Object.keys(models).length > 0 ? { models } : {}),
    });
  }
  async settings() {
    await this.prepare();
    const permission = await json(
      join(this.root, 'audio-capabilities.json'),
      {},
    );
    const snapshot = this.settingsSnapshot();
    const builtInProvider = this.providers.get('qianwen');
    const builtInCaps = {
      ...(builtInProvider ? builtInProvider.capabilities() : {}),
      ...(permission.musicDenied ? { music: false } : {}),
    };
    const models = [
      ...(builtInProvider
        ? [
            {
              id: 'qianwen',
              name: '千问（内置）',
              builtIn: true,
              protocol: 'qianwen-sync',
              baseUrl: 'https://maas.qianwenaiapi.com',
              remoteModel: 'fun-music-v1',
              capabilities: builtInCaps,
              hasKey: Boolean(await this.key('qianwen')),
              default: snapshot.defaultMusicModelId === 'qianwen',
              ...(permission.musicDenied
                ? { note: '音乐未开通，请导入配乐；开通后测试连接可重试' }
                : {}),
            },
          ]
        : []),
      ...snapshot.musicModels.map((model) => ({
        ...model,
        builtIn: false,
        capabilities: { tts: false, sfx: false, music: true },
      })),
    ];
    const hasKey = new Map();
    for (const model of snapshot.musicModels)
      hasKey.set(model.id, Boolean(await this.key(model.id)));
    return {
      configured: Boolean(await this.key('qianwen')),
      defaultMusicModelId: snapshot.defaultMusicModelId,
      musicModels: models.map((model) =>
        model.id === 'qianwen'
          ? model
          : { ...model, hasKey: hasKey.get(model.id) === true },
      ),
      providers: [...this.providers].map(([id, p]) => ({
        id,
        capabilities: {
          ...p.capabilities(),
          ...(id === 'qianwen' && permission.musicDenied
            ? { music: false }
            : {}),
        },
        ...(id === 'qianwen' && permission.musicDenied
          ? { note: '音乐未开通，请导入配乐；开通后测试连接可重试' }
          : {}),
        models:
          id === 'qianwen'
            ? models.map((model) => ({
                id: model.id,
                name: model.name,
                capabilities: model.capabilities,
                default: model.default,
              }))
            : undefined,
      })),
      limits: { maxCharacters: 2000, dailyCalls: 20, concurrent: 1 },
      billing:
        '按供应商实际用量计费；无可靠单价时不承诺金额。取消请求可能仍计费；不自动重试。',
    };
  }
  async configure({ apiKey }) {
    await this.prepare();
    if (
      typeof apiKey !== 'string' ||
      apiKey.length > 512 ||
      /[\r\n]/.test(apiKey)
    )
      throw error('E_PARAMS', 'API Key 格式不正确');
    return this.locked(async () => {
      const s = await this.readSecrets();
      await atomic(join(this.root, 'audio-secrets.json'), {
        qianwen: apiKey,
        ...(isPlainObject(s.models) && Object.keys(s.models).length > 0
          ? { models: s.models }
          : {}),
      });
      await atomic(join(this.root, 'audio-capabilities.json'), {});
      return this.settings();
    });
  }
  /** UI-only model upsert; key handling keeps both stores commit-or-rollback. */
  async saveModel({ model, apiKey } = {}) {
    const store = this.requireSettingsStore();
    await this.prepare();
    const normalized = store.normalizeModel(model);
    if (
      apiKey !== undefined &&
      (typeof apiKey !== 'string' ||
        apiKey.length > 512 ||
        /[\r\n]/.test(apiKey))
    )
      throw error('E_PARAMS', 'API Key 格式不正确');
    const providedKey =
      typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
    return this.locked(async () => {
      const previous = store.get();
      const existing = previous.musicModels.some(
        (entry) => entry.id === normalized.id,
      );
      const previousKey = existing ? await this.key(normalized.id) : null;
      let keyWritten = false;
      if (providedKey !== null) {
        await this.writeKey(normalized.id, providedKey);
        keyWritten = true;
      }
      try {
        await store.saveModel(normalized);
      } catch (err) {
        if (keyWritten)
          await this.writeKey(
            normalized.id,
            existing ? previousKey : null,
          ).catch(() => {});
        throw err;
      }
      return this.settings();
    });
  }
  async removeModel(modelId) {
    const store = this.requireSettingsStore();
    await this.prepare();
    return this.locked(async () => {
      const previous = store.get();
      await store.removeModel(modelId);
      try {
        await this.writeKey(modelId, null);
      } catch (err) {
        await store.restore(previous);
        throw err;
      }
      return this.settings();
    });
  }
  async setDefaultModel(modelId) {
    const store = this.requireSettingsStore();
    await this.prepare();
    await store.setDefaultModel(modelId);
    return this.settings();
  }
  /** Resolve one page-configured model into a request-time provider. */
  providerFor(modelId) {
    if (modelId === 'qianwen') return this.providers.get('qianwen');
    if (
      typeof modelId !== 'string' ||
      MUSIC_MODEL_ID.test(modelId) === false ||
      this.settingsStore === null ||
      this.settingsStore.prepared === false
    )
      return null;
    const model = this.settingsStore.model(modelId);
    if (model === null) return null;
    return new CustomMusicProvider({
      model,
      getKey: () => this.key(model.id),
      fetch: this.fetch,
      lookup: this.lookup,
      pollIntervalMs: this.pollIntervalMs,
    });
  }
  async check(modelId) {
    const id =
      typeof modelId === 'string' && modelId.length > 0
        ? modelId
        : this.settingsSnapshot().defaultMusicModelId;
    if (MUSIC_MODEL_ID.test(id) === false)
      throw error('E_PARAMS', '音乐模型 ID 格式不正确');
    const p = this.providerFor(id);
    if (p === null || typeof p.check !== 'function')
      throw error('E_AUDIO_UNSUPPORTED', '该模型不支持连接测试');
    const result = await p.check();
    if (id === 'qianwen')
      await atomic(join(this.root, 'audio-capabilities.json'), {});
    return { ...result, ...(await this.settings()) };
  }
  locked(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  /** A persisted async task whose provider is still configured. */
  resumable(j) {
    return (
      j.provider === 'custom-music' &&
      ['running', 'downloading'].includes(j.state) &&
      typeof j.modelId === 'string' &&
      typeof j.remoteTaskId === 'string' &&
      REMOTE_TASK_ID.test(j.remoteTaskId) &&
      this.settingsStore !== null &&
      this.settingsStore.prepared === true &&
      this.settingsStore.model(j.modelId) !== null
    );
  }
  async store() {
    await this.prepare();
    const s = await json(join(this.root, 'audio-jobs.json'), { jobs: [] });
    if (!Array.isArray(s.jobs))
      throw error('E_AUDIO_STORE', '音频任务记录损坏');
    if (
      s.jobs.some(
        (j) =>
          !j ||
          typeof j.jobId !== 'string' ||
          typeof j.projectId !== 'string' ||
          typeof j.operationId !== 'string' ||
          typeof j.createdAt !== 'string' ||
          typeof j.hash !== 'string' ||
          ![
            'queued',
            'running',
            'downloading',
            'succeeded',
            'failed',
            'cancelled',
            'timed_out',
            'interrupted',
          ].includes(j.state),
      )
    )
      throw error('E_AUDIO_STORE', '音频任务记录损坏，已保留原文件');
    for (const j of s.jobs)
      if (
        !this.running.has(j.jobId) &&
        ['queued', 'running', 'downloading'].includes(j.state) &&
        this.resumable(j) === false
      ) {
        j.state = 'interrupted';
        j.error = {
          code: 'E_AUDIO_INTERRUPTED',
          message: ['local','procedural'].includes(j.provider)?'上次本地生成被中断，请重新发起':'上次生成被中断，可能已计费；不会自动重复请求',
          uncertain: !['local','procedural'].includes(j.provider),
        };
      }
    return s;
  }
  /**
   * After a restart, async custom-model jobs with a persisted task id resume
   * by querying only; the paid submit is never repeated. Other unfinished
   * custom jobs are marked interrupted/uncertain.
   */
  async resumeJobs() {
    if (this.settingsStore === null || this.closed) return;
    let s;
    try {
      s = await this.store();
    } catch {
      return;
    }
    const candidates = s.jobs
      .filter((j) => this.resumable(j) && !this.running.has(j.jobId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (candidates.length === 0) return;
    const [first, ...rest] = candidates;
    const request = await json(
      join(this.root, first.jobId + '.recipe.json'),
      null,
    );
    const p = this.providerFor(first.modelId);
    const key = await this.key(first.modelId).catch(() => null);
    if (
      !isPlainObject(request) ||
      request.provider !== 'custom-music' ||
      p === null ||
      !key
    ) {
      await this.update(first, {
        state: 'interrupted',
        error: {
          code: 'E_AUDIO_INTERRUPTED',
          message: '上次生成被中断，可能已计费；不会自动重复请求',
          uncertain: true,
        },
      }).catch(() => {});
    } else {
      const control = new AbortController();
      this.running.set(first.jobId, { control });
      const task = this.run(first, request, p, control, first.remoteTaskId);
      this.running.get(first.jobId).task = task;
    }
    for (const other of rest)
      await this.update(other, {
        state: 'interrupted',
        error: {
          code: 'E_AUDIO_INTERRUPTED',
          message: '并发恢复暂不可用，上次生成可能已计费；请使用同一任务 ID 重试查询',
          uncertain: true,
        },
      }).catch(() => {});
  }
  async save(s) {
    await atomic(join(this.root, 'audio-jobs.json'), s);
  }
  async generate(req) {
    return this.locked(async () => {
      if (this.closed) throw error('E_AUDIO_CANCELLED', '音频服务已关闭');
      const {
        projectId,
        operationId,
        provider,
        kind = 'tts',
        text,
        voice,
        rate,
        score,
        modelId,
        durationFrames,
      } = req;
      let resolvedProvider = provider ?? 'qianwen';
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 2000 ||
        !['tts', 'sfx', 'music'].includes(kind) ||
        typeof operationId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)
      )
        throw error('E_PARAMS', '描述限 1–2000 字符，请提供有效任务 ID');
      if (
        durationFrames !== undefined &&
        (!Number.isInteger(durationFrames) ||
          durationFrames < 1 ||
          durationFrames > 108000)
      )
        throw error('E_PARAMS', 'durationFrames 需为 1–108000 的整数帧');
      // Resolve the page-configured music model before the idempotency
      // fingerprint so a default-model change is a new request, not a silent
      // replay of an old one.
      let resolvedModelId;
      if (kind === 'music') {
        if (modelId !== undefined) {
          if (
            typeof modelId !== 'string' ||
            MUSIC_MODEL_ID.test(modelId) === false
          )
            throw error('E_PARAMS', '音乐模型 ID 格式不正确');
          if (
            modelId !== 'qianwen' &&
            this.settingsStore?.model(modelId) === null
          )
            throw error('E_MODEL_NOT_FOUND', '音乐模型不存在，请在设置页重新配置');
          resolvedModelId = modelId;
          resolvedProvider = modelId === 'qianwen' ? 'qianwen' : 'custom-music';
        } else if (resolvedProvider === 'qianwen') {
          const fallback = this.settingsSnapshot().defaultMusicModelId;
          if (fallback !== 'qianwen' && this.settingsStore?.model(fallback)) {
            resolvedModelId = fallback;
            resolvedProvider = 'custom-music';
          } else resolvedModelId = 'qianwen';
        }
      } else if (modelId !== undefined || durationFrames !== undefined) {
        throw error('E_PARAMS', 'modelId 与 durationFrames 仅用于音乐生成');
      }
      const request = {
        projectId,
        operationId,
        provider: resolvedProvider,
        kind,
        text,
        voice,
        rate,
        ...(resolvedModelId === undefined ? {} : { modelId: resolvedModelId }),
        ...(durationFrames === undefined ? {} : { durationFrames }),
        ...(resolvedProvider === 'procedural' ? {score:validateScore(score)} : {}),
      };
      if (score !== undefined && resolvedProvider !== 'procedural') throw error('E_PARAMS','score 仅用于本地合成');
      if (
        rate !== undefined &&
        (!Number.isFinite(rate) || rate < 0.5 || rate > 2)
      )
        throw error('E_PARAMS', '语速范围为 0.5–2');
      if (
        voice !== undefined &&
        (typeof voice !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(voice))
      )
        throw error('E_PARAMS', '音色格式不正确');
      const hash = digest(request),
        s = await this.store();
      const old = s.jobs.find(
        (j) => j.projectId === projectId && j.operationId === operationId,
      );
      if (old) {
        if (old.hash !== hash)
          throw error('E_OPERATION_REUSED', '任务 ID 已用于不同请求');
        return this.public(old);
      }
      if (
        resolvedProvider === 'qianwen' &&
        kind === 'music' &&
        (await json(join(this.root, 'audio-capabilities.json'), {})).musicDenied
      )
        throw error(
          'E_AUDIO_ENTITLEMENT',
          '音乐未开通，请导入配乐；开通后测试连接可重试',
        );
      const p =
        resolvedProvider === 'custom-music'
          ? this.providerFor(resolvedModelId)
          : this.providers.get(resolvedProvider);
      if (!p || !p.capabilities()[kind])
        throw error('E_AUDIO_UNSUPPORTED', '供应商尚未开放此能力，请导入音频');
      if (this.running.size)
        throw error('E_AUDIO_BUSY', '已有音频生成任务，请等待或取消');
      if (
        s.jobs.filter(
          (j) =>
            j.createdAt.slice(0, 10) ===
              new Date().toISOString().slice(0, 10) && !['local','procedural'].includes(j.provider),
        ).length >= 20 &&
        !['local','procedural'].includes(resolvedProvider)
      )
        throw error('E_AUDIO_BUDGET', '今日已达 20 次调用护栏，请明日再试');
      if (s.jobs.length >= 1000)
        throw error('E_AUDIO_LIMIT', '音频任务记录已达上限，请保留记录后维护');
      const j = {
        jobId: 'audio_' + randomUUID(),
        projectId,
        operationId,
        provider: resolvedProvider,
        kind,
        hash,
        ...(resolvedModelId === undefined ? {} : { modelId: resolvedModelId }),
        createdAt: new Date().toISOString(),
        estimate: {
          characters: text.length,
          approxSpeechSeconds:
            kind === 'tts' ? Math.ceil(text.length / 3.3) : null,
          cny: ['local','procedural'].includes(resolvedProvider) ? 0 : null,
          note: ['local','procedural'].includes(resolvedProvider) ? '本地生成，不调用付费服务' : '仅估算输入规模；费用以供应商账单为准',
        },
        state: 'queued',
        label: text.slice(0,80),
        editable: resolvedProvider === 'procedural',
      };
      s.jobs.push(j);
      const control = new AbortController();
      this.running.set(j.jobId, { control });
      try {
        await atomic(join(this.root,j.jobId+'.recipe.json'),request);
        await this.save(s);
      } catch {
        this.running.delete(j.jobId);
        throw error('E_AUDIO_STORE', '任务记录未能保存，未向供应商发送请求');
      }
      const task = this.run(j, request, p, control);
      this.running.get(j.jobId).task = task;
      return this.public(j);
    });
  }
  public(j) {
    const { hash, ...result } = j;
    return result;
  }
  async update(j, patch) {
    await this.locked(async () => {
      const s = await this.store();
      Object.assign(j, patch);
      const i = s.jobs.findIndex((x) => x.jobId === j.jobId);
      s.jobs[i] = j;
      await this.save(s);
    });
  }
  async run(j, req, p, control, resumeTaskId) {
    const timer = setTimeout(
      () => control.abort('timeout'),
      p?.requestTimeoutMs ?? this.timeoutMs,
    );
    let file;
    try {
      await this.update(j, { state: 'running' });
      const result = await p.generate(req, {
        signal: control.signal,
        directory: this.root,
        ...(resumeTaskId === undefined
          ? {}
          : { resumeTaskId }),
        onTaskId: async (taskId) => {
          await this.update(j, { remoteTaskId: taskId });
        },
      });
      if (control.signal.aborted) throw 0;
      await this.update(j, { state: 'downloading' });
      file = join(this.root, randomUUID() + '.' + result.extension);
      await writeFile(file, result.bytes, { mode: 0o600, flag: 'wx' });
      if (control.signal.aborted) throw 0;
      const imported = await this.importAudio(j.projectId, file, req);
      await this.update(j, {
        state: 'succeeded',
        asset: imported.asset,
        usage: result.usage ?? null,
        model: result.model ?? p.id,
        analysis: result.analysis ?? null,
      });
    } catch (e) {
      if (
        j.provider === 'qianwen' &&
        j.kind === 'music' &&
        e?.code === 'E_AUDIO_ENTITLEMENT'
      )
        await this.locked(() =>
          atomic(join(this.root, 'audio-capabilities.json'), {
            musicDenied: true,
          }),
        ).catch(() => {});
      await this.update(j, {
        state: control.signal.aborted
          ? control.signal.reason === 'timeout'
            ? 'timed_out'
            : 'cancelled'
          : 'failed',
        error: {
          code: control.signal.aborted
            ? control.signal.reason === 'timeout'
              ? 'E_AUDIO_TIMEOUT'
              : 'E_AUDIO_CANCELLED'
            : (e?.code ?? 'E_AUDIO_PROVIDER'),
          message: control.signal.aborted
            ? control.signal.reason === 'timeout'
              ? (['local','procedural'].includes(j.provider)?'本地生成超时，请简化内容':'生成超时；供应商可能已计费，不会自动重试')
              : (['local','procedural'].includes(j.provider)?'已取消本地生成':'已取消；供应商可能仍计费')
            : e instanceof BridgeError
              ? e.message
              : '生成失败，请检查连接后重试',
          uncertain: !['local','procedural'].includes(j.provider) && (control.signal.aborted || e?.uncertain === true),
        },
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
      if (file) await unlink(file).catch(() => {});
      this.running.delete(j.jobId);
    }
  }
  async status(projectId, jobId) {
    const s = await this.store();
    if (!jobId)
      return {
        jobs: s.jobs
          .filter((j) => j.projectId === projectId)
          .slice(-20)
          .reverse()
          .map((j) => this.public(j)),
      };
    const j = s.jobs.find(
      (j) => j.jobId === jobId && j.projectId === projectId,
    );
    if (!j) throw error('E_JOB_NOT_FOUND', '音频任务不存在');
    return this.public(j);
  }
  async recipe(projectId, jobId) {
    const j=await this.status(projectId,jobId);
    if(!/^audio_[a-f0-9-]{36}$/.test(j.jobId))throw error('E_JOB_NOT_FOUND','音频任务不存在');
    const request=await json(join(this.root,j.jobId+'.recipe.json'),null);
    if(!request)throw error('E_AUDIO_RECIPE','旧任务没有生成参数，请重新描述');
    const {provider,kind,text,voice,rate,score,modelId,durationFrames}=request;
    return {provider:provider==='custom-music'?'qianwen':provider,kind,text,voice,rate,score,modelId,durationFrames};
  }
  async cancel(projectId, jobId) {
    const j = await this.status(projectId, jobId);
    this.running.get(jobId)?.control.abort();
    return { ...j, state: this.running.has(jobId) ? 'cancelling' : j.state };
  }
  async dispose() {
    this.closed = true;
    const tasks = [...this.running.values()];
    for (const r of tasks) r.control.abort();
    await Promise.allSettled(tasks.map((r) => r.task));
  }
}