import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeDaemon, daemonProxy } from '../src/native/daemon.mjs';
import { compactionProxy } from '../src/native/compaction.mjs';
import { isCompaction } from '../src/native/fallback.mjs';
import { makeLoader } from '../src/loader.mjs';
import { prepare, complete } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';

const turn = '11111111-1111-1111-1111-111111111111';
const metadata = { thread_id: 'fixture-thread', turn_id: turn, request_kind: 'compaction',
  compaction: { implementation: 'responses', strategy: 'memento' } };
const nativeModel = 'native/account-a/gpt-6-sol';
const input = [{ type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: 'Finish the task.' }],
  internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['user_message'] } }];
const body = () => ({ model: 'chatgpt-web/gpt-6-sol', stream: false, input: structuredClone(input),
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata), extra: 'keep' } });
const replacement = { output: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native checkpoint' }] }] };

async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('condition did not settle');
}

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-'));
  const calls = [], requests = [], children = [];
  let port = 45000;
  const daemon = new NativeDaemon({ home, runtimeCommand: ['C:/durable/bun.exe', 'C:/durable/cli.js'],
    tunnelBinary: 'C:/durable/tunnel.exe', chromeExecutablePath: 'C:/Chrome/chrome.exe',
    storageState: async () => ({ cookies: [{ name: 'fixture', value: 'account-a' }], origins: [] }),
    capabilities: { solAvailable: true }, compactionIdleMs: 25, startupTimeoutMs: 1000, pollMs: 1,
    env: { PATH: 'fixture', CODEX_HOME: 'not-inherited', OPENAI_API_KEY: 'not-inherited', TUNNEL_CLIENT_STATE_DIR: 'not-inherited' },
    allocatePort: async () => ++port,
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      calls.push({ file, args, options }); children.push(child);
      if (!args.includes('serve')) queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ process_running: true, healthy: true, ready: true })); child.emit('close', 0);
      });
      return child;
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/healthz')) return Response.json({ service: 'codex-chatgpt-web',
        mode: new URL(url).port === '45001' ? 'full' : 'browser-only', accepting_turns: true });
      if (url.includes('/admin/')) {
        if (url.endsWith('/shutdown')) {
          const index = calls.findLastIndex(call => call.args.includes('serve'));
          children[index].exited = true;
          children[index].emit('exit', 0);
        }
        return Response.json({ status: 'ok' });
      }
      return overrides.respond ? overrides.respond(url, options) : Response.json(replacement);
    }, ...overrides.settings });
  t.after(async () => { await daemon.stop(); await rm(home, { recursive: true, force: true }); });
  await daemon.start({ tunnelId: 'fixture', runtimeKey: 'fixture-secret' });
  const proxy = daemonProxy(JSON.parse(JSON.stringify(daemon.descriptor())));
  return { daemon, proxy, calls, requests, children, home };
}

test('serialized account descriptor compacts in the full daemon with shared ownership', async t => {
  const { daemon, proxy, calls, requests, home } = await fixture(t);
  const headers = { authorization: 'never-forward', cookie: 'never-forward',
    'x-codex-turn-metadata': JSON.stringify(metadata), 'x-codex-beta-features': 'fixture', session_id: 'session', conversation_id: 'conversation' };
  const result = await proxy.compaction(body(), headers, undefined, '/responses/compact');
  assert.deepEqual(await result.json(), replacement);
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
  assert.equal((await readdir(home)).includes('compaction'), false);
  assert.equal(calls.filter(call => call.args.includes('connect')).length, 1);
  const sent = requests.find(request => request.url.endsWith('/responses/compact'));
  assert.equal(new URL(sent.url).port, String(daemon.config.port));
  assert.equal(sent.options.headers.get('authorization'), `Bearer ${daemon.config.controlToken}`);
  assert.notEqual(daemon.compactionService.controlToken, daemon.config.controlToken);
  assert.equal(sent.options.headers.get('cookie'), null);
  for (const name of ['x-codex-turn-metadata', 'x-codex-beta-features', 'session_id', 'conversation_id']) {
    assert.equal(sent.options.headers.get(name), headers[name]);
  }
  assert.deepEqual(JSON.parse(sent.options.body), body());
});

test('concurrent compactions and later continuations keep the same owner beyond the former idle limit', async t => {
  const { daemon, proxy, calls, children, requests } = await fixture(t);
  await Promise.all(Array.from({ length: 5 }, async () => (await proxy.compaction(body())).text()));
  await delay(80);
  await (await proxy.compaction(body())).text();
  await (await daemon.responses({ ...body(), input: replacement.output })).text();
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
  assert.equal(children[0].killed, undefined);
  assert.equal(daemon.ready, true);
  assert.equal(requests.filter(request => request.url.includes('/admin/')).length, 0);
  assert.ok(requests.every(request => new URL(request.url).port === String(daemon.config.port)));
});

