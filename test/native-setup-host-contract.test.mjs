import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { _internal } from '../src/index.mjs';

for (const [label, executable] of [
  ['installed executable', process.env.MAGPIE_USAGE_HOST_EXE
    ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe'))],
  ['running 0.1.3930 host bundle', join(homedir(), '.cache/magpie/plugin-host/host-e6801c6cb0f6.js')],
]) test(`${label} awaits recovery ask and saves/settles into the existing account, including cancellation`, async t => {
  let binary;
  try { binary = await readFile(executable); }
  catch (error) {
    if (process.env.MAGPIE_USAGE_HOST_EXE || error.code !== 'ENOENT') throw error;
    t.skip('installed Magpie absent; no host startup/download'); return;
  }
  // The executable also embeds unrelated browser functions named settle.
  const hostStart = binary.indexOf('function accountsOf(all, provider) {');
  assert.ok(hostStart >= 0);
  binary = binary.subarray(hostStart);
  // Run only these verbatim host functions with a synthetic auth store and
  // transport. No real host, browser, account store, configuration or fetch.
  const names = ['accountsOf', 'whoOf', 'secretOf', 'uidOf', 'renamedBy', 'settle', 'save',
    'keyFor', 'inScope', 'signInKey', 'freshKey', 'nextPrompt', 'authorize', 'callback', 'signingIn', 'failed', 'abortedSignIn'];
  if (binary.includes(Buffer.from('function keptAs(r) {'))) names.push('keptAs');
  const source = names.map(name => {
    const marker = `function ${name}(`;
    let start = binary.indexOf(marker);
    assert.ok(start >= 0, `installed host ${name}`);
    if (binary.subarray(start - 6, start).toString() === 'async ') start -= 6;
    const end = binary.indexOf('\n}', start) + 2;
    assert.ok(end > start && end - start < 10000);
    return binary.subarray(start, end).toString();
  }).join('\n');
  const directory = await mkdtemp(join(tmpdir(), 'setup-host-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'plugin-auth.json');
  const auth = { type: 'oauth', refresh: 'fixture-cookie', access: 'fixture-access', expires: 9e12,
    accountId: 'one@example.invalid', profile: 'original-profile' };
  const original = { 'chatgpt-web': auth, 'chatgpt-web#other': { ...auth, refresh: 'other-cookie',
    accountId: 'two@example.invalid', profile: 'other-profile' } };
  let stored = structuredClone(original);
  const persist = async () => writeFile(file, JSON.stringify(stored));
  await persist();
  const scope = new AsyncLocalStorage(), signInSignal = new AsyncLocalStorage(), via = new AsyncLocalStorage();
  const controller = new AbortController();
  let result = { state: 'failed', stage: 'connectorCreate' }, cancel = false, calls = 0;
  const env = { input: { directory, magpie: { option: () => true, account: () => scope.getStore().key } },
    native: { async provision(selected, signal) {
      calls++;
      assert.deepEqual(selected, auth);
      assert.equal(signal, controller.signal, 'actual host callback supplies the cancellation signal');
      if (cancel) controller.abort();
      return result;
    } } };
  const hooks = _internal.createHooks(env);
  const host = runInNewContext(source + '\n({ nextPrompt, authorize, callback })', {
    scope, signInSignal, via, sessions: new Map(), nextSession: 1, DOMException,
    authOf: () => hooks.auth, readAuth: () => stored, providerOf: key => key.split('#')[0],
    bounded: async promise => promise, // host wrapper's own post-callback abort guard is under test
    setAuth: async (key, value) => { stored[key] = value; await persist(); },
    changeAuth: async update => { const result = update(stored); await persist(); return result; },
    forgetAccount() {}, send() {},
  });
  const prompt = await host.nextPrompt('chatgpt-web', 1, {});
  assert.equal(prompt.type, 'select');
  assert.deepEqual(prompt.options.map(row => row.value), Object.keys(original));
  const start = () => host.authorize({ provider: 'chatgpt-web', method: 1,
    inputs: { account: 'chatgpt-web' }, account: 'new' }, controller.signal);
  const first = await start();
  assert.equal(first.ok, true);
  assert.equal((await host.callback({ session: first.session }, controller.signal)).ok, false);
  assert.deepEqual(stored, original, 'failed recovery saves no new slot');
  result = { state: 'ready' };
  for (let i = 0; i < 2; i++) {
    const next = await start();
    const answer = await host.callback({ session: next.session }, controller.signal);
    assert.equal(answer.ok, true);
    assert.equal(answer.account, 'chatgpt-web');
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), original, 'real save + settle removes the temporary slot');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  }
  const aborted = await start();
  cancel = true;
  await assert.rejects(host.callback({ session: aborted.session }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), original);
  assert.equal(calls, 4);
});
