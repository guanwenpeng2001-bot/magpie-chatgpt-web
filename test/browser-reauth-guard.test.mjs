import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserSupervisor, createLoginFlow, sessionCredential } from '../backend/browser.mjs';
import { BackendError } from '../backend/guard.mjs';

const tokenName = '__Secure-next-auth.session-token';
const authA = { profile: 'native-a', browserProfile: 'physical', accountId: 'a@example.test', refresh: `${tokenName}=token-a` };
const authB = { ...authA, accountId: 'b@example.test', refresh: `${tokenName}=token-b` };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const state = { email: authA.accountId, token: 'token-a', reads: 0, closes: 0, launches: 0, status: 200, pages: [], writes: 0 };
  const context = new EventEmitter();
  const page = () => {
    const value = { location: 'about:blank', visits: [], closes: 0,
      url() { return this.location; }, isClosed() { return this.closes > 0; },
      async goto(url) { this.visits.push(url); this.location = String(url); },
      async close() { this.closes++; }, async bringToFront() {},
      async evaluate(_fn, { path }) {
        assert.equal(path, '/api/auth/session');
        state.reads++;
        const email = state.email;
        await state.onRead?.();
        return { status: state.status, headers: state.status === 403 ? { 'cf-mitigated': 'challenge' } : {},
          body: JSON.stringify({ accessToken: 'synthetic-access', expires: '2099-01-01T00:00:00Z', user: { email } }) };
      },
    };
    state.pages.push(value);
    return value;
  };
  const original = page();
  context.pages = () => state.pages.filter(value => !value.isClosed());
  context.newPage = async () => {
    state.allocating?.resolve();
    if (state.nextPage) { const pending = state.nextPage; state.nextPage = undefined; return pending.promise; }
    return page();
  };
  context.cookies = async () => [{ name: tokenName, value: state.token, domain: '.chatgpt.com', path: '/' }];
  context.clearCookies = context.addCookies = async () => { state.writes++; assert.fail('identity checks must not replace session cookies'); };
  context.newCDPSession = async () => ({ async send(method) {
    return method === 'Browser.getWindowForTarget' ? { windowId: 1, bounds: { left: 100, top: 100 } } : {};
  }, async detach() {} });
  context.close = async () => { state.closes++; context.emit('close'); };
  const browser = new BrowserSupervisor({ profileRoot: '.', idleMilliseconds: null, headless: false,
    launch: async () => { state.launches++; return context; } });
  const flow = createLoginFlow({ probeSignedIn: async () => { await state.onLogin?.(); return true; } });
  const run = (auth = authA, operation = async () => 'authorized', signal) => browser.run('physical', operation, signal, { auth });
  t.after(() => browser.close());
  return { state, context, browser, original, page, run, login: signal => flow('physical', signal, '.', { browser, preservePages: true }) };
}

test('reauthentication as B revokes cached A without restoring A cookies or discarding the browser', async t => {
  const f = fixture(t);
  // Prime the exact legacy refresh-token cache implicated in the regression.
  await f.browser.run('physical', async () => {}, undefined, { auth: { refresh: authA.refresh } });
  assert.equal(await f.run(), 'authorized');
  f.original.location = 'https://chatgpt.com/c/keep-user-page';
  f.state.onLogin = async () => { f.state.email = authB.accountId; f.state.token = 'token-b'; };
  const result = await f.login(new AbortController().signal);
  assert.equal(result.credential.accountId, authB.accountId);
  assert.notEqual(result.credential.accountId, authA.accountId, 'the host must reject this A reauthentication callback');
  let used = false;
  await assert.rejects(f.run(authA, async () => { used = true; }), { code: 'binding' });
  const reads = f.state.reads;
  await assert.rejects(f.run(authA), { code: 'binding' });
  assert.equal(f.state.reads, reads, 'the same proven mismatch does not spawn repeated validation tabs');
  assert.equal(used, false);
  assert.equal(f.state.token, 'token-b');
  assert.equal(f.state.writes, 0);
  assert.equal(f.original.location, 'https://chatgpt.com/c/keep-user-page');
  assert.equal(f.original.closes, 0);
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.launches, 1);
  // A later genuine A session revalidates in place, independently of the stale
  // host refresh string. No browser is reset and no message is replayed.
  f.state.email = authA.accountId;
  f.state.token = 'token-a-human-renewed';
  assert.equal(await f.run(), 'authorized');
  assert.equal(f.state.token, 'token-a-human-renewed');
  assert.equal(f.state.launches, 1);
});

test('identity proofs reuse the current cookie digest for 60 seconds and ignore host refresh-token changes', async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await f.run();
  const pages = f.state.pages.length;
  await assert.rejects(f.run({ refresh: authA.refresh }), { code: 'binding' });
  for (let n = 0; n < 12; n++) await f.run({ ...authA, refresh: `untrusted-host-token-${n}` });
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.pages.length, pages);
  assert.equal(f.state.writes, 0);
  now += 59_999;
  await f.run();
  assert.equal(f.state.reads, 1);
  now++;
  await f.run();
  assert.equal(f.state.reads, 2);
  f.state.token = 'rotated-in-browser';
  await f.run();
  assert.equal(f.state.reads, 3, 'cookie changes immediately revoke proof');
  await assert.rejects(f.run(authB), { code: 'binding' });
  assert.equal(f.state.reads, 4, 'a changed requested identity must be freshly checked');
  assert.equal(f.state.writes, 0);
});

