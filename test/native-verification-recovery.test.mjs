import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeVerificationRecovery, serve } from '../backend/main.mjs';
import { BrowserSupervisor } from '../backend/browser.mjs';
import { BackendError, Bridge } from '../src/bridge.mjs';
import { nativeClient } from '../src/native/index.mjs';
import { makeLoader } from '../src/loader.mjs';
import { prepare, complete } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';

const profileRoot = join(tmpdir(), 'native-verification-fixture'); // Virtual: never opened on disk.
const auth = { type: 'oauth', profile: 'repair-fixture', refresh: 'fixture-cookie' };
const descriptor = { port: 12345, controlToken: 'fixture-control', compaction: { port: 12346, controlToken: 'fixture-compaction' } };
const security = { code: 'chatgpt_security_check', type: 'permission_error', message: '人工验证 fixture', retryable: false };
const created = { type: 'response.created', response: { output: [] } };
const failed = { type: 'response.failed', response: { output: [], retryable: false, error: security } };
const frame = event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

function browserFixture(t, { navigate = async () => {}, move = true } = {}) {
  const events = [], contexts = [];
  const browser = new BrowserSupervisor({ profileRoot, headless: false, idleMilliseconds: null,
    async launch(path, options) {
      events.push(['launch', path, options]);
      const context = new EventEmitter();
      const pages = [];
      context.pages = () => pages.filter(page => !page.isClosed());
      context.newPage = async () => {
        const page = { closed: false, location: 'about:blank', visits: [], fronts: 0,
          isClosed() { return this.closed; }, url() { return this.location; },
          async goto(url, options) { this.visits.push([url, options]); this.location = url; await navigate(this); },
          async bringToFront() { this.fronts++; }, async close() { this.closed = true; },
        };
        pages.push(page);
        events.push(['page', path, page]);
        return page;
      };
      context.newCDPSession = async () => ({
        async send(method, params) {
          if (!move) throw new Error('fixture window unavailable');
          if (method === 'Browser.getWindowForTarget') return { windowId: contexts.length, bounds: { left: -32000, top: -32000 } };
          events.push(['window', path, params.bounds]);
          return {};
        }, async detach() {},
      });
      context.cookies = async () => [{ name: '__Secure-next-auth.session-token', value: 'human-refreshed', domain: 'chatgpt.com', path: '/' }];
      context.clearCookies = context.addCookies = async () => assert.fail('reveal must not change session cookies');
      context.close = async () => { events.push(['close', path]); for (const page of pages) await page.close(); context.emit('close'); };
      contexts.push(context);
      return context;
    },
  });
  t.after(() => browser.close());
  return { browser, contexts, events, pages: () => contexts.flatMap(context => context.pages()),
    driver: { browser, close: () => browser.close() } };
}

function clientFixture(fetch, { bridgeCall, profile = auth.profile } = {}) {
  const commands = [];
  const client = nativeClient({ profileRoot,
    bridge: { async call(command, signal) {
      commands.push(command);
      if (bridgeCall) return bridgeCall(command, signal);
      return command.method === 'nativeRuntime' ? descriptor : { shown: true };
    } }, fetch,
  });
  return { client, commands, auth: { ...auth, profile }, reveals: () => commands.filter(command => command.method === 'nativeVerification') };
}

function capturedRequest(t) {
  const model = `native/${auth.profile}/gpt-6-sol`;
  const body = { model: `chatgpt-web/${model}`, input: [{ role: 'user', content: 'fixture turn; never replay' }] };
  const context = { protocol: 'responses', origin: 'local', state: {} };
  prepare(body, context);
  t.after(() => complete(context.state.webGptNonce));
  body.model = model;
  onProvider(body, { provider: { id: 'chatgpt-web', model } });
  return body;
}

function backendBridge(t, options) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); },
  });
  let server;
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, options);
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  t.after(async () => { await bridge.dispose(); await server; });
  return bridge;
}

test('login RPC forwards preservePages only for literal true', async t => {
  const options = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); },
  });
  let server;
  const browser = {};
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, {
      turnDriver: { browser, close: async () => {} },
      loginFlow: async (_account, _signal, _root, value) => { options.push(value); return { state: 'cancelled' }; },
    });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  t.after(async () => { await bridge.dispose(); await server; });
  const values = [true, false, 'true', 1, undefined, null];
  for (const [index, preservePages] of values.entries()) {
    await bridge.call({ method: 'login', account: `fixture-${index}`, profileRoot, proxy: 'fixture-proxy', preservePages });
  }
  assert.deepEqual(options.map(value => value.preservePages), [true, false, false, false, false, false]);
  assert.ok(options.every(value => value.browser === browser && value.proxy === 'fixture-proxy'));
});

