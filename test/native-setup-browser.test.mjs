import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSupervisor } from '../backend/browser.mjs';
import { runNativeSetup, readSetupStatus } from '../src/native/setup.mjs';
// A separate module instance has its own active Set, so only the real OS lease
// can exclude this contender. No browser, daemon or remote provisioner runs.
import { runNativeSetup as independentSetup } from '../src/native/setup.mjs?browser-lease-contender';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Native setup drains aborted browser cleanup before releasing process and OS ownership', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-browser-'));
  const account = { profile: 'existing-account' };
  const controller = new AbortController();
  const entered = deferred(), cleaning = deferred(), releaseCleanup = deferred();
  let cleanupFinished = false, operationWork, contenderCalls = 0;
  const browser = new BrowserSupervisor({ profileRoot: join(root, 'profiles'), idleMilliseconds: null,
    launch: async () => ({ once() {}, pages: () => [], async close() {} }) });
  const work = runNativeSetup(account, () => browser.run(account.profile, (_context, signal) => {
    operationWork = (async () => {
      try {
        const aborted = new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        entered.resolve();
        await aborted;
      } finally {
        cleaning.resolve();
        await releaseCleanup.promise;
        cleanupFinished = true;
      }
    })();
    return operationWork;
  }, controller.signal, { visibleTurns: true, settleOnAbort: true }), { root, signal: controller.signal });
  // Observe rejection immediately, including the old wrapper's premature abort.
  const outcome = work.then(value => ({ value }), error => ({ error }));
  t.after(async () => {
    controller.abort();
    releaseCleanup.resolve();
    await outcome;
    await operationWork?.catch(() => {});
    await browser.close();
    await rm(root, { recursive: true, force: true });
  });

  await entered.promise;
  controller.abort();
  await cleaning.promise;
  // Give the old implementation time to persist cancellation and close its
  // lease; the fixed wrapper must remain pending behind our explicit gate.
  const beforeCleanup = await Promise.race([outcome, delay(100).then(() => 'pending')]);
  const contender = async () => { contenderCalls++; return true; };
  const local = await runNativeSetup(account, contender, { root });
  const independent = await independentSetup(account, contender, { root });
  assert.deepEqual({ local: local.state, independent: independent.state },
    { local: 'busy', independent: 'busy' }, 'both the process guard and OS lease must survive cancellation');
  assert.equal(contenderCalls, 0);
  assert.equal(beforeCleanup, 'pending', 'the aborted wrapper must await the underlying cleanup');
  assert.equal(cleanupFinished, false);
  assert.equal((await readSetupStatus(account, { root })).state, 'busy');

  releaseCleanup.resolve();
  assert.equal((await outcome).error?.name, 'AbortError');
  assert.equal(cleanupFinished, true);
  assert.equal((await readSetupStatus(account, { root })).stage, 'cancelled');
  assert.equal((await independentSetup(account, contender, { root })).state, 'ready', 'OS lease is released after cleanup');
  assert.equal((await runNativeSetup(account, contender, { root })).state, 'ready', 'process guard is released after cleanup');
  assert.equal(contenderCalls, 2);
});
