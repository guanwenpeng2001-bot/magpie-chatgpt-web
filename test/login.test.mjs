import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as browserModule from '../backend/browser.mjs';

test('ordinary Chrome sign-in launch uses only the four prescribed arguments', () => {
  assert.equal(typeof browserModule.chromeArguments, 'function');
  const args = browserModule.chromeArguments('C:/fixture/profile', 12345, { env: {} });
  assert.deepEqual(args, ['--user-data-dir=C:/fixture/profile', '--remote-debugging-port=12345', '--no-first-run', '--no-default-browser-check']);
  assert.equal(args.some(arg => /no-sandbox|enable-automation|headless/.test(arg)), false);
});

test('a restored non-blank page recovers without discarding its session', async () => {
  let location = 'about:blank#restored';
  const context = new EventEmitter();
  context.pages = () => [{ url: () => location, goto: async url => { location = url; } }];
  context.close = async () => context.emit('close');
  const supervisor = new browserModule.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    const value = await supervisor.run('fixture', async restored => {
      assert.equal(restored, context);
      assert.equal(location, 'about:blank');
      return 'account usable';
    });
    assert.equal(value, 'account usable');
  } finally { await supervisor.close(); }
});

test('cancellation during browser attachment closes it before navigating', async () => {
  const controller = new AbortController();
  const context = new EventEmitter();
  let closed = false;
  context.pages = () => [];
  context.newPage = async () => { throw new Error('must not navigate'); };
  const flow = browserModule.createLoginFlow({ launch: async () => {
    controller.abort();
    return { context, close: async () => { closed = true; context.emit('close'); } };
  } });
  assert.equal((await flow('fixture', controller.signal, '.')).state, 'cancelled');
  assert.equal(closed, true);
});

test('login mints in the signed-in page and reads HttpOnly rotation after the session response', async () => {
  const accessToken = randomUUID();
  const before = randomUUID();
  const after = randomUUID();
  let rotated = false;
  let nodeReads = 0;
  const context = new EventEmitter();
  const page = {
    url: () => 'https://chatgpt.com/', goto: async () => {}, isClosed: () => false,
    getByRole: () => ({ count: async () => 1, first: () => ({ isVisible: async () => true }) }),
    evaluate: async () => { rotated = true; return { status: 200, headers: {}, body: JSON.stringify({ accessToken, expires: new Date(Date.now() + 86400000).toISOString() }) }; },
  };
  context.pages = () => [page];
  context.cookies = async () => [{ name: '__Secure-next-auth.session-token', value: rotated ? after : before, httpOnly: true }];
  const flow = browserModule.createLoginFlow({
    launch: async () => ({ context, close: async () => {} }),
    readClient: () => { nodeReads++; throw new Error('login must use the signed-in page'); },
  });
  const result = await flow('fixture', new AbortController().signal, '.');
  assert.equal(result.state, 'signed-in');
  assert.ok(result.credential.refresh === '__Secure-next-auth.session-token=' + after, 'rotated HttpOnly cookie is persisted');
  assert.equal(nodeReads, 0);
});

test('login states retain actionable timeout and failure reasons and restart cleanly', () => {
  const states = new browserModule.LoginStates();
  states.start('fixture');
  assert.deepEqual(states.finish('fixture', 'timeout', undefined, new Error('Sign-in did not finish within 5 minutes. Start sign-in again.')), {
    state: 'timeout', reason: 'Sign-in did not finish within 5 minutes. Start sign-in again.',
  });
  assert.deepEqual(states.start('fixture'), { state: 'pending' });
  assert.deepEqual(states.finish('fixture', 'failed', undefined, new Error('Google Chrome could not attach. Restart Chrome and retry.')), {
    state: 'failed', reason: 'Google Chrome could not attach. Restart Chrome and retry.',
  });
  assert.deepEqual(states.finish('fixture', 'cancelled'), { state: 'cancelled' });
  states.start('fixture');
  assert.deepEqual(states.finish('fixture', 'signed-in', { access: 'fixture' }), { state: 'signed-in', credential: { access: 'fixture' } });
});

test('masked Chrome discovery names the missing component and remedy', async () => {
  await assert.rejects(browserModule.launchSignInBrowser('.', undefined, { candidates: [], chromium: {} }), error => {
    assert.equal(error.code, 'missingComponent');
    assert.equal(error.component, 'Google Chrome');
    assert.match(error.toJSON().message, /Google Chrome.*not found.*Install/);
    return true;
  });
});

test('sign-in launch inherits host proxy and stays visible', async () => {
  const child = new EventEmitter();
  let spawned;
  const context = new EventEmitter();
  const owned = await browserModule.launchSignInBrowser('.', undefined, {
    candidates: [process.execPath], env: { MAGPIE_HTTPS_PROXY: 'http://127.0.0.1:9123' },
    spawn: (executable, args) => { spawned = args; return child; },
    chromium: { connectOverCDP: async () => ({ contexts: () => [context], isConnected: () => true,
      newBrowserCDPSession: async () => ({ send: async () => { child.emit('exit', 0); } }),
    }) },
  });
  try {
    assert.ok(spawned.includes('--proxy-server=http://127.0.0.1:9123'));
    assert.equal(spawned.some(arg => /headless|enable-automation/.test(arg)), false);
    assert.equal(owned.context, context);
  } finally { await owned.close(); }
});

