import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const pinnedHash = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = resolve(process.env.NATIVE_PRO_CONTEXT_CLI
  ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));
const oldAnchor = 'else Iu(b,_,e.modelId,a.effort,i,y);let re=this.config.turnTimeoutMs';
const patchedAnchor = 'else Iu(b,_,e.modelId,a.effort,i,y);assertNativeProContext(b,a.effort,q);let re=this.config.turnTimeoutMs';
const roundAnchor = 'let D;if(y.localTools)try{D=m.resolve(f)}';
const roundPrefix = 'if(y.effort==="max"){try{assertNativeProContext(wo(w(f),{reasoning:[]},R,c,s,e.chatgptWeb?.appName).inputTokens,y.effort,q)}catch(';

// Execute actual preload only. Never import the full CLI or touch a browser,
// account, daemon, live app-server, installation or configuration.
async function preload(bytes, checksum = pinnedHash) {
  let onLoad;
  const script = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '')
    .replace(pinnedHash, checksum);
  runInNewContext(script, {
    createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
    Bun: {
      plugin({ setup }) { setup({ onLoad(_options, callback) { onLoad = callback; } }); },
      file(path) {
        assert.equal(path, entry);
        return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
      },
    },
  });
  assert.equal(typeof onLoad, 'function');
  assert.equal(await onLoad({ path: join(entry, '../unrelated/cli.js') }), undefined);
  return onLoad({ path: entry });
}

class FakeAdapterError extends Error {
  constructor(message, options) { super(message); Object.assign(this, options); }
}

function executionSource(source, anchor, includeHelper) {
  assert.equal(source.split(anchor).length, 2, 'unique preflight patch anchor');
  const anchorIndex = source.indexOf(anchor);
  const start = source.lastIndexOf('if(c.multipart)', anchorIndex);
  const stage = source.indexOf('O=await this.runStage(e.traceId,"browser_page",pt.browserPage', anchorIndex);
  const callback = source.indexOf(',async(E)=>{', stage);
  assert.ok(start >= 0 && anchorIndex > start && stage > anchorIndex && callback > stage);
  assert.ok(callback - start < 800, 'bounded preflight through first browser stage');
  let helper = '';
  if (includeHelper) {
    const helperAnchor = 'function assertNativeProContext(';
    assert.equal(source.split(helperAnchor).length, 2, 'helper actually appended by preload');
    const helperStart = source.indexOf(helperAnchor);
    const nextImport = source.indexOf('import { checkpointStore', helperStart);
    assert.ok(nextImport > helperStart);
    const helperEnd = source.lastIndexOf('}', nextImport) + 1;
    helper = source.slice(helperStart, helperEnd);
    const guard = source.indexOf('assertNativeProContext(b,a.effort,q);', start);
    assert.ok(guard > anchorIndex && guard < stage, 'guard executes before browser_page');
  }
  // Preserve actual if/else preflight, guard invocation, timeout and browser_page
  // call. Replace only browser callback body with an inert fixture callback.
  return helper + '\n(async function(){' + source.slice(start, callback)
    + ',async()=>{});return O;}).call(worker)';
}

function execute(script, { inputTokens, effort, multipart, family = '6', preflightError }) {
  const events = [];
  const preflight = kind => (...args) => {
    events.push({ kind, args });
    if (preflightError) throw preflightError;
  };
  const worker = {
    config: {},
    async runStage(trace, stage, timeout, callback) {
      events.push({ kind: stage, trace, timeout });
      assert.equal(typeof callback, 'function');
      return 'fixture-browser-stage';
    },
  };
  const result = runInNewContext(script, {
    q: FakeAdapterError, worker,
    b: inputTokens, _: 500, e: { modelId: 'fixture-native-model', modelFamily: family, traceId: 'fixture' },
    a: { effort }, i: { proAvailable: true }, y: 0,
    c: { multipart: multipart ? { parts: [{}, {}] } : undefined },
    I: multipart ? [{}, {}] : undefined, M: 'commit', L: 1000, W: 4000,
    X: { effort: 'low' }, R: 500, Pi: () => 0,
    Iu: preflight('ordinary-preflight'), y_: preflight('multipart-preflight'),
    pt: { browserPage: 60000 },
  });
  return { result, events };
}

