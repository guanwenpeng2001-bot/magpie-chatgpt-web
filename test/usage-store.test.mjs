import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accountKeyFromSession, usageProfile, beginTracking, recordSubmission, recordTrackingGap, readUsage, DAY_MS, RETENTION_MS } from '../src/usage/store.mjs';

const now = Date.UTC(2026, 10, 13, 12);
const key = accountKeyFromSession({ user: { id: 'fixture-user' }, account: { id: 'fixture-account' } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chat-send-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { profile: usageProfile('fixture', root), accountKey: key };
}
const receipt = (scope, id, at = now, extras = {}) => ({ ...scope, id, at, source: 'native', model: 'gpt-6-pro', effort: 'max', ...extras });

test('read-only empty store is not a measured zero and does not start coverage', async t => {
  const scope = await fixture(t);
  const result = await readUsage(scope, { now });
  assert.equal(result.status, 'not-started');
  assert.equal(result.since, null);
  assert.deepEqual(result.sources, []);
  await assert.rejects(readdir(scope.profile), { code: 'ENOENT' });
});

test('physical Sends persist once across replay, with model/effort/stage and gaps separate', async t => {
  const scope = await fixture(t);
  await beginTracking({ ...scope, source: 'native' }, { now: now - DAY_MS });
  assert.equal(await recordSubmission(receipt(scope, 'physical-1', now - 1000), { now }), true);
  assert.equal(await recordSubmission(receipt(scope, 'physical-1', now), { now }), false);
  await recordSubmission(receipt(scope, 'physical-2', now, { model: 'chatgpt-web/gpt-5.6-sol', effort: 'high', stage: 'multipart' }), { now });
  await recordSubmission(receipt(scope, 'physical-3', now, { model: 'gpt-6', effort: 'max', stage: 'compaction', source: 'text' }), { now });
  await recordTrackingGap(receipt(scope, 'uncertain-4'), { now });
  let result = await readUsage(scope, { now });
  assert.equal(result.day, 3);
  assert.equal(result.week, 3);
  assert.deepEqual(result.gaps, { day: 1, week: 1 });
  for (const stage of ['message', 'multipart', 'compaction']) assert.equal(result.byStage[stage].week, 1);
  assert.equal(result.byModel.find(x => x.model === 'gpt-5.6-sol').effort, 'high');
  assert.equal(result.sources.length, 2);
  await recordSubmission(receipt(scope, 'uncertain-4'), { now });
  result = await readUsage(scope, { now });
  assert.equal(result.week, 4);
  assert.equal(result.gaps.week, 0, 'later confirmation resolves its prior uncertainty');
  assert.equal((await readUsage(scope, { now })).week, 4, 'reopening re-reads durable files');
});

test('rolling windows are open at their lower boundary; out-of-order callbacks retain sends', async t => {
  const scope = await fixture(t);
  await recordSubmission(receipt(scope, 'later', now - 10), { now });
  await recordSubmission(receipt(scope, 'earlier', now - DAY_MS), { now });
  await recordSubmission(receipt(scope, 'inside-day', now - DAY_MS + 1), { now });
  assert.equal(await recordSubmission(receipt(scope, 'outside-week', now - RETENTION_MS), { now }), false);
  await recordSubmission(receipt(scope, 'inside-week', now - RETENTION_MS + 1), { now });
  const result = await readUsage(scope, { now });
  assert.equal(result.day, 2);
  assert.equal(result.week, 4);
  assert.equal(result.since, now - RETENTION_MS + 1);
  assert.equal((await readUsage(scope, { now: now + RETENTION_MS })).week, 0);
  assert.equal(await recordSubmission(receipt(scope, 'later', now - 10), { now: now + RETENTION_MS }), false);
});

test('account/user/profile isolation and identity hashing never use rotating tokens', async t => {
  const scope = await fixture(t);
  await recordSubmission(receipt(scope, 'same-send'), { now });
  for (const other of [
    { ...scope, accountKey: accountKeyFromSession({ user: { id: 'fixture-user' }, account: { id: 'other-account' } }) },
    { ...scope, accountKey: accountKeyFromSession({ user: { id: 'other-user' }, account: { id: 'fixture-account' } }) },
    { ...scope, profile: join(scope.profile, 'another-profile') },
  ]) {
    assert.equal((await readUsage(other, { now })).status, 'not-started');
    await recordSubmission(receipt(other, 'same-send'), { now });
    assert.equal((await readUsage(other, { now })).week, 1);
  }
  assert.equal(accountKeyFromSession({ user: { id: 'fixture-user' }, account: { id: 'fixture-account' }, accessToken: 'rotated' }), key);
  assert.equal(accountKeyFromSession({ user: { email: 'private' }, account: { id: 'fixture-account' } }), undefined);
  assert.equal(accountKeyFromSession({ user: { id: 'a\0b' }, account: { id: 'c' } }), undefined);
});

test('unknown labels are explicit, arbitrary private data and receipt IDs are never persisted', async t => {
  const scope = await fixture(t);
  await recordSubmission(receipt(scope, 'private-request-id', now, { model: 'private-prompt-text', effort: 'private-effort', auth: 'private-secret' }), { now });
  const result = await readUsage(scope, { now });
  assert.deepEqual(result.byModel, [{ model: 'unknown', effort: 'unknown', day: 1, week: 1 }]);
  const dir = join(scope.profile, 'usage-v1', key);
  const contents = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), 'utf8')))).join('');
  assert.doesNotMatch(contents + JSON.stringify(result), /private-|fixture-user|fixture-account/);
  assert.doesNotMatch(JSON.stringify(result), /"id"|accountKey|profile/);
});