test('concurrent requests share one session proof and every caller still checks its identity', async t => {
  const f = fixture(t), reading = deferred(), release = deferred();
  f.state.onRead = async () => { reading.resolve(); await release.promise; };
  const requests = Array.from({ length: 8 }, () => f.run());
  const wrong = assert.rejects(f.run(authB), { code: 'binding' });
  await reading.promise;
  assert.equal(f.state.reads, 1);
  release.resolve();
  assert.deepEqual(await Promise.all(requests), Array(8).fill('authorized'));
  await wrong;
  assert.equal(f.state.reads, 1);
});

test('signing in blocks new authenticated work and clears a valid proof even if cookies stay unchanged', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  await f.run();
  f.state.onLogin = async () => { entered.resolve(); await release.promise; };
  const login = f.login(new AbortController().signal);
  await entered.promise;
  let used = false;
  await assert.rejects(f.run(authA, () => { used = true; }), { code: 'binding' });
  assert.equal(used, false);
  release.resolve();
  assert.equal((await login).state, 'signed-in');
  const reads = f.state.reads;
  await f.run();
  assert.equal(f.state.reads, reads + 1, 'a pre-login proof cannot survive even an unchanged cookie');
  await assert.rejects(f.run({ refresh: authA.refresh }), { code: 'binding' });
  assert.equal(f.state.writes, 0);
});

test('a sign-in attempt cannot mutate the browser while authenticated work holds its lease', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const work = f.run(authA, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const before = f.state.pages.length;
  assert.equal((await f.login(new AbortController().signal)).state, 'failed');
  assert.equal(f.state.pages.length, before);
  assert.equal(f.state.closes, 0);
  release.resolve();
  await work;
});

test('normal NextAuth rotation on every session read preserves a confirmed identity and caches its latest cookie', async t => {
  const f = fixture(t);
  f.state.onRead = async () => { f.state.token = `rotated-${f.state.reads}`; };
  assert.equal(await f.run(), 'authorized');
  assert.equal(f.state.reads, 2);
  assert.equal(await f.run(), 'authorized');
  assert.equal(f.state.reads, 2, 'cache binds the final rotated cookie');
  f.state.token = 'external-refresh';
  assert.equal(await f.run(), 'authorized');
  assert.equal(f.state.reads, 4);
  assert.equal(f.state.writes, 0);
});

test('cookie replacement during the identity read cannot authorize the old account', async t => {
  const f = fixture(t);
  f.state.onRead = async () => {
    f.state.email = authB.accountId;
    f.state.token = 'token-b';
    f.state.onRead = undefined;
  };
  let used = false;
  await assert.rejects(f.run(authA, () => { used = true; }), { code: 'binding' });
  assert.equal(f.state.reads, 2);
  assert.equal(used, false);
  assert.equal(f.state.writes, 0);
});

test('unverified sessions and missing stored identity fail closed without closing user pages', async t => {
  for (const [email, status, code] of [[undefined, 200, 'expired'], ['', 200, 'expired'], ['chatgpt-web', 200, 'expired'],
    [authA.accountId, 401, 'expired'], [authA.accountId, 403, 'verification']]) {
    const f = fixture(t);
    f.state.email = email;
    f.state.status = status;
    await assert.rejects(f.run(authA, () => assert.fail('unverified request entered business operation')), { code });
    assert.equal(f.state.closes, 0);
    assert.equal(f.original.closes, 0);
    assert.equal(f.state.writes, 0);
  }
});

for (const reason of ['cancel', 'timeout', 'context-close']) test(`late login page after ${reason} is closed exactly once without navigation`, async t => {
  const f = fixture(t), allocating = deferred(), pageReady = deferred();
  f.state.allocating = allocating;
  f.state.nextPage = pageReady;
  const controller = new AbortController();
  const work = f.login(controller.signal);
  await allocating.promise;
  if (reason === 'context-close') f.context.emit('close');
  else controller.abort(reason === 'timeout' ? new BackendError('signinTimeout', { values: { windowMinutes: '15 minutes' } }) : undefined);
  const result = await work;
  assert.equal(result.state, reason === 'timeout' ? 'timeout' : 'cancelled');
  const late = f.page();
  pageReady.resolve(late);
  await tick();
  assert.equal(late.closes, 1);
  assert.deepEqual(late.visits, []);
  assert.equal(f.original.closes, 0);
  assert.equal(f.state.closes, 0, 'no closeAccount/context disposal for borrowed Chrome');
});

test('cancelled identity checks also close late-created probe pages and cannot authorize work', async t => {
  const f = fixture(t), allocating = deferred(), pageReady = deferred();
  f.state.allocating = allocating;
  f.state.nextPage = pageReady;
  const controller = new AbortController();
  const pending = assert.rejects(f.run(authA, () => assert.fail('cancelled identity proof was used'), controller.signal), { name: 'AbortError' });
  await allocating.promise;
  controller.abort();
  await pending;
  const late = f.page();
  pageReady.resolve(late);
  await tick();
  assert.equal(late.closes, 1);
  assert.deepEqual(late.visits, []);
  assert.equal(f.state.closes, 0);
});

test('session credentials require a real nonempty email instead of a shared sentinel', () => {
  const base = { accessToken: 'fixture', expires: '2099-01-01T00:00:00Z' };
  for (const email of [undefined, null, 0, '', '   ', 'chatgpt-web', '@host', 'name@', 'a@b@c', 'a b@c', 'a\0@b']) {
    assert.throws(() => sessionCredential({ ...base, user: { email } }, 'fixture', 'fixture'), { code: 'expired' });
  }
  assert.throws(() => sessionCredential(base, 'fixture', 'fixture'), { code: 'expired' });
  assert.equal(sessionCredential({ ...base, user: { email: ' A@Example.test ' } }, 'fixture', 'fixture').accountId, 'A@Example.test');
});
