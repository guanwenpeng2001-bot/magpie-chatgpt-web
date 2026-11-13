import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrokerDiagnostics, createFileBrokerDiagnostics, parseBrokerDiagnostic } from '../src/native/broker-diagnostics.mjs';

const register = hash => `[chatgpt-web] broker trace=fixture-turn registered tokenHash=${hash}\n`;
const claim = (hash, valid = false) => `[chatgpt-web] broker claim received (tokenChars=37, tokenHash=${hash}, valid=${valid}${valid ? '' : ', retiredTurn=unknown'})\n`;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

test('compaction timing and retirement failure retain only allowlisted content-free fields', () => {
  for (const phase of ['entered', 'retiring', 'retired']) {
    assert.deepEqual(parseBrokerDiagnostic(`[chatgpt-web] compaction_phase ${phase}`), { type: 'compaction', phase });
  }
  for (const suffix of ['unknown', 'entered extra', 'retiring\nprivate']) {
    assert.equal(parseBrokerDiagnostic(`[chatgpt-web] compaction_phase ${suffix}`), undefined);
  }
  const retirement = { traceId: 'fixture', completionCommitted: false,
    pendingTools: 1, queuedTools: 0, deliveredTools: 1, activeMcpRequests: 0 };
  const parse = failure => parseBrokerDiagnostic('[chatgpt-web] broker_retired ' + JSON.stringify({ ...retirement, failure }));
  const timedOut = parse({ code: 'codex_tool_timeout', tool: 'PRIVATE_TOOL', timeoutMs: 90000, message: 'PRIVATE_ARGUMENTS' });
  assert.equal(timedOut.failureCode, 'codex_tool_timeout');
  assert.doesNotMatch(JSON.stringify(timedOut), /PRIVATE|timeoutMs/);
  for (const failure of [null, {}, 'private', { code: 'PRIVATE_ERROR' }]) assert.equal(parse(failure).failureCode, undefined);
});

test('broker diagnostics distinguish registration/claim fingerprints without retaining credential material', async () => {
  let saved;
  const log = createBrokerDiagnostics(async value => { saved = JSON.parse(value); }, { now: () => 42 });
  const stdout = new PassThrough(), stderr = new PassThrough(); log.attach(stdout); log.attach(stderr);
  // Interleaved streams and arbitrary UTF-8 boundaries must not combine lines.
  stdout.write(register('012345abcdef').slice(0, 31));
  stderr.write('private prompt: 密钥 credential-value\n');
  stdout.write(register('012345abcdef').slice(31));
  const bytes = Buffer.from(claim('abcdef012345'));
  for (const byte of bytes) stderr.write(Buffer.from([byte]));
  stdout.write('[chatgpt-web] broker trace=fixture-turn committed browser completion revision=2\r\n');
  stdout.write('[chatgpt-web] broker_retired ' + JSON.stringify({ traceId: 'fixture-turn', completionCommitted: true,
    pendingTools: 0, queuedTools: 0, deliveredTools: 0, activeMcpRequests: 0,
    pendingCalls: [{ arguments: 'credential-value' }], secret: 'credential-value' }) + '\n');
  await log.flush();
  assert.deepEqual(saved.events.map(({ at, ...event }) => event), [
    { type: 'registered', traceHash: hash('fixture-turn'), tokenHash: '012345abcdef' },
    { type: 'claim', tokenChars: 37, tokenHash: 'abcdef012345', valid: false, retiredTraceHash: null },
    { type: 'completed', traceHash: hash('fixture-turn'), revision: 2 },
    { type: 'retired', traceHash: hash('fixture-turn'), completionCommitted: true, pendingTools: 0,
      queuedTools: 0, deliveredTools: 0, activeMcpRequests: 0 },
  ]);
  assert.ok(saved.events.every(event => event.at === 42));
  assert.doesNotMatch(JSON.stringify(saved), /credential-value|private prompt|fixture-turn|密钥/);
  await log.close();
  assert.equal(saved.closed, true);
});

