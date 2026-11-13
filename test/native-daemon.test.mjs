import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
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
      child.stdout.end(JSON.stringify(args[1] === 'list' ? { aliases: [] } : { process_running: true, healthy: true, ready: true }));
      child.emit('close', 0);
    });
    return child;
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(new URL(url).hostname, '127.0.0.1');
    if (url.includes('/admin/')) {
      if (url.endsWith('/shutdown')) children[calls.findLastIndex(call => call.args.includes('serve'))].emit('exit', 0);
      return Response.json({ status: 'ok' });
    }
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

test('native runtime receives only its owned ordinary browser endpoint', async t => {
  const browserEndpoint = 'http://127.0.0.1:43211';
  const {daemon,calls} = await fixture(t, {browserEndpoint,
    env:{PATH:'fixture',MAGPIE_NATIVE_BROWSER_CDP:'http://127.0.0.1:9999'}});
  await daemon.start(credentials);
  assert.equal(calls[0].options.env.MAGPIE_NATIVE_BROWSER_CDP, browserEndpoint);
});

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
  assert.notEqual(children[0].killed, true);
  assert.equal(daemon.child, null);
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

test('stop drains, cancels and shuts down before stopping the tunnel, awaiting graceful exit', { timeout: 2000 }, async t => {
  const { daemon, children, calls } = await fixture(t);
  await daemon.start(credentials);
  const child = children[0];
  const events = [];
  let shutdownRequested;
  const shutdown = new Promise(resolve => { shutdownRequested = resolve; });
  daemon.fetch = async (url, options) => {
    const action = new URL(url).pathname;
    events.push(action);
    assert.equal(new URL(url).origin, `http://127.0.0.1:${daemon.config.port}`);
    assert.equal(options.method, 'POST');
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${daemon.config.controlToken}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false, 'shutdown must not reuse the aborted startup controller');
    assert.equal(calls.some(call => call.args[1] === 'stop'), false, 'keep tunnel available until cancellation settles');
    if (action === '/admin/shutdown') shutdownRequested();
    return Response.json({ status: 'ok' });
  };
  const command = daemon.command.bind(daemon);
  daemon.command = (args, signal) => { if (args[1] === 'stop') events.push('tunnel-stop'); return command(args, signal); };
  const stopping = daemon.stop();
  assert.equal(daemon.stop(), stopping);
  let settled = false;
  void stopping.then(() => { settled = true; });
  await shutdown;
  assert.equal(settled, false);
  assert.notEqual(child.killed, true);
  child.emit('exit', 0);
  await stopping;
  assert.deepEqual(events, ['/admin/drain', '/admin/cancel-turns', '/admin/shutdown', 'tunnel-stop']);
  assert.notEqual(child.killed, true);
  assert.equal(daemon.restartTimer, null);
  assert.equal(daemon.child, null);
});

for (const failure of ['drain', 'cancel-turns', 'shutdown', 'invalid-json']) {
  test(`shutdown ${failure} failure forces cleanup and stops the tunnel`, async t => {
    const { daemon, calls, children } = await fixture(t);
    await daemon.start(credentials);
    const actions = [];
    daemon.fetch = async url => {
      const action = new URL(url).pathname.split('/').at(-1);
      actions.push(action);
      if (failure === 'invalid-json') return new Response('invalid');
      return Response.json({ status: action === failure ? 'refused' : 'ok' }, { status: action === failure ? 409 : 200 });
    };
    await daemon.stop();
    const expected = ['drain', 'cancel-turns', 'shutdown'];
    assert.deepEqual(actions, failure === 'invalid-json' ? ['drain'] : expected.slice(0, expected.indexOf(failure) + 1));
    assert.equal(children[0].killed, true);
    assert.equal(calls.some(call => call.args[1] === 'stop'), true);
    assert.equal(daemon.restartTimer, null);
  });
}

test('shutdown request timeout forces cleanup with a fresh bounded signal', { timeout: 2000 }, async t => {
  const { daemon, calls, children } = await fixture(t, { shutdownRequestTimeoutMs: 15 });
  await daemon.start(credentials);
  let timedOut = false;
  daemon.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { timedOut = true; reject(signal.reason); }, { once: true });
  });
  await daemon.stop();
  assert.equal(timedOut, true);
  assert.equal(children[0].killed, true);
  assert.equal(calls.some(call => call.args[1] === 'stop'), true);
});

test('acknowledged shutdown that never exits falls back after the exit deadline', { timeout: 2000 }, async t => {
  const { daemon, calls, children } = await fixture(t, { shutdownExitTimeoutMs: 15 });
  await daemon.start(credentials);
  const actions = [];
  daemon.fetch = async url => { actions.push(new URL(url).pathname); return Response.json({ status: 'ok' }); };
  await daemon.stop();
  assert.deepEqual(actions, ['/admin/drain', '/admin/cancel-turns', '/admin/shutdown']);
  assert.equal(children[0].killed, true);
  assert.equal(calls.some(call => call.args[1] === 'stop'), true);
});

