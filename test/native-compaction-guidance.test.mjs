import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const entry = resolve(process.env.NATIVE_COMPACTION_GUIDANCE_CLI ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = 'When the user requests later recall';
async function pinnedBytes(t) {
  try {
    const bytes = await readFile(entry);
    assert.equal(digest(bytes), pin);
    return bytes;
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_COMPACTION_GUIDANCE_CLI) throw error;
    t.skip('pinned runtime absent; no download or installation');
  }
}

async function transform(bytes) {
  let load;
  const script = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '');
  runInNewContext(script, { createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
    Bun: { plugin({ setup }) { setup({ onLoad(_filter, callback) { load = callback; } }); },
      file(path) { assert.equal(path, entry); return { arrayBuffer: async () => Uint8Array.from(bytes).buffer }; } },
  });
  assert.equal(await load({ path: resolve('unrelated/cli.js') }), undefined);
  return (await load({ path: entry })).contents;
}

test('compaction guidance patch is exact, isolated, and fails closed', async t => {
  const { patchNativeCompactionGuidance: patch } = await import('../src/native/compaction-guidance.mjs');
  assert.throws(() => patch(Buffer.from('source')), TypeError);
  assert.throws(() => patch(''), /anchor mismatch/);
  const bytes = await pinnedBytes(t);
  if (!bytes) return;
  const source = bytes.toString('utf8');
  const start = source.indexOf(':["This is a Codex history-compaction checkpoint, not a normal task turn.","Do not call local');
  const end = source.indexOf(':s.localTools?', start) + ':s.localTools?'.length;
  assert.ok(start > 0 && end > start);
  const anchor = source.slice(start, end);
  const changed = patch(source);
  assert.equal(changed.slice(0, start), source.slice(0, start));
  assert.ok(changed.endsWith(source.slice(end)), 'all other contracts and runtime code stay identical');
  assert.equal(changed.split(marker).length, 2);
  for (const bad of [source.replace(anchor, ''), source + anchor,
    source.replace(anchor, anchor.replace('Return only', 'Return')), changed]) {
    assert.throws(() => patch(bad), /anchor mismatch/);
  }
  // Function embedding must retain source outside the one anchor verbatim.
  const suffix = '\n// unrelated $& $` $\'';
  assert.ok(patch(source + suffix).endsWith(suffix));
  const production = await transform(bytes);
  assert.ok(production.includes(marker));
  await assert.rejects(transform(Buffer.concat([bytes, Buffer.from('\n')])), /runtime checksum mismatch/);
});

