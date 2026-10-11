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