test('real bridge and supervisor reveal the original profile after the runtime lease, with no replay or cookie import', async t => {
  const b = browserFixture(t);
  let server, leaseEnded = false, posts = 0, verified = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); },
  });
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, { turnDriver: b.driver,
      readClient() { assert.fail('presentation must not discover models, log in or provision'); },
      handlers: { async nativeRuntime(command, signal) {
        leaseEnded = false;
        const result = await b.browser.run(command.auth.profile, async context => {
          // Stand in for the loopback daemon's existing generation page.
          if (!context.pages().length) { const page = await context.newPage(); page.location = 'https://chatgpt.com/c/already-submitted'; }
          return descriptor;
        }, signal);
        leaseEnded = true;
        return result;
      } },
    });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  t.after(async () => { await bridge.dispose(); await server; });
  const native = nativeClient({ bridge, profileRoot, fetch: async (url, init) => {
    assert.equal(leaseEnded, true);
    if (url.endsWith('/healthz')) return Response.json({ service: 'codex-chatgpt-web', mode: 'full' });
    posts++;
    assert.equal(init.method, 'POST');
    return verified ? Response.json({ id: 'completed-fixture', status: 'completed', output: [] }) : sse(frame(created) + frame(failed));
  } });
  const loader = await makeLoader({ bridge: { open() { assert.fail('no text fallback or replay'); } }, native })(async () => auth);
  const request = capturedRequest(t);
  const response = await loader.fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify(request) });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
  assert.equal((await response.json()).error.code, security.code);
  assert.equal(posts, 1);
  assert.equal(b.events.filter(event => event[0] === 'launch').length, 1);
  assert.equal(b.events[0][1], join(profileRoot, auth.profile));
  assert.equal(b.events.some(event => event[0] === 'close'), false);
  const [generation, verification] = b.pages();
  assert.equal(generation.location, 'https://chatgpt.com/c/already-submitted');
  assert.equal(generation.visits.length, 0);
  assert.deepEqual(verification.visits, [['https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 10_000 }]]);
  assert.ok(verification.fronts > 0);
  assert.ok(b.events.some(event => event[0] === 'window' && event[2].left === 80));

  // Only a later caller request runs again. Human-updated state stays in this
  // same context; reveal itself never claims that the challenge has passed.
  verified = true;
  const runtime = await native.runtime(auth);
  const next = await runtime.responses({ input: 'next explicit fixture request' });
  assert.equal((await next.json()).status, 'completed');
  assert.equal(posts, 2);
  assert.equal(b.contexts.length, 1);
  assert.equal(b.pages().length, 2);
});

test('backend coalesces concurrent/repeated refusals, retains visibility and throttles reopening a closed page', async t => {
  const gate = deferred(), started = deferred();
  const b = browserFixture(t, { navigate: async () => { started.resolve(); await gate.promise; } });
  let now = 0;
  const recovery = createNativeVerificationRecovery(root => { assert.equal(root, profileRoot); return b.driver; }, { now: () => now });
  const command = { profileRoot, auth, url: 'https://untrusted.invalid/', origin: 'https://untrusted.invalid/' };
  const pending = Array.from({ length: 12 }, () => recovery.reveal(command));
  await started.promise;
  assert.equal(b.pages().length, 1);
  assert.equal(recovery.visible(command), true);
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), Array(12).fill({ shown: true }));
  const page = b.pages()[0], fronts = page.fronts;
  for (let n = 0; n < 7; n++) assert.deepEqual(await recovery.reveal(command), { shown: true });
  assert.equal(page.visits.length, 1);
  assert.equal(page.visits[0][0], 'https://chatgpt.com/');
  assert.equal(page.fronts, fronts);
  assert.equal(b.contexts.length, 1);
  now += 60_000;
  await recovery.reveal(command);
  assert.ok(page.fronts > fronts, 'a later refusal can foreground the same page again');
  assert.equal(page.visits.length, 1);
  await page.close();
  assert.equal(recovery.visible(command), false);
  assert.deepEqual(await recovery.reveal(command), { shown: false });
  now += 60_000;
  assert.deepEqual(await recovery.reveal(command), { shown: true });
  assert.equal(b.events.filter(event => event[0] === 'page').length, 2);
});

