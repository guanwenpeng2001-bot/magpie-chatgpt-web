import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard, BackendError } from '../backend/guard.mjs';
import { translate } from '../src/wire/translate.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { AnswerStream } from '../src/wire/translate.mjs';
import { siteAdapterHtml } from '../integrations/turn-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Bridge } from '../src/bridge.mjs';
import { serve } from '../backend/main.mjs';

const command = (extra = {}) => ({ auth: { profile: 'fixture', refresh: 'next-auth.session-token=fixture' }, model: 'auto', history: [{ role: 'user', content: 'first' }], ...extra });
const guard = () => new AccountGuard({ sleep: async () => {} });
function harness(options = {}) {
  const calls = [];
  const pages = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    cookies: async () => [{ name: 'next-auth.session-token', value: 'fixture' }],
    exposeBinding: async () => {}, addInitScript: async () => {},
    async newPage() {
      const page = {
        closed: false, isClosed() { return this.closed; },
        async close() { this.closed = true; calls.push('close'); },
        async goto() { calls.push('navigate'); },
        async evaluate() {},
        locator() { return { filter() { return this; }, async fill(text) { calls.push(['fill', text]); }, async press() { calls.push('submit'); } }; },
      };
      pages.push(page);
      return page;
    },
    async close() { for (const page of pages) await page.close(); this.emit('close'); },
  });
  const adapter = {
    async assertTemporaryChat() { calls.push('temporary'); return true; },
    async probePageError() { calls.push('probe'); return null; },
    async readComposer() { calls.push('composer'); return { ok: true }; },
    async selectModel() { calls.push('model'); return { ok: true }; },
    async attachImages(page, images) { calls.push(['images', images]); return { ok: true }; },
    ...options.adapter,
  };
  const driver = new TurnDriver({ profileRoot: '/fixture', launch: async () => context, adapter,
    observe: async () => ({ text: 'answer', route: 'dom' }), ...options, adapter });
  const complete = (request = command(), accountGuard = guard(), signal = new AbortController().signal) => {
    const frames = [];
    return driver.complete(request, accountGuard, 'fixture', signal, frame => frames.push(frame)).then(result => ({ frames, result }));
  };
  return { driver, calls, pages, context, complete };
}

test('real page interstitial takes precedence over rate limit and sign-in', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; t.skip('playwright-core is not installed'); return; }
  const root = await mkdtemp(join(tmpdir(), 'turn-precedence-'));
  const driver = new TurnDriver({ profileRoot: root, launch: async (profile, options) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, serviceWorkers: 'block' });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: siteAdapterHtml({ challenge: 'title', rate: 'Rate limit', signIn: true, composer: 'none' }) }));
    return context;
  } });
  try {
    await assert.rejects(driver.complete(command(), guard(), 'fixture', new AbortController().signal, () => {}), { code: 'verification' });
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

test('rendered DOM supersedes stream markdown in AnswerStream', () => {
  const answer = new AnswerStream();
  answer.accept({ event: 'answer', data: { text: '**bold**' } });
  answer.accept({ event: 'dom', data: { text: 'bold', complete: true } });
  answer.finish();
  assert.equal(answer.text, 'bold');
});

test('driver compiles history, attaches images and returns normalized rendered output', async () => {
  const image = { mediaType: 'image/png', dataBase64: 'eA==', bytes: 1 };
  const h = harness();
  try {
    const { frames, result } = await h.complete(command({ images: [image] }));
    assert.deepEqual(h.calls.filter(value => typeof value === 'string').slice(0, 7), ['navigate', 'probe', 'temporary', 'probe', 'composer', 'model', 'submit']);
    assert.deepEqual(h.calls.find(value => value[0] === 'images'), ['images', [image]]);
    assert.deepEqual(h.calls.find(value => value[0] === 'fill'), ['fill', '[Human]\nfirst']);
    assert.deepEqual(frames, [{ type: 'delta', index: 0, text: 'answer' }, { type: 'finish', reason: 'complete' }]);
    assert.equal(result.route, 'dom');
  } finally { await h.driver.close(); }
});

for (const [kind, code, detail] of [
  ['picker-missing', 'pickerMissing', { component: 'picker', selector: '[picker]', adapterVersion: 'fixture' }],
  ['picker-ambiguous', 'pickerAmbiguous', { slug: 'model', count: 2 }],
  ['model-not-offered', 'modelNotOffered', { slug: 'model' }],
]) test(`picker ${kind} maps to ${code} with populated slots`, async () => {
  const h = harness({ adapter: { selectModel: async () => ({ ok: false, kind, detail }) } });
  try { await assert.rejects(h.complete(), error => error.code === code && !/\{\w+\}/.test(error.message)); }
  finally { await h.driver.close(); }
});

test('prefix-matching second turn sends only new history', async () => {
  const h = harness();
  try {
    await h.complete(command({ conversationKey: 'session' }));
    await h.complete(command({ conversationKey: 'session', history: [...command().history, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'second' }] }));
    assert.deepEqual(h.calls.filter(value => value[0] === 'fill'), [['fill', '[Human]\nfirst'], ['fill', '[Human]\nsecond']]);
    assert.equal(h.pages.length, 1);
  } finally { await h.driver.close(); }
});

