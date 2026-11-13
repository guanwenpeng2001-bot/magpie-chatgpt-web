import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeRoot, compactionPreloadSource } from '../src/native/runtime.mjs';

// No server, model, browser or live account is started. Export the pinned
// parser/router/compiler and compare against its original compiler in Bun.
async function compilerFixture() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const entry = process.argv[2];
  process.argv = [process.execPath, entry, '--version'];
  const native = await import(pathToFileURL(entry).href);
  const caps = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: false };
  const config = { mode: 'full', browserInteractionMode: 'automatic', ...caps };
  const parsed = (family, effort, count, compact) => {
    const input = Array.from({ length: count }, (_, i) => ({ type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `RECORD_${i}: ${'context history '.repeat(100)}` }] }));
    const p = native.parse({ model: `chatgpt-web/gpt-${family}-sol${effort === 'low' ? '-instant' : ''}`, reasoning: { effort }, input });
    native.route(p, config);
    assert.equal(p.modelId, 'gpt-5.6-sol');
    assert.equal(p._chatgptModelFamily, family, 'real router supplies family, not fixture inference');
    p._compactionRequest = compact;
    return p;
  };
  let checks = 0;
  for (const family of ['6', '5.6']) for (const effort of ['medium', 'high', 'xhigh']) {
    for (const compact of [false, true]) for (const parts of [undefined, 6]) {
      const options = { experimentalMultipartParts: parts };
      const small = parsed(family, effort, 2, compact);
      assert.deepEqual(native.compile(small, caps, undefined, options), native.rawCompile(small, caps, undefined, options));
      const large = parsed(family, effort, 700, compact);
      const before = JSON.stringify(large);
      const full = native.rawCompile({ ...large, _compactionRequest: false }, caps, undefined, options);
      assert.ok(native.tokens(full, large.modelId) >= 111193, 'fixture really exceeds the full transaction limit');
      assert.throws(() => native.compile(large, caps, undefined, options), e => e.status === 400
        && e.code === 'context_length_exceeded' && e.retryable === false && /111,193/.test(e.message));
      assert.equal(JSON.stringify(large), before, 'guard leaves canonical history untouched');
      checks++;
    }
    // Below the token ceiling, the separate legacy inline byte ceiling can
    // still trigger trimming. Reject that too, rather than falsely returning
    // a successful lossy summary. Multipart need not hit that byte ceiling.
    const byteBound = parsed(family, effort, 100, true);
    const full = native.rawCompile({ ...byteBound, _compactionRequest: false }, caps);
    assert.ok(native.tokens(full, byteBound.modelId) < 111193);
    assert.ok(native.rawCompile(byteBound, caps).trimmedCompactionMessages > 0, 'original compiler silently drops history');
    assert.throws(() => native.compile(byteBound, caps), /without dropping records/);
    const completeMultipart = native.compile(byteBound, caps, undefined, { experimentalMultipartParts: 6 });
    assert.equal(completeMultipart.trimmedCompactionMessages, undefined);
    // Bigger off must not bypass the full-input guard during accounting.
    for (const bigger of [false, true]) {
      const large = parsed(family, effort, 700, true);
      assert.throws(() => native.usage(large, { reasoning: [] }, caps, bigger), e => e.code === 'context_length_exceeded');
    }
    checks++;
  }
  // Small outputs are byte-identical in both settings. Other tiers retain
  // the reference behavior, including its existing compaction fit policy.
  for (const family of ['6', '5.6']) {
    const plus = parsed(family, 'high', 100, true);
    const plusCaps = { ...caps, proAvailable: false };
    assert.deepEqual(native.compile(plus, plusCaps), native.rawCompile(plus, plusCaps));
    const instant = parsed(family, 'low', 100, true);
    assert.deepEqual(native.compile(instant, caps), native.rawCompile(instant, caps));
  }
  console.log(`Sol compiler checks: ${checks} passed`);
}

test('pinned Sol compiler rejects full history before compaction trimming', { timeout: 60000 }, async t => {
  const entry = resolve(process.env.NATIVE_PRO_CONTEXT_CLI ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));
  let original;
  try { original = await readFile(entry); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_PRO_CONTEXT_CLI) throw error;
    t.skip('pinned runtime absent; no downloads'); return;
  }
  assert.equal(createHash('sha256').update(original).digest('hex'), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const home = await mkdtemp(join(tmpdir(), 'native-sol-compiler-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preload = join(home, 'preload.mjs');
  const fixture = join(home, 'fixture.mjs');
  const exports = '\nexport { Fn as parse, sd as route, Xt as compile, rawXt as rawCompile, Nt as tokens, wo as usage };';
  const base = compactionPreloadSource(entry);
  const source = base.replace("return { contents, loader: 'js' };", `
    const start = source.indexOf('function Xt('), end = source.indexOf('var su=', start);
    if (start < 0 || end < start) throw new Error('Compiler fixture anchor mismatch');
    return { contents: contents + '\\n' + source.slice(start, end).replace('function Xt(', 'function rawXt(') + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, base);
  await writeFile(preload, source);
  await writeFile(fixture, `await (${compilerFixture.toString()})();`);
  const result = await promisify(execFile)(join(dirname(dirname(entry)), 'runtime', 'bun.exe'), ['--preload', preload, fixture, entry], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '' },
    windowsHide: true, timeout: 45000, maxBuffer: 1 << 20,
  });
  assert.match(result.stdout, /Sol compiler checks: 30 passed/);
  assert.deepEqual(await readFile(entry), original, 'downloaded runtime remains byte-identical');
});
