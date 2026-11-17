import fs from 'node:fs/promises';
import path from 'node:path';
import { HarnessError } from '@deepseek-ai/dsh-error';

export class MaitianError extends HarnessError {
  constructor(code, message) { super(message, code); }
}

export async function settings(config) {
  let local = {};
  if (config.configFile) {
    if (!path.isAbsolute(config.configFile)) throw new MaitianError('CONFIG_INVALID', 'configFile 必须是麦田 config.json 的绝对路径');
    try { local = JSON.parse(await fs.readFile(config.configFile, 'utf8')); }
    catch { throw new MaitianError('CONFIG_INVALID', '无法读取麦田配置，请检查 configFile'); }
  }
  const baseUrl = config.baseUrl || `http://127.0.0.1:${local.web?.port || 8787}`;
  let url;
  try { url = new URL(baseUrl); } catch { throw new MaitianError('CONFIG_INVALID', 'baseUrl 不是有效 URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) {
    throw new MaitianError('CONFIG_INVALID', 'baseUrl 必须是无凭证、无路径、无查询参数的 HTTP(S) 地址');
  }
  if (!loopback && (!config.allowRemote || url.protocol !== 'https:')) {
    throw new MaitianError('CONFIG_INVALID', '远程麦田需要 allowRemote=true 且使用 HTTPS');
  }
  const key = config.apiKey || process.env[config.apiKeyEnv || 'MAITIAN_WEB_KEY'] || local.web?.key;
  if (typeof key !== 'string' || !key || /[;\r\n\x00-\x20\x7f]/.test(key)) {
    throw new MaitianError('CONFIG_INVALID', '请通过 configFile、apiKey 或 MAITIAN_WEB_KEY 配置麦田访问口令');
  }
  return { url, key, local };
}

// Never follow a redirect carrying the local authentication cookie.
export async function request(config, endpoint, { signal } = {}) {
  const { url, key } = await settings(config);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(config.timeoutMs || 15000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(new URL(endpoint, url), {
      headers: { cookie: `mt_key=${key}`, accept: 'application/json' },
      redirect: 'manual', signal: combined,
    });
  } catch {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new MaitianError('REQUEST_TIMEOUT', '麦田请求超时');
    throw new MaitianError('SERVICE_UNAVAILABLE', '无法连接麦田，请先启动麦田网页服务并检查端口');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MaitianError(response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR', response.status === 401 ? '麦田访问口令不正确' : `麦田返回 HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > (config.maxResponseBytes || 8 * 1024 * 1024)) throw new MaitianError('RESPONSE_TOO_LARGE', '麦田响应超过大小限制，请调高 maxResponseBytes');
      parts.push(value);
    }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid shape');
    return data;
  } catch (e) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new MaitianError('REQUEST_TIMEOUT', '麦田响应读取超时');
    if (e instanceof MaitianError) throw e;
    throw new MaitianError('INVALID_RESPONSE', '麦田没有返回有效的 JSON 对象');
  } finally { await reader.cancel().catch(() => {}); }
}

export function limitOf(value, max = 200) {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new MaitianError('INVALID_ARGUMENT', `limit 必须是 1–${max} 的整数`);
  return limit;
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new MaitianError('INVALID_ARGUMENT', `${field} 不能为空或包含无效字符`);
  return value;
}

export function summarize(data) {
  return {
    name: data.name, now: data.now, health: data.health,
    episodeCount: data.episodes?.length || 0,
    recentEpisodes: (data.episodes || []).slice(0, 5).map(({ id, name, episode, schedule, views, inter, tasks }) => ({ id, name, episode, schedule, views, inter, tasks })),
    siteOn: !!data.siteOn,
    actions: data.actions || [],
  };
}
