import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadClient } from '../backend/http.mjs';

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
