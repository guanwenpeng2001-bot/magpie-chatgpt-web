// Executed by Bun, exclusively through the offline runner. No CLI startup,
// provider, browser, socket, process launch or account discovery is permitted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { nativeWindowPolicy } from '../../src/native/window-policy.mjs';
import { preparePinnedProbeSource, sha256, PROBE_CAPABILITIES, calibrateProbe,
  compileProbe, verifyProbeRecords, preflightProbe, physicalProbeMessages, scoreProbeAnswer } from '../../scripts/native-window-probe-core.mjs';

const [entryArg, mode, optionsArg, artifactDir] = process.argv.slice(2);
const entry = resolve(entryArg), options = JSON.parse(optionsArg), policy = nativeWindowPolicy(options);
const blockedCalls = [];
const deny = name => () => { blockedCalls.push(name); throw new Error(`Offline probe forbids ${name}`); };
globalThis.fetch = deny('fetch');
globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
for (const [object, keys, label] of [
  [http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
  [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child_process'],
  [Bun, ['connect', 'listen', 'serve', 'spawn', 'spawnSync'], 'Bun'],
]) for (const key of keys) object[key] = deny(`${label}.${key}`);
net.Server.prototype.listen = deny('net.Server.listen');
net.Socket.prototype.connect = deny('net.Socket.connect');
syncBuiltinESMExports();

const bytes = readFileSync(entry), transformed = preparePinnedProbeSource(bytes.toString('utf8'), { mode, ...options });
Bun.plugin({ name: 'offline-native-window', setup(build) {
  build.onLoad({ filter: /[\\/]cli\.js$/ }, ({ path }) => {
    assert.equal(resolve(path), entry, 'only exact pinned module is transformed');
    return { contents: transformed, loader: 'js' };
  });
} });
const native = await import(pathToFileURL(entry).href);
native.Worker.prototype.run = deny('Worker.run');
native.Worker.prototype.runBrowserTurn = deny('Worker.runBrowserTurn');
native.Worker.prototype.pageForNewTurn = deny('Worker.pageForNewTurn');
const capabilities = { ...PROBE_CAPABILITIES };
const fitError = error => error?.code === 'context_length_exceeded' && error.status === 400 && error.retryable === false;
function attempt(fn) {
  try { fn(); return { passed: true }; }
  catch (error) {
    if (!fitError(error)) throw error;
    return { passed: false, code: error.code, status: error.status, retryable: error.retryable, message: error.message };
  }
}
const checks = [], cases = [];
const check = (name, fn) => { fn(); checks.push(name); };
for (const family of ['6', '5.6']) {
  for (const targetInputTokens of [100_000, 128_000, 256_000, 380_000]) {
    const bundle = calibrateProbe(native, { family, targetInputTokens, capabilities });
    const integrity = verifyProbeRecords(bundle);
    const ordinaryBaseline = attempt(() => native.assertOrdinary(bundle.inputTokens, native.messageTokens(bundle.compiled, bundle.parsed.modelId),
      bundle.parsed.modelId, 'max', { ...capabilities, experimentalBiggerContext: false }, native.messageChars(bundle.compiled)));
    assert.equal(ordinaryBaseline.passed, targetInputTokens === 100_000, 'current reference ordinary 112193 baseline');
    let measured;
    const sixPart = attempt(() => { measured = preflightProbe(native, bundle); });
    assert.equal(sixPart.passed, mode === 'candidate' || targetInputTokens < 336_579, `${mode} ${family} ${targetInputTokens} six-part result`);
    if (mode === 'candidate') assert.equal(measured.stageEffort, 'max', 'all staging uses Pro');
    const physical = measured ?? (() => {
      // Retain complete compiled payload measurements even on the original
      // aggregate rejection, without reporting rejection as send success.
      const result = physicalProbeMessages(native, bundle.compiled, 'ctx_' + 'a'.repeat(32));
      return { ...result, physical: result.messages.map((text, index) => ({ part: index + 1,
        referenceTokens: native.textTokens(text), wholeStringTokens: native.tokenizer().encode_ordinary(text).length,
        utf16Chars: text.length, utf8Bytes: Buffer.byteLength(text), jsonStringBytes: Buffer.byteLength(JSON.stringify(text)), sha256: sha256(text) })) };
    })();
    assert.ok(physical.physical.every(part => part.referenceTokens <= 104000 && part.utf16Chars <= 1635000));
    let twoPart;
    if (targetInputTokens === 128_000 || targetInputTokens === 380_000) {
      const two = compileProbe(native, bundle.source, { capabilities, parts: 2 });
      verifyProbeRecords(two);
      twoPart = attempt(() => preflightProbe(native, two));
      assert.equal(twoPart.passed, targetInputTokens === 128_000);
    }
    const parsedBefore = JSON.stringify(bundle.source);
    let compaction;
    try {
      const compact = compileProbe(native, bundle.source, { capabilities, parts: 6, compaction: true });
      const trimmed = compact.compiled.trimmedCompactionMessages ?? 0;
      if (mode === 'candidate' || targetInputTokens < 336579) {
        verifyProbeRecords(compact);
        assert.equal(preflightProbe(native, compact).stageEffort, mode === 'candidate' ? 'max' : 'low');
      } else assert.ok(trimmed > 0, 'unpatched large compaction demonstrates omitted history');
      compaction = { compiled: true, inputTokens: compact.inputTokens, trimmedMessages: trimmed, completeHistory: trimmed === 0 };
    } catch (error) {
      if (!fitError(error)) throw error;
      compaction = { compiled: false, code: error.code, completeHistory: false };
      assert.equal(mode, 'reference');
    }
    assert.equal(JSON.stringify(bundle.source), parsedBefore, 'original corpus remains unchanged after compaction');
    const result = { mode, family, targetInputTokens, inputTokens: bundle.inputTokens,
      calibrationIterations: bundle.calibrationIterations, ...integrity, ordinaryBaseline, sixPart,
      ...(twoPart ? { twoPart } : {}), compaction,
      stageEffort: measured?.stageEffort ?? null, actualTransactionInputTokens: measured?.actualInputTokens ?? null,
      physicalMessages: physical.physical, tokenizer: ['o200k', 'base'].join('_'), referenceChunkCharacters: 4096,
      canClaimWebCapacity: false };
    cases.push(result);
    if (artifactDir) {
      const prefix = `${family}-${targetInputTokens}`;
      for (const [name, value] of Object.entries({ request: bundle.source.request, 'oracle.private': bundle.source.oracle,
        compiled: bundle.compiled, physical: { transactionId: 'ctx_' + 'a'.repeat(32), messages: physical.messages, acknowledgements: physical.acknowledgements }, manifest: result })) {
        await writeFile(join(artifactDir, `${prefix}.${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      }
    }
    if (targetInputTokens === 128000 && family === '6') {
      check('reconstruction rejects changed text, dropped and duplicate records', () => {
        for (const mutate of [
          rows => { const row = rows.find(item => item.kind === 'message'); row.message.content += 'corruption'; },
          rows => rows.splice(rows.findIndex(item => item.kind === 'message'), 1),
          rows => rows.push(structuredClone(rows.find(item => item.kind === 'message'))),
        ]) {
          const bad = { ...bundle, compiled: structuredClone(bundle.compiled) };
          const part = JSON.parse(bad.compiled.multipart.parts[0]); mutate(part.records);
          bad.compiled.multipart.parts[0] = JSON.stringify(part);
          assert.throws(() => verifyProbeRecords(bad));
        }
      });
      check('oracle scorer rejects swapped, missing, extra, invalid and unpaired values', () => {
        const oracle = bundle.source.oracle;
        assert.equal(scoreProbeAnswer(JSON.stringify(oracle.expected), oracle).passed, true);
        const keys = Object.keys(oracle.expected), swapped = { ...oracle.expected };
        [swapped[keys[0]], swapped[keys[1]]] = [swapped[keys[1]], swapped[keys[0]]];
        for (const text of [JSON.stringify(swapped), '{}', JSON.stringify({ ...oracle.expected, extra: 'x' }),
          'not-json', JSON.stringify(Object.values(oracle.expected))]) assert.equal(scoreProbeAnswer(text, oracle).passed, false);
      });
      const model = bundle.parsed.modelId;
      const bound = mode === 'candidate' ? policy.inputTokenCeilingExclusive : 336579;
      const details = { stagingEffort: 'max', maxStageMessageTokens: 100, maxStageChars: 100,
        finalMessageTokens: 100, finalMessageChars: 100, finalImageTokens: 0 };
      const guard = (input, override = {}, caps = capabilities, fam = family) => native.assertMultipart(input, 100, model,
        'max', caps, 100, 6, { ...details, ...override }, fam);
      check('exclusive aggregate limit and output reserve enforced by real preflight', () => {
        guard(bound - 1); assert.throws(() => guard(bound), fitError); assert.throws(() => guard(400000), fitError);
      });
      check('per-message token, character and image reserves remain enforced', () => {
        assert.throws(() => guard(10000, { maxStageMessageTokens: 104001 }), fitError);
        assert.throws(() => guard(10000, { finalMessageTokens: 104001 }), fitError);
        assert.throws(() => guard(10000, { maxStageChars: 1635001 }), fitError);
        assert.throws(() => guard(10000, { finalMessageChars: 1635001 }), fitError);
        assert.throws(() => guard(10000, { finalMessageTokens: 104000, finalImageTokens: 4096 }), fitError);
      });
      check('non-Pro, wrong family and absent opt-in never get the expanded ceiling', () => {
        assert.throws(() => guard(380000, {}, { ...capabilities, proAvailable: false }));
        assert.throws(() => guard(380000, {}, capabilities, 'unknown'), fitError);
        assert.throws(() => guard(380000, {}, { ...capabilities, experimentalWindowPolicy: false }), fitError);
        assert.equal(native.limits(model, 'high', capabilities, '6').contextWindow, 240000);
        assert.equal(native.limits(model, 'max', { ...capabilities, experimentalBiggerContext: false }, family).contextWindow, 112193);
      });
      check('single atomic oversized record cannot be rescued by six-way partition', () => {
        const atomic = structuredClone(bundle.source);
        atomic.request.input = [{ role: 'user', content: ' amber'.repeat(110000) }];
        const compiled = compileProbe(native, atomic, { capabilities });
        assert.throws(() => preflightProbe(native, compiled), fitError);
      });
      if (mode === 'candidate') {
        check('inline compaction fails before deleting older history', () => {
          const inline = structuredClone(bundle.source);
          inline.request.input = [{ role: 'user', content: ' amber'.repeat(25000) }, { role: 'user', content: 'Preserve the history.' }];
          const before = JSON.stringify(inline);
          assert.throws(() => compileProbe(native, inline, { capabilities, parts: null, compaction: true }), fitError);
          assert.equal(JSON.stringify(inline), before);
        });
        check('over-budget multipart compaction fails without mutating canonical history', () => {
          const large = calibrateProbe(native, { family, targetInputTokens: 400000, capabilities });
          const before = JSON.stringify(large.source);
          assert.throws(() => compileProbe(native, large.source, { capabilities, compaction: true }), fitError);
          assert.equal(JSON.stringify(large.source), before);
        });
      }
    }
  }
}
assert.deepEqual(blockedCalls, [], 'no attempted network, process, browser or socket operations');
assert.equal(sha256(readFileSync(entry)), sha256(bytes));
console.log(JSON.stringify({ mode, transformedSha256: sha256(transformed), cases, checks, blockedCalls, canClaimWebCapacity: false }));
