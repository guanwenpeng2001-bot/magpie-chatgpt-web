import { patchNativeCompactionGuidance } from '../src/native/compaction-guidance.mjs';
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
    // still trigger trimming. Automatically transport every record instead.
    const byteBound = parsed(family, effort, 100, true);
    const full = native.rawCompile({ ...byteBound, _compactionRequest: false }, caps);
    assert.ok(native.tokens(full, byteBound.modelId) < 111193);
    assert.ok(native.rawCompile(byteBound, caps).trimmedCompactionMessages > 0, 'original compiler silently drops history');
    const automatic = native.compile(byteBound, caps);
    assert.equal(automatic.multipart?.parts.length, 2);
    assert.equal(automatic.trimmedCompactionMessages, undefined);
    assert.deepEqual(automatic.multipart.parts.flatMap(part => JSON.parse(part).records).filter(r => r.kind === 'message').map(r => r.message.content), byteBound.context.messages.map(m => m.content));
    assert.equal(native.usage(byteBound, { reasoning: [] }, caps, false).inputTokens, native.tokens(automatic, byteBound.modelId));
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

async function proCompilerFixture() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const [entry, family] = process.argv.slice(2);
  process.argv = [process.execPath, entry, '--version'];
  const native = await import(pathToFileURL(entry).href);
  const caps = { solAvailable: true, proAvailable: true, localToolsEnabled: false, experimentalBiggerContext: false };
  const config = { mode: 'full', browserInteractionMode: 'automatic', ...caps };
  const request = (count, compact) => {
    const input = Array.from({ length: count }, (_, i) => ({ type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `PRO_RECORD_${i}: ${'context history '.repeat(100)}` }] }));
    const parsed = native.parse({ model: `chatgpt-web/gpt-${family}-pro`, reasoning: { effort: 'max' }, input });
    native.route(parsed, config);
    assert.equal(parsed._chatgptModelFamily, family);
    assert.equal(parsed.options.reasoning, 'max');
    parsed._compactionRequest = compact;
    return parsed;
  };
  const contextError = e => e.status === 400 && e.code === 'context_length_exceeded' && e.retryable === false;
  const parsed = request(100, true);
  const before = JSON.stringify(parsed);
  const full = native.rawCompile({ ...parsed, _compactionRequest: false }, caps);
  assert.ok(native.tokens(full, parsed.modelId) < 112193, 'byte-bound Pro history is below its token limit');
  assert.ok(Buffer.byteLength(JSON.stringify(full.text), 'utf8') > 110000, 'complete history exceeds the inline byte limit');
  assert.ok(native.rawCompile(parsed, caps).trimmedCompactionMessages > 0, 'original pinned Pro compiler drops history');
  const automatic = native.compile(parsed, caps);
  assert.equal(automatic.multipart?.parts.length, 2, 'byte-bound compaction automatically selects two parts');
  assert.equal(automatic.trimmedCompactionMessages, undefined);
  assert.deepEqual(automatic.multipart.parts.flatMap(part => JSON.parse(part).records).filter(r => r.kind === 'message').map(r => r.message.content), parsed.context.messages.map(m => m.content));
  assert.equal(JSON.stringify(parsed), before, 'selection leaves canonical history untouched');
  assert.equal(native.usage(parsed, { reasoning: [] }, caps, false).inputTokens, native.tokens(automatic, parsed.modelId));
  const completeMultipart = native.compile(parsed, caps, undefined, { experimentalMultipartParts: 6 });
  assert.equal(completeMultipart.trimmedCompactionMessages, undefined, 'fitting multipart history stays complete');
  assert.deepEqual(completeMultipart, native.rawCompile(parsed, caps, undefined, { experimentalMultipartParts: 6 }));
  for (const compact of [false, true]) for (const parts of [undefined, 6]) {
    const options = { experimentalMultipartParts: parts };
    const small = request(2, compact);
    assert.deepEqual(native.compile(small, caps, undefined, options), native.rawCompile(small, caps, undefined, options));
    const large = request(700, compact);
    const unchanged = JSON.stringify(large);
    const full = native.rawCompile({ ...large, _compactionRequest: false }, caps, undefined, options);
    assert.ok(native.tokens(full, large.modelId) >= 112193, 'complete Pro input exceeds its own baseline');
    assert.throws(() => native.compile(large, caps, undefined, options), e => contextError(e) && /112,193/.test(e.message));
    assert.equal(JSON.stringify(large), unchanged);
  }
  for (const bigger of [false, true]) {
    assert.throws(() => native.usage(request(700, true), { reasoning: [] }, caps, bigger), contextError);
  }
  // Find a real compiled input between the Sol and Pro ceilings. Pro must not
  // inherit Sol's smaller boundary, even with the new shared compiler hooks.
  let low = 2, high = 700;
  while (low + 1 < high) {
    const count = Math.floor((low + high) / 2);
    const sample = request(count, false);
    const tokens = native.tokens(native.rawCompile(sample, caps), sample.modelId);
    if (tokens < 112193) low = count;
    else high = count;
  }
  const below = request(low, false);
  const belowCompiled = native.rawCompile(below, caps);
  assert.ok(native.tokens(belowCompiled, below.modelId) >= 111193, 'Pro acceptance control crosses the Sol ceiling');
  assert.deepEqual(native.compile(below, caps), belowCompiled);
  const above = request(high, true);
  assert.throws(() => native.compile(above, caps), e => contextError(e) && /112,193/.test(e.message));
  console.log(`Pro ${family} compiler checks passed`);
}

