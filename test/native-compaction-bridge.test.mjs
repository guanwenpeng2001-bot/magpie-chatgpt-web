import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Bridge } from '../src/bridge.mjs';
import { compactionProxy } from '../src/native/compaction.mjs';

test('real backend child survives metadata diagnostics during HTTP compaction and later RPCs', { timeout: 10000 }, async t => {
  const bridge = new Bridge({ backend: fileURLToPath(new URL('./fixtures/native-compaction-bridge-fixture.mjs', import.meta.url)) });
  t.after(() => bridge.dispose());
  const descriptor = await bridge.call({ method: 'fixtureDescriptor' });
  const compact = compactionProxy(descriptor);
  const headers = { 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'compaction', thread_id: 'fixture', turn_id: 'turn' }) };
  for (let i = 0; i < 2; i++) {
    const response = await compact({ input: [], stream: false }, headers, AbortSignal.timeout(3000));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fixtureMetadataPresent, true);
    assert.deepEqual(await bridge.call({ method: 'fixtureAlive' }), { alive: true });
  }
});

test('stdout diagnostic control reproduces backend termination and connection reset', { timeout: 10000 }, async t => {
  const bridge = new Bridge({ backend: fileURLToPath(new URL('./fixtures/native-compaction-bridge-fixture.mjs', import.meta.url)),
    spawnProcess: (command, args, options) => spawn(command, args, { ...options,
      env: { ...options.env, METADATA_STDOUT_CONTROL: '1' } }) });
  t.after(() => bridge.dispose());
  const descriptor = await bridge.call({ method: 'fixtureDescriptor' });
  await assert.rejects(compactionProxy(descriptor)({ input: [], stream: false }, {
    'x-codex-turn-metadata': JSON.stringify({ request_kind: 'compaction' }),
  }, AbortSignal.timeout(3000)), error => error instanceof TypeError);
});
