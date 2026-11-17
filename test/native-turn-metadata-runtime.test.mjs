import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compactionPreloadSource } from '../src/native/runtime.mjs';

test('pinned Fn/Vu recover header-only compacted history only with current canonical rollout proof', { timeout: 60000 }, async t => {
  const payload = join(homedir(), '.config/magpie/chatgpt-web-native/runtime-6.1.18/payload');
  const entry = join(payload, 'app/cli.js'), bun = join(payload, 'runtime/bun.exe');
  try { await Promise.all([access(entry), access(bun)]); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Installed offline Windows v6.1.18 pin is required; never download'); throw error; }
  const original = await readFile(entry);
  assert.equal(createHash('sha256').update(original).digest('hex'),
    'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const home = await mkdtemp(join(tmpdir(), 'native-metadata-rollout-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), original);
  });
  const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  assert.equal(original.toString().split(startup).length, 2);
  const exports = '\nexport { Fn as parse, Jh as claim, Uh as compacted, Vu as Store };';
  const base = compactionPreloadSource(entry);
  const anchor = "return { contents, loader: 'js' };";
  assert.equal(base.split(anchor).length, 2);
  const preload = base.replace(anchor,
    `if(contents.split(${JSON.stringify(startup)}).length!==2)throw Error('Fixture startup anchor drift');return { contents: contents.replace(${JSON.stringify(startup)}, '') + ${JSON.stringify(exports)}, loader: 'js' };`);
  await writeFile(join(home, 'preload.mjs'), preload);
  // Only the fixture's new temporary home is trusted. No real rollout or account state.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  const result = await promisify(execFile)(bun, ['--preload', join(home, 'preload.mjs'),
    fileURLToPath(new URL('./fixtures/native-turn-metadata-runtime-fixture.mjs', import.meta.url)), entry, home], {
    windowsHide: true, timeout: 45000, maxBuffer: 1 << 20,
    env: { ...env, CODEX_HOME: home, CODEX_CHATGPT_WEB_HOME: home,
      CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '[]', MAGPIE_NATIVE_CHECKPOINT_HOME: '',
      MAGPIE_NATIVE_BROWSER_CDP: '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  assert.match(result.stdout, /PINNED_HEADER_ONLY_ROLLOUT_OK/);
});
