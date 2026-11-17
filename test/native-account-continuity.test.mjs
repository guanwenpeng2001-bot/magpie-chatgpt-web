import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { accountContinuity, patchNativeAccountContinuity } from '../src/native/account-continuity.mjs';
import { checkpointStore } from '../src/native/checkpoints.mjs';
import { createHistoryStore } from '../src/native/history-store.mjs';
import { captureNativeHistory } from '../src/native/history.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = (thread, turn, model = 'gpt-5.6-sol', effort = 'high') => JSON.stringify([thread, turn, model, effort]);
const record = text => ({ text, role: 'user', type: 'message' });
const checkpoint = (turn, summary, content = 'original task') => ({ summaryHash: digest(summary),
  source: { turnId: turn, itemId: 'task', content }, sourceHashes: new Set([digest([turn, content])]), sourceWasSyntheticInstruction: false });
const history = home => createHistoryStore(join(home, 'history-v1'));
const historyFile = (home, thread) => join(home, 'history-v1', 'history', thread + '.bin');

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'native-continuity-'));
  t.after(() => { assert.equal(dirname(scratch), resolve(tmpdir())); rmSync(scratch, { recursive: true, force: true }); });
  const root = join(scratch, 'accounts'); mkdirSync(root, { mode: 0o700 });
  const homes = ['a', 'b', 'c'].map(name => { const home = join(root, name); mkdirSync(home, { mode: 0o700 }); return home; });
  const env = { MAGPIE_NATIVE_CONTINUITY_ROOT: root, MAGPIE_NATIVE_CONTINUITY_PEERS: JSON.stringify(['a', 'b']) };
  return { root, scratch, homes, env, thread: randomUUID(), turn: randomUUID() };
}
function usePolicy(t, env) {
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
function seed(home, key, value) {
  const store = checkpointStore(home, { env: {} }); store.map.set(key, value); store.commit(); return store;
}
function capture(home, thread, text, extra = {}) {
  const environment = { tools: [] }, request = { context: {}, _rawBody: { input: text }, ...extra };
  return { environment, request, run: () => captureNativeHistory(request, environment, { threadId: thread, turnId: randomUUID() }, { home }) };
}

test('continuity requires paired daemon authority, exact membership and unlinked account paths', t => {
  const { root, scratch, homes: [a, b, c], env } = fixture(t);
  assert.equal(accountContinuity(a, {}), null);
  assert.deepEqual(accountContinuity(a, env).peerHomes(), [b]);
  for (const bad of [
    { MAGPIE_NATIVE_CONTINUITY_ROOT: root }, { MAGPIE_NATIVE_CONTINUITY_PEERS: '["a"]' },
    { ...env, MAGPIE_NATIVE_CONTINUITY_ROOT: 'relative' },
    ...['["a","../c"]', '["a","a"]', '["a","b/c"]', '["b"]', '{}'].map(peers => ({ ...env, MAGPIE_NATIVE_CONTINUITY_PEERS: peers })),
  ]) assert.throws(() => accountContinuity(a, bad), /continuity authority/);
  assert.throws(() => accountContinuity(c, env), /continuity authority/);
  assert.throws(() => accountContinuity(scratch, env), /continuity authority/);
  rmdirSync(b); symlinkSync(c, b, 'junction');
  assert.throws(() => accountContinuity(a, env).peerHomes(), /continuity authority/);
  rmSync(b); // Missing allowlisted accounts do not get created by reads.
  assert.deepEqual(accountContinuity(a, env).peerHomes(), []);
  assert.equal(existsSync(b), false);
});

test('exact-scope lookup returns only committed peer authority and re-encrypts on pinned acceptance', t => {
  const { homes: [a, b, c], env, thread, turn } = fixture(t), key = scope(thread, turn);
  const source = seed(a, key, checkpoint(turn, 'summary one'));
  source.map.set(scope(thread, 'uncommitted'), checkpoint(turn, 'never committed'));
  seed(c, scope(thread, 'excluded'), checkpoint(turn, 'not eligible'));
  const before = readFileSync(join(a, 'checkpoints.bin'));
  const target = checkpointStore(b, { env });
  assert.equal(target.map.size, 0);
  const found = target.lookup(key, 'summary one');
  assert.deepEqual(found, checkpoint(turn, 'summary one'));
  assert.equal(target.map.size, 0, 'lookup itself cannot authorize/persist a summary');
  assert.equal(existsSync(join(b, 'checkpoints.bin')), false);
  for (const [wrongScope, text] of [
    [scope(randomUUID(), turn), 'summary one'], [scope(thread, randomUUID()), 'summary one'],
    [scope(thread, turn, 'other-model'), 'summary one'], [scope(thread, turn, 'gpt-5.6-sol', 'max'), 'summary one'],
    [key, 'client invented summary'], [scope(thread, 'uncommitted'), 'never committed'], [scope(thread, 'excluded'), 'not eligible'],
  ]) assert.equal(target.lookup(wrongScope, text), undefined);
  assert.equal(checkpointStore(b, { env: {} }).lookup(key, 'summary one'), undefined);
  target.map.set(key, found); target.commit();
  assert.deepEqual(checkpointStore(b, { env: {} }).map.get(key), checkpoint(turn, 'summary one'));
  assert.notDeepEqual(readFileSync(join(b, 'checkpoints.key')), readFileSync(join(a, 'checkpoints.key')));
  assert.deepEqual(readFileSync(join(a, 'checkpoints.bin')), before);
  found.source.content = 'mutated caller copy';
  assert.equal(checkpointStore(a, { env: {} }).map.get(key).source.content, 'original task');
});

test('repeated compactions choose the exact summary even with a stale local checkpoint; pre-turn scans stay scoped', t => {
  const { homes: [a, b], env, thread, turn } = fixture(t), key = scope(thread, turn);
  seed(a, key, checkpoint(turn, 'first'));
  const source = checkpointStore(a, { env });
  seed(b, key, checkpoint(turn, 'first'));
  const target = checkpointStore(b, { env });
  source.map.set(key, checkpoint(turn, 'second')); source.commit();
  assert.equal(target.lookup(key, 'second').summaryHash, digest('second'));
  assert.equal(target.lookup(key, 'first'), undefined, 'a stale peer must not revive a superseded summary');
  const preTurn = scope(thread, randomUUID());
  source.map.set(scope(randomUUID(), turn), checkpoint(turn, 'foreign'));
  source.map.set(scope(thread, turn, 'other-model'), checkpoint(turn, 'other model'));
  source.commit();
  assert.deepEqual(target.scopes(preTurn), [key]);
  target.map.set(key, target.lookup(key, 'second')); target.commit();
  const next = checkpointStore(a, { env });
  target.map.set(key, checkpoint(turn, 'third')); target.commit();
  assert.equal(next.lookup(key, 'third').summaryHash, digest('third'), 'A -> B -> A needs no shared registry or peer cache');
});

test('matching summaries with inconsistent source authority reject; stale target commit cannot overwrite another writer', t => {
  const { homes: [a, b], env, thread, turn } = fixture(t), key = scope(thread, turn);
  seed(a, key, checkpoint(turn, 'same', 'source A'));
  seed(b, key, checkpoint(turn, 'same', 'source B'));
  const target = checkpointStore(b, { env });
  const before = readFileSync(join(b, 'checkpoints.bin'));
  assert.throws(() => target.lookup(key, 'same'), /checkpoint persistence/);
  assert.deepEqual(readFileSync(join(b, 'checkpoints.bin')), before);
  const current = checkpointStore(b, { env: {} });
  const another = scope(thread, randomUUID());
  current.map.set(another, checkpoint(turn, 'concurrent')); current.commit();
  const newest = readFileSync(join(b, 'checkpoints.bin'));
  target.map.set(key, checkpoint(turn, 'stale writer'));
  assert.throws(() => target.commit(), /checkpoint persistence/);
  assert.deepEqual(readFileSync(join(b, 'checkpoints.bin')), newest);
  assert.equal(target.map.get(key).summaryHash, digest('same'));
});

test('peer advancement during compaction rejects a stale parent and requires authenticated adoption', t => {
  const { homes: [a, b], env, thread, turn } = fixture(t), key = scope(thread, turn);
  const left = checkpointStore(a, { env }), right = checkpointStore(b, { env });
  left.map.set(key, checkpoint(turn, 'first')); left.commit();
  right.map.set(key, right.lookup(key, 'first')); right.commit();
  const stale = checkpointStore(a, { env });
  right.map.set(key, checkpoint(turn, 'second')); right.commit();
  const before = readFileSync(join(a, 'checkpoints.bin'));
  stale.map.set(key, checkpoint(turn, 'stale concurrent result'));
  assert.throws(() => stale.commit(), /checkpoint persistence/);
  assert.deepEqual(readFileSync(join(a, 'checkpoints.bin')), before);
  assert.equal(stale.map.get(key).continuityGeneration, 1);
  stale.map.set(key, stale.lookup(key, 'second')); stale.commit();
  stale.map.set(key, checkpoint(turn, 'third after adoption')); stale.commit();
  assert.equal(stale.map.get(key).continuityGeneration, 3);
  assert.equal(right.lookup(key, 'first'), undefined);
  assert.equal(right.lookup(key, 'third after adoption').continuityGeneration, 3);
});

test('concurrent same-generation branches fail closed, while a newer consistent generation supersedes older conflicts', t => {
  const { homes: [a, b, c], env, thread, turn } = fixture(t), key = scope(thread, turn);
  seed(a, key, { ...checkpoint(turn, 'branch A'), continuityGeneration: 1 });
  seed(b, key, { ...checkpoint(turn, 'branch B'), continuityGeneration: 1 });
  const target = checkpointStore(c, { env: { ...env, MAGPIE_NATIVE_CONTINUITY_PEERS: '["a","b","c"]' } });
  assert.throws(() => target.lookup(key, 'branch A'), /checkpoint persistence/);
  assert.throws(() => target.lookup(key, 'branch B'), /checkpoint persistence/);
  assert.equal(target.map.size, 0);
  seed(c, key, { ...checkpoint(turn, 'later committed'), continuityGeneration: 2 });
  const newest = checkpointStore(c, { env: { ...env, MAGPIE_NATIVE_CONTINUITY_PEERS: '["a","b","c"]' } });
  assert.equal(newest.lookup(key, 'later committed').continuityGeneration, 2);
  assert.equal(newest.lookup(key, 'branch A'), undefined);
});

for (const damage of ['ciphertext', 'missing key', 'foreign copy']) test(`peer ${damage} cannot authorize and is never repaired by import`, t => {
  const { homes: [a, b, c], env, thread, turn } = fixture(t), key = scope(thread, turn);
  seed(a, key, checkpoint(turn, 'summary'));
  if (damage === 'ciphertext') writeFileSync(join(a, 'checkpoints.bin'), Buffer.alloc(30));
  if (damage === 'missing key') rmSync(join(a, 'checkpoints.key'));
  if (damage === 'foreign copy') {
    seed(c, key, checkpoint(turn, 'summary'));
    for (const file of ['checkpoints.key', 'checkpoints.bin']) copyFileSync(join(c, file), join(a, file));
  }
  const before = readFileSync(join(a, 'checkpoints.bin'));
  const target = checkpointStore(b, { env });
  assert.throws(() => target.lookup(key, 'summary'), /checkpoint persistence/);
  assert.equal(target.map.size, 0);
  assert.deepEqual(readFileSync(join(a, 'checkpoints.bin')), before);
  assert.equal(existsSync(join(b, 'checkpoints.bin')), false);
});

test('history import keeps a multi-megabyte original, deduplicates and reads only the verified thread', async t => {
  const { homes: [a, b, c], env, thread } = fixture(t); usePolicy(t, env);
  const first = 'EARLY_NEEDLE ' + '历史🔧\r\n'.repeat(400_000) + ' LATE_NEEDLE';
  assert.ok(Buffer.byteLength(first) > 4 * 1024 * 1024);
  await history(a).append(thread, [record(first), record('duplicate')]);
  await history(b).append(thread, [record('duplicate')]);
  await history(c).append(thread, [record('excluded peer')]);
  const foreign = randomUUID();
  await history(a).append(foreign, [record('other chat secret')]);
  writeFileSync(historyFile(a, foreign), Buffer.from('corrupt other chat must never be opened'));
  const before = readFileSync(historyFile(a, thread)), originalKey = readFileSync(join(a, 'history-v1', 'history.key'));
  const active = capture(b, thread, 'current continuation'); await active.run();
  const store = history(b);
  assert.equal((await store.stats(thread)).records, 3);
  for (const query of ['EARLY_NEEDLE', 'LATE_NEEDLE']) assert.equal((await store.search(thread, query)).length, 1);
  assert.equal((await store.snapshot(thread)).find(row => row.text.startsWith('EARLY')).text, first);
  assert.deepEqual(await store.search(thread, '"other chat secret"'), []);
  assert.deepEqual(await store.search(thread, '"excluded peer"'), []);
  assert.deepEqual(readFileSync(historyFile(a, thread)), before);
  assert.deepEqual(readFileSync(join(a, 'history-v1', 'history.key')), originalKey);
  assert.notDeepEqual(readFileSync(join(b, 'history-v1', 'history.key')), originalKey);
  const targetBefore = readFileSync(historyFile(b, thread));
  await active.run(); assert.deepEqual(readFileSync(historyFile(b, thread)), targetBefore);
});

test('read-only history snapshots create nothing, refuse writes and keep account/thread AAD', async t => {
  const { scratch, homes: [a, b], thread } = fixture(t);
  const root = join(a, 'history-v1'), reader = createHistoryStore(root, { readOnly: true });
  assert.deepEqual(await reader.snapshot(thread), []);
  assert.deepEqual(readdirSync(a), []);
  await assert.rejects(reader.append(thread, [record('cannot write')]), { code: 'ERR_HISTORY_READ_ONLY' });
  await history(a).append(thread, [record('secret')]);
  await history(b).append(thread, [record('target')]);
  for (const [from, to] of [[join(root, 'history.key'), join(b, 'history-v1', 'history.key')],
    [historyFile(a, thread), historyFile(b, thread)]]) copyFileSync(from, to);
  await assert.rejects(createHistoryStore(join(b, 'history-v1'), { readOnly: true }).snapshot(thread), { code: 'ERR_HISTORY_CRYPTO' });
  const other = randomUUID(); copyFileSync(historyFile(a, thread), historyFile(a, other));
  await assert.rejects(reader.snapshot(other), { code: 'ERR_HISTORY_CRYPTO' });
  const alias = join(scratch, 'alias'); symlinkSync(a, alias, 'junction');
  await assert.rejects(createHistoryStore(join(alias, 'history-v1'), { readOnly: true }).snapshot(thread), { code: 'ERR_HISTORY_PATH' });
});

test('reciprocal imports and concurrent local appends preserve the union without nested account queue locks', async t => {
  const { homes: [a, b], thread } = fixture(t), left = history(a), right = history(b);
  await left.append(thread, [record('left')]); await right.append(thread, [record('right')]);
  const readLeft = createHistoryStore(join(a, 'history-v1'), { readOnly: true });
  const readRight = createHistoryStore(join(b, 'history-v1'), { readOnly: true });
  await Promise.all([left.appendFrom(thread, [readRight], [record('left new')]),
    right.appendFrom(thread, [readLeft], [record('right new')]), right.append(thread, [record('local simultaneous')])]);
  const leftTexts = new Set((await left.snapshot(thread)).map(row => row.text));
  const rightTexts = new Set((await right.snapshot(thread)).map(row => row.text));
  for (const text of ['left', 'right', 'left new']) assert.equal(leftTexts.has(text), true);
  for (const text of ['left', 'right', 'right new', 'local simultaneous']) assert.equal(rightTexts.has(text), true);
});

test('cross-peer duplicate records are counted once before the 16384-record limit', async t => {
  const { homes: [a, b, c], thread } = fixture(t), records = Array.from({ length: 16384 }, (_, i) => record('record ' + i));
  await history(a).append(thread, records); await history(b).append(thread, records);
  const target = history(c), peers = [a, b].map(home => createHistoryStore(join(home, 'history-v1'), { readOnly: true }));
  await target.appendFrom(thread, peers, [records[0]]);
  assert.equal((await target.stats(thread)).records, 16384);
  const before = readFileSync(historyFile(c, thread));
  await assert.rejects(target.appendFrom(thread, peers, [record('overflow')]), { code: 'ERR_HISTORY_LIMIT' });
  assert.deepEqual(readFileSync(historyFile(c, thread)), before);
});

test('combined history byte capacity rejects atomically before compaction and leaves no new scope or guidance', async t => {
  const { homes: [a, b], env, thread } = fixture(t); usePolicy(t, env);
  await history(a).append(thread, [record('a'.repeat(17 * 1024 * 1024))]);
  await history(b).append(thread, [record('b'.repeat(16 * 1024 * 1024))]);
  const before = readFileSync(historyFile(b, thread));
  const active = capture(b, thread, 'must not append');
  await assert.rejects(active.run(), { code: 'history_capacity_exceeded', status: 413 });
  assert.deepEqual(readFileSync(historyFile(b, thread)), before);
  assert.equal(active.request.context.systemPrompt, undefined);
  const compaction = capture(b, thread, 'must not compact', { _compactionRequest: true });
  await assert.rejects(captureNativeHistory(compaction.request, undefined, { threadId: thread, turnId: randomUUID() }, {
    home: b, verifyCompaction: () => compaction.environment,
  }), { code: 'history_capacity_exceeded' });
  assert.deepEqual(readFileSync(historyFile(b, thread)), before);
});

test('existing unreadable peer history fails closed, while client continuity fields cannot enable sharing', async t => {
  const { homes: [a, b], env, thread } = fixture(t);
  const empty = { MAGPIE_NATIVE_CONTINUITY_ROOT: '', MAGPIE_NATIVE_CONTINUITY_PEERS: '' }; usePolicy(t, empty);
  await history(a).append(thread, [record('peer secret')]);
  const forged = capture(b, thread, 'current', { client_metadata: env, peers: [a], root: env.MAGPIE_NATIVE_CONTINUITY_ROOT });
  await forged.run(); assert.deepEqual(await history(b).search(thread, '"peer secret"'), []);
  // A distinct destination avoids reconfiguring an already running daemon policy.
  const d = join(env.MAGPIE_NATIVE_CONTINUITY_ROOT, 'd'); mkdirSync(d, { mode: 0o700 });
  Object.assign(process.env, { ...env, MAGPIE_NATIVE_CONTINUITY_PEERS: '["a","d"]' });
  rmSync(join(a, 'history-v1', 'history.key'));
  const active = capture(d, thread, 'must not persist');
  await assert.rejects(active.run(), { code: 'history_archive_unavailable' });
  assert.equal(existsSync(historyFile(d, thread)), false);
  assert.equal(active.request.context.systemPrompt, undefined);
});

test('pinned continuity transform rejects missing persistence, drift and duplicate application', () => {
  const source = 'var magpieCheckpointPersistence=null;' +
    'function yi(e,t){let n=ss(e,t),r=n?Kt.get(n):void 0;if(!n||!r)return;return s!==null&&px(n,r,s)?{checkpoint:r,summaryIndex:i}:void 0}' +
    'function Lh(){for(let o of[...Kt.keys()]){let[i,a]=JSON.parse(o);}}';
  const patched = patchNativeAccountContinuity(source);
  assert.match(patched, /magpieCheckpointPersistence.lookup\(n,s\)/);
  assert.match(patched, /magpieCheckpointPersistence.scopes\(n\)/);
  assert.throws(() => patchNativeAccountContinuity(patched), /anchor mismatch/);
  assert.throws(() => patchNativeAccountContinuity(source.replace('Kt.get(n)', 'Kt.get(x)')), /anchor mismatch/);
  assert.throws(() => patchNativeAccountContinuity(source.replace('var magpieCheckpointPersistence=', 'var absent=')), /anchor mismatch/);
});
