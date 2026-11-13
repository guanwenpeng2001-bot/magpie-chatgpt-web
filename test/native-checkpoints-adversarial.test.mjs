import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkpointStore } from '../src/native/checkpoints.mjs';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = n => JSON.stringify(['thread', `turn-${n}`, 'chatgpt-web/high', 'high']);
const entry = n => ({ summaryHash: hash(`summary-${n}`), sourceHashes: new Set([hash([`turn-${n}`, 'task'])]),
  source: { turnId: `turn-${n}`, itemId: 'task', content: 'task' }, sourceWasSyntheticInstruction: true,
  taskMessage: { role: 'user', content: 'task' }, taskItemId: 'task' });
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'checkpoint-adversarial-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function seed(home) {
  const store = checkpointStore(home);
  store.map.set(scope(1), entry(1)); store.commit();
  return store;
}
// Authenticated malformed fixtures exercise the decoder, not an AES bypass.
function seal(home, entries, version = 'magpie-native-checkpoints:1:codex-chatgpt-web:6.1.18') {
  let canonical = fs.realpathSync(home);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fs.readFileSync(join(home, 'checkpoints.key')), iv);
  cipher.setAAD(Buffer.from(`${version}\n${canonical}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
  fs.writeFileSync(join(home, 'checkpoints.bin'), Buffer.concat([iv, cipher.getAuthTag(), body]));
}

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`injected ${operation} failure preserves disk, rolls back deep mutations and permits retry`, t => {
    const home = fixture(t), store = seed(home), path = join(home, 'checkpoints.bin');
    const before = fs.readFileSync(path), original = fs[operation];
    store.map.get(scope(1)).source.content = 'uncommitted';
    store.map.get(scope(1)).sourceHashes = new Set([hash(['turn-1', 'uncommitted'])]);
    store.map.set(scope(2), entry(2));
    fs[operation] = (...args) => {
      if (operation === 'writeFileSync') original(args[0], args[1].subarray(0, 13));
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    try { assert.throws(() => store.commit(), /Native checkpoint/); }
    finally { fs[operation] = original; syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(path), before);
    assert.deepEqual(store.map, checkpointStore(home).map);
    assert.equal(store.map.get(scope(1)).source.content, 'task');
    assert.equal(fs.readdirSync(home).some(name => name.endsWith('.tmp')), false);
    store.map.set(scope(2), entry(2)); store.commit();
    assert.equal(checkpointStore(home).map.has(scope(2)), true);
  });
}

test('live commit refuses corrupted existing state and preserves forensic bytes', t => {
  const home = fixture(t), store = seed(home), path = join(home, 'checkpoints.bin');
  const damaged = Buffer.from('truncated committed state');
  fs.writeFileSync(path, damaged); store.map.set(scope(2), entry(2));
  assert.throws(() => store.commit(), /Native checkpoint/);
  assert.deepEqual(fs.readFileSync(path), damaged);
  assert.equal(store.map.has(scope(2)), false);
});

test('live commit refuses replacement by an older authenticated snapshot', t => {
  const home = fixture(t), store = seed(home), path = join(home, 'checkpoints.bin');
  const old = fs.readFileSync(path);
  store.map.set(scope(2), entry(2)); store.commit();
  fs.writeFileSync(path, old); store.map.set(scope(3), entry(3));
  assert.throws(() => store.commit(), /Native checkpoint/);
  assert.deepEqual(fs.readFileSync(path), old);
});

for (const damage of ['missing', 'truncated']) {
  test(`unchanged commit must not acknowledge ${damage} durable state`, t => {
    const home = fixture(t), store = seed(home), path = join(home, 'checkpoints.bin');
    if (damage === 'missing') fs.rmSync(path);
    else fs.writeFileSync(path, Buffer.from('truncated'));
    // The latest-entry LRU touch or an identical remembered checkpoint leaves
    // serialization unchanged. A successful commit still promises restartability.
    let rejected = false;
    try { store.commit(); } catch { rejected = true; }
    if (!rejected) assert.deepEqual(checkpointStore(home).map, store.map,
      'successful unchanged commit must leave a recoverable durable snapshot');
  });
}

test('authenticated record with missing task message content is rejected', t => {
  const home = fixture(t); seed(home);
  const value = entry(1); value.sourceHashes = [...value.sourceHashes];
  value.taskMessage = { role: 'user' };
  seal(home, [[scope(1), value]]);
  assert.throws(() => checkpointStore(home), /Native checkpoint/);
});

test('duplicate scopes, unsupported version and orphan temporary files fail closed', t => {
  const home = fixture(t); seed(home);
  const value = entry(1); value.sourceHashes = [...value.sourceHashes];
  seal(home, [[scope(1), value], [scope(1), value]]);
  assert.throws(() => checkpointStore(home), /Native checkpoint/);
  seal(home, [[scope(1), value]], 'unsupported-version');
  assert.throws(() => checkpointStore(home), /Native checkpoint/);
  fs.renameSync(join(home, 'checkpoints.bin'), join(home, '.checkpoints-orphan.tmp'));
  assert.equal(checkpointStore(home).map.size, 0);
});

test('changed key refuses commit without destroying committed ciphertext', t => {
  const home = fixture(t), store = seed(home), path = join(home, 'checkpoints.bin');
  const before = fs.readFileSync(path);
  fs.writeFileSync(join(home, 'checkpoints.key'), randomBytes(32));
  store.map.set(scope(2), entry(2));
  assert.throws(() => store.commit(), /Native checkpoint/);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.equal(store.map.has(scope(2)), false);
});

test('existing publicly readable key is rejected on POSIX', { skip: process.platform === 'win32' }, t => {
  const home = fixture(t); seed(home);
  fs.chmodSync(join(home, 'checkpoints.key'), 0o644);
  assert.throws(() => checkpointStore(home), /Native checkpoint/);
});

test('pinned streaming compaction disk failure emits failed and never completed', {
  skip: process.env.NATIVE_COMPACTION_SMOKE !== '1', timeout: 60000,
}, t => {
  const home = fixture(t);
  // Read installed code only. All state and injection artifacts live in scratch.
  const runtime = join(nativeRoot(), 'runtime-6.1.18', 'payload');
  const cli = join(runtime, 'app', 'cli.js'), bun = join(runtime, 'runtime', 'bun.exe');
  const preload = join(home, 'preload.mjs'), runner = join(home, 'runner.mjs');
  const exports = '\nexport { Cs as Worker, Ls as responseRequest, vs as close };';
  fs.writeFileSync(preload, compactionPreloadSource(cli).replace("return { contents, loader: 'js' };",
    `return { contents: contents + ${JSON.stringify(exports)}, loader: 'js' };`));
  fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
process.argv = [process.execPath, ${JSON.stringify(cli)}, '--version'];
const native = await import(${JSON.stringify(new URL('file:///' + resolve(cli).replaceAll('\\', '/')).href)});
const home = process.env.MAGPIE_NATIVE_CHECKPOINT_HOME;
native.Worker.forProvider = () => ({ appName: 'Fault fixture', async run(options) {
  await options.prepare();
  mkdirSync(join(home, 'checkpoints.bin'));
  options.onTextDelta?.('Completed synthetic checkpoint.');
  return 'Completed synthetic checkpoint.';
} });
const body = { model: 'chatgpt-web/high', stream: true,
 client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'fault-thread', turn_id: 'fault-turn' }) },
 input: [{ type: 'message', role: 'user', id: 'task', content: 'Synthetic task',
 internal_chat_message_metadata_passthrough: { turn_id: 'fault-turn', content_item_kinds: ['goal.internal_context'] } },
 { type: 'compaction_trigger' }] };
const config = { mode: 'full', subagentProtocol: 'native', contextWindow: 256000, appName: 'Fault fixture',
 browserHost: 'managed-chrome', browserInteractionMode: 'automatic', storageStatePath: join(home, 'storage.json'),
 brokerSocketPath: '\\\\\\\\.\\\\pipe\\\\checkpoint-fault-' + process.pid, solAvailable: true, proAvailable: true, extraHighAvailable: true };
try {
 const response = await native.responseRequest(new Request('http://127.0.0.1/v1/responses', {
  method: 'POST', body: JSON.stringify(body) }), config);
 const text = await response.text();
 assert.match(text, /response.failed/);
 assert.match(text, /Native checkpoint persistence unavailable/);
 assert.doesNotMatch(text, /response.completed/);
 console.log('stream disk failure verified');
} finally { await native.close(); }
`);
  const output = execFileSync(bun, ['--preload', preload, runner], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, 'codex'), MAGPIE_NATIVE_CHECKPOINT_HOME: home },
    windowsHide: true, timeout: 45000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /stream disk failure verified/);
});