test('SSE streaming preserves response bytes and the owner for continuation', async t => {
  let finish;
  const first = 'event: response.created\ndata: {"native":true}\n\n';
  const last = 'event: response.completed\ndata: {"output":[{"type":"compaction","encrypted_content":"ocx1:ZmFrZQ=="}]}\n\n';
  const { daemon, proxy, children } = await fixture(t, { respond: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(first));
    finish = () => { controller.enqueue(new TextEncoder().encode(last)); controller.close(); };
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await proxy.compaction({ ...body(), stream: true }, undefined, undefined, '/v1/responses');
  const text = result.text();
  await delay(80);
  assert.equal(daemon.compactionService.active, 1);
  finish();
  assert.equal(await text, first + last);
  await eventually(() => daemon.compactionService.active === 0);
  assert.equal(children[0].killed, undefined);
});

test('disconnect aborts upstream without stopping the full daemon', async t => {
  let upstreamSignal;
  const { daemon, proxy, children } = await fixture(t, { respond: (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const controller = new AbortController();
  const result = await proxy.compaction({ ...body(), stream: true }, undefined, controller.signal, '/v1/responses');
  const reading = assert.rejects(result.text());
  controller.abort();
  await reading;
  await eventually(() => upstreamSignal.aborted && daemon.compactionService.active === 0);
  assert.equal(children[0].killed, undefined);
});

test('stopping the compaction endpoint aborts requests but leaves owner shutdown to its supervisor', async t => {
  let upstreamSignal;
  const { daemon, proxy, calls, children } = await fixture(t, { respond: (_url, { signal }) => {
    upstreamSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const request = proxy.compaction(body()).then(r => r.text()).catch(() => {});
  await eventually(() => upstreamSignal);
  const service = daemon.compactionService;
  await service.stop();
  await request;
  assert.equal(service.closed, true);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(children[0].killed, undefined);
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
  await assert.rejects(proxy.compaction(body()));
});

test('native compaction failures are returned unchanged without another owner or replay', async t => {
  const failure = { error: { type: 'invalid_request_error', code: 'compaction_control_unavailable' } };
  const { proxy, calls } = await fixture(t, { respond: () => Response.json(failure, { status: 409, headers: { 'retry-after': '3' } }) });
  const response = await proxy.compaction(body());
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.deepEqual(await response.json(), failure);
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
});

test('transport failure is terminal and never starts an isolated compactor', async t => {
  const { proxy, calls } = await fixture(t, { respond: () => { throw new Error('owner unavailable'); } });
  const response = await proxy.compaction(body());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'native_compaction_unavailable');
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
});

test('compaction endpoint authenticates and rejects non-compaction requests before spawning', async t => {
  const { daemon, calls } = await fixture(t);
  const descriptor = daemon.descriptor().compaction;
  const url = `http://127.0.0.1:${descriptor.port}/v1/responses`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  for (const [payload, status] of [['{}', 400], ['null', 400], ['broken', 400]]) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${descriptor.controlToken}` }, body: payload });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.equal(calls.filter(call => call.args.includes('serve')).length, 1);
});

test('proxy normalizes header-only metadata without mutating input, and restricts credentials', async () => {
  const original = { ...body(), client_metadata: { extra: 'keep' } };
  const snapshot = structuredClone(original);
  const signal = new AbortController().signal;
  const proxy = compactionProxy({ port: 12345, controlToken: 'local' }, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/v1/responses');
    assert.equal(options.signal, signal);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('cookie'), null);
    assert.deepEqual(JSON.parse(options.body).client_metadata, { extra: 'keep', 'x-codex-turn-metadata': JSON.stringify(metadata) });
    return Response.json({});
  });
  await proxy(original, { 'x-codex-turn-metadata': JSON.stringify(metadata), cookie: 'private' }, signal, '/responses');
  assert.deepEqual(original, snapshot);
  for (const port of [undefined, 0, 65536, '12/path']) assert.throws(() => compactionProxy({ port }));
});

for (const path of ['/v1/responses', '/v1/responses/compact']) {
  for (const representation of ['string', 'object', 'absent']) {
    test(`${path} preserves ${representation} canonical metadata through both compaction proxy hops`, async t => {
      const { proxy, requests } = await fixture(t);
      const request = { ...body(), model: `chatgpt-web/${nativeModel}` };
      if (representation === 'object') request.client_metadata['x-codex-turn-metadata'] = structuredClone(metadata);
      if (representation === 'absent') delete request.client_metadata['x-codex-turn-metadata'];
      const canonicalMetadata = request.client_metadata['x-codex-turn-metadata'];
      const context = { protocol: 'responses', origin: 'local', state: {} };
      prepare(request, context);
      t.after(() => complete(context.state.webGptNonce));
      request.model = nativeModel;
      for (const item of request.input) delete item.internal_chat_message_metadata_passthrough;
      onProvider(request, { provider: { id: 'chatgpt-web', model: nativeModel } });
      const vendorMetadata = JSON.stringify({ thread_id: 'vendor-thread', turn_id: 'vendor-turn', request_kind: 'turn' });
      request.client_metadata['x-codex-turn-metadata'] = vendorMetadata;
      const headers = { 'x-codex-turn-metadata': representation === 'absent' ? JSON.stringify(metadata) : vendorMetadata };
      const originalHeaders = { ...headers };
      const loader = await makeLoader({
        bridge: { open() { assert.fail('text fallback'); } },
        native: { runtime: async () => ({ compaction: proxy.compaction,
          health() { assert.fail('canonical compaction must be classified before health/normal routing'); },
          responses() { assert.fail('compaction cannot enter the normal endpoint'); } }) },
      })(async () => ({ type: 'oauth', refresh: 'fixture', profile: 'account-a' }));
      const response = await loader.fetch(`http://localhost${path}`, { body: JSON.stringify(request), headers });
      assert.equal(response.status, 200, await response.text());
      const sent = requests.find(request => request.url.endsWith(path));
      assert.ok(sent, 'the full daemon receives the compaction');
      assert.deepEqual(JSON.parse(sent.options.body).client_metadata, {
        extra: 'keep', 'x-codex-turn-metadata': canonicalMetadata ?? JSON.stringify(metadata),
      });
      assert.deepEqual(JSON.parse(sent.options.headers.get('x-codex-turn-metadata')), metadata);
      assert.deepEqual(headers, originalHeaders);
    });
  }
}

test('predicate recognizes endpoint, memento headers/body, and v2 trigger but not history checkpoints', () => {
  assert.equal(isCompaction({}, '/responses/compact'), true);
  assert.equal(isCompaction(body(), '/responses'), true);
  assert.equal(isCompaction({}, '/responses', { 'x-codex-turn-metadata': JSON.stringify(metadata) }), true);
  assert.equal(isCompaction({ client_metadata: { 'x-codex-turn-metadata': metadata } }, '/responses'), true);
  assert.equal(isCompaction({ input: [{ type: 'compaction_trigger' }] }, '/responses'), true);
  assert.equal(isCompaction({ input: [{ type: 'compaction', encrypted_content: 'ocx1:eA==' }] }, '/responses'), false);
  assert.equal(isCompaction({}, '/responses', { 'x-codex-turn-metadata': 'invalid' }), false);
});

for (const kind of ['v1', 'memento-body', 'memento-header', 'v2']) test(`loader routes ${kind} through the compaction endpoint without text replay`, async () => {
  const request = { ...body(), model: nativeModel };
  const headers = { 'x-codex-turn-metadata': JSON.stringify(metadata) };
  if (kind === 'memento-header' || kind === 'v2') delete request.client_metadata['x-codex-turn-metadata'];
  if (kind === 'v2') { request.input.push({ type: 'compaction_trigger' }); delete headers['x-codex-turn-metadata']; }
  const path = kind === 'v1' ? '/v1/responses/compact' : '/v1/responses';
  const signal = new AbortController().signal;
  const response = Response.json(replacement);
  const loader = await makeLoader({ bridge: { open() { assert.fail('text fallback'); } }, native: { runtime: async () => ({
    health() { assert.fail('compaction does not need full-mode health'); },
    responses() { assert.fail('full-mode response'); },
    async compaction(sent, sentHeaders, sentSignal, sentPath) {
      assert.deepEqual(sent, { ...request, model: 'chatgpt-web/gpt-6-sol' });
      assert.deepEqual(Object.fromEntries(sentHeaders), headers); assert.equal(sentSignal, signal); assert.equal(sentPath, path);
      return response;
    },
  }) } })(async () => ({ type: 'oauth', refresh: 'fixture', profile: 'account-a' }));
  assert.equal(await loader.fetch(`http://localhost${path}`, { body: JSON.stringify(request), headers, signal }), response);
});

test('loader restores proven canonical history before compaction', async () => {
  const request = { ...body(), model: `chatgpt-web/${nativeModel}` };
  const context = { protocol: 'responses', origin: 'local', state: {} };
  prepare(request, context);
  for (const item of request.input) delete item.internal_chat_message_metadata_passthrough;
  request.model = nativeModel;
  onProvider(request, { provider: { id: 'chatgpt-web', model: nativeModel } });
  try {
    const loader = await makeLoader({ native: { runtime: async () => ({ compaction: async sent => {
      assert.deepEqual(sent.input, input);
      assert.equal(sent.client_metadata['x-magpie-native-nonce'], undefined);
      return Response.json(replacement);
    } }) } })(async () => ({ type: 'oauth', refresh: 'fixture', profile: 'account-a' }));
    assert.equal((await loader.fetch('http://localhost/v1/responses/compact', { body: JSON.stringify(request) })).status, 200);
  } finally { complete(context.state.webGptNonce); }
});

test('loader never replays a failed compaction submission through text', async () => {
  const loader = await makeLoader({ bridge: { open() { assert.fail('must not replay'); } },
    native: { runtime: async () => ({ compaction: async () => { throw new Error('fixture'); } }) },
  })(async () => ({ type: 'oauth', refresh: 'fixture', profile: 'account-a' }));
  assert.equal((await loader.fetch('http://localhost/responses/compact', { body: JSON.stringify({ ...body(), model: nativeModel }) })).status, 502);
});