function loginFixture() {
  let closed = false;
  const context = new EventEmitter();
  const page = new EventEmitter();
  Object.assign(page, {
    url: () => 'http://127.0.0.1/', goto: async () => {}, isClosed: () => closed,
    getByRole: () => ({ count: async () => 1, first: () => ({ isVisible: async () => true }) }),
    evaluate: async () => ({ status: 200, headers: {}, body: JSON.stringify({ accessToken: 'fixture', expires: new Date(Date.now() + 60000).toISOString() }) }),
  });
  context.pages = () => closed ? [] : [page];
  context.cookies = async () => [{ name: '__Secure-next-auth.session-token', value: 'fixture' }];
  return { context, page, close: async () => { closed = true; context.emit('close'); } };
}

for (const terminal of ['cancelled', 'timeout', 'failed']) test(`login ${terminal} carries its cause and permits immediate retry`, async () => {
  let attempt = 0;
  let fixture;
  const controller = new AbortController();
  const reason = terminal === 'timeout'
    ? Object.assign(new Error('Sign-in did not finish within 5 minutes. Start sign-in again.'), { code: 'signinTimeout' })
    : new Error('Profile unavailable. Close other Chrome windows and retry.');
  const flow = browserModule.createLoginFlow({
    origin: 'http://127.0.0.1', pollMilliseconds: 1,
    launch: async () => { fixture = loginFixture(); attempt++; return fixture; },
    probeSignedIn: async () => {
      if (attempt > 1) return true;
      if (terminal === 'cancelled') await fixture.close();
      else if (terminal === 'timeout') controller.abort(reason);
      else throw reason;
      return false;
    },
  });
  const result = await flow('fixture', controller.signal, '.');
  assert.equal(result.state, terminal);
  assert.equal(result.credential, undefined);
  if (terminal !== 'cancelled') assert.equal(result.reason, reason.message);
  assert.equal((await flow('fixture', new AbortController().signal, '.')).state, 'signed-in');
});

test('an elapsed window interrupts a stalled page probe and closes once', async () => {
  const controller = new AbortController();
  const fixture = loginFixture();
  let closes = 0;
  const flow = browserModule.createLoginFlow({
    origin: 'http://127.0.0.1',
    launch: async () => ({ context: fixture.context, close: async () => { closes++; await fixture.close(); } }),
    probeSignedIn: async () => {
      controller.abort(Object.assign(new Error('Sign-in did not finish within 5 minutes. Start sign-in again.'), { code: 'signinTimeout' }));
      await new Promise(() => {});
    },
  });
  const result = await Promise.race([
    flow('fixture', controller.signal, '.'),
    new Promise(resolve => setTimeout(() => resolve({ state: 'hung' }), 100)),
  ]);
  assert.equal(result.state, 'timeout');
  assert.equal(closes, 1);
});

for (const location of ['about:blank', 'http://127.0.0.1/']) test(`navigation TimeoutError from ${location} is a load failure rather than an elapsed sign-in window`, async () => {
  const fixture = loginFixture();
  fixture.page.url = () => location;
  const navigationError = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
  fixture.page.goto = async () => { throw navigationError; };
  const flow = browserModule.createLoginFlow({ launch: async () => fixture });
  const result = await flow('fixture', new AbortController().signal, '.');
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /sign-in page could not be loaded/i);
  assert.match(result.reason, /network.*proxy/i);
  assert.doesNotMatch(result.reason, /5 minutes/);
  const states = new browserModule.LoginStates();
  assert.equal(states.finish('fixture', result.state, undefined, result.error).reason, result.reason);
});

test('reasonless abort during sign-in is cancelled', async () => {
  const controller = new AbortController();
  const fixture = loginFixture();
  const flow = browserModule.createLoginFlow({
    launch: async () => fixture,
    probeSignedIn: async () => { controller.abort(); return false; },
  });
  assert.deepEqual(await flow('fixture', controller.signal, '.'), { state: 'cancelled' });
});

test('session conversion yields the exact synthetic credential record', () => {
  assert.equal(typeof browserModule.sessionCredential, 'function');
  const refresh = `fixture=${randomUUID()}`;
  const access = randomUUID();
  const expires = Date.now() + 10 * 86400000;
  assert.deepEqual(browserModule.sessionCredential({ accessToken: access, expires: new Date(expires).toISOString(), user: { email: 'fixture@example.invalid' } }, refresh, 'fixture'), {
    type: 'oauth', refresh, access, expires, accountId: 'fixture@example.invalid', profile: 'fixture', persona: 'chatgpt-paid',
  });
});
