import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeSetup, readSetupStatus } from '../src/native/setup.mjs';
import { nativeClient } from '../src/native/index.mjs';
import { usageHook } from '../src/hooks/usage.mjs';

const auth = { type: 'oauth', profile: 'same-account', refresh: 'synthetic-secret' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'setup-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home: join(root, 'accounts', auth.profile) };
}
test('failure status survives a new client and usage exposes sanitized explicit retry; success clears it', async t => {
  const { root, home } = await fixture(t);
  const failed = await runNativeSetup(auth, async stage => {
    stage('install'); throw Object.assign(new Error('synthetic-secret'), { code: 'untrusted', cause: auth });
  }, { root });
  assert.equal(failed.stage, 'install');
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret|untrusted/);
  const saved = JSON.parse(await readFile(join(home, 'setup-status.json'), 'utf8'));
  assert.deepEqual(saved, { state: 'failed', stage: 'install' });
  let calls = 0;
  const bridge = { async call(command) {
    calls++; assert.equal(command.method, 'quota', 'status read must never provision');
    return { state: 'unknown', reason: 'not-reported' };
  } };
  const native = nativeClient({ root, bridge }); // fresh facade, no process-memory failure state
  const usage = usageHook({ native, bridge });
  const result = await usage(async () => auth);
  const status = result.windows.find(row => row.name === 'Native tools setup');
  assert.match(status.display, /Install|Resume Native setup/);
  assert.equal(status.aside, true);
  assert.equal(status.used, undefined);
  assert.equal(result.signIn, 'kept');
  assert.equal(calls, 1);
  await runNativeSetup(auth, async () => {
    await writeFile(join(home, 'native.json'), JSON.stringify({ ...auth, tunnelId: 't', runtimeKey: 'k', connectorId: 'c', linkId: 'l' }));
    return true;
  }, { root });
  assert.equal((await native.status(auth)).state, 'ready');
  assert.equal((await usage(async () => auth)).windows.at(-1).display, (await native.status(auth)).message);
});

test('abort keeps ownership until underlying cleanup settles; concurrent attempts never run', async t => {
  const { root } = await fixture(t);
  const ctl = new AbortController();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const work = runNativeSetup(auth, async () => { entered(); await cleanup; return true; }, { root, signal: ctl.signal });
  const rejection = assert.rejects(work, { name: 'AbortError' });
  await started;
  assert.equal((await readSetupStatus(auth, { root })).state, 'busy');
  ctl.abort();
  assert.equal((await runNativeSetup(auth, () => assert.fail('must not start concurrently'), { root })).state, 'busy');
  release();
  await rejection;
  assert.equal((await readSetupStatus(auth, { root })).stage, 'cancelled');
  assert.equal((await runNativeSetup(auth, async () => true, { root })).state, 'ready');
});

test('persisted running status is unknown, not proof of process interruption; pre-abort never enters setup', async t => {
  const { root, home } = await fixture(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'setup-status.json'), JSON.stringify({ state: 'running', message: 'synthetic-secret' }));
  const status = await readSetupStatus(auth, { root });
  assert.match(status.message, /unknown.*may still be running/);
  assert.doesNotMatch(status.message, /was interrupted|synthetic-secret/);
  await assert.rejects(runNativeSetup(auth, () => assert.fail('pre-aborted'), { root, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
