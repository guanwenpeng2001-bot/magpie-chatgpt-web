import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serve } from '../backend/main.mjs';
import { BackendError } from '../backend/guard.mjs';
import { LoginStates } from '../backend/browser.mjs';

function harness(options) {
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
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const work = serve(input, output, options);
  return { input, frames, work,
    send: command => input.write(JSON.stringify(command) + '\n'),
    async until(predicate) {
      while (!predicate(frames)) await new Promise(resolve => waiters.push(resolve));
    },
  };
}

test('backend streams head/data/done and cancels a live handler on abort', async () => {
  const server = harness({ handlers: {
    complete: async (command, signal, emit) => {
      await emit({ text: 'fixture' });
      if (command.wait) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  } });
  server.send({ id: 'finished', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.id === 'finished' && frame.event === 'done'));
  assert.deepEqual(server.frames.filter(frame => frame.id === 'finished').map(frame => frame.event), ['head', 'data', 'done']);
  server.send({ id: 'cancelled', method: 'complete', wait: true });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'data'));
  server.send({ id: 'cancelled', method: 'abort' });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'error'));
  assert.equal(server.frames.some(frame => frame.id === 'cancelled' && frame.event === 'done'), false);
  server.input.end();
  await server.work;
});

test('the serve request budget expires as its own typed error, not upstream', async () => {
  const server = harness({ timeout: 50, handlers: {
    async complete(command, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new BackendError('upstream')), { once: true });
      });
    },
  } });
  server.send({ id: 'budget', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.id === 'budget' && frame.event === 'error'));
  const frame = server.frames.find(frame => frame.id === 'budget' && frame.event === 'error');
  assert.equal(frame.error.status, 504);
  assert.notEqual(frame.error.message, new BackendError('upstream').message);
  assert.equal(BackendError.fromEnvelope(frame.error).code, 'requestBudget');
  server.input.end();
  await server.work;
});

test('a client abort command still cancels without the budget code', async () => {
  const server = harness({ timeout: 60000, handlers: {
    async complete(command, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new BackendError('upstream')), { once: true });
      });
    },
  } });
  server.send({ id: 'cancelled', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'head'));
  server.send({ id: 'cancelled', method: 'abort' });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'error'));
  const frame = server.frames.find(frame => frame.id === 'cancelled' && frame.event === 'error');
  assert.notEqual(BackendError.fromEnvelope(frame.error).code, 'requestBudget');
  server.input.end();
  await server.work;
});

test('stdin EOF aborts work and disposes owned resources', async () => {
  let aborted = false;
  let disposed = false;
  const server = harness({
    close: async () => { disposed = true; },
    handlers: { complete: async (command, signal, emit) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await emit({ text: 'waiting' });
      await new Promise(() => {});
    } },
  });
  server.send({ id: 'active', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.event === 'data'));
  server.input.end();
  await server.work;
  assert.equal(aborted, true);
  assert.equal(disposed, true);
});

test('request timeout emits a sanitized error without success', async () => {
  const server = harness({ timeout: 10, handlers: { complete: () => new Promise(() => {}) } });
  server.send({ id: 'timeout', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.event === 'error'));
  server.input.end();
  await server.work;
  assert.equal(server.frames.some(frame => frame.event === 'done'), false);
  assert.equal(server.frames.at(-1).error.status, 504);
});

test('backend bounds active executions to sixteen and drains on EOF', async () => {
  let active = 0;
  const server = harness({ handlers: { complete: async (command, signal, emit) => {
    active++;
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await emit({ active });
    await aborted;
    active--;
  } } });
  for (let index = 0; index < 20; index++) server.send({ id: `request-${index}`, method: 'complete' });
  await server.until(frames => frames.filter(frame => frame.event === 'data').length === 16);
  assert.equal(active, 16);
  server.input.end();
  await server.work;
  assert.equal(active, 0);
});

test('login commands keep polling status pending and resolve through the flow', async () => {
  let resolveFlow;
  const server = harness({ loginFlow: () => new Promise(resolve => { resolveFlow = resolve; }) });
  server.send({ id: 'login-start', method: 'login', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-start' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-start' && frame.event === 'data').data, { ok: true });
  server.send({ id: 'login-poll', method: 'loginStatus', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-poll' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-poll' && frame.event === 'data').data, { state: 'pending' });
  resolveFlow({ state: 'signed-in', credential: { profile: 'fixture' } });
  server.send({ id: 'login-final', method: 'loginStatus', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-final' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-final' && frame.event === 'data').data, { state: 'signed-in', credential: { profile: 'fixture' } });
  server.input.end();
  await server.work;
});

