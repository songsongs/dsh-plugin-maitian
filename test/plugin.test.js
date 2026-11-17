import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request, settings, limitOf } from '../client.js';
import { validateCommand, prepareCommand, runCommand } from '../commands.js';
import { apply, Config } from '../index.js';

async function server(t, handler) {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  t.after(() => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'test-key' };
}
function fixture(config, approval = async () => 'rejected') {
  const tools = new Map();
  const disposers = [];
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, approval: { request: approval }, effect: body => disposers.push(body()) }, Config(config));
  const call = (name, args, signal = new AbortController().signal) => tools.get(name).execute(args, { signal, name, callId: 'fixture-1', agent: {} });
  return { tools, call, dispose: () => disposers.forEach(dispose => dispose()) };
}
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maitian-plugin-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'projects/episode-1'), { recursive: true });
  await fs.writeFile(path.join(root, 'projects/episode-1/publish.json'), '{}');
  await fs.writeFile(path.join(root, 'src/hub.mjs'), `console.log('received',JSON.stringify(process.argv.slice(2)));console.log('secret-value');`);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ web: { key: 'secret-value', port: 8789 }, rootPath: path.join(root, 'projects') }));
  return { root, config: { maitianDir: root, configFile, enableCommands: true }, dir: path.join(root, 'projects/episode-1') };
}