test('startup stops and removes stale aliases of this profile only, keeping the current one', async t => {
  const { daemon, calls, home } = await fixture(t);
  const profileDir = join(home, 'tunnel');
  const staleA = 'magpie-11111111-1111-4111-8111-111111111111';
  const staleB = 'magpie-22222222-2222-4222-8222-222222222222';
  const foreign = 'magpie-33333333-3333-4333-8333-333333333333';
  const otherTunnel = 'magpie-44444444-4444-4444-8444-444444444444';
  const original = daemon.command.bind(daemon);
  const commands = [];
  daemon.command = (args, signal) => {
    commands.push(args.slice(0, 3));
    if (args[1] === 'list') return Promise.resolve({ aliases: [
      { alias: staleA, profile_dir: profileDir, tunnel_id: credentials.tunnelId },
      { alias: staleB, profile_dir: profileDir.toUpperCase(), tunnel_id: credentials.tunnelId },
      { alias: foreign, profile_dir: join(home, 'other'), tunnel_id: credentials.tunnelId },
      { alias: otherTunnel, profile_dir: profileDir, tunnel_id: 'another-tunnel' },
      { alias: 'user-alias', profile_dir: profileDir, tunnel_id: credentials.tunnelId },
      { alias: 'magpie-' + 'a'.repeat(36), profile_dir: profileDir, tunnel_id: credentials.tunnelId },
      { alias: 'magpie-' + '-'.repeat(36), profile_dir: profileDir, tunnel_id: credentials.tunnelId },
    ] });
    return original(args, signal);
  };
  await daemon.start(credentials);
  const current = daemon.config.tunnel.alias;
  const removed = commands.filter(args => args[1] === 'rm').map(args => args[2]);
  assert.deepEqual(removed, [staleA, staleB]);
  assert.deepEqual(commands.filter(args => args[1] === 'stop').map(args => args[2]), [staleA, staleB]);
  const connectAt = commands.findIndex(args => args[1] === 'connect');
  assert.ok(commands.findLastIndex(args => args[1] === 'rm') < connectAt, 'stale aliases are removed before connecting');
  assert.ok(!removed.includes(current));
  assert.ok(calls.some(call => call.args.includes(current)));
  await daemon.stop();
  assert.deepEqual(commands.slice(-2).map(args => [args[1], args[2]]), [['stop', current], ['rm', current]]);
});

test('an unreadable alias list blocks startup before connect and permits retry', async t => {
  const { daemon, calls } = await fixture(t);
  const original = daemon.command.bind(daemon);
  daemon.command = (args, signal) => args[1] === 'list' ? Promise.reject(new Error('list failed')) : original(args, signal);
  await assert.rejects(daemon.start(credentials), /startup failed/);
  assert.equal(calls.some(call => call.args[1] === 'connect'), false);
  daemon.command = original;
  assert.equal(await daemon.start(credentials), daemon);
});

test('same normalized home rejects a second owner before writes or commands, then stop releases it', async t => {
  const first = await fixture(t);
  const home = process.platform === 'win32' ? first.home.toUpperCase() : first.home;
  const second = await fixture(t, { home: home + '/unused/..' });
  await first.daemon.start(credentials);
  const before = await readFile(join(first.home, 'config.json'), 'utf8');
  await assert.rejects(second.daemon.start(credentials));
  assert.equal(second.calls.length, 0);
  assert.equal(await readFile(join(first.home, 'config.json'), 'utf8'), before);
  assert.equal(second.daemon.restartTimer, null, 'contender must not retry stealing ownership');
  await second.daemon.stop();
  assert.equal(second.calls.length, 0);
  await first.daemon.stop();
  await second.daemon.start(credentials);
  const count = first.calls.length;
  await first.daemon.stop();
  assert.equal(first.calls.length, count, 'old stop cannot clean a successor');
});

test('different homes can own native daemons concurrently', async t => {
  const a = await fixture(t), b = await fixture(t);
  await Promise.all([a.daemon.start(credentials), b.daemon.start(credentials)]);
  assert.equal(a.daemon.ready && b.daemon.ready, true);
});

test('startup failure releases ownership after cleanup', async t => {
  const a = await fixture(t, { restartBaseMs: 60_000, fetch: async () => Response.json({}), startupTimeoutMs: 10 });
  const b = await fixture(t, { home: a.home });
  await assert.rejects(a.daemon.start(credentials), /startup failed/);
  await b.daemon.start(credentials);
  const count = a.calls.length;
  await a.daemon.stop();
  assert.equal(a.calls.length, count);
});