test('equal-length resume index is rejected before compilation', async () => {
  let compiled = false;
  const h = harness({ prompter: () => { compiled = true; return 'bad'; } });
  h.driver.bindings.take = async () => ({ entry: {}, resumeFrom: 1 });
  try {
    await assert.rejects(h.complete(), { code: 'binding' });
    assert.equal(compiled, false);
  } finally { await h.driver.close(); }
});

for (const [kind, code] of [['challenge', 'verification'], ['rate-limit', 'cooldown'], ['sign-in', 'expired']]) test(`page ${kind} blocks composer and maps to ${code}`, async () => {
  const h = harness({ adapter: { probePageError: async () => ({ kind }) } });
  const accountGuard = guard();
  try {
    await assert.rejects(h.complete(command(), accountGuard), { code });
    assert.equal(h.calls.includes('composer'), false);
    if (kind === 'sign-in') await assert.rejects(accountGuard.begin(), { code: 'expired' });
    if (kind === 'rate-limit') await assert.rejects(accountGuard.begin(), { code: 'cooldown' });
  } finally { await h.driver.close(); }
});

for (const [kind, code] of [['challenge', 'verification'], ['rate-limit', 'cooldown'], ['sign-in', 'expired']]) test(`page ${kind} classification survives deadline during slow teardown`, async () => {
  const h = harness({ timeout: 120, adapter: { probePageError: async page => {
    const close = page.close.bind(page);
    page.close = async () => { await delay(200); await close(); };
    return { kind };
  } } });
  try {
    await assert.rejects(h.complete(command({ conversationKey: 'classified' })), { code });
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.size, 0);
    assert.equal(h.calls.includes('submit'), false);
  } finally { await h.driver.close(); }
});

test('cooldown retryAfter survives slow teardown through bridge and translation', async () => {
  const h = harness({ timeout: 120, observe: async page => {
    const close = page.close.bind(page);
    page.close = async () => { await delay(200); await close(); };
    throw new BackendError('cooldown', { retryAfter: 120 });
  } });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); } });
  let server;
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, { handlers: { complete: (request, signal, emit) => h.driver.complete(request, guard(), 'fixture', signal, emit) } });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  try {
    const source = await bridge.open({ ...command(), method: 'complete' });
    await assert.rejects(async () => {
      for await (const event of translate(source, command())) {}
    }, error => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, 'cooldown');
      assert.equal(error.retryAfter, '120');
      assert.equal(error.toJSON().retryAfter, '120');
      assert.equal(error.headers['retry-after'], '120');
      return true;
    });
  } finally { await bridge.dispose(); await server; await h.driver.close(); }
});