for (const [label, line] of [
  ['unparseable', '{not json\n'], ['blank', '\n'],
  ['invalid id', '{"id":"bad:id","method":"models"}\n'],
  ['missing id', '{"method":"models"}\n'],
  ['duplicate id', '{"id":"active","method":"complete"}\n'],
]) test(`bad input ${label} preserves concurrent work`, { timeout: 2000 }, async t => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const server = harness({ handlers: { complete: async () => { await held; return true; } } });
  t.after(async () => { finish(); server.input.end(); await server.work; });
  server.send({ id: 'active', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.id === 'active'));
  server.input.write(line);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.input.destroyed, false);
  server.send({ id: 'later', method: 'loginStatus' });
  await server.until(frames => frames.some(frame => frame.id === 'later' && frame.event === 'done'));
  finish();
  await server.until(frames => frames.some(frame => frame.id === 'active' && frame.event === 'done'));
  assert.equal(server.frames.filter(frame => frame.id === 'active' && frame.event === 'head').length, 1);
});

test('login state polling represents all four states without arbitrary error text', () => {
  const states = new LoginStates();
  assert.deepEqual(states.start('fixture'), { state: 'pending' });
  assert.deepEqual(states.finish('fixture', 'signed-in', { profile: 'fixture' }), { state: 'signed-in', credential: { profile: 'fixture' } });
  assert.equal(states.finish('fixture', 'failed').state, 'failed');
  assert.equal(states.finish('fixture', 'cancelled').state, 'cancelled');
});

for (const rejected of [false, true]) test(`browser fallback reconciles rotated credentials before navigation (expired=${rejected})`, async () => {
  const { EventEmitter } = await import('node:events');
  const { BrowserSupervisor } = await import('../backend/browser.mjs');
  const context = new EventEmitter();
  let stored = [{ name: '__Secure-next-auth.session-token', value: 'prior', domain: 'chatgpt.com', path: '/' }];
  let writes = 0;
  const sent = [];
  context.pages = () => [];
  context.close = async () => context.emit('close');
  context.cookies = async () => stored;
  context.clearCookies = async () => { stored = []; };
  context.addCookies = async cookies => { stored = cookies; writes++; };
  context.newPage = async () => ({
    goto: async () => { sent.push(stored.map(cookie => cookie.value).join('')); },
    url: () => 'https://chatgpt.com/', close: async () => {},
    evaluate: async () => ({ status: rejected ? 401 : 200, headers: {}, body: JSON.stringify({ models: [{ slug: 'auto', title: 'Auto' }] }) }),
  });
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  const server = harness({
    turnDriver: { browser, close: () => browser.close() },
    readClient: ({ browserRoute, guard }) => ({ guard, models: signal => browserRoute('/backend-api/models', signal, new URL('https://chatgpt.com')) }),
  });
  try {
    for (const [id, refresh] of [['prior', '__Secure-next-auth.session-token=prior'], ['rotated', '__Secure-next-auth.session-token=rotated-secret'], ['unchanged', '__Secure-next-auth.session-token=rotated-secret']]) {
      server.send({ id, method: 'models', profileRoot: '.', auth: { profile: 'fixture', refresh } });
      await server.until(frames => frames.some(frame => frame.id === id && ['done', 'error'].includes(frame.event)));
    }
    assert.deepEqual(sent, ['prior', 'rotated-secret', 'rotated-secret']);
    assert.equal(writes, 1);
    assert.equal(server.frames.filter(frame => frame.event === 'error').length, rejected ? 3 : 0);
    if (rejected) for (const frame of server.frames.filter(frame => frame.event === 'error')) assert.equal(BackendError.fromEnvelope(frame.error).code, 'expired');
    assert.equal(JSON.stringify(server.frames).includes('rotated-secret'), false);
  } finally { server.input.end(); await server.work; }
});

test('session command renews over the read client without starting login', async () => {
  const accessToken = crypto.randomUUID();
  const expires = Date.now() + 10 * 86400000;
  let logins = 0;
  const server = harness({ loginFlow: async () => { logins++; }, readClient: () => ({ session: async () => ({ accessToken, expires: new Date(expires).toISOString() }) }) });
  server.send({ id: 'renew', method: 'session', auth: { refresh: crypto.randomUUID(), profile: 'fixture' } });
  await server.until(frames => frames.some(frame => frame.id === 'renew' && frame.event === 'done'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'renew' && frame.event === 'data').data, { access: accessToken, expires });
  assert.equal(logins, 0);
  server.input.end();
  await server.work;
});