test('same account in different roots and different profiles never share a verification page', async t => {
  const a = browserFixture(t), b = browserFixture(t);
  const otherRoot = join(tmpdir(), 'native-verification-other');
  const recovery = createNativeVerificationRecovery(root => root === profileRoot ? a.driver : b.driver);
  for (const [root, profile] of [[profileRoot, 'repair'], [profileRoot, 'new-signin'], [otherRoot, 'repair']]) {
    await recovery.reveal({ profileRoot: root, auth: { profile } });
  }
  assert.equal(a.contexts.length, 2);
  assert.equal(b.contexts.length, 1);
  assert.notEqual(a.pages()[0], b.pages()[0]);
});

test('browserProfile selects the physical directory and deduplicates it across logical Native identities', async t => {
  const b = browserFixture(t);
  const recovery = createNativeVerificationRecovery(() => b.driver);
  const logical = { profileRoot, auth: { ...auth, browserProfile: 'verified-browser-fixture' } };
  await recovery.reveal(logical);
  await recovery.reveal({ ...logical, auth: { ...logical.auth, profile: 'other-native-identity' } });
  assert.equal(b.contexts.length, 1);
  assert.equal(b.pages().length, 1);
  assert.equal(b.events[0][1], join(profileRoot, 'verified-browser-fixture'));
  assert.equal(recovery.visible(logical), true);
  assert.equal(recovery.visible({ profileRoot, auth }), false, 'logical ID is not a second browser identity');
  await recovery.reveal({ ...logical, auth: { ...logical.auth, browserProfile: 'replacement-browser-fixture' } });
  assert.equal(b.contexts.length, 2);
  assert.equal(b.pages().length, 2);
});

test('Native proxy retains its logical account while recovery snapshots the verified physical browser', async () => {
  const h = clientFixture(async () => Response.json({ error: security }, { status: 403 }));
  const account = { ...h.auth, browserProfile: 'verified-browser-fixture' };
  const runtime = await h.client.runtime(account);
  assert.equal(h.commands[0].auth.profile, auth.profile);
  assert.equal(h.commands[0].auth.browserProfile, 'verified-browser-fixture');
  account.profile = 'changed-logical';
  account.browserProfile = 'changed-physical';
  const result = await runtime.responses({});
  assert.equal(result.status, 403);
  assert.deepEqual(h.reveals()[0].auth, { profile: auth.profile, browserProfile: 'verified-browser-fixture' });
  await result.body.cancel();
});

test('backend read routing, client isolation and session refresh preserve browserProfile independently of the Native ID', async t => {
  const browserProfiles = [], identities = [];
  let clients = 0;
  const bridge = backendBridge(t, {
    turnDriver: {
      browser: { async run(profile, operation) {
        browserProfiles.push(profile);
        return operation({ newPage: async () => ({
          async goto() {}, async close() {}, url: () => 'https://chatgpt.com/',
          evaluate: async () => ({ status: 200, headers: {}, body: JSON.stringify({ models: [] }) }),
        }) });
      } },
      async complete(command, _guard, identity, _signal, emit) { identities.push(identity); await emit({ type: 'finish', reason: 'complete' }); },
      async close() {},
    },
    readClient(options) {
      clients++;
      return { guard: options.guard, credential: options.cookie,
        models: signal => options.browserRoute('/backend-api/models', signal, new URL('https://chatgpt.com/')),
        session: async () => ({ accessToken: 'new-fixture-access', expires: new Date(Date.now() + 60_000).toISOString(), user: { email: 'fixture@example.test' } }),
      };
    },
  });
  const physical = { ...auth, browserProfile: 'verified-browser-fixture' };
  await bridge.call({ method: 'models', profileRoot, auth: physical });
  assert.deepEqual(browserProfiles, ['verified-browser-fixture']);
  const session = await bridge.call({ method: 'session', profileRoot, auth: physical });
  assert.equal(session.browserProfile, physical.browserProfile);
  assert.equal(session.access, 'new-fixture-access');
  for (const account of [auth, { ...auth, browserProfile: auth.profile }, physical, { ...physical, refresh: 'renewed-fixture-cookie' }]) {
    await bridge.call({ method: 'complete', profileRoot, auth: account, model: 'auto', history: [] });
  }
  assert.equal(identities[0], identities[1], 'default and explicit same browser share identity');
  assert.notEqual(identities[0], identities[2], 'physical rebind cannot reuse stale clients/conversations');
  assert.equal(identities[2], identities[3], 'cookie refresh keeps the same physical binding');
  assert.equal(clients, 3);
});

