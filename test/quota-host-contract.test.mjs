import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { _internal } from '../src/index.mjs';
import { BackendError } from '../backend/guard.mjs';

test('installed Magpie usage contract preserves unknown quota and cancellation (no host startup)', async t => {
  const path = process.env.MAGPIE_USAGE_HOST_EXE
    ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe'));
  if (!path) { t.skip('set MAGPIE_USAGE_HOST_EXE to an existing Magpie executable'); return; }
  let binary;
  try { binary = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.MAGPIE_USAGE_HOST_EXE) throw error;
    t.skip('installed Magpie absent; no download or host startup'); return;
  }
  // Read only embedded program code, not a running host or any configuration,
  // sign-in store or browser profile. Execute this one function with fixtures.
  const start = binary.indexOf('async function usageOf(provider, account, signal) {');
  const end = binary.indexOf('// ---- check-in ', start);
  assert.ok(start >= 0 && end > start && end - start < 10000, 'installed usageOf boundaries');
  assert.ok(binary.includes(Buffer.from('usage: typeof a.auth.usage === "function"')), 'host discovers auth.usage');
  let snapshot = { state: 'unknown', reason: 'not-reported', planType: 'pro' };
  const auth = { type: 'oauth', refresh: 'fixture-only', profile: 'fixture' };
  const controller = new AbortController();
  let calls = 0;
  const hooks = _internal.createHooks({ profileRoot: '/fixture', bridge: { async call(command, signal) {
    assert.equal(command.method, 'quota');
    assert.deepEqual(command.auth, auth);
    assert.equal(signal, controller.signal);
    calls++;
    if (snapshot instanceof Error) throw snapshot;
    return snapshot;
  } } });
  const usageOf = runInNewContext(binary.subarray(start, end).toString('utf8') + '\nusageOf', {
    auths: () => new Map([['chatgpt-web', { auth: hooks.auth }]]),
    accountKey: (provider, account) => { assert.equal(provider, 'chatgpt-web'); return account; },
    readAuth: () => ({ fixture: auth }),
    fresh: async () => {}, // never invoke real host refresh/models hooks
    infoOf: async () => ({ id: 'chatgpt-web', models: {} }),
    authCopy: () => structuredClone(auth),
    inScope: (_provider, _key, callback) => callback(),
  });
  for (const value of [snapshot, { state: 'unknown', reason: 'plan-not-reported' },
    new BackendError('verification'), new BackendError('expired')]) {
    snapshot = value;
    const result = await usageOf('chatgpt-web', 'fixture', controller.signal);
    assert.equal(result.windows.length, 1, 'unknown must still have a visible text window');
    assert.equal(result.windows[0].used, null, 'host must not turn unknown into 0% used');
    assert.equal(result.windows[0].balance, null);
    assert.equal(result.windows[0].aside, true);
    assert.equal(result.error, '', 'show the fixed reason as a text window, not a hidden tooltip');
    assert.match(result.windows[0].display, /^Unknown — .+/);
    assert.equal(result.signIn, value?.code === 'expired' ? 'expired' : 'kept');
    assert.equal(result.until, '');
    assert.equal(result.windows[0].resetsAt, '');
    assert.doesNotMatch(JSON.stringify(result), /fixture-only/);
  }
  assert.equal(calls, 4);
  controller.abort();
  await assert.rejects(usageOf('chatgpt-web', 'fixture', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 4, 'cancelled host reads never reach the backend');
});