async function transportFixture() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const entry = process.argv[2];
  process.argv = [process.execPath, entry, '--version'];
  const native = await import(pathToFileURL(entry).href);
  const caps = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: false };
  const config = { mode: 'full', browserInteractionMode: 'automatic', ...caps };
  const parse = (family, effort, contents) => {
    const p = native.parse({ model: `chatgpt-web/gpt-${family}-${effort === 'max' ? 'pro' : 'sol'}`,
      reasoning: { effort }, input: contents.map(content => ({ type: 'message', role: 'user', content })) });
    native.route(p, config);
    p._compactionRequest = true;
    return p;
  };
  const fitError = e => e.status === 400 && e.code === 'context_length_exceeded' && e.retryable === false;
  const records = c => c.multipart.parts.flatMap(part => JSON.parse(part).records);
  // Exactly the pure reference preflight used by the worker, independently of
  // the new chooser. A successful compiler partition alone is not a fit proof.
  const validate = (c, p) => {
    const texts = native.messages(c), final = texts.at(-1), stages = texts.slice(0, -1);
    const stageTokens = Math.max(...stages.map(t => native.textTokens(t, p.modelId)));
    const stageChars = Math.max(...stages.map(t => t.length));
    const mode = native.stagingMode(p.modelId, caps, stageTokens, stageChars);
    native.preflight(native.tokens(c, p.modelId), native.messageTokens(c, p.modelId),
      p.modelId, p.options.reasoning, caps, Math.max(...texts.map(t => t.length)), c.multipart.parts.length,
      { stagingEffort: mode.effort, maxStageMessageTokens: stageTokens, maxStageChars: stageChars,
        finalMessageTokens: native.textTokens(final, p.modelId), finalMessageChars: final.length, finalImageTokens: 0 }, p._chatgptModelFamily);
    return mode;
  };
  for (const family of ['6', '5.6']) for (const effort of ['max', 'high']) {
    const contents = Array.from({ length: 6 }, (_, i) => `SPARSE_${i} ${' '.repeat(600_000)} END_${i}`);
    const p = parse(family, effort, [...contents, 'Summarize all records.']);
    const before = JSON.stringify(p);
    const two = native.compile(p, caps, undefined, { experimentalMultipartParts: 2 });
    assert.ok(native.tokens(two, p.modelId) < 111193, 'two-part failure is per-message, not the baseline');
    assert.throws(() => validate(two, p), fitError);
    const chosen = native.compile(p, caps);
    assert.equal(chosen.multipart.parts.length, 6);
    assert.equal(validate(chosen, p).effort, 'max', 'wide atomic stage uses existing Pro staging');
    assert.deepEqual(records(chosen).filter(r => r.kind === 'message').map(r => r.message.content), [...contents, 'Summarize all records.']);
    assert.equal(JSON.stringify(p), before);
    assert.equal(chosen.trimmedCompactionMessages, undefined);
    assert.equal(native.usage(p, {}, caps, false).inputTokens, native.tokens(chosen, p.modelId));

    for (const [label, content] of [['atomic', `START ${' '.repeat(1_700_000)} END`], ['escaping', '_'.repeat(150_000)]]) {
      const rejected = parse(family, effort, [content, 'Summarize.']);
      const inline = native.rawCompile({ ...rejected, _compactionRequest: false }, caps);
      assert.ok(native.tokens(inline, rejected.modelId) < 111193, `${label} full inline input passes baseline`);
      assert.ok(Buffer.byteLength(JSON.stringify(inline.text)) > 110000);
      const original = JSON.stringify(rejected);
      assert.throws(() => native.compile(rejected, caps), fitError, `${label} must not gain lossy fallback`);
      assert.throws(() => native.usage(rejected, {}, caps, false), fitError);
      assert.equal(JSON.stringify(rejected), original);
    }
  }
  const p = parse('6', 'high', Array.from({ length: 100 }, (_, i) => `ROW_${i} ${'history '.repeat(200)}`));
  // Capability and non-compaction paths are deliberately outside the fallback.
  const controls = [
    { p: { ...p, _compactionRequest: false }, caps, options: {} },
    { p, caps: { ...caps, proAvailable: false }, options: {} },
    { p: { ...p, options: { ...p.options, reasoning: 'low' } }, caps, options: {} },
    { p: { ...p, modelId: 'chatgpt-web-zero-risk' }, caps: { ...caps, localToolsEnabled: true }, options: { manualControl: true } },
  ];
  for (const c of controls) {
    assert.deepEqual(native.compile(c.p, c.caps, c.options.manualControl ? 'fixture-request' : undefined, c.options),
      native.rawCompile(c.p, c.caps, c.options.manualControl ? 'fixture-request' : undefined, c.options));
  }
  const luna = { ...p, modelId: 'gpt-5.6-luna', options: { ...p.options, reasoning: 'low' } };
  const lunaCaps = { ...caps, solAvailable: false, proAvailable: false };
  assert.throws(() => native.compile(luna, lunaCaps), /Luna uses rolling checkpoints/);
  assert.throws(() => native.rawCompile(luna, lunaCaps), /Luna uses rolling checkpoints/);
  // Final attachments are still carried once and their tokens count in usage.
  p.context.messages.push({ role: 'user', content: [{ type: 'image', imageUrl: 'data:image/jpeg;base64,fixture', detail: 'original' }] });
  const attached = native.compile(p, caps);
  assert.equal(attached.images.length, 1);
  assert.equal(native.usage(p, {}, caps, false).inputTokens, native.tokens(attached, p.modelId));
  console.log('Transport allocation checks passed');
}

