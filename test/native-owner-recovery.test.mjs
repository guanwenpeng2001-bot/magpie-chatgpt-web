import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNative, stopNative } from '../src/native/index.mjs';

test('a newly bound browser queues behind startup without inheriting the old browser result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-browser-rebind-'));
  t.after(async () => { await stopNative(); await rm(root, { recursive: true, force: true }); });
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { unblock = resolve; });
  const profiles = [];
  const account = browserProfile => ({ profile: 'stable-route', browserProfile, chromeExecutablePath: 'fixture',
    context: { id: browserProfile, storageState: async () => ({}) } });
  const options = { root, install: async () => ({}),
    provision: async context => {
      profiles.push(context.id);
      if (profiles.length === 1) { entered(); await held; }
      return { tunnelId: 'fixture', runtimeKey: 'fixture', connectorId: 'fixture', linkId: 'fixture' };
    },
    createDaemon: () => ({ health: async () => true, start: async () => {}, stop: async () => {} }),
  };
  const first = ensureNative(account('old-browser'), options);
  await started;
  const second = ensureNative(account('verified-browser'), options);
  unblock();
  const [oldRuntime, newRuntime] = await Promise.all([first, second]);
  assert.notEqual(oldRuntime, newRuntime);
  assert.deepEqual(profiles, ['old-browser', 'verified-browser']);
});

for (const recovery of ['next start', 'shutdown retry']) {
  test(`failed startup retains its owner for ${recovery} after cleanup fails`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'native-owner-recovery-'));
    let held = false, cleanupFails = true, created = 0, stops = 0;
    t.after(async () => { cleanupFails = false; await stopNative(); await rm(root, { recursive: true, force: true }); });
    const account = { profile: 'fixture', chromeExecutablePath: 'fixture', context: { storageState: async () => ({}) } };
    const options = { root, install: async () => ({}),
      provision: async () => ({ tunnelId: 'fixture', runtimeKey: 'fixture', connectorId: 'fixture', linkId: 'fixture' }),
      createDaemon: () => {
        assert.equal(held, false, 'old owner must be cleaned up before creating a replacement');
        const generation = ++created;
        return {
          health: async () => false,
          async start() { held = true; if (generation === 1) throw new Error('startup failed'); },
          async stop() { stops++; if (cleanupFails) throw new Error('cleanup failed'); held = false; },
        };
      },
    };
    await assert.rejects(ensureNative(account, options));
    assert.equal(held, true);
    if (recovery === 'shutdown retry') {
      await stopNative();
      assert.equal(held, true);
    }
    cleanupFails = false;
    if (recovery === 'shutdown retry') { await stopNative(); assert.equal(held, false); }
    await ensureNative(account, options);
    assert.equal(created, 2);
    assert.ok(stops >= 2);
  });
}
