import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { createProbeSource, verifyProbeRecords } from '../../scripts/native-window-probe-core.mjs';

const [entry, root] = process.argv.slice(2), blockedCalls = [];
const deny = name => () => { blockedCalls.push(name); throw Error('Offline production fixture forbids ' + name); };
globalThis.fetch = deny('fetch');
globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
for (const [object, keys, label] of [
  [http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
  [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child_process'],
  [Bun, ['connect', 'listen', 'serve', 'spawn', 'spawnSync'], 'Bun'],
]) for (const key of keys) object[key] = deny(label + '.' + key);
net.Server.prototype.listen = deny('net.Server.listen'); net.Socket.prototype.connect = deny('net.Socket.connect');
syncBuiltinESMExports();
const native = await import(pathToFileURL(entry).href);
const print = console.log.bind(console);
let workerFailureDiagnostics = 0;
console.error = (...args) => {
  if (!String(args[0]).startsWith('[chatgpt-web] browser turn synthetic failed:')) throw Error('Unexpected native fixture diagnostic');
  workerFailureDiagnostics++;
};
const caps = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: false, experimentalBiggerContext: false };
const options = { appName: 'Offline production Pro window' };
const fitError = error => error instanceof native.AdapterError && error.status === 400
  && error.code === 'context_length_exceeded' && error.retryable === false;
function compile(source, capabilities = caps, compaction = false) {
  const parsed = native.parseRequest(structuredClone(source.request));
  native.route(parsed, { mode: 'full', browserInteractionMode: 'automatic', ...capabilities });
  if (compaction) parsed._compactionRequest = true;
  const before = JSON.stringify(parsed), token = capabilities.localToolsEnabled ? native.usageTurnToken : undefined;
  const compiled = native.compile(parsed, capabilities, token, options);
  assert.equal(JSON.stringify(parsed), before, 'compiler preserves the canonical request');
  assert.equal(compiled.trimmedCompactionMessages ?? 0, 0);
  const parts = compiled.multipart?.parts.length;
  const bundle = { source, parsed, compiled, parts, capabilities, inputTokens: native.tokens(compiled, parsed.modelId) };
  if (parts) verifyProbeRecords(bundle);
  assert.ok(bundle.inputTokens < 256000);
  return bundle;
}
function calibrated(family, target) {
  let units = Math.floor(target * 0.8);
  for (let attempt = 0; attempt < 12; attempt++) {
    const source = createProbeSource({ family, units, recordCount: Math.max(16, Math.ceil(target / 2000)) });
    const bundle = compile(source);
    if (bundle.inputTokens <= target && bundle.inputTokens >= target - 192) return bundle;
    units += target - 64 - bundle.inputTokens;
  }
  throw Error('Production corpus did not calibrate');
}
async function workerPreflight(bundle, expectFit = true) {
  const worker = Object.create(native.Worker.prototype), stop = new Error('OFFLINE_BROWSER_BOUNDARY');
  worker.config = { appName: options.appName, browserDiagnosticsPath: join(root, 'diagnostics') };
  let pages = 0;
  worker.runStage = async (_trace, stage) => { assert.equal(stage, 'browser_page'); pages++; throw stop; };
  worker.pageForNewTurn = deny('pageForNewTurn');
  try {
    await worker.runBrowserTurn({ traceId: 'synthetic', modelId: bundle.parsed.modelId, modelFamily: bundle.parsed._chatgptModelFamily,
      reasoning: 'max', capabilities: bundle.capabilities, prepare: async () => ({ ...bundle.compiled, release: async () => {} }) });
    assert.fail('worker must stop before browser access');
  } catch (error) { if (expectFit) assert.equal(error, stop); else assert.ok(fitError(error)); }
  assert.equal(pages, expectFit ? 1 : 0);
}
const cases = []; let compactionCases = 0;
for (const family of ['6', '5.6']) {
  assert.equal(native.limits('gpt-5.6-sol', 'max', caps, family).contextWindow, 256000);
  assert.deepEqual(native.transportLimits('gpt-5.6-sol', 'max', caps), { browserMessageTokenLimit: 104000, browserComposerCharLimit: 1635000 });
  for (const total of [255999, 256000, 380000, 400000]) {
    const multipart = () => native.assertMultipart(total, 1000, 'gpt-5.6-sol', 'max', caps, 6000, 6,
      { stagingEffort: 'max', maxStageMessageTokens: 1000, maxStageChars: 6000, finalMessageTokens: 1000, finalMessageChars: 6000, finalImageTokens: 0 }, family);
    const ordinary = () => native.assertOrdinary(total, 1000, 'gpt-5.6-sol', 'max', caps, 6000);
    if (total < 256000) { multipart(); ordinary(); }
    else { assert.throws(multipart, fitError); assert.throws(ordinary, fitError); }
  }
  assert.throws(() => native.assertMultipart(100000, 1000, 'gpt-5.6-sol', 'max', caps, 6000, 2,
    { stagingEffort: 'low', maxStageMessageTokens: 1000, maxStageChars: 6000, finalMessageTokens: 1000, finalMessageChars: 6000, finalImageTokens: 0 }, family), fitError);
  const model = native.catalogModel({ slug: 'gpt-5.3-codex' }, { slug: `chatgpt-web/gpt-${family}-pro`, displayName: 'Fixture Pro',
    interactionMode: 'automatic', backendModel: 'gpt-5.6-sol', modelFamily: family, adapterEffort: 'max', codexEffort: 'max', supportedCodexEfforts: ['max'] }, caps);
  assert.equal(model.context_window, 256000); assert.equal(model.max_context_window, 256000);
  assert.equal(model.auto_compact_token_limit, 230400); assert.equal(model.effective_context_window_percent, 95);
  assert.equal(model.context_window * model.effective_context_window_percent / 100, 243200);
  for (const target of [100000, 128000, 224000, 255000]) {
    const bundle = calibrated(family, target);
    assert.equal(bundle.parts ?? 1, target === 100000 ? 1 : target === 128000 ? 2 : 6);
    assert.equal(native.usage(bundle.parsed, { reasoning: [] }, caps, false, false, options.appName).inputTokens, bundle.inputTokens);
    await workerPreflight(bundle);
    if (target === 128000 || target === 255000) {
      const compact = compile(bundle.source, caps, true);
      assert.ok([2, 6].includes(compact.parts)); await workerPreflight(compact); compactionCases++;
      const bigger = compile(bundle.source, { ...caps, experimentalBiggerContext: true });
      assert.deepEqual(bigger.compiled, bundle.compiled, 'Bigger does not change default Pro allocation');
      assert.equal(native.usage(bundle.parsed, { reasoning: [] }, { ...caps, experimentalBiggerContext: true }, true, false, options.appName).inputTokens, bundle.inputTokens);
    }
    if (target === 128000) {
      const tools = compile(bundle.source, { ...caps, localToolsEnabled: true });
      assert.equal(tools.parts, 2);
    }
    if (target === 255000) {
      const oversized = structuredClone(bundle.source); oversized.request.input[0].content += ' amber'.repeat(8000);
      assert.throws(() => compile(oversized), fitError); assert.throws(() => compile(oversized, caps, true), fitError);
      const expanded = structuredClone(bundle.compiled), last = JSON.parse(expanded.multipart.parts.at(-1));
      last.records.push({ kind: 'message', message_index: 9999, message: { role: 'user', content: ' amber'.repeat(8000) } });
      expanded.multipart.parts[expanded.multipart.parts.length - 1] = JSON.stringify(last);
      await workerPreflight({ ...bundle, compiled: expanded }, false);
    }
    cases.push({ family, target, inputTokens: bundle.inputTokens, parts: bundle.parts ?? 1 });
  }
  const hugeRecord = createProbeSource({ family, units: 0, recordCount: 16 });
  hugeRecord.request.input[0].content = ' amber'.repeat(110000);
  const unchanged = JSON.stringify(hugeRecord);
  assert.throws(() => compile(hugeRecord), fitError); assert.throws(() => compile(hugeRecord, caps, true), fitError);
  assert.equal(JSON.stringify(hugeRecord), unchanged);
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const small = createProbeSource({ family, units: 1000, recordCount: 16 });
    small.request.model = `chatgpt-web/gpt-${family}-sol${effort === 'low' ? '-instant' : ''}`; small.request.reasoning.effort = effort;
    const parsed = native.parseRequest(small.request); native.route(parsed, { mode: 'full', browserInteractionMode: 'automatic', ...caps });
    assert.deepEqual(native.compile(parsed, caps, undefined, options), native.originalCompile(parsed, caps, undefined, options));
    assert.equal(native.limits(parsed.modelId, effort, caps, family).contextWindow, 111193);
  }
}
assert.deepEqual(blockedCalls, []);
print(JSON.stringify({ live: false, cases, compactionCases, workerFailureDiagnostics, blockedCalls }));