function adapterExecutionSource(source) {
  assert.equal(source.split(roundPrefix).length, 2, 'unique patched canonical-round prelude');
  const start = source.indexOf(roundPrefix);
  const environmentPrelude = source.indexOf(roundAnchor, start);
  const preludeEnd = source.indexOf('if(f._compactionRequest)', start);
  assert.ok(preludeEnd > start && preludeEnd - start < 1000);
  assert.ok(environmentPrelude > start && environmentPrelude < preludeEnd);
  const resolveIndex = source.indexOf('m.resolve(f)', start);
  const sessionStart = source.indexOf('await De.getOrCreateAfterOwnerRetirement(', preludeEnd);
  const sessionEnd = source.indexOf(',K=Df(f)', sessionStart);
  assert.ok(start < resolveIndex && resolveIndex < preludeEnd && preludeEnd < sessionStart);
  assert.ok(sessionEnd > sessionStart && sessionEnd - sessionStart < 250);
  const helperStart = source.indexOf('function assertNativeProContext(');
  const helperImport = source.indexOf('import { checkpointStore', helperStart);
  assert.ok(helperStart > 0 && helperImport > helperStart);
  const helper = source.slice(helperStart, source.lastIndexOf('}', helperImport) + 1);
  // Execute the actual patched adapter prelude and actual later session call.
  // Unrelated compaction/identity plumbing between them is intentionally omitted.
  return helper + '\n(async()=>{' + source.slice(start, preludeEnd)
    + 'return ' + source.slice(sessionStart, sessionEnd) + ';})()';
}

function executeAdapter(script, { inputTokens, effort = 'max', localTools = true, appName = 'Fixture app', failureAt, failure }) {
  const events = [];
  const emitted = [];
  const adapterErrors = [];
  class CapturedAdapterError extends FakeAdapterError {
    constructor(message, options) { super(message, options); adapterErrors.push(this); }
  }
  const toolResult = Object.freeze({ role: 'tool', tool_call_id: 'fixture-call', content: 'small result', fixtureTokens: 13 });
  const history = Object.freeze({ role: 'user', content: 'full canonical history fixture', fixtureTokens: inputTokens - 13 });
  const parsed = Object.freeze({ context: { messages: [history, toolResult] }, browserDelta: [toolResult] });
  const canonical = Object.freeze({ ...parsed, fixtureUsageInput: true });
  const capabilities = Object.freeze({ proAvailable: true });
  const environment = Object.freeze({ fixtureEnvironment: true });
  const signal = Object.freeze({ fixtureSignal: true });
  const scope = {
    q: CapturedAdapterError, f: parsed, y: { effort, localTools }, R: capabilities,
    c: true, s: false, e: appName === undefined ? {} : { chatgptWeb: { appName } },
    T(event) { events.push('emitError'); emitted.push(event); },
    w(input) {
      assert.equal(effort, 'max', 'non-Pro must not compute currentUsageInput');
      assert.equal(input, parsed, 'currentUsageInput receives canonical request, not browser delta');
      events.push('currentUsageInput');
      if (failureAt === 'currentUsageInput') throw failure;
      return canonical;
    },
    wo(input, output, receivedCapabilities, biggerContext, skillAttachments, receivedAppName) {
      assert.equal(input, canonical, 'estimate usage on the actual result of currentUsageInput');
      assert.equal(input.context.messages[0], history);
      assert.equal(input.context.messages[1], toolResult);
      assert.notEqual(input.context.messages, parsed.browserDelta);
      assert.deepEqual(Object.keys(output), ['reasoning']);
      assert.ok(Array.isArray(output.reasoning));
      assert.equal(output.reasoning.length, 0);
      assert.equal(receivedCapabilities, capabilities);
      assert.equal(biggerContext, true);
      assert.equal(skillAttachments, false);
      assert.equal(receivedAppName, appName);
      events.push('estimateFullHistory');
      if (failureAt === 'estimateFullHistory') throw failure;
      return { inputTokens: input.context.messages.reduce((sum, message) => sum + message.fixtureTokens, 0), outputTokens: 999999 };
    },
    m: { resolve(input) { assert.equal(input, parsed); events.push('resolveEnvironment'); return environment; } },
    De: { async getOrCreateAfterOwnerRetirement(...args) {
      events.push('createSession');
      assert.equal(typeof args[2], 'function');
      assert.equal(args[4], signal);
      return 'fixture-session';
    } },
    re: 'fixture-execution', O: 'fixture-owner', Qe: 'fixture-trace', v: { abortSignal: signal },
    qe: 'fixture-turn', ve: { threadId: 'fixture-thread' }, $f: input => { assert.equal(input, parsed); return 'fixture-lineage'; },
    C() { assert.fail('session factory must not start a runtime in this fixture'); },
  };
  return { result: runInNewContext(script, scope), events, emitted, adapterErrors };
}