for (const method of ['stop', 'rm']) {
  test(`stale alias ${method} failure prevents connect and permits retry`, async t => {
    const { daemon, home, calls } = await fixture(t, { restartBaseMs: 60_000 });
    const original = daemon.command.bind(daemon);
    const alias = 'magpie-11111111-1111-4111-8111-111111111111';
    daemon.command = (args, signal) => {
      if (args[1] === 'list') return Promise.resolve({ aliases: [{ alias, profile_dir: join(home, 'tunnel'), tunnel_id: credentials.tunnelId }] });
      if (args[1] === method && args[2] === alias) return Promise.reject(new Error('private diagnostic'));
      return original(args, signal);
    };
    await assert.rejects(daemon.start(credentials), error => error.message === 'Native daemon startup failed' && !error.cause);
    assert.equal(calls.some(call => call.args[1] === 'connect'), false);
    daemon.command = original;
    await daemon.start(credentials);
  });

  test(`shutdown ${method} failure retains ownership until a successful retry`, async t => {
    const a = await fixture(t), b = await fixture(t, { home: a.home });
    await a.daemon.start(credentials);
    const original = a.daemon.command.bind(a.daemon);
    a.daemon.command = (args, signal) => args[1] === 'list'
      ? Promise.resolve({ aliases: [{ alias: a.daemon.config.tunnel.alias }] })
      : args[1] === method ? Promise.reject(new Error('private diagnostic')) : original(args, signal);
    await assert.rejects(a.daemon.stop(), error => !error.message.includes('private diagnostic') && !error.cause);
    await assert.rejects(b.daemon.start(credentials));
    assert.equal(b.calls.length, 0);
    a.daemon.command = original;
    await a.daemon.stop();
    await b.daemon.start(credentials);
  });
}

for (const mode of ['crash', 'explicit']) {
  test(`${mode} restart holds ownership through tunnel cleanup`, async t => {
    const a = await fixture(t), b = await fixture(t, { home: a.home });
    await a.daemon.start(credentials);
    let entered, release;
    const cleaning = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = a.daemon.command.bind(a.daemon);
    a.daemon.command = async (args, signal) => {
      if (args[1] === 'rm') { entered(); await gate; }
      return original(args, signal);
    };
    const old = a.daemon.config.tunnel.alias;
    a.daemon.allocatePort = async () => {
      await assert.rejects(b.daemon.start(credentials), 'ownership must survive the cleanup-to-launch gap');
      assert.equal(b.calls.length, 0);
      return 43210;
    };
    let restarting;
    if (mode === 'crash') a.children[0].emit('exit', 1);
    else restarting = a.daemon.restart();
    await cleaning;
    try { await assert.rejects(b.daemon.start(credentials)); assert.equal(b.calls.length, 0); }
    finally { release(); }
    if (restarting) await restarting;
    for (let i = 0; i < 100 && (!a.daemon.ready || a.daemon.config.tunnel.alias === old); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(a.daemon.ready, true);
    assert.notEqual(a.daemon.config.tunnel.alias, old);
    await assert.rejects(b.daemon.start(credentials));
  });
}

test('OS ownership rejects another process and is released after process death', { timeout: 10_000 }, async t => {
  const { daemon, home } = await fixture(t);
  const moduleURL = new URL('../src/native/daemon.mjs', import.meta.url).href;
  const source = `import { NativeDaemon } from ${JSON.stringify(moduleURL)};
    const daemon = new NativeDaemon({home:process.argv[1],runtimeCommand:[],
      allocatePort:async()=>{process.send('owned');return new Promise(()=>{});}});
    daemon.start({tunnelId:'fixture',runtimeKey:'fixture'}).catch(()=>process.exit(2));
    setInterval(()=>{},1000);`;
  const child = spawnProcess(process.execPath, ['--input-type=module', '-e', source, home], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('owner exited early'))); });
  await assert.rejects(daemon.start(credentials));
  child.kill();
  await exited;
  await daemon.start(credentials);
});

for (const inventory of [{}, { aliases: null }, { aliases: {} }]) {
  test(`invalid inventory ${JSON.stringify(inventory)} fails closed before connect`, async t => {
    const { daemon, calls } = await fixture(t, { restartBaseMs: 60_000 });
    const original = daemon.command.bind(daemon);
    daemon.command = (args, signal) => args[1] === 'list' ? Promise.resolve(inventory) : original(args, signal);
    await assert.rejects(daemon.start(credentials), /startup failed/);
    assert.equal(calls.some(call => call.args[1] === 'connect'), false);
    daemon.command = original;
    await daemon.start(credentials);
  });
}

test('a timed-out tunnel command must exit before ownership can pass to another daemon', async t => {
  const a = await fixture(t, { startupTimeoutMs: 100 }), b = await fixture(t, { home: a.home });
  await a.daemon.start(credentials);
  const original = a.daemon.spawn;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => true; // kill requested, but OS has not confirmed exit/close.
  a.daemon.spawn = (file, args, options) => args[1] === 'stop' ? child : original(file, args, options);
  try {
    await assert.rejects(a.daemon.stop());
    await assert.rejects(b.daemon.start(credentials));
    assert.equal(b.calls.length, 0);
  } finally {
    a.daemon.spawn = original;
    child.emit('close', 1);
  }
  await a.daemon.stop();
  await b.daemon.start(credentials);
});
