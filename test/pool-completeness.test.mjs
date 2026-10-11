import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from '../backend/main.mjs';

async function inspectedPool(t) {
  const source = (await readFile(new URL('../backend/main.mjs', import.meta.url), 'utf8'))
    .replaceAll(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, new URL('../backend/main.mjs', import.meta.url)).href}'`)
    .replace('  const loginPromises = new Map();', '  handlers.inspect({ clients, guards, clientFor });\n  const loginPromises = new Map();');
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let pool;
  const work = instrumented.serve(input, output, { handlers: { inspect: value => { pool = value; } } });
  while (!pool) await new Promise(resolve => setImmediate(resolve));
  t.after(async () => { input.end(); await work; });
  return pool;
}

const command = (identity, rotation = 0) => ({ origin: 'http://127.0.0.1', auth: { refresh: `__Secure-next-auth.session-token=${identity}; ancillary=${rotation}` } });
const restricted = guard => { try { guard.restriction(); return false; } catch { return true; } };
const snapshot = pool => ({ clients: [...pool.clients].map(([key, entry]) => [key, entry, entry.refs, entry.used]), guards: [...pool.guards] });

for (const status of [401, 429]) for (const order of ['blocked-first', 'healthy-first', 'interleaved']) {
  test(`threshold recovery ${status} ${order}`, { timeout: 15_000 }, async t => {
    const blocked = Array.from({ length: 32 }, () => randomUUID());
    const healthy = Array.from({ length: 32 }, () => randomUUID());
    let hits = 0;
    const server = createServer((request, response) => {
      hits++;
      if (blocked.some(identity => request.headers.cookie.includes(identity))) response.writeHead(status, { 'Retry-After': '600' });
      response.end(JSON.stringify({ models: [{ slug: 'fixture', title: 'Fixture' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const input = new PassThrough();
    const output = new PassThrough();
    let buffer = '';
    const replies = new Map();
    output.setEncoding('utf8');
    output.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.event === 'done' || frame.event === 'error') replies.get(frame.id)?.(frame);
      }
    });
    const work = serve(input, output);
    t.after(async () => { input.end(); await work; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let sequence = 0;
    const request = (identity, rotation = 0) => {
      const id = `threshold-${sequence++}`;
      const reply = new Promise(resolve => replies.set(id, resolve));
      input.write(JSON.stringify({ ...command(identity, rotation), id, method: 'models', origin: `http://127.0.0.1:${server.address().port}` }) + '\n');
      return reply;
    };
    const setup = order === 'blocked-first' ? [...blocked, ...healthy] : order === 'healthy-first' ? [...healthy, ...blocked] : blocked.flatMap((identity, index) => [identity, healthy[index]]);
    for (const identity of setup) {
      const frame = await request(identity);
      assert.equal(blocked.includes(identity) ? frame.error?.status : frame.event, blocked.includes(identity) ? status : 'done');
    }
    const rotations = await Promise.all(healthy.map(identity => request(identity, 1)));
    assert.ok(rotations.every(frame => frame.event === 'done'));
    let admitted = 0;
    for (let index = 0; index < 50; index++) if ((await request(randomUUID())).event === 'done') admitted++;
    const before = hits;
    for (const identity of blocked) assert.equal((await request(identity)).error?.status, status);
    assert.equal(hits, before);
    t.diagnostic(`${status} ${order}: ${admitted}/50 fresh admitted; blocked revisits add 0 HTTP hits`);
    assert.equal(admitted, 50);
  });
}

for (const seed of [7, 19, 43]) test(`admission completeness property seed ${seed}`, async t => {
  const pool = await inspectedPool(t);
  let random = seed;
  const next = limit => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % limit; };
  const identities = [];
  let admissions = 0;
  let refusals = 0;
  let multiple = 0;
  const combinations = new Set();
  for (let step = 0; step < 2000; step++) {
    const identity = !identities.length || next(100) < 45 ? randomUUID() : identities[next(identities.length)];
    if (!identities.includes(identity)) identities.push(identity);
    const before = snapshot(pool);
    const clientFree = pool.clients.size < 64 || [...pool.clients.values()].some(entry => entry.refs === 0);
    const existingGuard = pool.guards.has(createHash('sha256').update(`__Secure-next-auth.session-token=${identity}`).digest('hex'));
    const guardFree = existingGuard || pool.guards.size < 64 || [...pool.guards.values()].some(guard => !restricted(guard) && [...pool.clients.values()].every(entry => entry.client.guard !== guard || entry.refs === 0));
    let lease;
    try { lease = pool.clientFor(command(identity, next(8))); }
    catch (error) {
      assert.equal(error.code, 'capacity');
      assert.deepEqual(snapshot(pool), before, 'refused admission must leave exact map state unchanged');
      assert.ok(!clientFree || !guardFree, `unjustified capacity refusal at seed ${seed}, step ${step}`);
      refusals++;
      continue;
    }
    admissions++;
    const removedClients = before.clients.filter(([key]) => !pool.clients.has(key)).length;
    const removedGuards = before.guards.filter(([key]) => !pool.guards.has(key));
    combinations.add(`${removedClients > 0}:${removedGuards.length > 0}`);
    if (removedClients > 1) {
      if (!multiple) t.diagnostic(`multi-client eviction: clients ${before.clients.length} -> ${pool.clients.size}, guards ${before.guards.length} -> ${pool.guards.size}, removed ${removedClients} clients`);
      multiple++;
    }
    for (const [, guard] of removedGuards) {
      assert.equal(restricted(guard), false);
      assert.ok([...pool.clients.values()].every(entry => entry.client.guard !== guard));
    }
    assert.ok(pool.clients.size <= 64 && pool.guards.size <= 64);
    if (next(100) < 30) lease.client.guard.observe(401);
    lease.release();
  }
  assert.ok(admissions > 64 && refusals > 0);
  assert.deepEqual([...combinations].sort(), ['false:false', 'false:true', 'true:false', 'true:true']);
  assert.ok(multiple > 0);
  t.diagnostic(`seed ${seed}: ${admissions} admissions, ${refusals} refusals, ${multiple} multi-client evictions, combinations ${[...combinations].sort().join(',')}`);
});

test('active guard remains unique across concurrent admission pressure', async t => {
  const pool = await inspectedPool(t);
  for (let index = 0; index < 63; index++) {
    const lease = pool.clientFor(command(randomUUID()));
    lease.client.guard.observe(401);
    lease.release();
  }
  const identity = randomUUID();
  const active = pool.clientFor(command(identity));
  const guard = active.client.guard;
  let refusals = 0;
  for (let episode = 0; episode < 20; episode++) {
    const before = snapshot(pool);
    assert.throws(() => pool.clientFor(command(randomUUID())), error => error.code === 'capacity');
    assert.deepEqual(snapshot(pool), before);
    refusals++;
    const rotation = pool.clientFor(command(identity, episode + 1));
    assert.equal(rotation.client.guard, guard);
    assert.equal(active.client.guard, guard);
    assert.ok([...pool.guards.values()].includes(guard));
    rotation.release();
  }
  active.release();
  pool.clientFor(command(randomUUID())).release();
  assert.ok(![...pool.guards.values()].includes(guard));
  t.diagnostic(`concurrent episodes 20; admissions 85; refusals ${refusals}; no active guard eviction or duplicate guard`);
});

test('cooldown expiry frees capacity without dropping retained restrictions', async t => {
  const pool = await inspectedPool(t);
  let now = 0;
  for (let index = 0; index < 64; index++) {
    const lease = pool.clientFor(command(randomUUID()));
    lease.client.guard.now = () => now;
    lease.client.guard.observe(429, '600');
    lease.release();
  }
  const before = snapshot(pool);
  assert.throws(() => pool.clientFor(command(randomUUID())), error => error.code === 'capacity');
  assert.deepEqual(snapshot(pool), before);
  now = 600001;
  pool.clientFor(command(randomUUID())).release();
  assert.equal(pool.guards.size, 64);
  assert.equal(pool.clients.size, 64);
  t.diagnostic('all 64 cooldowns: 1 atomic refusal before expiry, 1 admission after expiry');
});
