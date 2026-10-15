import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from '../backend/main.mjs';
import { BackendError } from '../backend/guard.mjs';

function harness(t, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  const waiters = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const work = serve(input, output, options);
  t.after(async () => { input.end(); await work; });
  let sequence = 0;
  const until = async predicate => {
    while (!predicate()) await new Promise(resolve => waiters.push(resolve));
  };
  return { frames, until,
    async request(method, fields = {}) {
      const id = `request-${sequence++}`;
      input.write(JSON.stringify({ id, method, ...fields }) + '\n');
      await until(() => frames.some(frame => frame.id === id && ['done', 'error'].includes(frame.event)));
      return frames.filter(frame => frame.id === id);
    },
  };
}

test('discard drops the binding with only a conversation key', async t => {
  let discarded;
  const server = harness(t, { turnDriver: { bindings: { async discard(key) { discarded = key; } }, async close() {} } });
  const frames = await server.request('discard', { conversationKey: 'fixture' });
  assert.equal(frames.at(-1).event, 'done');
  assert.equal(discarded, 'fixture');
});

const auth = { refresh: 'fixture-cookie', profile: 'fixture' };
const complete = { auth, origin: 'http://127.0.0.1', model: 'fixture', history: [{ role: 'user', content: 'hello' }] };

test('handshake advertises protocol 3', async t => {
  const server = harness(t);
  await server.until(() => server.frames.length);
  assert.deepEqual(server.frames[0], { event: 'ready', protocol: 3 });
});

test('login acknowledges and forwards the proxy to the flow', async t => {
  let received;
  const server = harness(t, { loginFlow: async (...args) => {
    received = args;
    return { state: 'signed-in', credential: { profile: 'fixture' } };
  } });
  const reply = await server.request('login', { account: 'fixture', profileRoot: '/profiles', proxy: 'http://localhost:8080' });
  assert.deepEqual(reply.find(frame => frame.event === 'data').data, { ok: true });
  assert.deepEqual(received.slice(2), ['/profiles', { proxy: 'http://localhost:8080' }]);
  const status = await server.request('loginStatus', { account: 'fixture' });
  assert.equal(status.find(frame => frame.event === 'data').data.state, 'signed-in');
});

test('login window abort carries signinTimeout and preserves timeout reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const server = harness(t, { loginFlow: async (account, current) => {
    signal = current;
    await new Promise(resolve => current.addEventListener('abort', resolve, { once: true }));
    return { state: 'timeout', error: current.reason };
  } });
  await server.request('login');
  t.mock.timers.tick(299_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.reason.code, 'signinTimeout');
  const frames = await server.request('loginStatus');
  const status = frames.find(frame => frame.event === 'data').data;
  assert.equal(status.state, 'timeout');
  assert.match(status.reason, /within 5 minutes.*Start sign-in again/);
});

test('a rejected login abort preserves the reason as failed', async t => {
  const reason = new Error('Sign-in was interrupted. Start sign-in again.');
  reason.name = 'AbortError';
  const server = harness(t, { loginFlow: async () => { throw reason; } });
  await server.request('login');
  const frames = await server.request('loginStatus');
  assert.deepEqual(frames.find(frame => frame.event === 'data').data, { state: 'failed', reason: reason.message });
});

test('flow timeout passes through without being rewritten to failed', async t => {
  const error = new BackendError('signinTimeout', { values: { windowMinutes: 5 } });
  const server = harness(t, { loginFlow: async () => ({ state: 'timeout', error }) });
  await server.request('login');
  const frames = await server.request('loginStatus');
  assert.deepEqual(frames.find(frame => frame.event === 'data').data, { state: 'timeout', reason: error.message });
});

test('flow failure preserves its actionable reason', async t => {
  const reason = 'The sign-in page could not be loaded. Check the network/proxy and retry sign-in.';
  const server = harness(t, { loginFlow: async () => ({ state: 'failed', reason }) });
  await server.request('login');
  const frames = await server.request('loginStatus');
  assert.deepEqual(frames.find(frame => frame.event === 'data').data, { state: 'failed', reason });
});

test('logout cancels pending sign-in and ignores late success', async t => {
  let signal;
  let finish;
  const server = harness(t, { loginFlow: (account, current) => {
    signal = current;
    return new Promise(resolve => { finish = resolve; });
  } });
  await server.request('login');
  const logout = await server.request('logout');
  finish({ state: 'signed-in', credential: { profile: 'stale' } });
  assert.equal(signal.aborted, true);
  assert.deepEqual(logout.find(frame => frame.event === 'data').data, { ok: true });
  const status = await server.request('loginStatus');
  assert.deepEqual(status.find(frame => frame.event === 'data').data, { state: 'cancelled' });
});