test('配置默认只注册查询工具，拒绝不安全地址和无效口令', async () => {
  assert.equal(fixture({}).tools.size, 4);
  for (const baseUrl of ['http://example.com', 'https://example.com/path', 'http://user:pass@localhost', 'http://127.0.0.1?key=x']) {
    await assert.rejects(settings({ baseUrl, apiKey: 'x' }), { code: 'CONFIG_INVALID' });
  }
  await assert.rejects(settings({ apiKey: 'x;inject=y' }), { code: 'CONFIG_INVALID' });
  const configured = await settings({ baseUrl: 'https://example.com', apiKey: 'x', allowRemote: true });
  assert.equal(configured.url.hostname, 'example.com');
});
test('HTTP 使用口令且不把认证放入 URL', async t => {
  const cfg = await server(t, (req, res) => { assert.equal(req.headers.cookie, 'mt_key=test-key'); assert.equal(req.url, '/api/overview'); res.end('{"name":"test"}'); });
  assert.deepEqual(await request(cfg, '/api/overview'), { name: 'test' });
});
test('401 被转成稳定错误且不泄露响应正文', async t => {
  const cfg = await server(t, (_req, res) => { res.writeHead(401); res.end('private detail'); });
  await assert.rejects(request(cfg, '/api/overview'), e => e.code === 'UNAUTHORIZED' && !e.message.includes('private'));
});
test('拒绝重定向，认证口令不会跟随其他地址', async t => {
  let forwarded = false;
  const destination = await server(t, (_req, res) => { forwarded = true; res.end('{}'); });
  const cfg = await server(t, (_req, res) => { res.writeHead(302, { location: destination.baseUrl }); res.end(); });
  await assert.rejects(request(cfg, '/api/overview'), { code: 'HTTP_ERROR' });
  assert.equal(forwarded, false);
});
test('限制响应大小并拒绝无效 JSON', async t => {
  const large = await server(t, (_req, res) => res.end(JSON.stringify({ data: 'a'.repeat(2048) })));
  await assert.rejects(request({ ...large, maxResponseBytes: 1024 }, '/api/overview'), { code: 'RESPONSE_TOO_LARGE' });
  const bad = await server(t, (_req, res) => res.end('not-json'));
  await assert.rejects(request(bad, '/api/overview'), { code: 'INVALID_RESPONSE' });
});
test('超时与取消不会变成成功结果', async t => {
  const cfg = await server(t, () => {});
  await assert.rejects(request({ ...cfg, timeoutMs: 30 }, '/api/overview'), { code: 'REQUEST_TIMEOUT' });
  const controller = new AbortController(); const reason = new DOMException('test cancel', 'AbortError'); controller.abort(reason);
  await assert.rejects(request(cfg, '/api/overview', { signal: controller.signal }), e => e === reason);
});
test('查询支持分页和精确 id 编码，历史数据明确标注截断', async t => {
  const cfg = await server(t, (req, res) => {
    if (req.url.startsWith('/api/episode?')) { assert.equal(new URL(req.url, 'http://x').searchParams.get('id'), 'id & x'); res.end('{"id":"id & x"}'); return; }
    res.end(JSON.stringify({ episodes: [{ id: '1', name: '测试A' }, { id: '2', name: '测试B' }], followers: [{ platform: 'x', day: '1' }, { platform: 'x', day: '2' }] }));
  });
  const { call } = fixture(cfg);
  const page = await call('maitian_episodes', { limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.hasMore, true); assert.equal(page.episodes[0].id, '1');
  assert.equal((await call('maitian_episode', { id: 'id & x' })).id, 'id & x');
  const history = await call('maitian_metrics', { kind: 'followers', limit: 1 });
  assert.equal(history.truncated, true); assert.equal(history.rows[0].day, '2');
});
test('SDK 参数校验拒绝无效类型、枚举和越界分页', async () => {
  const { call } = fixture({});
  await assert.rejects(call('maitian_metrics', { kind: 'other' }));
  await assert.rejects(call('maitian_episodes', { limit: '20' }));
  for (const value of [0, -1, 1.5, 201]) assert.throws(() => limitOf(value), { code: 'INVALID_ARGUMENT' });
});
test('命令白名单拒绝 shell、强制重传和缺失参数', () => {
  for (const args of [{ command: 'daemon' }, { command: 'run', projectDir: 'x' }, { command: 'sync' }, { command: 'status', id: '--force' }, { command: 'run', projectDir: 'x', platforms: ['zsz'] }, { command: 'weekly', projectDir: 'x' }, { command: 'status', force: true }]) {
    assert.throws(() => validateCommand(args), { code: 'INVALID_ARGUMENT' });
  }
});
test('卸载会中止进行中的请求', async t => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const cfg = await server(t, () => received());
  const f = fixture(cfg);
  const pending = f.call('maitian_overview', {});
  await started; f.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('真实目录校验阻止工程路径越界', async t => {
  const p = await project(t);
  const prepared = await prepareCommand(p.config, { command: 'plan', projectDir: p.dir });
  assert.equal(prepared.argv[1], 'plan');
  await assert.rejects(prepareCommand(p.config, { command: 'plan', projectDir: p.root }), { code: 'PROJECT_OUTSIDE_ROOT' });
});
test('审批拒绝时不启动命令，通过后固定 argv 执行并遮盖口令', async t => {
  const p = await project(t); let asks = 0;
  const rejected = fixture(p.config, async () => { asks++; return 'rejected'; });
  await assert.rejects(rejected.call('maitian_command', { command: 'plan', projectDir: p.dir }), { code: 'APPROVAL_DENIED' });
  assert.equal(asks, 1);
  const accepted = fixture(p.config, async () => 'allowed-once');
  const value = await accepted.call('maitian_command', { command: 'plan', projectDir: p.dir });
  assert.equal(value.exitCode, 0); assert.match(value.stdout, /plan/); assert.ok(!value.stdout.includes('secret-value'));
});
test('缺失会话不能绕过审批，取消能终止子进程', async t => {
  const p = await project(t); const { tools } = fixture(p.config, async () => 'allowed-once');
  await assert.rejects(tools.get('maitian_command').execute({ command: 'plan', projectDir: p.dir }, { signal: new AbortController().signal }), { code: 'APPROVAL_UNAVAILABLE' });
  await fs.writeFile(path.join(p.root, 'src/hub.mjs'), 'setTimeout(()=>{},60000);');
  const args = { command: 'status' }, prepared = await prepareCommand(p.config, args), controller = new AbortController();
  const pending = runCommand(p.config, args, prepared, controller.signal);
  const reason = new DOMException('stop process', 'AbortError'); controller.abort(reason);
  await assert.rejects(pending, e => e === reason);
});
