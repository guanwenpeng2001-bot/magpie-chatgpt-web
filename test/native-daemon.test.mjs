import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDaemon, daemonProxy, quoteMcpCommand } from '../src/native/daemon.mjs';

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'native-daemon-'));
  const calls = [], requests = [], children = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('exit', null); };
    children.push(child);
    if (!args.includes('serve')) queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ process_running: true, healthy: true, ready: true }));
      child.emit('close', 0);
    });
    return child;
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(new URL(url).hostname, '127.0.0.1');
    return url.endsWith('/healthz') ? Response.json({ service: 'codex-chatgpt-web', mode: 'full', accepting_turns: true }) : new Response('data: fixture\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const daemon = new NativeDaemon({ home, runtimeCommand: ['C:\\durable path\\bun.exe', 'C:\\durable path\\cli.js'],
    tunnelBinary: 'C:\\durable\\tunnel-client.exe', chromeExecutablePath: 'C:\\Chrome\\chrome.exe',
    storageState: async () => ({ cookies: [{ name: 'fixture', value: 'local' }], origins: [] }),
    capabilities: { solAvailable: true, proAvailable: false, extraHighAvailable: false },
    appName: 'Codex Magpie fixture', spawn, fetch, allocatePort: async () => 43210, startupTimeoutMs: 1000, pollMs: 1,
    restartBaseMs: 10, restartMaxMs: 40, env: { PATH: 'fixture', OPENAI_API_KEY: 'never-inherit', CODEX_HOME: 'never-use' }, ...overrides });
  t.after(async () => { await daemon.stop(); await rm(home, { recursive: true, force: true }); });
  return { daemon, calls, requests, children, home };
}
const credentials = { tunnelId: 'fixture-tunnel', runtimeKey: 'fixture-key' };

test('daemon writes exact verified state, private config and isolated hidden processes', async t => {
  const { daemon, calls, home } = await fixture(t);
  assert.equal(await daemon.start(credentials), daemon);
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(config.appName, 'Codex Magpie fixture');
  assert.equal(config.mode, 'full');
  assert.equal(config.browserHost, 'managed-chrome');
  assert.match(config.brokerSocketPath, /^\\\\\.\\pipe\\magpie-native-/);
  assert.equal(config.proAvailable, false);
  const marker = JSON.parse(await readFile(`${config.storageStatePath}.verified.json`, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['authenticated', 'extraHighAvailable', 'proAvailable', 'solAvailable', 'verifiedAt', 'version']);
  assert.equal(marker.authenticated, true);
  assert.ok(Number.isFinite(Date.parse(marker.verifiedAt)));
  const state = JSON.parse(await readFile(config.storageStatePath, 'utf8'));
  assert.equal(state.cookies[0].value, 'local');
  assert.equal(await readFile(config.tunnel.runtimeKeyFile, 'utf8'), credentials.runtimeKey);
  assert.ok(calls.every(call => call.options.windowsHide));
  assert.equal(calls[0].options.env.CODEX_HOME, join(home, 'codex'));
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  const connect = calls.find(call => call.args.includes('connect'));
  assert.equal(connect.options.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION, 'true');
  assert.equal(connect.args[connect.args.indexOf('--runtime-api-key') + 1], `file:${config.tunnel.runtimeKeyFile}`);
  assert.equal(connect.args.includes(credentials.runtimeKey), false);
  assert.equal(connect.args[connect.args.indexOf('--mcp-command') + 1], quoteMcpCommand([...config.runtimeCommand, 'mcp', '--contract', 'native', '--broker-socket', config.brokerSocketPath]));
  assert.equal(await daemon.health(), true);
});

test('native Responses proxy streams unchanged, strips caller credentials and carries cancellation', async t => {
  const { daemon, requests } = await fixture(t);
  await daemon.start(credentials);
  const signal = new AbortController().signal;
  const body = { model: 'chatgpt-web/gpt-6-sol', input: [], client_metadata: { important: 'keep' } };
  const result = await daemon.responses(body, { authorization: 'private', cookie: 'private', 'x-codex-turn-metadata': 'fixture' }, signal);
  assert.equal(await result.text(), 'data: fixture\n\n');
  const sent = requests.at(-1).options;
  assert.equal(sent.signal, signal);
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers.get('cookie'), null);
  assert.equal(sent.headers.get('authorization'), `Bearer ${daemon.config.controlToken}`);
  assert.deepEqual(JSON.parse(sent.body), body);
});

test('concurrent start shares work, crash restarts with new pipe, stop cancels restarts', async t => {
  const { daemon, calls, children } = await fixture(t);
  await Promise.all([daemon.start(credentials), daemon.start(credentials)]);
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
  const pipe = daemon.config.brokerSocketPath;
  children[0].emit('exit', 1);
  for (let i = 0; i < 100 && (!daemon.ready || daemon.config.brokerSocketPath === pipe); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(daemon.ready, true);
  assert.notEqual(daemon.config.brokerSocketPath, pipe);
  await daemon.stop();
  const count = calls.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls.length, count);
  assert.equal(daemon.ready, false);
  assert.ok(calls.some(call => call.args[1] === 'stop'));
});

test('health timeout cleans up and stop prevents retry', async t => {
  const { daemon, children } = await fixture(t, { startupTimeoutMs: 2, fetch: async () => Response.json({}) });
  await assert.rejects(daemon.start(credentials), /startup failed/);
  await daemon.stop();
  assert.equal(children[0].killed, true);
  assert.equal(daemon.ready, false);
});

test('proxy rejects arbitrary or invalid ports', () => {
  for (const port of [0, 65536, '123/path', undefined]) assert.throws(() => daemonProxy({ port }));
});

test('tunnel readiness requires all three flags, not merely a running process', async t => {
  const { daemon } = await fixture(t);
  let checks = 0;
  const command = daemon.command.bind(daemon);
  daemon.command = (args, signal) => args[1] === 'status'
    ? Promise.resolve({ process_running: true, healthy: true, ready: ++checks > 2 }) : command(args, signal);
  await daemon.start(credentials);
  assert.equal(checks, 3);
  assert.equal(daemon.ready, true);
});

test('tunnel connect failure cleans up without exposing command diagnostics', async t => {
  const { daemon, children } = await fixture(t);
  const command = daemon.command.bind(daemon);
  daemon.command = (args, signal) => args[1] === 'connect'
    ? Promise.reject(new Error('fixture-secret-do-not-log')) : command(args, signal);
  await assert.rejects(daemon.start(credentials), error => error.message === 'Native daemon startup failed' && !error.cause);
  await daemon.stop();
  assert.equal(children[0].killed, true);
});

test('stop aborts startup before tunnel connection and leaves no crash retry', async t => {
  let probing;
  const probe = new Promise(resolve => { probing = resolve; });
  const { daemon, calls, children } = await fixture(t, { fetch: async (_url, { signal }) => {
    probing();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const started = daemon.start(credentials);
  const rejected = assert.rejects(started, /startup failed/);
  await probe;
  await daemon.stop();
  await rejected;
  assert.equal(children[0].killed, true);
  assert.equal(calls.some(call => call.args[1] === 'connect'), false);
  assert.equal(daemon.restartTimer, null);
});
