import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeRoot, compactionPreloadSource } from '../src/native/runtime.mjs';
import { writeAccountContinuityPolicy } from '../src/native/account-continuity.mjs';

test('pinned canonical boundary carries task checkpoints and original history A -> B -> A, pre-turn and restart', {
  skip: process.env.NATIVE_ACCOUNT_CONTINUITY_SMOKE !== '1', timeout: 60000,
}, async t => {
  // Installed code only. No install helper, account/config read, network or GUI.
  const payload = join(nativeRoot(), 'runtime-6.1.18', 'payload');
  const entry = join(payload, 'app', 'cli.js'), original = await readFile(entry);
  assert.equal(createHash('sha256').update(original).digest('hex'), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const scratch = await mkdtemp(join(tmpdir(), 'continuity-pinned-'));
  t.after(async () => {
    assert.equal(dirname(scratch), resolve(tmpdir()));
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), original);
  });
  for (const dir of ['accounts/a', 'accounts/b', 'accounts/c', 'workspace', 'canonical']) await mkdir(join(scratch, dir), { recursive: true, mode: 0o700 });
  await writeFile(join(scratch, 'identity.json'), JSON.stringify({ thread: randomUUID(), turn: randomUUID(), other: randomUUID(), preTurn: randomUUID() }));
  const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  const boundary = 'if(f._compactionRequest){console.info("[chatgpt-web] compaction_phase entered");';
  const exports = '\nexport { dn as Broker, Vu as EnvironmentStore, Fn as parseRequest, ue as identity, q as AdapterError, sd as route, Nh as restore, _i as revisions, jn as compactionSource, Ls as responseRequest, Cs as Worker, Xt as compilePrompt, Kt as registry, vs as close };';
  const preload = compactionPreloadSource(entry).replace("return { contents, loader: 'js' };", `
    // Observe production wiring; the fixture must never install its own patch.
    if(contents.split('magpieCheckpointPersistence.lookup(n,s)').length!==2
      ||contents.split('magpieCheckpointPersistence.scopes(n)').length!==2)throw Error('Missing or repeated production continuity patch');
    const start=contents.indexOf('if(D||f._compactionRequest)'),end=contents.indexOf(${JSON.stringify(boundary)},start);
    if(start<0||end<start)throw Error('Missing actual archive boundary');
    const archive=contents.slice(start,end);
    if(contents.split(${JSON.stringify(startup)}).length!==2)throw Error('Missing CLI boundary');
    return {contents:contents.replace(${JSON.stringify(startup)},'')+${JSON.stringify(exports)}+
      '\\nexport async function archiveBoundary(f,D,m){'+archive+'}',loader:'js'};`);
  await writeFile(join(scratch, 'preload.mjs'), preload);
  const fixture = fileURLToPath(new URL('./fixtures/native-account-continuity-fixture.mjs', import.meta.url));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|PATHEXT)$/i.test(key)));
  for (const [phase, profile, sharing] of [['seed', 'a', true], ['continue', 'b', true], ['return', 'a', true], ['pre-turn', 'c', true], ['restart', 'b', false]]) {
    const home = join(scratch, 'accounts', profile);
    await mkdir(join(home, 'codex'), { recursive: true });
    const policyEnv = phase === 'continue' ? await writeAccountContinuityPolicy(home, [profile]) : {};
    const result = await promisify(execFile)(join(payload, 'runtime', 'bun.exe'), ['--preload', join(scratch, 'preload.mjs'), fixture, entry, scratch, phase], {
      windowsHide: true, cwd: scratch, timeout: 20000, maxBuffer: 1024 * 1024,
      env: { ...inherited, USERPROFILE: scratch, APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
        CODEX_HOME: join(home, 'codex'), CODEX_CHATGPT_WEB_HOME: home, MAGPIE_NATIVE_CHECKPOINT_HOME: home,
        CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: JSON.stringify([join(scratch, 'canonical')]),
        MAGPIE_NATIVE_CONTINUITY_ROOT: sharing ? join(scratch, 'accounts') : '',
        MAGPIE_NATIVE_CONTINUITY_PEERS: sharing ? '["a","b","c"]' : '',
        ...policyEnv,
        MAGPIE_NATIVE_RETAINED_COMPACTION: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    });
    assert.match(result.stdout, new RegExp(`PINNED_CONTINUITY_OK ${phase}`));
    t.diagnostic(`pinned ${phase}: canonical proof, source/summary isolation, scoped history and persistence passed`);
  }
});
