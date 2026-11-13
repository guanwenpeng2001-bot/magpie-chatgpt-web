import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { checkpointStore } from '../src/native/checkpoints.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = n => JSON.stringify(['thread', `turn-${n}`, 'chatgpt-web/gpt-6-sol', 'high']);
const entry = n => ({ summaryHash: digest(`summary-${n}`), sourceHashes: new Set([digest([`turn-${n}`, '中文任务🔧'])]),
  source: { turnId: `turn-${n}`, content: '中文任务🔧', itemId: `task-${n}` }, sourceWasSyntheticInstruction: true,
  taskMessage: { role: 'user', content: '中文任务🔧' }, taskItemId: `task-${n}` });
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'native-checkpoints-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('durable checkpoints restore Sets and Unicode across store instances without plaintext history', t => {
  const home = fixture(t), store = checkpointStore(home);
  store.map.set(scope(1), entry(1)); store.commit();
  assert.deepEqual(checkpointStore(home).map, store.map);
  const bytes = readFileSync(join(home, 'checkpoints.bin'));
  assert.equal(bytes.includes(Buffer.from('中文任务')), false);
  assert.equal(bytes.includes(Buffer.from('task-1')), false);
});

test('checkpoint writes preserve only latest scope and bounded 256-entry LRU', t => {
  const home = fixture(t), store = checkpointStore(home);
  for (let n = 0; n < 256; n++) store.map.set(scope(n), entry(n));
  store.commit();
  const first = store.map.get(scope(0)); store.map.delete(scope(0)); store.map.set(scope(0), first);
  store.map.set(scope(256), entry(256));
  store.commit();
  const restored = checkpointStore(home).map;
  assert.equal(restored.size, 256); assert.equal(restored.has(scope(1)), false); assert.equal(restored.has(scope(0)), true);
  const replaced = entry(0); replaced.summaryHash = digest('new summary');
  store.map.set(scope(0), replaced); store.commit();
  assert.equal(checkpointStore(home).map.get(scope(0)).summaryHash, replaced.summaryHash);
});

test('missing key, tampering, truncation and foreign account copies never authorize a checkpoint', t => {
  const home = fixture(t), store = checkpointStore(home);
  store.map.set(scope(1), entry(1)); store.commit();
  const file = join(home, 'checkpoints.bin'), bytes = readFileSync(file);
  const keyPath = join(home, 'checkpoints.key'), key = readFileSync(keyPath);
  for (const bad of [bytes.subarray(0, 10), Buffer.from(bytes).fill(0, bytes.length - 1), Buffer.from('{}')]) {
    writeFileSync(file, bad);
    assert.throws(() => checkpointStore(home), /Native checkpoint/);
    assert.deepEqual(readFileSync(file), bad, 'corruption must not be erased');
  }
  writeFileSync(file, bytes); rmSync(keyPath);
  assert.throws(() => checkpointStore(home), /Native checkpoint/);
  writeFileSync(keyPath, key);
  const other = fixture(t);
  copyFileSync(file, join(other, 'checkpoints.bin')); copyFileSync(keyPath, join(other, 'checkpoints.key'));
  assert.throws(() => checkpointStore(other), /Native checkpoint/);
});

test('failed durable commit rolls back in-memory authorization and permits retry', t => {
  const home = fixture(t), store = checkpointStore(home);
  store.map.set(scope(1), entry(1)); store.commit();
  const file = join(home, 'checkpoints.bin'), previous = readFileSync(file);
  rmSync(file); mkdirSync(file);
  store.map.set(scope(2), entry(2));
  assert.throws(() => store.commit(), /Native checkpoint/);
  assert.equal(store.map.has(scope(2)), false); assert.equal(store.map.has(scope(1)), true);
  rmSync(file, { recursive: true }); writeFileSync(file, previous);
  store.map.set(scope(2), entry(2)); store.commit();
  assert.equal(checkpointStore(home).map.has(scope(2)), true);
});

test('invalid scope or source digest is rejected and cannot persist authorization', t => {
  const store = checkpointStore(fixture(t));
  for (const [key, value] of [['not-json', entry(1)], [scope(1), { ...entry(1), sourceHashes: new Set([digest('forged')]) }]]) {
    store.map.set(key, value);
    assert.throws(() => store.commit(), /Native checkpoint/);
    assert.equal(store.map.size, 0);
  }
});


function ordinaryEntry(n, content) {
  return { summaryHash: digest(`summary-${n}`), sourceHashes: new Set([digest([`turn-${n}`, content])]),
    source: { turnId: `turn-${n}`, itemId: `task-${n}`, content }, sourceWasSyntheticInstruction: false };
}

test('32 MiB cumulative budget evicts least recently used ordinary tasks and permits further durable writes', t => {
  const home = fixture(t), store = checkpointStore(home);
  // Each source is 12 MiB in UTF-8 but only 4 Mi characters: enforce bytes,
  // independently of the 256-record limit and JavaScript string length.
  const content = '中'.repeat(4 * 1024 * 1024);
  assert.equal(Buffer.byteLength(content, 'utf8'), 12 * 1024 * 1024);
  store.map.set(scope(1), ordinaryEntry(1, content));
  store.map.set(scope(2), ordinaryEntry(2, content));
  store.commit();
  assert.deepEqual([...checkpointStore(home).map.keys()], [scope(1), scope(2)]);
  const touched = store.map.get(scope(1));
  store.map.delete(scope(1)); store.map.set(scope(1), touched);
  store.map.set(scope(3), ordinaryEntry(3, content));
  store.commit();
  assert.deepEqual([...store.map.keys()], [scope(1), scope(3)], 'byte eviction honors the LRU touch and protects the newest task');
  const reopened = checkpointStore(home);
  assert.deepEqual([...reopened.map.keys()], [scope(1), scope(3)]);
  assert.equal(reopened.map.get(scope(3)).source.content, content);
  assert.ok(reopened.map.get(scope(3)).sourceHashes instanceof Set);
  reopened.map.set(scope(4), ordinaryEntry(4, content));
  reopened.commit();
  const final = checkpointStore(home);
  assert.deepEqual([...final.map.keys()], [scope(3), scope(4)], 'a reopened full store must keep accepting new tasks');
  assert.equal(final.map.get(scope(4)).source.content, content);
  assert.ok(readFileSync(join(home, 'checkpoints.bin')).length <= 32 * 1024 * 1024 + 28);
});

test('a single oversized newest task rejects and restores prior authorization, disk bytes and LRU order', t => {
  const home = fixture(t), store = checkpointStore(home);
  store.map.set(scope(1), entry(1)); store.map.set(scope(2), entry(2)); store.commit();
  const file = join(home, 'checkpoints.bin'), before = readFileSync(file);
  const durable = checkpointStore(home).map;
  store.map.get(scope(1)).summaryHash = digest('uncommitted replacement');
  // Content alone reaches the limit; its valid checkpoint framing exceeds it.
  store.map.set(scope(3), ordinaryEntry(3, 'a'.repeat(32 * 1024 * 1024)));
  assert.throws(() => store.commit(), /Native checkpoint persistence unavailable/);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.map, durable, 'rollback must restore records temporarily evicted while attempting the oversized commit');
  assert.deepEqual([...store.map.keys()], [scope(1), scope(2)]);
  assert.deepEqual(checkpointStore(home).map, durable);
  store.map.set(scope(3), ordinaryEntry(3, 'small retry'));
  store.commit();
  const restored = checkpointStore(home).map;
  assert.deepEqual([...restored.keys()], [scope(1), scope(2), scope(3)]);
  assert.equal(restored.get(scope(3)).source.content, 'small retry');
});
