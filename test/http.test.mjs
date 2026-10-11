import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const module = await import('../backend/http.mjs');

test('external origins are rejected before opening any socket', () => {
  assert.throws(() => new module.ReadClient({ origin: 'https://chatgpt.com', cookie: randomUUID() }), error => error.status === 502);
});

test('HTTP failures suppress upstream bodies and retain cooldown', async t => {
  const marker = randomUUID();
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    response.writeHead(429, { 'retry-after': '7' });
    response.end(marker);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new module.ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: marker });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.models(), error => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, '7');
      assert.equal(error.message.includes(marker), false);
      return true;
    });
  }
  assert.equal(count, 1);
});
test('both measured reads send exactly H to a loopback fixture', async t => {
  assert.equal(typeof module.ReadClient, 'function', 'ReadClient must implement measured reads');
  const cookie = `fixture=${randomUUID()}`;
  const accessToken = randomUUID();
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, path: request.url, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/auth/session' ? { accessToken } : { models: [{ slug: 'fixture', title: 'Fixture' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new module.ReadClient({ origin, cookie });
  assert.equal((await client.models()).models[0].slug, 'fixture');
  assert.equal((await client.session()).accessToken, accessToken);
  for (const request of seen) {
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      accept: 'application/json', 'accept-encoding': 'identity', connection: 'close',
      cookie, host: new URL(origin).host,
    });
  }
  assert.deepEqual(seen.map(request => request.path), ['/backend-api/models', '/api/auth/session']);
});

test('session rotation merges cookie replacements and deletions without exposing attributes', async t => {
  const old = crypto.randomUUID();
  const fresh = crypto.randomUUID();
  const other = crypto.randomUUID();
  let hits = 0;
  const server = createServer((request, response) => {
    if (hits++) assert.equal(request.headers.cookie, 'session=' + fresh + '; other=' + other);
    response.setHeader('Set-Cookie', ['session=' + fresh + '; Path=/; HttpOnly; Secure', 'obsolete=; Max-Age=0; Path=/']);
    response.end(JSON.stringify({ accessToken: crypto.randomUUID() }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new module.ReadClient({ origin: 'http://127.0.0.1:' + server.address().port, cookie: 'session=' + old + '; obsolete=' + old + '; other=' + other });
  assert.equal((await client.session()).refresh, 'session=' + fresh + '; other=' + other);
  assert.equal((await client.session()).refresh, 'session=' + fresh + '; other=' + other);
});

test('production defaults to fixed HTTPS and rejects any caller origin override', () => {
  const cookie = randomUUID();
  assert.doesNotThrow(() => module.productionReadClient({ cookie }));
  for (const origin of ['http://127.0.0.1', 'https://example.invalid', 'https://chatgpt.com.attacker.invalid']) {
    assert.throws(() => module.productionReadClient({ cookie, origin }), error => error.code === 'protocol');
  }
});

test('classification keys on the interstitial evidence, not the status code alone', async t => {
  const interstitial = '<!doctype html><title>Just a moment...</title><p>Enable JavaScript and cookies to continue</p><script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script>';
  const cases = [
    ['401 json', { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"token rejected"}' }, 'expired'],
    ['403 interstitial markers', { status: 403, headers: { 'content-type': 'text/html' }, body: interstitial }, 'verification'],
    ['403 cf-mitigated header', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, body: '<html><body>blocked</body></html>' }, 'verification'],
    ['403 without markers', { status: 403, headers: { 'content-type': 'application/json' }, body: '{"detail":"forbidden"}' }, 'expired'],
    ['429', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' }, body: '{}' }, 'cooldown'],
  ];
  const { BackendError, AccountGuard } = await import('../backend/guard.mjs');
  for (const [label, shape, expected] of cases) {
    await t.test(label, async () => {
      const server = createServer((request, response) => {
        response.writeHead(shape.status, shape.headers);
        response.end(shape.body);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => server.close());
      const guard = new AccountGuard({ sleep: async () => {} });
      const client = new module.ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: `fixture=${randomUUID()}`, guard });
      await assert.rejects(client.models(), error => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, expected, `expected ${expected}, got ${error.code} (${error.message})`);
        if (expected === 'verification') {
          assert.equal(error.status, 502);
          assert.equal(error.signIn, undefined, 'a challenge must not ask the user to sign in');
          assert.notEqual(error.message, 'Sign in again to refresh the ChatGPT session.');
        }
        if (expected === 'expired') assert.equal(error.signIn, 'expired');
        return true;
      });
    });
  }
});

test('a challenged node read falls back to the browser route and validates the result the same way', async t => {
  let nodeHits = 0;
  const server = createServer((request, response) => {
    nodeHits++;
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('<title>Just a moment...</title>Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const routes = [];
  const client = new module.ReadClient({
    origin: `http://127.0.0.1:${server.address().port}`, cookie: `next-auth.session-token=${randomUUID()}`,
    browserRoute: async (path, signal, origin) => {
      routes.push({ path, origin: String(origin) });
      return { value: { models: [{ slug: 'routed', title: 'Routed' }] }, cookies: '' };
    },
  });
  const catalogue = await client.models();
  assert.equal(catalogue.models[0].slug, 'routed');
  assert.deepEqual(routes, [{ path: '/backend-api/models', origin: `http://127.0.0.1:${server.address().port}/` }]);
  assert.equal(nodeHits, 1, 'the node read is attempted first and only once');
});

test('a successful node read never launches the browser route', async t => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ slug: 'fixture', title: 'Fixture' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new module.ReadClient({
    origin: `http://127.0.0.1:${server.address().port}`, cookie: `fixture=${randomUUID()}`,
    browserRoute: async () => { throw new Error('browser must not be launched when the node read succeeds'); },
  });
  assert.equal((await client.models()).models[0].slug, 'fixture');

});

test('the fallback route result is validated exactly like the node result', async t => {
  const server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  for (const broken of [{ models: [] }, { models: [{ slug: '', title: 'Routed' }] }, { models: [{ slug: 'routed' }] }, {}]) {
    const client = new module.ReadClient({
      origin: `http://127.0.0.1:${server.address().port}`, cookie: `fixture=${randomUUID()}`,
      browserRoute: async () => ({ value: broken, cookies: '' }),
    });
    await assert.rejects(client.models(), error => error.code === 'protocol');
  }
});

test('when neither route can obtain the read the result is a typed failure, not a synthesized success', async t => {
  const server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new module.ReadClient({
    origin: `http://127.0.0.1:${server.address().port}`, cookie: `fixture=${randomUUID()}`,
    browserRoute: async () => { throw new (await import('../backend/guard.mjs')).BackendError('verification'); },
  });
  await assert.rejects(client.models(), error => error.code === 'verification');
  await assert.rejects(client.session(), error => error.code === 'verification');
  const withoutRoute = new module.ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: `fixture=${randomUUID()}` });
  await assert.rejects(withoutRoute.models(), error => error.code === 'verification');
});

test('a browser-routed session read folds rotated session-token chunks and nothing else', async t => {
  const accessToken = randomUUID();
  const server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const fresh = randomUUID();
  const stale = randomUUID();
  const retained = randomUUID();
  const clearance = randomUUID();
  const route = async () => ({ value: { accessToken }, cookies: `next-auth.session-token.0=${fresh}; cf_clearance=${clearance}` });
  const client = new module.ReadClient({
    origin: `http://127.0.0.1:${server.address().port}`, cookie: `next-auth.session-token.0=${stale}; next-auth.session-token.1=${stale}; keep=${retained}`,
    browserRoute: route,
  });
  const session = await client.session();
  assert.equal(session.accessToken, accessToken);
  assert.equal(session.refresh, `keep=${retained}; next-auth.session-token.0=${fresh}`);
  const unchanged = new module.ReadClient({
    origin: `http://127.0.0.1:${server.address().port}`, cookie: `next-auth.session-token.0=${fresh}`,
    browserRoute: async () => ({ value: { accessToken }, cookies: `next-auth.session-token.0=${fresh}` }),
  });
  assert.equal((await unchanged.session()).refresh, undefined, 'no rotation means no refresh field');
});

test('a truncated unmarked 403 cannot evade the persistent credential block', async t => {
  const server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'text/html', 'content-length': '1000' });
    response.write('<html>');
    setImmediate(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { AccountGuard } = await import('../backend/guard.mjs');
  const guard = new AccountGuard({ sleep: async () => {} });
  const client = new module.ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: randomUUID(), guard });
  await assert.rejects(client.models(), error => error.code === 'expired');
  await assert.rejects(guard.begin(), error => error.code === 'expired');
});

