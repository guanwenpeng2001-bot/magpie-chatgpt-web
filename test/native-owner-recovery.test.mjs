import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNative, stopNative } from '../src/native/index.mjs';

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