test('invalid profiles/roots and pre-aborted reveals cannot launch or navigate', async () => {
  const recovery = createNativeVerificationRecovery(() => assert.fail('invalid identity must not open a browser'));
  for (const command of [
    { profileRoot, auth: {} }, { profileRoot, auth: { profile: '../outside' } },
    { profileRoot, auth: { profile: 'a\\b' } }, { profileRoot, auth: { profile: '' } },
    { profileRoot, auth: { ...auth, browserProfile: '../outside' } },
    { profileRoot: '.', auth }, { profileRoot: 1, auth }, { profileRoot: profileRoot + '\0', auth },
  ]) await assert.rejects(recovery.reveal(command), { code: 'browserConfiguration' });
  await assert.rejects(recovery.reveal({ profileRoot, auth }, AbortSignal.abort()), { name: 'AbortError' });
  const h = clientFixture(() => assert.fail('invalid binding cannot reach transport'));
  await assert.rejects(h.client.runtime({ ...auth, browserProfile: '../outside' }), { code: 'browserConfiguration' });
  assert.equal(h.commands.length, 0);
});

test('navigation and reveal failures keep at most one page and never report verification success', async t => {
  for (const kind of ['navigation', 'window']) {
    const b = browserFixture(t, { move: kind !== 'window', navigate: async () => { throw new Error('fixture navigation failed'); } });
    const recovery = createNativeVerificationRecovery(() => b.driver);
    const command = { profileRoot, auth };
    await assert.rejects(recovery.reveal(command));
    for (let n = 0; n < 7; n++) {
      const result = await recovery.reveal(command);
      assert.equal(result.shown, kind === 'navigation');
      assert.equal(result.verified, undefined);
    }
    assert.equal(b.pages().length, 1);
    assert.equal(b.contexts.length, 1);
  }
});

for (const route of ['responses', 'compaction']) test(`${route}: typed JSON refusal retains its body and requests only the original profile`, async () => {
  const expected = JSON.stringify({ error: security });
  const requests = [];
  const h = clientFixture(async (url, init) => {
    requests.push([url, init]);
    return new Response(expected, { status: 403, headers: { 'content-type': 'application/json', 'x-request-id': 'unchanged' } });
  });
  const bound = { ...h.auth };
  const runtime = await h.client.runtime(bound);
  bound.profile = 'new-profile-after-request-start';
  const response = await runtime[route]({ input: 'original payload', stream: false }, {}, undefined, '/v1/responses/compact');
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-request-id'), 'unchanged');
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
  assert.equal(await response.text(), expected);
  assert.deepEqual(h.reveals(), [{ method: 'nativeVerification', profileRoot, auth: { profile: auth.profile } }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], route === 'responses' ? 'http://127.0.0.1:12345/v1/responses' : 'http://127.0.0.1:12346/v1/responses/compact');
  assert.equal(JSON.parse(requests[0][1].body).input, 'original payload');
  assert.equal(requests[0][1].headers.get('authorization'), route === 'responses' ? 'Bearer fixture-control' : 'Bearer fixture-compaction');
});

