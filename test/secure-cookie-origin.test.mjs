import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BrowserSupervisor } from '../backend/browser.mjs';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { Bridge } from '../src/bridge.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';

for (const [label, refresh] of [
  ['absent', undefined], ['empty', ''], ['whitespace', '   '], ['unrelated', 'preference=dark'],
  ['empty session', '__Secure-next-auth.session-token='], ['number', 12], ['object', {}],
  ['carriage return', '__Secure-next-auth.session-token=value\r'], ['nul', '__Secure-next-auth.session-token=value\0'],
]) test(`HTTPS expiry remains honest for ${label}`, async () => {
  const context = Object.assign(new EventEmitter(), {
    pages: () => [], cookies: async () => [{ name: '__Secure-next-auth.session-token', value: 'live' }],
    clearCookies: async () => assert.fail('invalid credential must not clear cookies'),
    addCookies: async () => assert.fail('invalid credential must not write cookies'),
    close: async () => context.emit('close'),
  });
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await assert.rejects(browser.run('fixture', () => assert.fail('invalid credential must not run'), undefined,
      { origin: 'https://chatgpt.com', auth: { refresh } }), { code: 'expired', status: 401, signIn: 'expired' });
  } finally { await browser.close(); }
});

let browserAvailable = true;
try { import.meta.resolve('playwright-core'); } catch { browserAvailable = false; }

for (const prefix of ['__Secure-', '__Host-']) test(`${prefix} HTTP reconciliation preserves the jar and emits one safe diagnostic`, async t => {
  const initial = [{ name: 'next-auth.session-token', value: 'prior', domain: '127.0.0.1', path: '/' }, { name: 'preference', value: 'dark' }];
  const context = Object.assign(new EventEmitter(), {
    pages: () => [], cookies: async () => structuredClone(initial),
    clearCookies: async () => assert.fail('HTTP skip must not clear cookies'),
    addCookies: async () => assert.fail('HTTP skip must not write cookies'),
    close: async () => context.emit('close'),
  });
  const diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args.join(' ')));
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    let ran = false;
    await browser.run('fixture', async context => { ran = true; assert.deepEqual(await context.cookies(), initial); }, undefined,
      { origin: 'http://127.0.0.1:12345', auth: { refresh: `${prefix}next-auth.session-token=private-marker` } });
    assert.equal(ran, true);
    assert.equal(diagnostics.filter(line => JSON.parse(line).event === 'session-cookie-reconcile-skipped').length, 1);
    assert.match(diagnostics[0], /http:\/\/127\.0\.0\.1:12345/);
    assert.doesNotMatch(diagnostics[0], /private-marker|next-auth/);
  } finally { await browser.close(); }
});

test('equal HTTP credentials return before the skip diagnostic', async t => {
  const context = Object.assign(new EventEmitter(), {
    pages: () => [], cookies: async () => [{ name: '__Secure-next-auth.session-token', value: 'same' }],
    clearCookies: async () => assert.fail('equal cookies must not be cleared'),
    addCookies: async () => assert.fail('equal cookies must not be written'),
    close: async () => context.emit('close'),
  });
  t.mock.method(console, 'error', () => assert.fail('equal cookies must not emit a diagnostic'));
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await browser.run('fixture', async () => {}, undefined, { origin: 'http://127.0.0.1:12345', auth: { refresh: '__Secure-next-auth.session-token=same' } });
  } finally { await browser.close(); }
});

test('secure credential completes a real HTTP fixture turn without mutating the Chrome jar', { skip: !browserAvailable && 'playwright-core is not installed' }, async t => {
  const { chromium } = await import('playwright-core');
  const fixture = await createTurnFixture({ interval: 50 });
  const root = await mkdtemp(join(tmpdir(), 'secure-cookie-turn-'));
  let context;
  let initial;
  const diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args.join(' ')));
  const driver = new TurnDriver({ profileRoot: root, origin: fixture.origin, timeout: 15000, launch: async profile => {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    await context.addCookies([
      { name: 'next-auth.session-token', value: 'prior', url: fixture.origin },
      { name: 'preference', value: 'dark', url: fixture.origin },
      { name: '__Secure-next-auth.session-token', value: 'elsewhere', url: 'https://chatgpt.com', secure: true },
    ]);
    initial = await context.cookies();
    t.mock.method(context, 'clearCookies');
    t.mock.method(context, 'addCookies');
    return context;
  } });
  try {
    const frames = [];
    await driver.complete({ model: 'auto', history: [{ role: 'user', content: 'Describe a garden.' }],
      auth: { profile: 'fixture', refresh: '__Secure-next-auth.session-token=private-turn-marker' } },
    new AccountGuard(), 'fixture', new AbortController().signal, frame => frames.push(frame));
    assert.deepEqual(frames.map(frame => frame.type), ['delta', 'finish']);
    assert.equal(frames[0].text, fixture.batches.join(''));
    assert.deepEqual(await context.cookies(), initial);
    assert.equal(context.clearCookies.mock.callCount(), 0);
    assert.equal(context.addCookies.mock.callCount(), 0);
    assert.equal(diagnostics.filter(line => JSON.parse(line).event === 'session-cookie-reconcile-skipped').length, 1);
    assert.doesNotMatch(diagnostics.join('\n'), /private-turn-marker/);
    fixture.setMode('post-expired');
    await assert.rejects(driver.complete({ model: 'auto', history: [{ role: 'user', content: 'Again.' }],
      auth: { profile: 'fixture', refresh: '__Secure-next-auth.session-token=private-turn-marker' } },
    new AccountGuard(), 'fixture', new AbortController().signal, () => {}), { code: 'expired' });
    assert.deepEqual(await context.cookies(), initial);
  } finally {
    await driver.close(); await fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('real Bridge session rotation and shipped fixture backend complete a secure credential turn', { skip: !browserAvailable && 'playwright-core is not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'secure-cookie-bridge-'));
  const statePath = join(root, 'state.json');
  const bridge = new Bridge({ backend: fileURLToPath(new URL('../integrations/fixture-backend.mjs', import.meta.url)), startupMilliseconds: 60000,
    spawnProcess: (executable, args, options) => spawn(executable, args, { ...options, env: { ...options.env,
      CHATGPT_WEB_FIXTURE_STATE: statePath, CHATGPT_WEB_FIXTURE_PROFILE_ROOT: join(root, 'profiles') } }),
  });
  try {
    await bridge.start();
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const auth = { profile: 'fixture', refresh: `__Secure-next-auth.session-token=${state.cookie}` };
    const session = await bridge.call({ method: 'session', auth, profileRoot: join(root, 'profiles') });
    assert.ok(session.refresh.startsWith('__Secure-next-auth.session-token='));
    assert.notEqual(session.refresh, auth.refresh);
    const frames = [];
    for await (const frame of await bridge.open({ method: 'complete', model: 'auto', history: [{ role: 'user', content: 'Describe a garden.' }],
      auth: { ...auth, refresh: session.refresh }, profileRoot: join(root, 'profiles') })) frames.push(frame);
    assert.ok(frames.some(frame => frame.type === 'delta'));
    assert.ok(frames.some(frame => frame.type === 'finish'));
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
