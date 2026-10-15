import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSupervisor } from '../backend/browser.mjs';
import { ReadClient } from '../backend/http.mjs';
import { serve } from '../backend/main.mjs';

for (const status of [401, 429]) test(`typed ${status} remains observed across slow page cleanup`, async t => {
  let hits = 0;
  let pages = 0;
  let guard;
  const closes = [];
  const server = createServer((request, response) => {
    hits++;
    response.writeHead(403, { 'cf-mitigated': 'challenge' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = new EventEmitter();
  context.pages = () => [];
  context.cookies = async () => [{ name: 'next-auth.session-token', value: 'fixture' }];
  context.close = async () => context.emit('close');
  context.newPage = async () => {
    pages++;
    return {
      url: () => origin,
      goto: async () => {},
      evaluate: async () => ({ status, headers: { 'content-type': 'application/json', 'retry-after': '60' }, body: '{}' }),
      close: () => { const work = delay(500); closes.push(work); return work; },
    };
  };
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (frame.event === 'error' || frame.event === 'done') replies.get(frame.id)?.(frame);
    }
  });
  const work = serve(input, output, {
    turnDriver: { browser, close: () => browser.close() },
    readClient: options => { guard = options.guard; return new ReadClient({ ...options, timeout: 100 }); },
  });
  t.after(async () => { input.end(); await work; await Promise.all(closes); server.closeAllConnections(); server.close(); });
  const request = id => new Promise(resolve => {
    replies.set(id, resolve);
    input.write(JSON.stringify({ id, method: 'models', origin, profileRoot: '.', auth: { profile: 'fixture', refresh: 'next-auth.session-token=fixture' } }) + '\n');
  });
  const first = await request('first');
  assert.equal(first.error.status, 504);
  assert.throws(() => guard.restriction(), error => error.code === (status === 401 ? 'expired' : 'cooldown'));
  const second = await request('second');
  assert.equal(second.error.status, status);
  assert.equal(hits, 1);
  assert.equal(pages, 1);
});

test('a fallback that never settles remains bounded with requestBudget', async t => {
  let hits = 0;
  let fallbacks = 0;
  const server = createServer((request, response) => { hits++; response.writeHead(403, { 'cf-mitigated': 'challenge' }); response.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture', timeout: 100,
    browserRoute: () => { fallbacks++; return new Promise(() => {}); },
  });
  const started = Date.now();
  await assert.rejects(client.models(), error => error.code === 'requestBudget' && error.status === 504);
  assert.ok(Date.now() - started < 1000);
  assert.equal(hits, 1);
  assert.equal(fallbacks, 1);
});
