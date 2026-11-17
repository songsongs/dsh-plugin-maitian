import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MaitianError, requiredString, settings } from './client.js';

export const COMMANDS = ['status', 'plan', 'run', 'sync', 'doctor', 'followers', 'metrics', 'review', 'weekly', 'login'];
const MUTATING = new Set(['plan', 'run', 'sync', 'doctor', 'followers', 'metrics', 'login']);
const PLATFORMS = new Set(['bilibili', 'douyin', 'xhs', 'channels', 'youtube', 'x', 'instagram']);

export function validateCommand(args) {
  if (Object.keys(args).some(key => !['command', 'projectDir', 'id', 'platforms'].includes(key))) throw new MaitianError('INVALID_ARGUMENT', '命令包含不支持的参数');
  if (!COMMANDS.includes(args.command)) throw new MaitianError('INVALID_ARGUMENT', '不支持的麦田命令');
  for (const key of ['projectDir', 'id']) if (args[key] !== undefined) requiredString(args[key], key);
  if (['plan', 'run'].includes(args.command) && !args.projectDir) throw new MaitianError('INVALID_ARGUMENT', 'plan/run 必须指定 projectDir');
  if (['sync', 'review'].includes(args.command) && !args.id) throw new MaitianError('INVALID_ARGUMENT', 'sync/review 必须指定 id');
  if (args.id?.startsWith('-')) throw new MaitianError('INVALID_ARGUMENT', 'id 不能以 - 开头');
  if (args.platforms !== undefined && (!Array.isArray(args.platforms) || args.platforms.length === 0 || !args.platforms.every(p => PLATFORMS.has(p)))) throw new MaitianError('INVALID_ARGUMENT', 'platforms 包含不支持的平台');
  if (args.platforms && !['run', 'sync', 'followers'].includes(args.command)) throw new MaitianError('INVALID_ARGUMENT', '该命令不接受 platforms');
  if (args.command === 'run' && !args.platforms?.length) throw new MaitianError('INVALID_ARGUMENT', 'run 必须明确指定 platforms');
  if (args.projectDir && !['plan', 'run'].includes(args.command)) throw new MaitianError('INVALID_ARGUMENT', '该命令不接受 projectDir');
  if (args.id && !['status', 'sync', 'metrics', 'review'].includes(args.command)) throw new MaitianError('INVALID_ARGUMENT', '该命令不接受 id');
  return { mutating: MUTATING.has(args.command) };
}

export async function prepareCommand(config, args) {
  const classification = validateCommand(args);
  if (!config.maitianDir || !path.isAbsolute(config.maitianDir)) throw new MaitianError('CONFIG_INVALID', '使用命令前，请设置 maitianDir 为麦田仓库绝对路径');
  const root = await fs.realpath(config.maitianDir);
  const configFile = config.configFile || path.join(root, 'config.json');
  const { local } = await settings({ ...config, configFile });
  const hub = path.join(root, 'src/hub.mjs');
  try { await fs.access(hub); } catch { throw new MaitianError('CONFIG_INVALID', 'maitianDir 中没有 src/hub.mjs'); }
  const argv = [hub, args.command];
  if (args.projectDir) {
    if (!path.isAbsolute(args.projectDir)) throw new MaitianError('INVALID_ARGUMENT', 'projectDir 必须是绝对路径');
    const project = await fs.realpath(args.projectDir);
    const allowed = await fs.realpath(requiredString(local.rootPath, 'config.rootPath'));
    const relative = path.relative(allowed, project);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new MaitianError('PROJECT_OUTSIDE_ROOT', '工程必须是麦田 rootPath 内的子目录');
    await fs.access(path.join(project, 'publish.json'));
    argv.push(project);
  }
  if (args.id) argv.push(args.id);
  if (args.platforms) argv.push('--only', args.platforms.join(','));
  const secrets = [local.web?.key, config.apiKey, process.env[config.apiKeyEnv || 'MAITIAN_WEB_KEY'], local.feishuWebhook, local.nasUrl].filter(Boolean);
  return { ...classification, root, configFile, argv, secrets };
}

export function runCommand(config, args, prepared, signal) {
  signal?.throwIfAborted();
  const env = { ...process.env, MAITIAN_CONFIG: prepared.configFile, HUB_NO_WEB: '1' };
  // An inherited demo/test database must never redirect a real publishing command.
  delete env.MAITIAN_DB;
  const maxBytes = config.maxCommandOutputBytes || 1024 * 1024;
  const timeout = args.command === 'run' ? (config.publishTimeoutMs || 3600000) : (config.commandTimeoutMs || 300000);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, prepared.argv, { cwd: prepared.root, env, windowsHide: true, shell: false, signal, timeout, maxBuffer: maxBytes }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const redact = value => prepared.secrets.reduce((s, key) => s.replaceAll(key, '[REDACTED]'), String(value || ''));
      if (error && typeof error.code !== 'number') {
        reject(new MaitianError(error.killed ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED', error.killed ? '命令超时或输出超过限制，浏览器可能已部分操作；先查看麦田状态，勿自动重试发布' : '麦田命令无法启动'));
        return;
      }
      resolve({ command: args.command, exitCode: error?.code || 0, stdout: redact(stdout), stderr: redact(stderr), publishing: args.command === 'run' });
    });
  });
}
