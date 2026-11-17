import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeDaemon } from '../src/native/daemon.mjs';
import { CompactionService } from '../src/native/compaction.mjs';
import { ensureNative, stopNative } from '../src/native/index.mjs';
import { accountContinuity } from '../src/native/account-continuity.mjs';
import { checkpointStore } from '../src/native/checkpoints.mjs';

const credentials = { tunnelId: 'synthetic-tunnel', runtimeKey: 'synthetic-runtime-key', connectorId: 'synthetic-connector', linkId: 'synthetic-link' };
const sensitive = ['MAGPIE_NATIVE_CHECKPOINT_HOME', 'MAGPIE_NATIVE_CONTINUITY_ROOT', 'MAGPIE_NATIVE_CONTINUITY_PEERS', 'MAGPIE_NATIVE_CONTINUITY_POLICY'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function workspace(t, cleanup = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'continuity-daemon-'));
  const homes = ['a', 'b', 'c'].map(profile => join(root, 'accounts', profile));
  for (const home of homes) await mkdir(home, { recursive: true, mode: 0o700 });
  t.after(async () => { await cleanup(); assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { root, homes };
}

async function fixture(t, { peers = ['a'], env = {} } = {}) {
  let daemon;
  const { root, homes: [home, peer, excluded] } = await workspace(t, async () => { await daemon?.stop(); });
  // All I/O boundaries are inert: no process launch, socket bind or HTTP request.
  t.mock.method(CompactionService.prototype, 'listen', async function () {
    this.server = { address: () => ({ port: 43112 }) }; return this;
  });
  t.mock.method(CompactionService.prototype, 'stop', async function () { this.closed = true; });
  const calls = [], requests = [], servers = [];
  let responseGate;
  const spawn = (file, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    child.once('exit', () => { child.stdout.end(); child.stderr.end(); });
    calls.push({ file, args, options: { ...options, env: { ...options.env } }, child });
    if (args.includes('serve')) {
      assert.deepEqual(JSON.parse(readFileSync(join(home, 'continuity-policy.json'), 'utf8')).profiles, peers,
        'policy must be durable before the native server is spawned');
      servers.push(child);
    } else queueMicrotask(() => {
      child.stdout.end(JSON.stringify(args[1] === 'list' ? { aliases: [] } : { process_running: true, healthy: true, ready: true }));
      child.emit('close', 0);
    });
    return child;
  };
  const fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    requests.push({ url, options });
    if (url.endsWith('/healthz')) return Response.json({ service: 'codex-chatgpt-web', mode: 'full', accepting_turns: true });
    if (url.includes('/admin/')) {
      if (url.endsWith('/shutdown')) servers.at(-1).emit('exit', 0);
      return Response.json({ status: 'ok' });
    }
    assert.ok(url.endsWith('/v1/responses'));
    return responseGate ? responseGate.promise : new Response('synthetic response');
  };
  daemon = new NativeDaemon({ home, continuityPeers: peers, runtimeCommand: ['offline-bun', 'offline-cli'], tunnelBinary: 'offline-tunnel',
    chromeExecutablePath: 'offline-chrome', storageState: async () => ({ cookies: [], origins: [] }),
    capabilities: { solAvailable: true, proAvailable: true }, spawn, fetch, allocatePort: async () => 43111,
    startupTimeoutMs: 500, pollMs: 1, shutdownRequestTimeoutMs: 100, shutdownExitTimeoutMs: 100,
    diagnosticsFactory: () => ({ attach() {}, async close() {} }),
    env: { PATH: 'synthetic', CODEX_HOME: join(root, 'isolated-codex'), ...env } });
  daemon.ownerLock = { close(callback) { callback(); } }; // Test only policy/env, not the OS lease.
  return { root, home, peer, excluded, daemon, calls, requests, servers, holdResponse(gate) { responseGate = gate; } };
}