test('complete accepts the prepared seam without prompt and retains route metadata', async t => {
  const server = harness(t, { turnDriver: {
    async complete(command, guard, identity, signal, emit) {
      assert.equal(command.prompt, undefined);
      assert.equal(typeof identity, 'string');
      await emit({ type: 'delta', index: 0, text: 'hello' });
      await emit({ type: 'finish', reason: 'complete' });
      return { route: 'dom', degraded: 'clone-unavailable' };
    },
    async close() {},
  } });
  const frames = await server.request('complete', complete);
  assert.deepEqual(frames.map(frame => frame.event), ['head', 'data', 'data', 'done']);
  assert.deepEqual(frames.at(-1), { id: frames[0].id, event: 'done', route: 'dom', degraded: 'clone-unavailable' });
});

test('normalized cooldown errors retain the real retry window', async t => {
  const server = harness(t, { turnDriver: {
    async complete(command, guard, identity, signal, emit) {
      await emit({ type: 'error', code: 'cooldown', message: new BackendError('cooldown').message, retryAfter: 237 });
    },
    async close() {},
  } });
  const frames = await server.request('complete', complete);
  assert.equal(frames.find(frame => frame.event === 'data').data.retryAfter, 237);
});

for (const images of [Array(5).fill({ mediaType: 'image/png', dataBase64: 'YQ==', bytes: 1 }), [{ mediaType: 'image/png', dataBase64: 'YQ==', bytes: 10 * 1024 * 1024 + 1 }], [{ mediaType: 'application/pdf', dataBase64: 'YQ==', bytes: 1 }]]) {
  test('complete rejects invalid images before the driver', async t => {
    let called = false;
    const server = harness(t, { turnDriver: { async complete() { called = true; }, async close() {} } });
    const frames = await server.request('complete', { ...complete, prompt: 'legacy', images });
    assert.equal(called, false);
    assert.equal(frames.at(-1).error.code, 'attachmentUnsupported');
    assert.doesNotMatch(frames.at(-1).error.message, /\{\w+\}/);
  });
}

test('session explicitly opts out of browser fallback and caps stalled clients at 10 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let options;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const server = harness(t, { readClient: () => ({ session(current, settings) {
    signal = current;
    options = settings;
    entered();
    return new Promise(() => {});
  } }) });
  const response = server.request('session', { auth });
  await started;
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(options, { interactive: false });
  const frames = await response;
  assert.equal(BackendError.fromEnvelope(frames.at(-1).error).code, 'requestBudget');
});

for (const missing of ['dependency', 'node']) test(`startup names missing ${missing} and remedy`, async () => {
  const loader = `export function resolve(specifier, context, next) { if (specifier === 'playwright-core') throw new Error('masked dependency'); return next(specifier, context); }`;
  const bootstrap = missing === 'dependency'
    ? `import { register } from 'node:module'; register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);`
    : `Object.defineProperty(process.versions, 'node', {value: '18.0.0'});`;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(bootstrap), 'backend/main.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  const frames = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].code, 'missingComponent');
  assert.equal(frames[0].component, missing === 'dependency' ? 'plugin dependency' : 'Node.js >= 20');
  assert.match(frames[0].remedy, /[Ii]nstall/);
  assert.doesNotMatch(frames[0].detail, /\{\w+\}/);
});

test('session challenge never calls the browser route', async t => {
  const http = createServer((request, response) => {
    response.writeHead(403, { 'cf-mitigated': 'challenge' });
    response.end('challenge');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  let browsers = 0;
  const server = harness(t, { turnDriver: { browser: { async run() { browsers++; throw new Error('browser forbidden'); } }, async close() {} } });
  const frames = await server.request('session', { auth, origin: `http://127.0.0.1:${http.address().port}` });
  assert.equal(BackendError.fromEnvelope(frames.at(-1).error).code, 'verification');
  assert.equal(browsers, 0);
});

test('thrown cooldown retains retryAfter in the terminal envelope', async t => {
  const server = harness(t, { turnDriver: {
    async complete() { throw new BackendError('cooldown', { retryAfter: 237 }); }, async close() {},
  } });
  const frames = await server.request('complete', complete);
  assert.equal(frames.at(-1).event, 'error');
  assert.equal(frames.at(-1).error.retryAfter, '237');
});

test('shortened sign-in window names its actual duration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = harness(t, { signinTimeout: 60_000, loginFlow: async (account, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { state: 'timeout', error: signal.reason };
  } });
  await server.request('login');
  t.mock.timers.tick(60_000);
  const frames = await server.request('loginStatus');
  assert.equal(frames.find(frame => frame.event === 'data').data.state, 'timeout');
  assert.match(frames.find(frame => frame.event === 'data').data.reason, /within 1 minutes.*Start sign-in again/);
});
