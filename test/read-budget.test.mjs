import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadClient } from '../backend/http.mjs';

test('refresh aborts a stalled HTTP request at ten seconds even with a larger client timeout', async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  let fallbacks = 0;
  const client = new ReadClient({ origin: 'http://127.0.0.1:' + server.address().port, cookie: 'fixture=value', timeout: 30_000,
    browserRoute: async () => { fallbacks++; },
  });
  const started = performance.now();
  await assert.rejects(client.session(), error => error.code === 'requestBudget');
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 9_900 && elapsed < 12_000, 'refresh must stop at the ten-second cap: ' + elapsed);
  assert.equal(fallbacks, 0);
});

test('refresh budget includes waiting for the account guard and leaves it usable', async t => {
  const { AccountGuard } = await import('../backend/guard.mjs');
  const guard = new AccountGuard({ sleep: async () => {} });
  const release = await guard.begin();
  const client = new ReadClient({ origin: 'http://127.0.0.1', cookie: 'fixture=value', guard, timeout: 30 });
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(client.session(), error => error.code === 'requestBudget');
  release();
  const nextRelease = await guard.begin();
  nextRelease();
});

for (const cancelled of [false, true]) test(`refresh distinguishes caller cancellation (${cancelled})`, async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const client = new ReadClient({ origin: 'http://127.0.0.1:' + server.address().port, cookie: 'fixture=value', timeout: 100 });
  const result = client.session(controller.signal);
  if (cancelled) controller.abort();
  await assert.rejects(result, error => error.code === (cancelled ? 'upstream' : 'requestBudget'));
});

for (const cancelled of [false, true]) test(`node read timeout distinguishes caller cancellation (${cancelled})`, async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const client = new ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: crypto.randomUUID(), timeout: 50 });
  const received = once(server, 'request');
  const result = client.models(controller.signal);
  if (cancelled) { await received; controller.abort(); }
  await assert.rejects(result, error => error.code === (cancelled ? 'upstream' : 'requestBudget'));
});

for (const fallbackDelay of [120, 400]) test(`challenged read has an independent bounded fallback (${fallbackDelay} ms)`, async t => {
  let hits = 0;
  let fallbacks = 0;
  const server = createServer(async (request, response) => {
    hits++;
    await delay(120);
    response.writeHead(403, { 'cf-mitigated': 'challenge' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: crypto.randomUUID(), timeout: 200,
    browserRoute: async (path, signal) => {
      fallbacks++;
      await delay(fallbackDelay, undefined, { signal });
      return { value: { models: [{ slug: 'fixture', title: 'Fixture' }] } };
    },
  });
  if (fallbackDelay < 200) assert.equal((await client.models()).models[0].slug, 'fixture');
  else await assert.rejects(client.models(), error => error.code === 'requestBudget' && error.status === 504);
  assert.equal(hits, 1);
  assert.equal(fallbacks, 1);
});