test('unconfirmed temporary chat prevents submission', async () => {
  const h = harness({ adapter: { assertTemporaryChat: async () => ({ ok: false, kind: 'temp-chat-unconfirmed' }) } });
  try {
    await assert.rejects(h.complete(), { code: 'temporary' });
    assert.equal(h.calls.includes('submit'), false);
  } finally { await h.driver.close(); }
});

test('visible/headless conflict is invalidRequest and keeps the active operation intact', async () => {
  const h = harness();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let finish;
  const held = h.driver.browser.run('fixture', async () => { entered(); await new Promise(resolve => { finish = resolve; }); }, undefined, { visibleTurns: false });
  try {
    await ready;
    await assert.rejects(h.complete(command({ visibleTurns: true })), { code: 'invalidRequest' });
    assert.equal(h.context.pages().length, 0);
  } finally { finish(); await held; await h.driver.close(); }
});

test('abort closes the page, clears binding, and permits the next turn', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let attempts = 0;
  const h = harness({ observe: async (page, { signal }) => {
    if (++attempts === 1) {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { text: 'answer', route: 'dom' };
  } });
  const controller = new AbortController();
  const accountGuard = guard();
  try {
    const first = h.complete(command({ conversationKey: 'session' }), accountGuard, controller.signal);
    const rejected = assert.rejects(first);
    await ready;
    controller.abort();
    await rejected;
    assert.equal(h.pages[0].closed, true);
    assert.equal(h.driver.bindings.entries.has('session'), false);
    assert.equal((await h.complete(command({ conversationKey: 'session' }), accountGuard)).result.text, 'answer');
  } finally { await h.driver.close(); }
});

test('bridge abort reaches backend driver cleanup and the next bridge turn succeeds', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let attempts = 0;
  const h = harness({ observe: async (page, { signal }) => {
    if (++attempts === 1) {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { text: 'answer', route: 'dom' };
  } });
  const accountGuard = guard();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); } });
  let server;
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, { handlers: { complete: async (request, signal, emit) => { await h.driver.complete(request, accountGuard, 'fixture', signal, emit); } } });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  const controller = new AbortController();
  try {
    const first = await bridge.open({ ...command({ conversationKey: 'session' }), method: 'complete' }, controller.signal);
    const rejected = assert.rejects(first.next(), { code: 'upstream' });
    await ready;
    controller.abort();
    await rejected;
    const next = await bridge.open({ ...command({ conversationKey: 'session' }), method: 'complete' });
    const frames = [];
    for await (const frame of next) frames.push(frame);
    assert.equal(h.pages[0].closed, true);
    assert.notEqual(h.driver.bindings.entries.get('session').page, h.pages[0]);
    assert.deepEqual(frames, [{ type: 'delta', index: 0, text: 'answer' }, { type: 'finish', reason: 'complete' }]);
  } finally { await bridge.dispose(); await server; await h.driver.close(); }
});

test('never-completing observation fails truncated within the turn budget', async () => {
  const h = harness({ timeout: 50, observe: async () => new Promise(() => {}) });
  const started = performance.now();
  try {
    await assert.rejects(h.complete(command({ conversationKey: 'stalled' })), { code: 'truncated' });
    assert.ok(performance.now() - started < 1000);
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.size, 0);
  } finally { await h.driver.close(); }
});

test('overlapping turns serialize while retaining both keyed sessions', async () => {
  let active = 0;
  let maximum = 0;
  const h = harness({ observe: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { text: 'answer', route: 'dom' };
  } });
  const accountGuard = guard();
  try {
    await Promise.all(['one', 'two'].map(conversationKey => h.complete(command({ conversationKey }), accountGuard)));
    assert.equal(maximum, 1);
    for (const entry of h.driver.bindings.entries.values()) {
      assert.equal(entry.busy, false);
      assert.equal(entry.page.isClosed(), false);
      assert.equal(entry.history.at(-1).content, 'answer');
    }
    assert.equal(h.driver.bindings.entries.size, 2);
  } finally { await h.driver.close(); }
});