async function integrationFixture() {
  const assert = (await import('node:assert/strict')).default;
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const entry = process.argv[2];
  process.argv = [process.execPath, entry, '--version'];
  const native = await import(pathToFileURL(entry).href);
  const caps = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: false };
  const config = { mode: 'full', subagentProtocol: 'native', appName: 'Compaction transport fixture',
    browserHost: 'managed-chrome', browserInteractionMode: 'automatic', experimentalBiggerContext: false,
    storageStatePath: join(process.env.CODEX_CHATGPT_WEB_HOME, 'storage.json'),
    brokerSocketPath: `\\\\.\\pipe\\transport-fixture-${process.pid}`, ...caps };
  let expectedFamily, expectedEffort, prepared, parsedInput, summary, taskText, calls = 0;
  native.Worker.forProvider = () => ({ appName: config.appName, async run(options) {
    calls++;
    assert.equal(options.compaction, true);
    assert.equal(options.capabilities.localToolsEnabled, false);
    assert.equal(options.modelFamily, expectedFamily);
    assert.equal(options.reasoning, expectedEffort);
    prepared = await options.prepare();
    assert.equal(prepared.multipart.parts.length, 2);
    assert.equal(prepared.trimmedCompactionMessages, undefined);
    assert.equal(prepared.turnToken, undefined);
    const all = prepared.multipart.parts.flatMap(part => JSON.parse(part).records);
    const explicit = native.compile(parsedInput, options.capabilities, undefined,
      { appName: config.appName, experimentalMultipartParts: 6 });
    assert.deepEqual(all, explicit.multipart.parts.flatMap(part => JSON.parse(part).records), 'automatic preserves every restored record, role, index and system instruction');
    assert.equal(all.filter(r => r.kind === 'message' && r.message.content === taskText).length, 1);
    assert.match(prepared.text, /Do not call local or ChatGPT-native tools/);
    assert.equal(native.usage(parsedInput, {}, caps, false, false, config.appName).inputTokens,
      native.tokens(prepared, parsedInput.modelId), 'accounting agrees before this checkpoint supersedes its predecessor');
    options.onTextDelta?.(summary);
    return summary;
  } });
  const factory = provider => {
    const adapter = native.createAdapter(provider);
    return { ...adapter, runTurn(p, incoming, emit) {
      parsedInput = p;
      return adapter.runTurn(p, incoming, emit);
    } };
  };
  const request = body => new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  for (const family of ['6', '5.6']) for (const effort of ['max', 'high']) {
    expectedFamily = family; expectedEffort = effort;
    for (const kind of ['v1', 'v2', 'v2-stream', 'memento', 'memento-stream']) {
      const protocol = kind.replace('-stream', ''), stream = kind.endsWith('-stream');
      const turn = `transport-${family}-${effort}-${kind}`;
      taskText = `<codex_internal_context source="goal">RESTORED_TASK ${'history '.repeat(20_000)}</codex_internal_context>`;
      const human = { type: 'message', role: 'user', id: 'human', content: 'Report status.',
        internal_chat_message_metadata_passthrough: { turn_id: 'earlier' } };
      const task = { type: 'message', role: 'user', id: 'task', content: taskText,
        internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['goal.internal_context'] } };
      const base = { model: `chatgpt-web/gpt-${family}-${effort === 'max' ? 'pro' : 'sol'}`, reasoning: { effort }, stream,
        instructions: 'Preserve the complete task.', input: [human, task],
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: turn, turn_id: turn,
          ...(protocol === 'memento' ? { request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' } } : {}) }) } };
      let input = base.input;
      for (const round of [1, 2]) {
        summary = `Fixture checkpoint ${turn} ${round}`;
        const body = { ...base, input: [...input, ...(protocol === 'v2' ? [{ type: 'compaction_trigger' }] : [])] };
        const before = calls;
        const response = await (protocol === 'v1' ? native.compactRequest : native.responseRequest)(request(body), config, factory);
        const result = stream ? (await response.text()).split('\n').filter(l => l.startsWith('data: {'))
          .map(l => JSON.parse(l.slice(6))).find(e => e.type === 'response.completed')?.response : await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.ok(result?.output?.length, 'real response route completes');
        assert.equal(calls, before + 1);
        const expected = native.tokens(prepared, parsedInput.modelId);
        if (protocol !== 'v1') assert.equal(result.usage.input_tokens, expected, 'final response usage agrees with preparation');
        input = protocol === 'memento' ? [human, { type: 'message', role: 'user', content: `${native.summaryPrefix}\n${summary}`,
          internal_chat_message_metadata_passthrough: { turn_id: turn } }]
          : (protocol === 'v1' ? result.output : [human, ...result.output]).filter(item => item.id !== task.id);
      }
    }
  }
  // No compiler change may relax the automatic managed-Chrome-only handoff gate.
  const guarded = { model: 'chatgpt-web/gpt-6-pro', input: [{ type: 'message', role: 'user', content: 'Compact.',
    internal_chat_message_metadata_passthrough: { turn_id: 'control' } }],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'control', turn_id: 'control' }) } };
  for (const browserHost of ['launcher', undefined]) {
    const before = calls;
    const response = await native.compactRequest(request(guarded), { ...config, browserHost }, factory);
    assert.equal((await response.json()).error.code, 'compaction_control_unavailable');
    assert.equal(calls, before);
  }
  const beforeManual = calls;
  const manual = await native.compactRequest(request(guarded), { ...config, browserInteractionMode: 'manual' }, factory);
  assert.ok(manual.status >= 400, 'automatic model cannot use a manual structured-handoff bypass');
  assert.equal(calls, beforeManual);
  const oversized = { ...guarded, input: [{ ...guarded.input[0], content: `ATOMIC ${' '.repeat(1_700_000)} END` }] };
  const beforeRejected = calls;
  const rejected = await native.compactRequest(request(oversized), config, factory);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'context_length_exceeded');
  assert.equal(calls, beforeRejected, 'canonical accounting rejects an untransportable record before worker preparation');
  await native.close();
  console.log('Transport integration checks passed');
}

