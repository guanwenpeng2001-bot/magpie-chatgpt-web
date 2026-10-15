import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internal } from '../src/index.mjs';
import { BackendError } from '../src/bridge.mjs';

const PROFILE_NAME = /^[a-f0-9-]{36}$/;
const CLAIM_FILE = 'signin.profile';
const claimBytes = root => readFile(join(root, CLAIM_FILE), 'utf8');
const directories = async root => (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const temporary = async () => mkdtemp(join(tmpdir(), 'magpie-signin-'));
const methodFor = (bridge, profileRoot) => _internal.createHooks({ bridge, profileRoot, pollMilliseconds: 0 }).auth.methods[0];
const source = relative => readFile(new URL(relative, import.meta.url), 'utf8');
const lifecycle = () => import('../backend/browser.mjs');

test('a retried sign-in reuses the profile directory left behind by the lapsed attempt', async () => {
  const root = await temporary();
  try {
    const accounts = [];
    const method = methodFor({ call: async command => {
      if (command.method === 'login') accounts.push(command.account);
      return { ok: true };
    } }, root);
    await method.authorize();
    await mkdir(join(root, accounts[0]));
    await method.authorize();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1], accounts[0], 'the retry opens the same Chrome profile, not a fresh one');
    assert.deepEqual(await directories(root), [accounts[0]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the pending profile survives a backend restart while the sign-in is unfinished', async () => {
  const root = await temporary();
  try {
    const accounts = [];
    const bridge = { call: async command => { if (command.method === 'login') accounts.push(command.account); return { ok: true }; } };
    const module = await lifecycle();
    assert.equal(typeof module.signinProfileClaim, 'function', 'backend/browser.mjs must export the profile-claim helper');
    await methodFor(bridge, root).authorize();
    assert.equal(accounts.length, 1);
    assert.equal((await claimBytes(root)).trim(), accounts[0], 'the pending profile is the one stored on disk');
    await methodFor(bridge, root).authorize();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1], accounts[0], 'a restarted backend resumes the stored pending profile');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a second account signs in to a fresh profile once the first sign-in succeeded', async () => {
  const root = await temporary();
  try {
    const accounts = [];
    const method = methodFor({ call: async command => {
      if (command.method === 'login') accounts.push(command.account);
      return command.method === 'loginStatus' ? { state: 'signed-in', credential: { type: 'oauth' } } : { ok: true };
    } }, root);
    assert.deepEqual(await (await method.authorize()).callback(), { type: 'success' });
    await assert.rejects(claimBytes(root), 'a completed sign-in retires its pending profile');
    await method.authorize();
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[1], accounts[0], 'a second account never inherits a signed-in profile');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cancelled sign-in keeps the pending profile for the retry', async () => {
  const root = await temporary();
  try {
    const accounts = [];
    const method = methodFor({ call: async command => {
      if (command.method === 'login') accounts.push(command.account);
      if (command.method === 'loginStatus') return { state: 'cancelled' };
      return { ok: true };
    } }, root);
    assert.equal((await (await method.authorize()).callback()).type, 'failed');
    await method.authorize();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1], accounts[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed sign-in keeps the pending profile for the retry', async () => {
  const root = await temporary();
  try {
    const accounts = [];
    const method = methodFor({ call: async command => {
      if (command.method === 'login') accounts.push(command.account);
      if (command.method === 'loginStatus') return { state: 'failed', reason: 'Fixture failure' };
      return { ok: true };
    } }, root);
    await (await method.authorize()).callback();
    await method.authorize();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1], accounts[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the pending profile is one validated name inside the profile root, never a path', async () => {
  const root = await temporary();
  try {
    const module = await lifecycle();
    assert.equal(typeof module.signinProfileClaim, 'function', 'backend/browser.mjs must export the profile-claim helper');
    const first = await module.signinProfileClaim(root);
    assert.match(first, PROFILE_NAME);
    assert.equal(first.includes('/'), false);
    assert.equal(first.includes('\\'), false);
    assert.equal(await module.signinProfileClaim(root), first);
    assert.equal((await claimBytes(root)).trim(), first);
    assert.deepEqual(await directories(root), [], 'claiming a profile does not create it');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a corrupted or hostile claim name is replaced rather than trusted', async () => {
  const root = await temporary();
  try {
    const module = await lifecycle();
    assert.equal(typeof module.signinProfileClaim, 'function', 'backend/browser.mjs must export the profile-claim helper');
    for (const planted of ['../../escape', 'a/b', '', 'name with spaces', 'x'.repeat(65), '..']) {
      await writeFile(join(root, CLAIM_FILE), planted);
      const claimed = await module.signinProfileClaim(root);
      assert.match(claimed, PROFILE_NAME, `planted claim ${JSON.stringify(planted)} must not be trusted`);
      assert.notEqual(claimed, planted);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two profile roots never share one pending claim', async () => {
  const first = await temporary();
  const second = await temporary();
  try {
    const module = await lifecycle();
    assert.equal(typeof module.signinProfileClaim, 'function', 'backend/browser.mjs must export the profile-claim helper');
    assert.notEqual(await module.signinProfileClaim(first), await module.signinProfileClaim(second));
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('the sign-in window is one single-sourced quarter hour, rendered from that source', async () => {
  const root = await temporary();
  try {
    const module = await lifecycle();
    assert.equal(typeof module.signinTimeoutWindow, 'function', 'backend/browser.mjs must export the window renderer');
    assert.equal(module.DEFAULT_SIGNIN_TIMEOUT_MS, 900_000, 'the single default is one bounded quarter hour');
    assert.equal(module.signinTimeoutWindow(root), '15 minutes');
    await rm(join(root, CLAIM_FILE), { force: true });
    assert.equal(module.signinTimeoutWindow(root), '15 minutes', 'the window is derived, never read from a profile claim');
    const shipped = await source('../backend/main.mjs');
    assert.match(shipped, /signinTimeout = DEFAULT_SIGNIN_TIMEOUT_MS/, 'the served default is the single exported source');
    assert.doesNotMatch(shipped, /signinTimeout = 3\d\d_000/, 'no second hardcoded sign-in default may remain');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a timeout names its condition and the resume recovery through the taxonomy', async () => {
  const timeout = new BackendError('signinTimeout', { values: { windowMinutes: '15 minutes' } });
  assert.equal(timeout.message, 'The sign-in window timed out after 15 minutes. Retry to resume where you left off; the previous attempt was cancelled cleanly.');
  assert.equal(timeout.status, 504);
  assert.equal(timeout.code, 'signinTimeout');
  assert.deepEqual(timeout.headers, {});
  assert.equal(BackendError.fromEnvelope(timeout.toJSON()).message, timeout.message);
});

test('no shipped source still carries the retired five-minute default or its generic wording', async () => {
  for (const relative of ['../backend/main.mjs', '../backend/browser.mjs', '../backend/guard.mjs', '../src/hooks/auth.mjs', '../src/errors.mjs']) {
    const text = await source(relative);
    assert.doesNotMatch(text, /5 minutes|five minutes|did not finish within/i, relative);
    assert.doesNotMatch(text, /signin\w*\s*=\s*3\d\d_000/i, relative);
  }
});