test('daemon startup persists its fixed policy and exposes storage authority only to the native server', async t => {
  const f = await fixture(t, { env: {
    MAGPIE_NATIVE_CHECKPOINT_HOME: 'untrusted-parent-home', MAGPIE_NATIVE_CONTINUITY_ROOT: 'untrusted-parent-root',
    MAGPIE_NATIVE_CONTINUITY_PEERS: '["untrusted-parent-peer"]', MAGPIE_NATIVE_CONTINUITY_POLICY: 'untrusted-parent-policy',
    OPENAI_API_KEY: 'never-inherit',
  } });
  await f.daemon.start(credentials);
  const server = f.calls.find(call => call.args.includes('serve'));
  assert.equal(server.options.env.MAGPIE_NATIVE_CHECKPOINT_HOME, f.home);
  assert.equal(server.options.env.MAGPIE_NATIVE_CONTINUITY_POLICY, join(f.home, 'continuity-policy.json'));
  assert.equal(server.options.env.MAGPIE_NATIVE_CONTINUITY_ROOT, undefined);
  assert.equal(server.options.env.MAGPIE_NATIVE_CONTINUITY_PEERS, undefined);
  assert.equal(server.options.env.OPENAI_API_KEY, undefined);
  assert.equal(server.options.windowsHide, true);
  assert.deepEqual(accountContinuity(f.home, server.options.env).peerHomes(), []);
  assert.ok(f.calls.some(call => call.args[1] === 'connect' && call.args.includes('--mcp-command')));
  for (const call of f.calls.filter(call => !call.args.includes('serve'))) {
    for (const name of sensitive) assert.equal(Object.hasOwn(call.options.env, name), false, name);
  }
  // Explicitly cover legacy env stripping in the same command path.
  f.daemon.childEnv.MAGPIE_NATIVE_CONTINUITY_ROOT = join(f.root, 'accounts');
  f.daemon.childEnv.MAGPIE_NATIVE_CONTINUITY_PEERS = '["a","b"]';
  await f.daemon.command(['runtimes', 'status', 'synthetic', '--json']);
  for (const name of sensitive) assert.equal(Object.hasOwn(f.calls.at(-1).options.env, name), false, name);
});

test('live configureContinuity updates the same reader/store while an active response finishes without replay or restart', async t => {
  const f = await fixture(t); await f.daemon.start(credentials);
  const launched = f.calls.find(call => call.args.includes('serve')), reader = accountContinuity(f.home, launched.options.env);
  const target = checkpointStore(f.home, { env: launched.options.env }), source = checkpointStore(f.peer, { env: {} });
  const thread = randomUUID(), turn = randomUUID(), key = JSON.stringify([thread, turn, 'gpt-5.6-sol', 'high']);
  const value = { summaryHash: hash('summary'), source: { turnId: turn, content: 'long task' },
    sourceHashes: new Set([hash([turn, 'long task'])]), sourceWasSyntheticInstruction: false };
  source.map.set(key, value); source.commit();
  assert.equal(target.lookup(key, 'summary'), undefined);
  const gate = deferred(); f.holdResponse(gate);
  const pending = f.daemon.responses({ model: 'chatgpt-web/gpt-5.6-sol', input: 'synthetic active request' }, {});
  const count = f.calls.length, config = f.daemon.config, child = f.daemon.child;
  const peers = ['a', 'b'], update = f.daemon.configureContinuity(peers); peers.push('../client-mutation'); await update;
  assert.equal(f.calls.length, count); assert.equal(f.daemon.child, child); assert.equal(f.daemon.config, config);
  assert.equal(f.daemon.ready, true); assert.equal(child.killed, undefined);
  assert.equal(f.requests.some(request => request.url.includes('/admin/')), false);
  assert.deepEqual(reader.peerHomes(), [f.peer]);
  assert.deepEqual(target.lookup(key, 'summary'), value);
  assert.equal(target.lookup(JSON.stringify([randomUUID(), turn, 'gpt-5.6-sol', 'high']), 'summary'), undefined);
  assert.equal(target.lookup(key, 'invented'), undefined);
  assert.deepEqual(f.daemon.continuityPeers, ['a', 'b']);
  assert.equal(launched.options.env.MAGPIE_NATIVE_CONTINUITY_POLICY, f.daemon.continuityEnv.MAGPIE_NATIVE_CONTINUITY_POLICY);
  gate.resolve(new Response('completed once'));
  assert.equal(await (await pending).text(), 'completed once');
  assert.equal(f.requests.filter(request => request.url.endsWith('/v1/responses')).length, 1);
});

