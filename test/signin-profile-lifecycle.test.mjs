import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
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

function claimant(root) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    const { signinProfileClaim } = await import(process.argv[2]);
    process.stdin.once('data', async () => {
      try { console.log(JSON.stringify({ account: await signinProfileClaim(process.argv[1]) })); }
      catch (error) { console.log(JSON.stringify({ error: error.code })); }
    });
    process.stdin.resume();
  `, root, new URL('../backend/browser.mjs', import.meta.url).href], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function claimInProcess(root) {
  const child = claimant(root);
  const answer = once(child.stdout, 'data');
  child.stdin.write('go');
  const result = JSON.parse(String((await answer)[0]));
  const exit = once(child, 'exit');
  child.stdin.end();
  await exit;
  return result;
}

async function foreignBind(root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    import { createHash } from 'node:crypto';
    import { resolve } from 'node:path';
    const root = resolve(process.argv[1]);
    const identity = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
    const slash = String.fromCharCode(92);
    const address = process.platform === 'win32'
      ? slash + slash + '.' + slash + 'pipe' + slash + 'magpie-signin-' + identity
      : String.fromCharCode(0) + 'magpie-signin-' + identity;
    const server = createServer();
    server.once('error', error => console.log(error.code));
    server.listen(address, () => server.close(() => console.log('released')));
  `, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  assert.equal((await once(child, 'exit'))[0], 0);
  return output.trim();
}

for (const check of ['ownership', 'retirement']) test('N1 overlapping sign-ins preserve ' + check, async () => {
  const root = await temporary();
  const first = methodFor({ call: async command => command.method === 'loginStatus' ? { state: 'timeout' } : { ok: true } }, root);
  const second = methodFor({ call: async command => command.method === 'loginStatus' ? { state: 'signed-in', credential: { profile: command.account } } : { ok: true } }, root);
  let later;
  try {
    const earlier = await first.authorize();
    later = await second.authorize();
    const pending = await claimBytes(root);
    assert.equal((await earlier.callback()).type, 'failed');
    if (check === 'ownership') {
      assert.equal(await foreignBind(root), 'EADDRINUSE', 'second sign-in must retain the OS lock');
      assert.notEqual((await claimInProcess(root)).account, pending, 'foreign process must not adopt the second sign-in profile');
    }
    assert.equal((await later.callback()).type, 'success');
    later = undefined;
    await assert.rejects(claimBytes(root), { code: 'ENOENT' }, 'second success must retire the pending claim');
    assert.equal(await foreignBind(root), 'released', 'last release closes the OS lock');
    assert.ok((await claimInProcess(root)).account, 'last release permits a new claimant');
  } finally {
    if (later) await later.callback().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('N1 overlapping successes cannot retire a newer pending profile', async () => {
  const root = await temporary();
  const method = methodFor({ call: async command => command.method === 'loginStatus'
    ? { state: 'signed-in', credential: { profile: command.account } } : { ok: true } }, root);
  try {
    const first = await method.authorize();
    const second = await method.authorize();
    const original = await claimBytes(root);
    assert.equal((await first.callback()).type, 'success');
    const third = await method.authorize();
    const newer = await claimBytes(root);
    assert.notEqual(newer, original);
    assert.equal((await second.callback()).type, 'success');
    assert.equal(await claimBytes(root), newer);
    await first.callback();
    assert.equal(await claimBytes(root), newer);
    assert.equal(await foreignBind(root), 'EADDRINUSE');
    assert.equal((await third.callback()).type, 'success');
    await assert.rejects(claimBytes(root), { code: 'ENOENT' });
    assert.equal(await foreignBind(root), 'released');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('N2 absent pending claim still delivers the successful credential', async () => {
  const root = await temporary();
  try {
    const method = methodFor({ call: async command => command.method === 'loginStatus'
      ? { state: 'signed-in', credential: { profile: command.account } } : { ok: true } }, root);
    const flow = await method.authorize();
    await rm(join(root, CLAIM_FILE));
    let result;
    await assert.doesNotReject(async () => { result = await flow.callback(); }, 'an absent claim is already retired');
    assert.equal(result.type, 'success');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F1 a retire failure prevents credential delivery', async () => {
  const root = await temporary();
  const original = fs.rmSync;
  try {
    const method = methodFor({ call: async command => command.method === 'loginStatus'
      ? { state: 'signed-in', credential: { type: 'oauth', profile: 'fixture' } } : { ok: true } }, root);
    const flow = await method.authorize();
    fs.rmSync = (path, options) => {
      if (String(path) === join(root, CLAIM_FILE)) throw Object.assign(new Error('fixture lock'), { code: 'EBUSY' });
      return original(path, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(flow.callback(), { code: 'browserConfiguration' }, 'retire failure must prevent success');
    const pending = await claimBytes(root);
    fs.rmSync = original;
    syncBuiltinESMExports();
    assert.equal((await (await method.authorize()).callback()).type, 'success');
    await assert.rejects(claimBytes(root), { code: 'ENOENT' });
    assert.notEqual((await claimInProcess(root)).account, pending, 'after success a restarted host cannot adopt the retired profile');
  } finally {
    fs.rmSync = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('F3 missing root persists the claim across real process restarts', async () => {
  const parent = await temporary();
  const root = join(parent, 'missing', 'profiles');
  try {
    const first = await claimInProcess(root);
    const second = await claimInProcess(root);
    assert.ok(first.account);
    assert.equal(second.account, first.account, 'fresh-install retry must resume across processes');
    assert.equal(await claimBytes(root), first.account);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('F2 two racing processes have exactly one adopter', async () => {
  const root = await temporary();
  await writeFile(join(root, CLAIM_FILE), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const children = [claimant(root), claimant(root)];
  try {
    const answers = children.map(child => once(child.stdout, 'data'));
    for (const child of children) child.stdin.write('go');
    const results = (await Promise.all(answers)).map(chunks => JSON.parse(String(chunks[0])));
    const persisted = await claimBytes(root);
    assert.equal(results.filter(result => result.account === persisted).length, 1, 'only one process may adopt a pending profile');
    assert.equal(new Set(results.map(result => result.account)).size, 2, 'the contender gets a fresh profile');
  } finally {
    const exits = children.map(child => once(child, 'exit'));
    for (const child of children) child.stdin.end();
    await Promise.all(exits);
    await rm(root, { recursive: true, force: true });
  }
});

test('F2 a killed holder releases ownership for a restarted process', async () => {
  const root = await temporary();
  const child = claimant(root);
  try {
    const answer = once(child.stdout, 'data');
    child.stdin.write('go');
    const first = JSON.parse(String((await answer)[0]));
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const resumed = await claimInProcess(root);
    assert.equal(resumed.account, first.account);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test('F4 cleanup identifies credential references and pending claims', async () => {
  const readme = await source('../README.md');
  assert.match(readme, /plugin-auth\.json/);
  assert.match(readme, /`profile`/);
});

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
      assert.equal((await claimBytes(root)).trim(), claimed, 'every planted value must be replaced on disk');
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