test('fragmented UTF-8 empty-prelude failure is revealed once and retains nonretryable HTTP 403 for compaction', async () => {
  const bytes = new TextEncoder().encode(frame(created) + frame(failed));
  let cancelled = false;
  const h = clientFixture(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await (await h.client.runtime(h.auth)).compaction({ input: 'fixture', stream: true });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal((await response.json()).error.message, security.message);
  assert.equal(h.reveals().length, 1);
  assert.equal(cancelled, true);
});

test('a typed refusal after tool/output events reveals without altering bytes/status or replaying', async () => {
  const prefix = frame(created) + frame({ type: 'response.output_item.added', item: { type: 'function_call', name: 'fixture_tool' } });
  const text = prefix + frame({ type: 'response.output_text.delta', delta: 'retained output' }) + frame(failed) + frame(failed);
  let posts = 0;
  const h = clientFixture(async () => { posts++; return sse(text); });
  const response = await (await h.client.runtime(h.auth)).responses({ input: 'fixture' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
  assert.equal(posts, 1);
  assert.equal(h.reveals().length, 1);
});

test('huge SSE data is forwarded with bounded inspection; a later typed event is still detected', async () => {
  const text = frame({ type: 'response.output_text.delta', delta: 'x'.repeat(180_000) }) + frame(failed);
  const h = clientFixture(async () => sse(text));
  const response = await (await h.client.runtime(h.auth)).responses({});
  assert.equal(await response.text(), text);
  assert.equal(h.reveals().length, 1);
});

test('generic/expired/rate-limit errors, HTML, model text and oversized JSON cannot trigger presentation', async () => {
  const samples = [
    () => Response.json({ error: { ...security, code: 'upstream_error' } }, { status: 403 }),
    () => Response.json({ error: { ...security, type: 'other_error' } }, { status: 403 }),
    () => Response.json({ error: security }, { status: 401 }),
    () => Response.json({ error: security }, { status: 429 }),
    () => new Response('verify you are human', { status: 403, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ padding: 'x'.repeat(65537), error: security }, { status: 403 }),
    () => sse(frame({ type: 'response.output_text.delta', delta: JSON.stringify(failed) })),
    () => sse('data: not valid JSON\n\n'),
  ];
  for (const sample of samples) {
    const original = sample(), expected = await original.clone().text();
    const h = clientFixture(async () => original);
    const result = await (await h.client.runtime(h.auth)).responses({});
    assert.equal(result.status, original.status);
    assert.equal(await result.text(), expected);
    assert.equal(h.reveals().length, 0);
  }
});

test('typed verification in a failed JSON response or missing retry metadata reveals the bound browser', async () => {
  for (const sample of [
    () => Response.json({ ...failed.response, status: 'failed', retryable: undefined }),
    () => sse(frame({ ...failed, response: { ...failed.response, retryable: undefined } })),
    () => sse(frame({ ...failed, response: { ...failed.response, retryable: true } })),
  ]) {
    const h = clientFixture(async () => sample());
    const response = await (await h.client.runtime(h.auth)).compaction({});
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal(h.reveals().length, 1);
  }
});

test('typed startup/transport exceptions are preserved; untyped errors never launch presentation', async () => {
  const typed = Object.assign(new Error('typed fixture'), { status: 403, code: security.code, errorType: security.type, retryable: false });
  for (const error of [new BackendError('verification'), typed, new BackendError('expired'), new Error('verification'), { code: 'verification' }]) {
    const h = clientFixture(async () => { throw error; }, { bridgeCall: async command => {
      if (command.method === 'nativeRuntime') throw error;
      return { shown: true };
    } });
    await assert.rejects(h.client.runtime(h.auth), value => value === error);
    assert.equal(h.reveals().length, error === typed || error instanceof BackendError && error.code === 'verification' ? 1 : 0);
  }
  const h = clientFixture(async () => { throw typed; });
  await assert.rejects((await h.client.runtime(h.auth)).responses({}), value => value === typed);
  assert.equal(h.reveals().length, 1);
});

test('a failed reveal RPC cannot change the refusal or submit a second request', async () => {
  let posts = 0;
  const h = clientFixture(async () => { posts++; return sse(frame(created) + frame(failed)); }, {
    bridgeCall: async command => {
      if (command.method === 'nativeRuntime') return descriptor;
      throw new BackendError('browserClosed');
    },
  });
  const response = await (await h.client.runtime(h.auth)).responses({});
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal((await response.json()).error.code, security.code);
  assert.equal(posts, 1);
  assert.equal(h.reveals().length, 1);
});

test('concurrent Native failures coalesce the presentation RPC, while accounts stay independent', async () => {
  const gate = deferred(), started = deferred();
  const h = clientFixture(async () => Response.json({ error: security }, { status: 403 }), {
    bridgeCall: async command => {
      if (command.method === 'nativeRuntime') return descriptor;
      started.resolve();
      await gate.promise;
      return { shown: true };
    },
  });
  const runtime = await h.client.runtime(h.auth);
  const other = await h.client.runtime({ ...h.auth, profile: 'other-fixture' });
  const work = [...Array.from({ length: 8 }, () => runtime.responses({})), other.responses({})];
  await started.promise;
  // Let all bounded error inspections reach the shared presentation operation.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.reveals().map(command => command.auth.profile).sort(), ['other-fixture', auth.profile].sort());
  gate.resolve();
  for (const response of await Promise.all(work)) assert.equal((await response.json()).error.code, security.code);
});

test('cancelling before submission or during the empty prelude cannot open a verification page', async () => {
  const controller = new AbortController(), started = deferred();
  let posts = 0, cancelled = false;
  const h = clientFixture(async () => {
    posts++;
    return new Response(new ReadableStream({
      start(output) { output.enqueue(new TextEncoder().encode(frame(created))); started.resolve(); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const runtime = await h.client.runtime(h.auth);
  await assert.rejects(runtime.responses({}, {}, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(posts, 0);
  const work = runtime.responses({}, {}, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(h.reveals().length, 0);
});

test('consumer cancellation forwards upstream and does not inspect unread failure events', async () => {
  let source, cancelled = false;
  const h = clientFixture(async () => new Response(new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: 'fixture' })));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await (await h.client.runtime(h.auth)).responses({});
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /fixture/);
  source.enqueue(new TextEncoder().encode(frame(failed)));
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(h.reveals().length, 0);
});
