import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { accountContinuity, writeAccountContinuityPolicy } from '../src/native/account-continuity.mjs';
import { checkpointStore } from '../src/native/checkpoints.mjs';
import { createHistoryStore } from '../src/native/history-store.mjs';
import { captureNativeHistory } from '../src/native/history.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'native-policy-')), root = join(scratch, 'accounts');
  mkdirSync(root, { mode: 0o700 });
  const [a, b, c] = ['a', 'b', 'c'].map(profile => { const home = join(root, profile); mkdirSync(home, { mode: 0o700 }); return home; });
  t.after(() => { assert.equal(dirname(scratch), resolve(tmpdir())); rmSync(scratch, { recursive: true, force: true }); });
  return { scratch, root, a, b, c, thread: randomUUID(), turn: randomUUID() };
}
const scope = (thread, turn) => JSON.stringify([thread, turn, 'gpt-5.6-sol', 'high']);
const entry = turn => ({ summaryHash: hash('persisted summary'), sourceHashes: new Set([hash([turn, 'original task'])]),
  source: { turnId: turn, content: 'original task' }, sourceWasSyntheticInstruction: false });
const archive = home => createHistoryStore(join(home, 'history-v1'));
const record = text => ({ text, role: 'user', type: 'message' });

test('writer returns only the fixed policy env; a live reader/store discovers and removes peers without reopening', async t => {
  const { a, b, c, thread, turn } = fixture(t), key = scope(thread, turn);
  const env = await writeAccountContinuityPolicy(a, ['a']);
  assert.deepEqual(env, { MAGPIE_NATIVE_CONTINUITY_POLICY: join(a, 'continuity-policy.json') });
  const reader = accountContinuity(a, env), target = checkpointStore(a, { env });
  const peer = checkpointStore(b, { env: {} }); peer.map.set(key, entry(turn)); peer.commit();
  const excluded = checkpointStore(c, { env: {} }); excluded.map.set(scope(thread, 'excluded'), entry(turn)); excluded.commit();
  assert.deepEqual(reader.peerHomes(), []); assert.equal(target.lookup(key, 'persisted summary'), undefined);
  const sourceBytes = readFileSync(join(b, 'checkpoints.bin'));
  assert.deepEqual(await writeAccountContinuityPolicy(a, ['b', 'a']), env);
  assert.deepEqual(reader.peerHomes(), [b]);
  assert.deepEqual(target.lookup(key, 'persisted summary'), entry(turn));
  assert.equal(target.lookup(scope(randomUUID(), turn), 'persisted summary'), undefined);
  assert.equal(target.lookup(key, 'invented'), undefined);
  assert.equal(target.lookup(scope(thread, 'excluded'), 'persisted summary'), undefined);
  target.map.set(key, target.lookup(key, 'persisted summary')); target.commit();
  assert.deepEqual(readFileSync(join(b, 'checkpoints.bin')), sourceBytes);
  await writeAccountContinuityPolicy(a, ['a']);
  assert.deepEqual(reader.peerHomes(), []);
  peer.map.set(scope(thread, 'new-after-removal'), entry(turn)); peer.commit();
  assert.equal(target.lookup(scope(thread, 'new-after-removal'), 'persisted summary'), undefined);
  assert.equal(target.map.get(key).summaryHash, hash('persisted summary'), 'removing a peer does not delete already accepted local records');
});

test('the same cached native history store imports only its verified thread after a live policy update', async t => {
  const { a, b, thread } = fixture(t), env = await writeAccountContinuityPolicy(a, ['a']);
  const variables = { ...env, MAGPIE_NATIVE_CONTINUITY_ROOT: '', MAGPIE_NATIVE_CONTINUITY_PEERS: '' };
  const prior = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const other = randomUUID();
  await archive(b).append(thread, [record('ORIGINAL_FROM_NEW_PEER')]);
  await archive(b).append(other, [record('FOREIGN_THREAD_SECRET')]);
  const request = { context: {}, _rawBody: { input: 'current' }, peers: [b], threadId: other };
  const environment = { tools: [] }, identity = { threadId: thread, turnId: randomUUID() };
  await captureNativeHistory(request, environment, identity, { home: a });
  assert.deepEqual(await archive(a).search(thread, 'ORIGINAL_FROM_NEW_PEER'), []);
  await writeAccountContinuityPolicy(a, ['a', 'b']);
  await captureNativeHistory(request, environment, identity, { home: a });
  assert.equal((await archive(a).search(thread, 'ORIGINAL_FROM_NEW_PEER')).length, 1);
  assert.deepEqual(await archive(a).search(thread, 'FOREIGN_THREAD_SECRET'), []);
  assert.equal((await archive(a).stats(thread)).records, 2);
});