test('oversized lines cannot smuggle a valid-looking suffix and partial EOF is never accepted', async () => {
  let saved; const log = createBrokerDiagnostics(async value => { saved = JSON.parse(value); });
  const stream = new PassThrough(); log.attach(stream);
  stream.write('x'.repeat(4090)); stream.write(register('012345abcdef'));
  stream.write(register('111111111111'));
  stream.write(claim('222222222222').trimEnd());
  await log.close();
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].tokenHash, '111111111111');
  assert.equal(saved.droppedLines, 2);
  stream.write(register('333333333333'));
  assert.equal(log.snapshot().events.length, 1, 'late bytes do not rewrite the closed generation');
});

test('bounded snapshots coalesce writes and preserve latest events under backpressure', async () => {
  let release, writing = 0, maxWriting = 0;
  const writes = [];
  const log = createBrokerDiagnostics(async value => {
    writing++; maxWriting = Math.max(maxWriting, writing); writes.push(JSON.parse(value));
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    writing--;
  }, { limit: 3 });
  const stream = new PassThrough(); log.attach(stream);
  for (let index = 0; index < 100; index++) stream.write(register(index.toString(16).padStart(12, '0')));
  assert.equal(writes.length, 1);
  assert.equal(log.snapshot().events.length, 3);
  release(); await log.flush();
  assert.equal(writes.length, 2); assert.equal(maxWriting, 1);
  assert.equal(writes[1].droppedEvents, 97);
  assert.equal(writes[1].events.at(-1).tokenHash, '000000000063');
  await log.close();
});

test('I/O failure and stream errors do not fail a turn or leave unhandled rejections', async () => {
  let attempts = 0, saved;
  const log = createBrokerDiagnostics(async value => {
    if (++attempts === 1) throw new Error('disk unavailable'); saved = JSON.parse(value);
  });
  const stream = new PassThrough(); log.attach(stream);
  stream.write(register('012345abcdef')); await log.flush();
  assert.equal(log.snapshot().writeFailures, 1);
  stream.emit('error', new Error('broken pipe'));
  stream.write(claim('012345abcdef', true)); await log.close();
  assert.equal(saved.writeFailures, 1); assert.equal(saved.droppedLines, 1);
  assert.equal(saved.events.at(-1).valid, true);
  stream.emit('error', new Error('late closed pipe'));
});

test('reject unknown, prefixed, malformed and payload-bearing log lines', () => {
  for (const line of [
    'noise ' + register('012345abcdef').trim(), register('012345abcdef').trim() + ' secret',
    register('TOKEN_IS_SECRET').trim(), claim('012345abcdef').replace('37', '-1').trim(),
    '[chatgpt-web] broker_retired {"traceId":"fixture","completionCommitted":true}',
    '[chatgpt-web] broker_retired {"traceId":"<injected>","completionCommitted":true,"pendingTools":0,"queuedTools":0,"deliveredTools":0,"activeMcpRequests":0}',
  ]) assert.equal(parseBrokerDiagnostic(line), undefined);
  const event = parseBrokerDiagnostic(register('012345abcdef').replace('fixture-turn', 'turn_abcdefghijklmnopqrstuvwxyz012345').trim());
  assert.equal(event.traceHash.length, 16);
  assert.doesNotMatch(JSON.stringify(event), /turn_abcdefghijklmnopqrstuvwxyz012345/);
});

test('close drains both streams, includes tail lines and is idempotent', { timeout: 2000 }, async () => {
  let saved, settled = false;
  const log = createBrokerDiagnostics(async value => { saved = JSON.parse(value); });
  const stdout = new PassThrough(), stderr = new PassThrough();
  log.attach(stdout); log.attach(stderr);
  stdout.write(register('111111111111'));
  const closing = log.close();
  assert.equal(log.close(), closing);
  void closing.then(() => { settled = true; });
  stdout.end('[chatgpt-web] broker trace=fixture committed browser completion revision=1\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'stdout EOF must not discard stderr tail');
  stderr.end(claim('222222222222'));
  await closing;
  assert.deepEqual(saved.events.map(event => event.type), ['registered', 'completed', 'claim']);
  assert.equal(saved.closed, true);
  assert.equal(saved.drainTimedOut, false);
  assert.equal(saved.flushTimedOut, false);
  assert.equal(stdout.listenerCount('data'), 0);
  assert.equal(stderr.listenerCount('end'), 0);
});

test('an open inherited pipe has a bounded drain and partial lines remain rejected', { timeout: 1000 }, async () => {
  let saved;
  const log = createBrokerDiagnostics(async value => { saved = JSON.parse(value); }, { drainTimeoutMs: 10 });
  const stream = new PassThrough(); log.attach(stream);
  stream.write(register('111111111111'));
  stream.write(claim('222222222222').trimEnd());
  await log.close();
  assert.equal(saved.drainTimedOut, true);
  assert.equal(saved.droppedLines, 1);
  assert.equal(saved.events.length, 1);
  stream.end('\n' + claim('333333333333'));
  assert.equal(log.snapshot().events.length, 1);
});

test('a stalled optional writer cannot hold close or start queued writes after timeout', { timeout: 1000 }, async () => {
  let release, signal, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const log = createBrokerDiagnostics(async (_value, context) => {
    writes++; signal = context.signal; await gate;
  }, { drainTimeoutMs: 10, flushTimeoutMs: 10 });
  const stream = new PassThrough(); log.attach(stream);
  stream.write(register('111111111111')); stream.end(claim('222222222222'));
  await log.close();
  assert.equal(signal.aborted, true);
  assert.equal(log.snapshot().flushTimedOut, true);
  assert.equal(log.snapshot().closed, true);
  assert.equal(await log.flush(), false);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1, 'dirty final snapshot must not resume after abandonment');
});

