import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internal } from '../src/index.mjs';

const auth = { type: 'oauth', refresh: 'fixture-cookie-secret', access: 'fixture-access-secret',
  profile: 'existing-profile', accountId: 'fixture@example.invalid', expires: 9000000000000 };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-setup-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'plugin-auth.json');
  const saved = { 'chatgpt-web': auth, 'chatgpt-web#other': { ...auth, profile: 'other-profile', accountId: 'other@example.invalid' } };
  await writeFile(file, JSON.stringify(saved));
  const calls = [], notices = [];
  let result = { state: 'failed', stage: 'connectorCreate' };
  const env = { profileRoot: join(directory, 'profiles'), bridge: { call() { assert.fail('recovery must not log in'); } },
    input: { directory, magpie: { account: () => 'chatgpt-web#new', option: () => true },
      client: { app: { log: async value => notices.push(value) } } },
    native: { async provision(value, signal) { calls.push({ auth: structuredClone(value), signal }); return result; } } };
  const hooks = _internal.createHooks(env);
  const method = hooks.auth.methods.find(value => /Resume Native setup/.test(value.label));
  assert.ok(method, 'existing-host OAuth recovery method must be exposed');
  return { method, hooks, env, file, saved, calls, notices, result: value => { result = value; } };
}

test('explicit existing-account recovery reports failure, then succeeds without replacing its session', async t => {
  const f = await fixture(t);
  const prompt = await f.method.ask({});
  assert.equal(prompt.type, 'select');
  assert.deepEqual(prompt.options.map(x => x.value), Object.keys(f.saved));
  assert.doesNotMatch(JSON.stringify(prompt), /fixture-cookie-secret|fixture-access-secret/);
  const inputs = { account: 'chatgpt-web' };
  const attempt = await f.method.authorize(inputs);
  assert.equal(f.calls.length, 0, 'authorize only prepares explicit callback');
  const failed = await attempt.callback();
  assert.equal(failed.type, 'failed');
  assert.match(failed.error, /connector|连接器/);
  assert.match(failed.error, /Resume Native setup/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.saved);
  f.result({ state: 'ready' });
  const again = await f.method.authorize(inputs);
  const success = await again.callback();
  assert.deepEqual(success, { ...auth, type: 'success' });
  assert.deepEqual(f.calls.map(x => x.auth), [auth, auth]);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.saved, 'host alone saves auth');
  assert.doesNotMatch(JSON.stringify(f.notices), /fixture-cookie-secret|fixture-access-secret/);
});

test('recovery refuses absent, cross-slot, disabled and replaced accounts without setup', async t => {
  const f = await fixture(t);
  assert.equal((await f.method.authorize({ account: 'foreign' })).type, 'failed');
  f.env.input.magpie.account = () => 'chatgpt-web#other';
  assert.equal((await f.method.authorize({ account: 'chatgpt-web' })).type, 'failed');
  f.env.input.magpie.account = () => 'chatgpt-web#new';
  f.env.input.magpie.option = () => false;
  assert.match((await f.method.authorize({ account: 'chatgpt-web' })).error, /enable|Enable/);
  f.env.input.magpie.option = () => true;
  const pending = await f.method.authorize({ account: 'chatgpt-web' });
  await writeFile(f.file, JSON.stringify({ ...f.saved, 'chatgpt-web': { ...auth, profile: 'replaced' } }));
  assert.equal((await pending.callback()).type, 'failed');
  assert.equal(f.calls.length, 0);
});

test('recovery passes host cancellation and never returns success after abort or leaks errors', async t => {
  const f = await fixture(t);
  const ctl = new AbortController();
  const attempt = await f.method.authorize({ account: 'chatgpt-web' }, { signal: ctl.signal });
  f.env.native.provision = async (_auth, signal) => {
    assert.equal(signal, ctl.signal);
    ctl.abort();
    return { state: 'ready' };
  };
  await assert.rejects(attempt.callback(undefined, { signal: ctl.signal }), { name: 'AbortError' });
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.saved);
  const next = await f.method.authorize({ account: 'chatgpt-web' });
  f.env.native.provision = async () => { throw new Error(auth.refresh); };
  const failed = await next.callback();
  assert.equal(failed.type, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /fixture-cookie-secret/);
});