test('policy paths are bound to the current owner and malformed replacement never falls back to legacy peers', async t => {
  const { a, b, root } = fixture(t), env = await writeAccountContinuityPolicy(a, ['a']);
  const path = env.MAGPIE_NATIVE_CONTINUITY_POLICY, valid = readFileSync(path);
  await writeAccountContinuityPolicy(b, ['b']);
  assert.throws(() => accountContinuity(a, { MAGPIE_NATIVE_CONTINUITY_POLICY: join(b, 'continuity-policy.json') }), /continuity authority/);
  assert.throws(() => accountContinuity(a, { ...env, MAGPIE_NATIVE_CONTINUITY_ROOT: a }), /continuity authority/);
  const reader = accountContinuity(a, { ...env, MAGPIE_NATIVE_CONTINUITY_ROOT: root, MAGPIE_NATIVE_CONTINUITY_PEERS: '["a","b"]' });
  for (const bad of [Buffer.from('{'), Buffer.alloc(16385),
    ...[{ version: 2, profiles: ['a'] }, { version: 1, profiles: ['b'] }, { version: 1, profiles: ['a', '../b'] },
      { version: 1, profiles: ['a', 'a'] }, { version: 1, profiles: ['a'], root: b }].map(value => Buffer.from(JSON.stringify(value))),
  ]) {
    writeFileSync(path, bad);
    assert.throws(() => reader.peerHomes(), /continuity authority/);
    await assert.rejects(writeAccountContinuityPolicy(a, ['a', 'b']), /continuity authority/);
    assert.deepEqual(readFileSync(path), bad);
    writeFileSync(path, valid);
  }
  rmSync(path);
  assert.throws(() => reader.peerHomes(), /continuity authority/);
  await writeAccountContinuityPolicy(a, ['a', 'b']);
  assert.deepEqual(reader.peerHomes(), [b], 'an authorized writer may restore a missing file without replacing the reader');
});

test('linked policy files and redirected account directories are rejected without changing their targets', async t => {
  const { a, b, scratch } = fixture(t), env = await writeAccountContinuityPolicy(a, ['a']);
  const reader = accountContinuity(a, env), path = env.MAGPIE_NATIVE_CONTINUITY_POLICY;
  const outside = join(scratch, 'outside.json'), bytes = readFileSync(path);
  writeFileSync(outside, bytes, { mode: 0o600 });
  for (const link of [() => symlinkSync(outside, path, 'file'), () => linkSync(outside, path)]) {
    rmSync(path); link();
    assert.throws(() => reader.peerHomes(), /continuity authority/);
    await assert.rejects(writeAccountContinuityPolicy(a, ['a', 'b']), /continuity authority/);
    assert.deepEqual(readFileSync(outside), bytes);
    rmSync(path); writeFileSync(path, bytes, { mode: 0o600 });
  }
  const alias = join(dirname(b), 'alias'); symlinkSync(b, alias, 'junction');
  await assert.rejects(writeAccountContinuityPolicy(alias, ['alias']), /continuity authority/);
  assert.equal(readdirSync(b).length, 0);
});

test('writer snapshots names, serializes updates, skips identical writes and leaves no temporary files', async t => {
  const { a, b, c } = fixture(t), names = ['a'];
  const first = writeAccountContinuityPolicy(a, names); names.push('../untrusted');
  const second = writeAccountContinuityPolicy(a, ['a', 'b']);
  const third = writeAccountContinuityPolicy(a, ['c', 'b', 'a']);
  const [env] = await Promise.all([first, second, third]);
  const reader = accountContinuity(a, env), path = env.MAGPIE_NATIVE_CONTINUITY_POLICY;
  assert.deepEqual(reader.peerHomes(), [b, c]);
  const before = lstatSync(path), bytes = readFileSync(path);
  await writeAccountContinuityPolicy(a, ['b', 'a', 'c']);
  assert.equal(lstatSync(path).ino, before.ino);
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(a), ['continuity-policy.json']);
  await assert.rejects(writeAccountContinuityPolicy(a, ['b']), /continuity authority/);
  await writeAccountContinuityPolicy(a, ['a']);
  assert.deepEqual(reader.peerHomes(), []);
});

test('policy files must remain private on POSIX', { skip: process.platform === 'win32' }, async t => {
  const { a } = fixture(t), env = await writeAccountContinuityPolicy(a, ['a']);
  const reader = accountContinuity(a, env), path = env.MAGPIE_NATIVE_CONTINUITY_POLICY;
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644);
  assert.throws(() => reader.peerHomes(), /continuity authority/);
  await assert.rejects(writeAccountContinuityPolicy(a, ['a']), /continuity authority/);
});
