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
  const count = rotation ? 71 : 200;
  for (let index = 0; index < count; index++) {
    const id = `request-${index}`;
    const reply = new Promise(resolve => replies.set(id, resolve));
    const cookie = rotation ? `__Secure-next-auth.session-token=${session}; ancillary=${index}` : `fixture=${randomUUID()}`;
    input.write(JSON.stringify({ id, method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: cookie } }) + '\n');
    const frame = await reply;
    assert.equal(frame.event, 'done', `request ${index} must succeed without restarting`);
    successes++;
  }
  assert.equal(successes, count);
  t.diagnostic(`${rotation ? 'ancillary rotations' : 'distinct clients and guards'}: ${count} successes, 0 refusals; requests 65-${count} recovered without restart`);
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
  const request = async (identity, ancillary = '') => {
    const id = `restricted-${sequence++}`;
    const reply = new Promise(resolve => replies.set(id, resolve));
    input.write(JSON.stringify({ id, method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: `__Secure-next-auth.session-token=${identity}${ancillary}` } }) + '\n');
    return reply;
  };
  for (const identity of identities.slice(0, 64)) assert.equal((await request(identity)).error.status, status);
  const full = await request(identities[64]);
  assert.equal(full.error.status, 503);
  assert.equal(full.error.retryAfter, undefined);
  assert.match(full.error.message, /capacity/);
  assert.equal((await request(identities[1], `; ancillary=${randomUUID()}`)).error.status, status);
  assert.equal((await request(identities[0])).error.status, status);
  assert.equal(hits, 64, 'evicted restricted identity must not reach the fixture again');
});

for (const status of [401, 429]) for (const blockedFirst of [true, false]) test(`mixed pool admits new identities with ${status} client ${blockedFirst ? 'oldest' : 'newest'}`, { timeout: 10_000 }, async t => {
  const blocked = randomUUID();
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    if (request.headers.cookie === `fixture=${blocked}`) response.writeHead(status, { 'Retry-After': '600' });
    response.end(JSON.stringify({ models: [{ slug: 'fixture', title: 'Fixture' }] }));
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
  let sequence = 0;
  const request = identity => {
    const id = `mixed-${sequence++}`;
    const reply = new Promise(resolve => replies.set(id, resolve));
    input.write(JSON.stringify({ id, method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: `fixture=${identity}` } }) + '\n');
    return reply;
  };
  if (blockedFirst) assert.equal((await request(blocked)).error.status, status);
  for (let index = 0; index < 63; index++) assert.equal((await request(randomUUID())).event, 'done');
  if (!blockedFirst) assert.equal((await request(blocked)).error.status, status);
  let successes = 0;
  for (let index = 0; index < 130; index++) {
    const frame = await request(randomUUID());
    if (frame.event === 'done') successes++;
  }
  t.diagnostic(`blocked ${blockedFirst ? 'oldest' : 'newest'}: ${successes} admitted, ${130 - successes} refused`);
  assert.equal(successes, 130);
  assert.equal(hits, 194);
  assert.equal((await request(blocked)).error.status, status);
  assert.equal(hits, 194, 'retained blocked guard must refuse locally after client eviction');
});