test('generation artifacts isolate uncancellable late writes and retain only two generations', { timeout: 3000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'broker-generations-'));
  let release, entered, wrote;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const lateWritten = new Promise(resolve => { wrote = resolve; });
  t.after(async () => { release(); await rm(home, { recursive: true, force: true }); });
  const old = createFileBrokerDiagnostics(home, { now: () => 1, flushTimeoutMs: 10,
    writeFile: async (path, value, options) => {
      entered(); await gate;
      // Simulate an OS operation that ignores cancellation and completes late.
      await writeFile(path, value, { ...options, signal: undefined }); wrote();
    } });
  const stream = new PassThrough(); old.attach(stream); stream.end(register('111111111111'));
  await started; await old.close();
  assert.equal(old.snapshot().flushTimedOut, true);
  const unrelated = join(home, 'keep.json'); await writeFile(unrelated, 'unrelated');
  const generations = [];
  for (let index = 2; index <= 5; index++) {
    const log = createFileBrokerDiagnostics(home, { now: () => index });
    const output = new PassThrough(); log.attach(output);
    output.end(register(String(index).repeat(12))); await log.close();
    generations.push(log);
  }
  const newest = generations.at(-1), before = await readFile(newest.path, 'utf8');
  release(); await lateWritten;
  // Wait for the abandoned writer's private cleanup, not an unbounded flush.
  let names;
  for (let attempt = 0; attempt < 100; attempt++) {
    names = (await readdir(home)).filter(name => name.startsWith('broker-diagnostics-'));
    if (!names.includes(`${basename(old.path)}.tmp`) && !names.includes(basename(old.path))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(names.sort(), generations.slice(-2).map(log => basename(log.path)).sort());
  assert.equal(await readFile(newest.path, 'utf8'), before);
  assert.equal(JSON.parse(before).events[0].tokenHash, '555555555555');
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated');
});

test('a rename already issued at timeout cannot replace the next generation snapshot', { timeout: 3000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'broker-late-rename-'));
  let release, entered, committed;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredCommit = new Promise(resolve => { entered = resolve; });
  const lateCommit = new Promise(resolve => { committed = resolve; });
  t.after(async () => { release(); await rm(home, { recursive: true, force: true }); });
  const old = createFileBrokerDiagnostics(home, { now: () => 1, flushTimeoutMs: 10,
    rename: async (from, to) => { entered(); await gate; await rename(from, to); committed(); } });
  const stream = new PassThrough(); old.attach(stream); stream.end(register('111111111111'));
  await enteredCommit; await old.close();
  assert.equal(old.snapshot().flushTimedOut, true);
  const current = createFileBrokerDiagnostics(home, { now: () => 2 });
  const output = new PassThrough(); current.attach(output); output.end(register('222222222222'));
  await current.close();
  const before = await readFile(current.path, 'utf8');
  release(); await lateCommit;
  assert.equal(await readFile(current.path, 'utf8'), before);
  let names;
  for (let attempt = 0; attempt < 100; attempt++) {
    names = await readdir(home);
    if (!names.includes(basename(old.path))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(names, [basename(current.path)], 'late abandoned generation is removed, not republished');
});
