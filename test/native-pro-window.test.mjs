import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compactionPreloadSource, assertNativeProContext } from '../src/native/runtime.mjs';
import { nativeProWindowPolicy, nativeProWindowEnabled, patchNativeProWindow } from '../src/native/pro-window.mjs';
import { nativeCatalog, describeNativeCatalogue, publishedWindow } from '../src/native/models.mjs';

test('production Pro locally allocates 256K input within 400K total with 128K reasoning/output and 16K headroom', () => {
  const policy = nativeProWindowPolicy(), caps = { solAvailable: true, proAvailable: true };
  assert.equal(policy.outputReserve, 128000); assert.equal(policy.headroom, 16000);
  assert.equal(policy.totalWindow - policy.outputReserve - policy.headroom, policy.inputCeilingExclusive);
  assert.equal(policy.inputCeilingExclusive, 256000);
  assert.equal(policy.inputCeilingExclusive * policy.codexEffectivePercent / 100, 243200);
  class AdapterError extends Error { constructor(message, fields) { super(message); Object.assign(this, fields); } }
  for (const family of ['6', '5.6']) for (const bigger of [false, true]) {
    const capabilities = { ...caps, experimentalBiggerContext: bigger };
    assert.equal(nativeProWindowEnabled('gpt-5.6-sol', 'max', capabilities, family), true);
    assertNativeProContext(255999, 'max', AdapterError, false, 'gpt-5.6-sol', family, capabilities);
    for (const tokens of [256000, 380000, 400000, Infinity, NaN]) assert.throws(() =>
      assertNativeProContext(tokens, 'max', AdapterError, false, 'gpt-5.6-sol', family, capabilities), { code: 'context_length_exceeded', retryable: false });
    const rows = nativeCatalog(capabilities), row = rows.find(row => row.slug === `chatgpt-web/gpt-${family}-pro`);
    assert.equal(row.context_window, 400000); assert.equal(row.auto_compact_token_limit, 230400);
    assert.equal(publishedWindow(row), 256000);
    assert.deepEqual(describeNativeCatalogue(rows, 'fixture')[`native/fixture/gpt-${family}-pro`].limit,
      { context: 400000, input: 256000, output: 0 });
  }
  for (const [model, effort, capabilities, family] of [
    ['gpt-5.6-sol', 'high', caps, '6'], ['gpt-5.6-sol', 'low', caps, '6'],
    ['gpt-5.6-sol', 'max', { proAvailable: true }, '6'], ['gpt-5.6-sol', 'max', { solAvailable: true }, '6'],
    ['gpt-5.6-luna', 'max', caps, '6'], ['gpt-5.6-sol', 'max', caps, 'unknown'],
  ]) assert.equal(nativeProWindowEnabled(model, effort, capabilities, family), false);
  assert.throws(() => patchNativeProWindow(''), /anchor mismatch/);
});

test('actual production preload: default Pro auto transport, canonical/worker budgets and complete compaction', { timeout: 240000 }, async t => {
  const payload = join(homedir(), '.config/magpie/chatgpt-web-native/runtime-6.1.18/payload');
  const entry = join(payload, 'app/cli.js'), bun = join(payload, 'runtime/bun.exe');
  try { await access(entry); await access(bun); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Existing pinned runtime required; never download'); throw error; }
  const original = await readFile(entry), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(original), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const root = await mkdtemp(join(tmpdir(), 'production-pro-window-'));
  const suffix = relative(resolve(tmpdir()), resolve(root)); assert.ok(suffix && !isAbsolute(suffix) && !suffix.startsWith('..'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); assert.equal(hash(await readFile(entry)), hash(original)); });
  const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  const anchor = "return { contents, loader: 'js' };", base = compactionPreloadSource(entry);
  assert.equal(base.split(anchor).length, 2); assert.equal(original.toString().split(startup).length, 2);
  const exports = '\nexport { Fn as parseRequest, sd as route, Xt as compile, magpieCompileProOriginal as originalCompile, Nt as tokens, Ai as messages, Pe as textTokens, dC as tokenizer, ht as mode, at as limits, rn as transportLimits, gs as messageTokens, fs as messageChars, y_ as assertMultipart, Iu as assertOrdinary, wo as usage, Cs as Worker, q as AdapterError, QT as catalogModel, Ff as usageTurnToken };';
  const preload = base.replace(anchor, `if(contents.split(${JSON.stringify(startup)}).length!==2)throw Error('Startup anchor drift');return {contents:contents.replace(${JSON.stringify(startup)},'')+${JSON.stringify(exports)},loader:'js'};`);
  await writeFile(join(root, 'preload.mjs'), preload);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  const result = await promisify(execFile)(bun, ['--preload', join(root, 'preload.mjs'),
    fileURLToPath(new URL('./fixtures/native-pro-window-fixture.mjs', import.meta.url)), entry, root], {
    windowsHide: true, timeout: 210000, maxBuffer: 1 << 20, cwd: root,
    env: { ...inherited, CODEX_HOME: root, CODEX_CHATGPT_WEB_HOME: root, CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '[]',
      MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.live, false); assert.deepEqual(report.blockedCalls, []);
  assert.equal(report.cases.length, 8); assert.equal(report.compactionCases, 4);
  t.diagnostic(JSON.stringify(report));
});