async function runCompilerFixture(t, fixtureFunction, args = []) {
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
  const exports = '\nexport { Fn as parse, sd as route, Xt as compile, rawXt as rawCompile, Nt as tokens, wo as usage, Ai as messages, Pe as textTokens, gs as messageTokens, v_ as stagingMode, y_ as preflight, Cs as Worker, Bi as createAdapter, cd as compactRequest, Ls as responseRequest, zt as summaryPrefix, vs as close };';
  const base = compactionPreloadSource(entry);
  const source = base.replace("return { contents, loader: 'js' };", `
    const comparison = (${patchNativeCompactionGuidance.toString()})(source);
    const start = comparison.indexOf('function Xt('), end = comparison.indexOf('var su=', start);
    if (start < 0 || end < start) throw new Error('Compiler fixture anchor mismatch');
    return { contents: contents + '\\n' + comparison.slice(start, end).replace('function Xt(', 'function rawXt(') + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, base);
  await writeFile(preload, source);
  await writeFile(fixture, `await (${fixtureFunction.toString()})();`);
  const result = await promisify(execFile)(join(dirname(dirname(entry)), 'runtime', 'bun.exe'), ['--preload', preload, fixture, entry, ...args], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '' },
    windowsHide: true, timeout: 90000, maxBuffer: 1 << 20,
  });
  assert.deepEqual(await readFile(entry), original, 'downloaded runtime remains byte-identical');
  return result.stdout;
}

test('pinned Sol compiler transports complete byte-bound compaction and guards full history', { timeout: 60000 }, async t => {
  const output = await runCompilerFixture(t, compilerFixture);
  if (output !== undefined) assert.match(output, /Sol compiler checks: 30 passed/);
});

for (const family of ['6', '5.6']) {
  test(`pinned GPT-${family} Pro max compiler transports byte-bound compaction with Bigger off`, { timeout: 60000 }, async t => {
    const output = await runCompilerFixture(t, proCompilerFixture, [family]);
    if (output !== undefined) assert.ok(output.includes(`Pro ${family} compiler checks passed`));
  });
}

test('pinned compiler chooses two then six using real transport preflight, never trims rejected input', { timeout: 120000 }, async t => {
  const output = await runCompilerFixture(t, transportFixture);
  if (output !== undefined) assert.match(output, /Transport allocation checks passed/);
});

test('pinned Responses compaction restores task records and shares preparation/accounting without handoff bypass', { timeout: 120000 }, async t => {
  const output = await runCompilerFixture(t, integrationFixture);
  if (output !== undefined) assert.match(output, /Transport integration checks passed/);
});
