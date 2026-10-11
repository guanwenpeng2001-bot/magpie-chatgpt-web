import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serve } from '../backend/main.mjs';

for (const rotation of [false, true]) test(`pool recovers beyond 64 ${rotation ? 'ancillary rotations' : 'distinct accounts'}`, { timeout: 100_000 }, async t => {
  const server = createServer((request, response) => response.end(JSON.stringify({ models: [{ slug: 'fixture', title: 'Fixture' }] })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (frame.event === 'done' || frame.event === 'error') replies.get(frame.id)?.(frame);
    }
  });
  const work = serve(input, output);
  t.after(async () => { input.end(); await work; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = randomUUID();
  let successes = 0;
  for (let index = 0; index < 71; index++) {
    const id = `request-${index}`;
    const reply = new Promise(resolve => replies.set(id, resolve));
    const cookie = rotation ? `__Secure-next-auth.session-token=${session}; ancillary=${index}` : `fixture=${randomUUID()}`;
    input.write(JSON.stringify({ id, method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: cookie } }) + '\n');
    const frame = await reply;
    assert.equal(frame.event, 'done', `request ${index} must succeed without restarting`);
    successes++;
  }
  assert.equal(successes, 71);
  t.diagnostic(`${rotation ? 'ancillary rotations' : 'distinct clients and guards'}: 71 successes, 0 refusals; requests 65-71 recovered without restart`);
});

for (const status of [401, 429]) test(`pool retains ${status} guards after client eviction and reports local capacity`, async t => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    response.writeHead(status, { 'Retry-After': '600' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (frame.event === 'done' || frame.event === 'error') replies.get(frame.id)?.(frame);
    }
  });
  const work = serve(input, output);
  t.after(async () => { input.end(); await work; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const identities = Array.from({ length: 65 }, () => randomUUID());
  let sequence = 0;
  const request = async identity => {
    const id = `restricted-${sequence++}`;
    const reply = new Promise(resolve => replies.set(id, resolve));
    input.write(JSON.stringify({ id, method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: `fixture=${identity}` } }) + '\n');
    return reply;
  };
  for (const identity of identities.slice(0, 64)) assert.equal((await request(identity)).error.status, status);
  const full = await request(identities[64]);
  assert.equal(full.error.status, 503);
  assert.equal(full.error.retryAfter, undefined);
  assert.match(full.error.message, /capacity/);
  assert.equal((await request(identities[0])).error.status, status);
  assert.equal(hits, 64, 'evicted restricted identity must not reach the fixture again');
});