test('a positive challenge leaves the guard usable while an unmarked 403 permanently blocks it', async t => {
  let challenged = true;
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    if (challenged) { response.writeHead(403, { 'cf-mitigated': 'challenge' }); response.end(''); }
    else { response.end(JSON.stringify({ models: [{ slug: 'recovered', title: 'Recovered' }] })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { AccountGuard } = await import('../backend/guard.mjs');
  const guard = new AccountGuard({ sleep: async () => {} });
  const client = new module.ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: randomUUID(), guard });
  await assert.rejects(client.models(), error => error.code === 'verification');
  challenged = false;
  assert.equal((await client.models()).models[0].slug, 'recovered');
  assert.equal(hits, 2);
  assert.equal(module.responseFailure(403, {}, guard).code, 'expired');
  await assert.rejects(guard.begin(), error => error.code === 'expired');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86400000 });
  await assert.rejects(guard.begin(), error => error.code === 'expired');
});

test('catalogue cache expires at sixty seconds and cannot mask a known expired session', async t => {
  let hits = 0;
  let expired = false;
  const server = createServer((request, response) => {
    hits++;
    if (expired) { response.writeHead(401); response.end('{}'); }
    else response.end(JSON.stringify({ models: [{ slug: 'fixture', title: 'Fixture' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { AccountGuard } = await import('../backend/guard.mjs');
  const guard = new AccountGuard({ sleep: async () => {} });
  const client = new module.ReadClient({ origin: 'http://127.0.0.1:' + server.address().port, cookie: crypto.randomUUID(), guard });
  await client.models();
  await client.models();
  assert.equal(hits, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60001 });
  await client.models();
  assert.equal(hits, 2);
  expired = true;
  await assert.rejects(client.session(), error => error.signIn === 'expired');
  await assert.rejects(client.models(), error => error.signIn === 'expired');
  assert.equal(hits, 3);
});