test('invalid live policies reject before acknowledging configuration and preserve the running owner', async t => {
  const f = await fixture(t); await f.daemon.start(credentials);
  const before = await readFile(join(f.home, 'continuity-policy.json'));
  const child = f.daemon.child, count = f.calls.length, env = f.daemon.continuityEnv;
  for (const peers of [['b'], ['a', '../b'], ['a', 'a'], 'a', 'ab', null, {}, []]) await assert.rejects(f.daemon.configureContinuity(peers));
  assert.deepEqual(await readFile(join(f.home, 'continuity-policy.json')), before);
  assert.deepEqual(f.daemon.continuityPeers, ['a']);
  assert.equal(f.daemon.continuityEnv, env); assert.equal(f.daemon.child, child);
  assert.equal(f.calls.length, count); assert.equal(f.daemon.ready, true);
});

test('ensureNative awaits policy refresh before healthy-owner reuse and does not coalesce different peer snapshots', { timeout: 5000 }, async t => {
  const { root, homes: [home, b, c] } = await workspace(t, stopNative);
  await writeFile(join(home, 'native.json'), JSON.stringify({ ...credentials, profile: 'a' }), { mode: 0o600 });
  const events = [], gate = deferred(), entered = deferred();
  let installs = 0, created = 0, owner, block = false;
  const account = { profile: 'a', chromeExecutablePath: 'offline', context: { storageState: async () => ({ cookies: [], origins: [] }) } };
  const options = { root, resumeOnly: true, continuityPeers: ['a'], install: async () => { installs++; return {}; },
    createDaemon: settings => {
      created++;
      owner = { home: settings.home, continuityPeers: settings.continuityPeers, browserEndpoint: settings.browserEndpoint,
        configure() {}, async start() { await NativeDaemon.prototype.configureContinuity.call(this, this.continuityPeers); },
        async configureContinuity(peers) {
          events.push('policy-start:' + peers.join(','));
          if (block && peers.length === 2) { entered.resolve(); await gate.promise; }
          await NativeDaemon.prototype.configureContinuity.call(this, peers);
          events.push('policy-done:' + peers.join(','));
        },
        async health() { events.push('health'); return true; }, async stop() { events.push('stop'); } };
      return owner;
    } };
  assert.equal(await ensureNative(account, options), owner);
  const reader = accountContinuity(home, owner.continuityEnv);
  assert.deepEqual(reader.peerHomes(), []);
  block = true;
  const first = ensureNative(account, { ...options, continuityPeers: ['a', 'b'] });
  await entered.promise;
  const next = ensureNative(account, { ...options, continuityPeers: ['a', 'b', 'c'] });
  assert.notEqual(first, next);
  assert.deepEqual(events, ['policy-start:a,b']);
  assert.deepEqual(reader.peerHomes(), []);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, next]), [owner, owner]);
  assert.deepEqual(events, ['policy-start:a,b', 'policy-done:a,b', 'health', 'policy-start:a,b,c', 'policy-done:a,b,c', 'health']);
  assert.deepEqual(reader.peerHomes(), [b, c]); assert.equal(installs, 1); assert.equal(created, 1);
  await ensureNative(account, { ...options, continuityPeers: undefined });
  assert.deepEqual(reader.peerHomes(), [b, c], 'an absent authoritative snapshot must not silently narrow the policy');
  const before = events.length;
  await assert.rejects(ensureNative(account, { ...options, continuityPeers: ['b'] }), /continuity authority/);
  assert.deepEqual(events.slice(before), ['policy-start:b'], 'invalid policy must not return the existing healthy owner');
});