test('clock skew, conflicting identities and corrupt data fail without overwriting history', async t => {
  const scope = await fixture(t);
  await assert.rejects(recordSubmission(receipt(scope, 'future', now + 1), { now }), { code: 'usage-clock' });
  await recordSubmission(receipt(scope, 'one'), { now });
  await assert.rejects(recordSubmission(receipt(scope, 'one', now, { model: 'gpt-5.6-pro' }), { now }), { code: 'usage-conflict' });
  await assert.rejects(readUsage(scope, { now: now - 1 }), { code: 'usage-clock' });
  const dir = join(scope.profile, 'usage-v1', key);
  const name = (await readdir(dir)).find(x => x.startsWith('s-'));
  await writeFile(join(dir, name), '{broken');
  await assert.rejects(readUsage(scope, { now }), { code: 'usage-corrupt' });
  assert.equal(await readFile(join(dir, name), 'utf8'), '{broken');
  assert.throws(() => usageProfile('../outside'), { code: 'usage-config' });
  await assert.rejects(recordSubmission(receipt({ ...scope, accountKey: '../outside' }, 'x'), { now }), { code: 'usage-config' });
});

test('concurrent independent processes neither lose sends nor double-count shared receipts', async t => {
  const scope = await fixture(t);
  const moduleURL = new URL('../src/usage/store.mjs', import.meta.url).href;
  const run = index => new Promise((resolve, reject) => {
    const code = `import {recordSubmission} from ${JSON.stringify(moduleURL)};
      const scope=JSON.parse(process.env.USAGE_FIXTURE_SCOPE);
      await Promise.all(Array.from({length:8},(_,i)=>recordSubmission({...scope,id:i===0?'shared':${JSON.stringify(index)}+'-'+i,at:${now},source:'native',model:'gpt-6-pro',effort:'max'},{now:${now}})));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, USAGE_FIXTURE_SCOPE: JSON.stringify(scope) }, stdio: 'pipe', windowsHide: true });
    let error = ''; child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve() : reject(Error(error)));
  });
  await Promise.all([run(0), run(1), run(2)]);
  assert.equal((await readUsage(scope, { now })).week, 22);
  const files = await readdir(join(scope.profile, 'usage-v1', key));
  assert.equal(files.filter(x => x.startsWith('.pending-')).length, 0);
});

test('cancelled reads produce no snapshot', async t => {
  const scope = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readUsage(scope, { now, signal: controller.signal }), { name: 'AbortError' });
});

function coordinatedWriter(t, scope, script, executable = process.execPath) {
  const moduleURL = new URL('../src/usage/store.mjs', import.meta.url).href;
  const child = spawn(executable, ['--input-type=module', '-e', script], {
    env: { ...process.env, USAGE_FIXTURE_SCOPE: JSON.stringify(scope), USAGE_FIXTURE_MODULE: moduleURL },
    stdio: 'pipe', windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '', readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) readyResolve(true); });
  child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => {
      readyResolve(false);
      if (code !== 0 && code !== null) reject(Error(errors || `Child exited ${code}`));
      else resolve(output);
    });
  });
  return { child, ready, done };
}

test('two processes competing for the last slot cannot exceed 20,000 or poison reads', { timeout: 60000 }, async t => {
  const scope = await fixture(t);
  await beginTracking({ ...scope, source: 'native' }, { now });
  const dir = join(scope.profile, 'usage-v1', key);
  // Seed the real bound, not a smaller alternate store implementation. The
  // immutable fixtures are fully written before either contender starts.
  for (let offset = 0; offset < 19999; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 19999 - offset) }, async (_, i) => {
      const id = createHash('sha256').update(`seed-${offset + i}`).digest('hex');
      await writeFile(join(dir, `s-${id}.json`), JSON.stringify({ version: 1, kind: 'send', id, at: now,
        source: 'native', model: 'gpt-6-pro', effort: 'max', stage: 'message' }), { mode: 0o600 });
    }));
  }
  const contenders = [0, 1].map(index => coordinatedWriter(t, scope, `
    const { recordSubmission } = await import(process.env.USAGE_FIXTURE_MODULE);
    const gate = new Promise(resolve => process.stdin.once('data', resolve));
    console.log('ready'); await gate;
    try { const recorded = await recordSubmission({...JSON.parse(process.env.USAGE_FIXTURE_SCOPE),
      id:'last-slot-${index}', at:${now}, source:'native', model:'gpt-6-pro', effort:'max'}, {now:${now}});
      console.log(JSON.stringify({index:${index},recorded}));
    } catch(error) { console.log(JSON.stringify({index:${index},code:error.code})); }
    process.stdin.destroy();
  `));
  assert.deepEqual(await Promise.all(contenders.map(x => x.ready)), [true, true]);
  for (const contender of contenders) contender.child.stdin.write('go\n');
  const results = (await Promise.all(contenders.map(x => x.done))).map(text => JSON.parse(text.trim().split('\n').at(-1)));
  assert.equal(results.filter(x => x.recorded === true).length, 1);
  assert.equal(results.filter(x => x.code === 'usage-capacity').length, 1);
  assert.equal((await readdir(dir)).filter(name => /^s-/.test(name)).length, 20000);
  assert.equal((await readUsage(scope, { now })).week, 20000, 'full is still readable');
  const winner = results.find(x => x.recorded === true);
  assert.equal(await recordSubmission(receipt(scope, `last-slot-${winner.index}`), { now }), false, 'full-store replay does not need admission capacity');
});

test('killing a writer after durable staging releases admission without stale-lock cleanup', { timeout: 15000 }, async t => {
  const scope = await fixture(t);
  const writer = coordinatedWriter(t, scope, `
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const original = fs.link;
    fs.link = async (from,to) => {
      if (/[\\\\/]s-[a-f0-9]{64}\\.json$/.test(to)) { console.log('ready'); await new Promise(()=>{}); }
      return original(from,to);
    };
    syncBuiltinESMExports();
    const {recordSubmission} = await import(process.env.USAGE_FIXTURE_MODULE);
    await recordSubmission({...JSON.parse(process.env.USAGE_FIXTURE_SCOPE),id:'crashed',at:${now},source:'native',model:'gpt-6-pro',effort:'max'},{now:${now}});
  `, process.versions.bun ? 'node' : process.execPath);
  // Bun's syncBuiltinESMExports is a no-op: Node supplies the paused holder for
  // fault injection. The recovering writer still runs in the test's own runtime.
  assert.equal(await writer.ready, true, 'writer reached the intercepted publication while holding admission');
  writer.child.kill();
  await writer.done;
  assert.equal(await recordSubmission(receipt(scope, 'crashed'), { now }), true);
  assert.equal(await recordSubmission(receipt(scope, 'crashed'), { now }), false);
  assert.equal((await readUsage(scope, { now })).week, 1);
  const files = await readdir(join(scope.profile, 'usage-v1', key));
  assert.equal(files.filter(name => name.startsWith('.pending-')).length, 1, 'abandoned staged bytes are not a receipt or a stale lock');
});