test('pinned Native Pro context guard through actual patched preload', async t => {
  let bytes;
  try { bytes = await readFile(entry); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_PRO_CONTEXT_CLI) throw error;
    t.skip('pinned runtime absent; set NATIVE_PRO_CONTEXT_CLI to existing v6.1.18 app/cli.js (never downloads)');
    return;
  }
  assert.equal(digest(bytes), pinnedHash);
  const raw = bytes.toString('utf8');
  const patched = await preload(bytes);
  assert.equal(patched.loader, 'js');
  assert.equal(patched.contents.includes(oldAnchor), false);
  const script = executionSource(patched.contents, patchedAnchor, true);
  const adapterScript = adapterExecutionSource(patched.contents);

  for (const localTools of [true, false]) {
    for (const inputTokens of [112192, 112193, 275414, 340069]) {
      await t.test(`canonical tool-result round ${inputTokens}, localTools=${localTools}: full-history guard before side effects`, async () => {
        const { result, events, emitted, adapterErrors } = executeAdapter(adapterScript, { inputTokens, localTools });
        if (inputTokens < 112193) {
          assert.equal(await result, 'fixture-session');
          assert.deepEqual(events, ['currentUsageInput', 'estimateFullHistory', ...(localTools ? ['resolveEnvironment'] : []), 'createSession']);
          assert.deepEqual(emitted, []);
          assert.deepEqual(adapterErrors, []);
        } else {
          assert.equal(await result, undefined, 'guard emits a typed error and returns instead of throwing');
          assert.equal(adapterErrors.length, 1);
          assert.equal(emitted.length, 1);
          assert.match(adapterErrors[0].message, /112,193/);
          assert.deepEqual({ ...emitted[0] }, {
            type: 'error', message: adapterErrors[0].message,
            status: 400, errorType: 'invalid_request_error',
            code: 'context_length_exceeded', retryable: false,
          });
          assert.deepEqual(events, ['currentUsageInput', 'estimateFullHistory', 'emitError']);
        }
      });
    }
    for (const effort of ['low', 'medium', 'high']) {
      await t.test(`canonical round ${effort}, localTools=${localTools}: does not compute Pro estimate`, async () => {
        const { result, events, emitted, adapterErrors } = executeAdapter(adapterScript, { inputTokens: 340069, effort, localTools });
        assert.equal(await result, 'fixture-session');
        assert.deepEqual(events, [...(localTools ? ['resolveEnvironment'] : []), 'createSession']);
        assert.deepEqual(emitted, []);
        assert.deepEqual(adapterErrors, []);
      });
    }
    for (const failureAt of ['currentUsageInput', 'estimateFullHistory']) {
      await t.test(`non-q exception from ${failureAt}, localTools=${localTools}: rethrows without emission or side effects`, async () => {
        // Matching fields must not make an ordinary Error an AdapterError.
        const failure = Object.assign(new Error('fixture estimator fault'), {
          status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false,
        });
        const { result, events, emitted, adapterErrors } = executeAdapter(adapterScript, {
          inputTokens: 340069, localTools, failureAt, failure,
        });
        await assert.rejects(result, error => error === failure);
        assert.deepEqual(events, failureAt === 'currentUsageInput'
          ? ['currentUsageInput'] : ['currentUsageInput', 'estimateFullHistory']);
        assert.deepEqual(emitted, []);
        assert.deepEqual(adapterErrors, []);
      });
    }
  }

  for (const [label, replacement] of [['missing', 'missing-round-guard-anchor'], ['duplicate', roundAnchor + roundAnchor]]) {
    await t.test(`${label} canonical round guard anchor fails closed independently of SHA`, async () => {
      assert.equal(raw.split(roundAnchor).length, 2);
      const drift = Buffer.from(raw.replace(roundAnchor, replacement));
      await assert.rejects(preload(drift, digest(drift)), /Native Pro round guard compatibility mismatch/);
    });
  }

  for (const family of ['5.6', '6']) {
    for (const multipart of [false, true]) {
      const label = `${family} max ${multipart ? 'multipart' : 'ordinary'}`;
      for (const inputTokens of [112192, 112193, 275414, 340069]) {
        await t.test(`${label}: ${inputTokens} ${inputTokens < 112193 ? 'accepted' : 'rejected before browser'}`, async () => {
          const { result, events } = execute(script, { inputTokens, effort: 'max', multipart, family });
          if (inputTokens < 112193) {
            assert.equal(await result, 'fixture-browser-stage');
            assert.deepEqual(events.map(event => event.kind), [multipart ? 'multipart-preflight' : 'ordinary-preflight', 'browser_page']);
          } else {
            await assert.rejects(result, error => {
              assert.ok(error instanceof FakeAdapterError);
              assert.equal(error.status, 400);
              assert.equal(error.errorType, 'invalid_request_error');
              assert.equal(error.code, 'context_length_exceeded');
              assert.equal(error.retryable, false);
              return true;
            });
            assert.deepEqual(events.map(event => event.kind), [multipart ? 'multipart-preflight' : 'ordinary-preflight']);
          }
          assert.equal(events[0].args[0], inputTokens, 'full input reaches original preflight');
          assert.equal(events[0].args[3], 'max');
        });
      }
    }
  }

  for (const effort of ['low', 'medium', 'high']) {
    for (const multipart of [false, true]) {
      await t.test(`${effort} ${multipart ? 'multipart' : 'ordinary'} remains original preflight responsibility`, async () => {
        for (const inputTokens of [112193, 275414, 340069]) {
          // Original preflight is an observation stub, not a capacity assertion.
          const { result, events } = execute(script, { inputTokens, effort, multipart });
          assert.equal(await result, 'fixture-browser-stage');
          assert.deepEqual(events.map(event => event.kind), [multipart ? 'multipart-preflight' : 'ordinary-preflight', 'browser_page']);
          assert.equal(events[0].args[0], inputTokens);
          assert.equal(events[0].args[3], effort);
        }
        const originalError = new Error('original preflight rejection');
        const { result, events } = execute(script, { inputTokens: 340069, effort, multipart, preflightError: originalError });
        await assert.rejects(result, error => error === originalError);
        assert.equal(events.length, 1, 'original rejection still stops before browser');
      });
    }
  }

  await t.test('unpached bundle lacks this guard when original preflight permits the input', async () => {
    const before = executionSource(raw, oldAnchor, false);
    const { result, events } = execute(before, { inputTokens: 340069, effort: 'max', multipart: true });
    assert.equal(await result, 'fixture-browser-stage');
    assert.equal(events.at(-1).kind, 'browser_page');
  });
  await t.test('SHA drift fails closed', async () => {
    await assert.rejects(preload(Buffer.from(raw + '\n')), /runtime checksum mismatch/);
  });
  for (const [label, replacement] of [['missing', 'missing-context-guard-anchor'], ['duplicate', oldAnchor + oldAnchor]]) {
    await t.test(`${label} context guard anchor fails closed independently of SHA`, async () => {
      const drift = Buffer.from(raw.replace(oldAnchor, replacement));
      // Test-only hash substitution reaches the independent anchor check.
      await assert.rejects(preload(drift, digest(drift)), /Native Pro context guard compatibility mismatch/);
    });
  }
  assert.deepEqual(await readFile(entry), bytes, 'installed bundle remains byte-identical');
});
