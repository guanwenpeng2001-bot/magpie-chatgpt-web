import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authHook } from '../src/hooks/auth.mjs';

const saved = { type: 'oauth', refresh: 'fixture-secret', profile: 'saved-native-profile', accountId: 'owner@example.test' };
async function fixture(t, key = 'chatgpt-web#saved') {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-account-signin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'plugin-auth.json');
  const save = value => writeFile(path, JSON.stringify(value));
  await save({ 'chatgpt-web#saved': saved });
  const calls = [];
  let result;
  let provision = async () => ({});
  const input = { directory, magpie: { account: () => key, option: () => false } };
  const method = authHook({ input, profileRoot: join(directory, 'profiles'), pollMilliseconds: 0,
    native: { provision: (...args) => provision(...args) },
    bridge: { async call(command) {
      calls.push(command);
      if (command.method === 'loginStatus') return { state: 'signed-in', credential: result ?? { ...saved, profile: command.account } };
      return { ok: true };
    } },
  }).methods[0];
  return { method, calls, save, directory, setResult(value) { result = value; },
    setProvision(handler) { provision = handler; input.magpie.option = () => true; } };
}

test('reauthentication reuses the selected account profile and preserves the native model route', async t => {
  const f = await fixture(t);
  const first = await f.method.authorize();
  assert.equal(f.calls[0].account, saved.profile);
  assert.equal((await first.callback()).profile, saved.profile);
  const second = await f.method.authorize();
  assert.equal((await second.callback()).profile, saved.profile);
  assert.ok(f.calls.every(call => call.account === saved.profile));
  await assert.rejects(readFile(join(f.directory, 'profiles/signin.profile')), { code: 'ENOENT' });
});

test('new-account scope retains isolated sign-in profiles', async t => {
  const f = await fixture(t, 'chatgpt-web#new');
  const flow = await f.method.authorize();
  const profile = f.calls[0].account;
  f.setResult({ ...saved, accountId: 'new@example.test', profile });
  assert.notEqual(profile, saved.profile);
  assert.match(profile, /^[a-f0-9-]{36}$/);
  assert.equal((await flow.callback()).profile, profile);
});

test('adding the same account preserves its native route and binds the verified browser in place', async t => {
  const f = await fixture(t, 'chatgpt-web#new');
  const flow = await f.method.authorize();
  const browserProfile = f.calls[0].account;
  const result = await flow.callback();
  assert.equal(result.profile, saved.profile);
  assert.equal(result.browserProfile, browserProfile);
  assert.equal(result.accountId, saved.accountId);
});

test('subsequent reauthentication uses the bound browser while retaining the native identity', async t => {
  const f = await fixture(t);
  await f.save({ 'chatgpt-web#saved': { ...saved, browserProfile: 'verified-browser' } });
  const flow = await f.method.authorize();
  assert.equal(f.calls[0].account, 'verified-browser');
  const result = await flow.callback();
  assert.equal(result.profile, saved.profile);
  assert.equal(result.browserProfile, 'verified-browser');
});

test('equivalent email casing keeps the exact saved identity used by host deduplication', async t => {
  const f = await fixture(t, 'chatgpt-web#new');
  const flow = await f.method.authorize();
  f.setResult({ ...saved, profile: f.calls[0].account, accountId: saved.accountId.toUpperCase() });
  const result = await flow.callback();
  assert.equal(result.accountId, saved.accountId);
  assert.equal(result.profile, saved.profile);
});

test('a different signed-in identity cannot replace the selected saved account', async t => {
  const f = await fixture(t);
  f.setResult({ ...saved, accountId: 'someone-else@example.test' });
  const flow = await f.method.authorize();
  await assert.rejects(flow.callback(), /different ChatGPT account/);
  assert.equal(f.calls.at(-1).method, 'logout');
});

test('a profile mismatch cannot change a native account identity', async t => {
  const f = await fixture(t);
  f.setResult({ ...saved, profile: 'other-profile' });
  const flow = await f.method.authorize();
  await assert.rejects(flow.callback(), /different ChatGPT account/);
});

for (const change of ['removed', 'profile', 'identity']) test(`sign-in rejects a concurrently ${change} account`, async t => {
  const f = await fixture(t);
  const flow = await f.method.authorize();
  await f.save(change === 'removed' ? {} : { 'chatgpt-web#saved': { ...saved,
    ...(change === 'profile' ? { profile: 'changed-profile' } : { accountId: 'changed@example.test' }) } });
  await assert.rejects(flow.callback(), /changed during sign-in/);
});

test('an invalid stored profile fails before opening a browser', async t => {
  const f = await fixture(t);
  await f.save({ 'chatgpt-web#saved': { ...saved, profile: '../foreign-profile' } });
  await assert.rejects(f.method.authorize(), /no reusable browser profile/);
  assert.equal(f.calls.length, 0);
});

for (const accountId of [undefined, '', 'chatgpt-web', 'not-an-email']) {
  test(`an unverified identity ${String(accountId)} cannot be saved or merge a native route`, async t => {
    const f = await fixture(t, 'chatgpt-web#new');
    const flow = await f.method.authorize();
    f.setResult({ ...saved, profile: f.calls[0].account, accountId });
    await assert.rejects(flow.callback(), /verified account identity/);
    assert.equal(f.calls.at(-1).method, 'logout');
  });
}

test('adding an existing account rejects a concurrent browser binding update during provisioning', async t => {
  const f = await fixture(t, 'chatgpt-web#new');
  f.setProvision(async () => {
    await f.save({ 'chatgpt-web#saved': { ...saved, browserProfile: 'newer-verified-browser' } });
    return {};
  });
  const flow = await f.method.authorize();
  await assert.rejects(flow.callback(), /binding changed during sign-in/);
});

test('adding an existing account tolerates refresh-only changes during provisioning', async t => {
  const f = await fixture(t, 'chatgpt-web#new');
  f.setProvision(async () => {
    await f.save({ 'chatgpt-web#saved': { ...saved, refresh: 'refreshed-fixture-secret' } });
    return {};
  });
  const flow = await f.method.authorize();
  const result = await flow.callback();
  assert.equal(result.profile, saved.profile);
  assert.equal(result.browserProfile, f.calls[0].account);
});
