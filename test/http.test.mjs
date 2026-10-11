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
