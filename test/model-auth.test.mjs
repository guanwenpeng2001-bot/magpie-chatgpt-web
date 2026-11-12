import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ReadClient } from '../backend/http.mjs';
import { browserRead } from '../backend/browser.mjs';

test('model reads authenticate with access token and session reads keep cookie authentication', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/backend-api/models' && request.headers.authorization !== 'Bearer current-token') {
      response.writeHead(401); response.end('{}'); return;
    }
    response.end(JSON.stringify(request.url === '/api/auth/session'
      ? { accessToken: 'current-token' } : { models: [{ slug: 'auto', title: 'Auto' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const client = new ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture=session', access: 'old-token' });
  await client.session();
  assert.equal((await client.models()).models.length, 1);
  assert.deepEqual(seen, [
    { path: '/api/auth/session', authorization: undefined },
    { path: '/backend-api/models', authorization: 'Bearer current-token' },
  ]);
});

test('browser model fallback carries the same bearer token', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    seen.push({ path, authorization: options.headers?.Authorization });
    return new Response(JSON.stringify({ models: [{ slug: 'auto', title: 'Auto' }] }));
  });
  const page = { url: () => 'https://chatgpt.com/', evaluate: (fn, arg) => fn(arg) };
  await browserRead({}, page, '/backend-api/models', 'https://chatgpt.com', undefined, 'current-token');
  assert.deepEqual(seen, [{ path: '/backend-api/models', authorization: 'Bearer current-token' }]);
});