async function compilerFixture() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const entry = process.argv[2];
  process.argv = [process.execPath, entry, '--version'];
  const n = await import(pathToFileURL(entry).href);
  const marker = 'When the user requests later recall';
  const caps = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: false };
  const token = 'turn_' + '0'.repeat(32);
  const parse = (family, effort, compact = true) => {
    const p = n.parse({ model: `chatgpt-web/gpt-${family}-${effort === 'max' ? 'pro' : 'sol'}`,
      reasoning: { effort }, instructions: 'Preserve the source facts and instruction priorities.',
      input: [{ role: 'user', content: 'Remember these field names and their values for later recall: reference_code = paper-crane; delivery_zone = north.' },
        { role: 'assistant', content: 'The identifier is paper-crane. The label is north.' },
        { type: 'function_call', call_id: 'prior-read', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'prior-read', output: 'The original field labels remain reference_code and delivery_zone.' },
        { role: 'user', content: 'Preserve the task for the next turn.' }] });
    n.route(p, { mode: 'full', browserInteractionMode: 'automatic', ...caps });
    p._compactionRequest = compact;
    return p;
  };
  const guidance = text => {
    assert.equal(text.split(marker).length, 2, 'automatic compaction must include fidelity guidance exactly once');
    for (const phrase of ['exact original identifier names', 'field labels', 'key-value associations',
      'source facts', 'assistant paraphrases', 'uncertainty', 'missing', 'Do not invent', 'omitted history']) {
      assert.ok(text.includes(phrase), `missing fidelity rule: ${phrase}`);
    }
    assert.ok(text.includes('Do not call local or ChatGPT-native tools.'));
    assert.ok(text.includes('Return only the checkpoint summary'));
  };
  const inlineRecords = c => JSON.parse(c.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)[1]);
  const records = c => c.multipart.parts.flatMap(part => JSON.parse(part).records);
  let cases = 0;
  for (const family of ['6', '5.6']) for (const effort of ['max', 'medium', 'high', 'xhigh']) {
    const p = parse(family, effort);
    const before = JSON.stringify(p);
    for (const parts of [undefined, 2, 6]) {
      const options = { appName: 'Fidelity fixture', experimentalMultipartParts: parts };
      const c = n.compile(p, caps, undefined, options), baseline = n.baseline(p, caps, undefined, options);
      guidance(c.text);
      assert.equal(c.turnToken, undefined);
      assert.ok(n.tokens(c, p.modelId) > n.tokens(baseline, p.modelId), 'guidance consumes the existing input budget');
      assert.equal(n.estimate(p, caps, options), n.tokens(c, p.modelId), 'usage estimator compiles the same guidance');
      if (parts) {
        const transaction = 'ctx_' + 'a'.repeat(32);
        guidance(n.finalPayload(c.multipart, transaction));
        assert.deepEqual(records(c), records(baseline));
        assert.deepEqual(c.multipart.parts, baseline.multipart.parts, 'small-input staging allocation is unchanged');
        for (let index = 0; index < parts - 1; index++) {
          assert.deepEqual(n.stagePayload(c.multipart.parts[index], transaction, index + 1, parts),
            n.stagePayload(baseline.multipart.parts[index], transaction, index + 1, parts));
          assert.ok(!c.multipart.parts[index].includes(marker), 'guidance is never injected into history or inert stages');
        }
      } else assert.deepEqual(inlineRecords(c), inlineRecords(baseline));
      cases++;
    }
    assert.equal(JSON.stringify(p), before, 'source facts and even incorrect assistant paraphrases remain immutable');
    for (const compact of [false, true]) {
      const control = parse(family, effort, compact);
      const tools = { ...caps, localToolsEnabled: true };
      if (!compact) for (const capabilities of [caps, tools]) for (const parts of [undefined, 2, 6]) {
        const options = { experimentalMultipartParts: parts };
        assert.deepEqual(n.compile(control, capabilities, capabilities.localToolsEnabled ? token : undefined, options),
          n.baseline(control, capabilities, capabilities.localToolsEnabled ? token : undefined, options), 'ordinary read-only and local-tools contracts unchanged');
      }
      assert.deepEqual(n.compile(control, tools, 'request_' + '0'.repeat(32), { manualControl: true }),
        n.baseline(control, tools, 'request_' + '0'.repeat(32), { manualControl: true }), 'manual contract unchanged, including manual compaction');
    }
    // Exercise the new rule with the complete-history fallback, not only explicit parts.
    p.context.messages.unshift({ role: 'user', content: 'Existing history '.repeat(9000) });
    const unchanged = JSON.stringify(p);
    const c = n.compile(p, caps), baseline = n.baseline(p, caps);
    guidance(c.text);
    assert.equal(c.multipart.parts.length, 2);
    assert.deepEqual(records(c), records(baseline));
    assert.equal(c.trimmedCompactionMessages, undefined);
    assert.equal(n.usage(p, {}, caps, false).inputTokens, n.tokens(c, p.modelId));
    assert.equal(JSON.stringify(p), unchanged);
  }
  console.log(`Fidelity compiler cases: ${cases} passed; normal/manual controls and automatic fallback passed`);
}

test('real pinned compiler preserves fidelity guidance in inline and multipart compaction only', { timeout: 60000 }, async t => {
  const bytes = await pinnedBytes(t);
  if (!bytes) return;
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-guidance-'));
  const preloadSnapshot = async () => Object.fromEntries(await Promise.all((await readdir(nativeRoot()))
    .filter(name => /^compaction-6\.1\.18-.*\.mjs$/.test(name)).sort()
    .map(async name => [name, digest(await readFile(join(nativeRoot(), name)))])));
  const installedPreloads = await preloadSnapshot();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), bytes);
    assert.deepEqual(await preloadSnapshot(), installedPreloads, 'installed preload files were not changed');
  });
  let base = compactionPreloadSource(entry);
  const insertion = '    contents = (function patchNativeCompactionGuidance(';
  const patched = base.includes(insertion);
  if (patched) {
    assert.equal(base.split(insertion).length, 2);
    base = base.replace(insertion, '    const guidanceBaseline = contents;\n' + insertion);
  }
  const exports = '\nexport { Fn as parse, sd as route, Xt as compile, baselineXt as baseline, Nt as tokens, Du as estimate, wo as usage, ao as finalPayload, _r as stagePayload };';
  const source = base.replace("return { contents, loader: 'js' };", `
    const baselineSource = ${patched ? 'guidanceBaseline' : 'contents'};
    const start = baselineSource.indexOf('function Xt('), end = baselineSource.indexOf('var su=', start);
    if (start < 0 || end < start) throw new Error('Fidelity compiler fixture anchor mismatch');
    const baselineCompiler = baselineSource.slice(start, end).replace('function Xt(', 'function baselineXt(').replaceAll('compile:Xt', 'compile:baselineXt');
    return { contents: contents + '\\n' + baselineCompiler + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, base);
  await writeFile(join(home, 'preload.mjs'), source);
  await writeFile(join(home, 'fixture.mjs'), `await (${compilerFixture.toString()})();`);
  const result = await promisify(execFile)(join(dirname(dirname(entry)), 'runtime/bun.exe'),
    ['--preload', join(home, 'preload.mjs'), join(home, 'fixture.mjs'), entry], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '' },
      windowsHide: true, timeout: 45000, maxBuffer: 1 << 20,
    });
  assert.match(result.stdout, /Fidelity compiler cases: 24 passed/);
});
