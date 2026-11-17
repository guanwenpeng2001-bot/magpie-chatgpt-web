import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { nativeWindowPolicy, patchNativeWindowPolicy, WINDOW_POLICY_ANCHORS } from '../src/native/window-policy.mjs';
import { runNativeWindowProbe, defaultProbePaths } from '../scripts/native-window-probe.mjs';
import { preparePinnedProbeSource, PROBE_STARTUP, createProbeSource, scoreProbeAnswer } from '../scripts/native-window-probe-core.mjs';

test('experimental total-window allocation subtracts explicit output once and never treats catalogue max as input', () => {
  const policy = nativeWindowPolicy();
  assert.equal(policy.totalWindowCeiling, 400000);
  assert.equal(policy.inputTokenCeilingExclusive, 383616);
  assert.equal(policy.referencePlatformReserveTokens, 8192);
  assert.equal(policy.verifiedWebCapacity, false);
  assert.equal(nativeWindowPolicy({ accountCatalogMaxTokens: 390000 }).inputTokenCeilingExclusive, 373616);
  assert.equal(nativeWindowPolicy({ outputReserveTokens: 20000 }).inputTokenCeilingExclusive, 380000);
  for (const value of [0, -1, Infinity, NaN, '410000', 1.5]) assert.throws(() => nativeWindowPolicy({ accountCatalogMaxTokens: value }), TypeError);
  for (const value of [0, -1, Infinity, 400000, 391808, '16384', 1.5]) assert.throws(() => nativeWindowPolicy({ outputReserveTokens: value }), TypeError);
});

test('separate private challenge seed changes selected keys without changing source records', () => {
  const a = createProbeSource({ family: '6', units: 10000, recordCount: 120, challengeSeed: 'a' });
  const b = createProbeSource({ family: '6', units: 10000, recordCount: 120, challengeSeed: 'b' });
  assert.deepEqual(a.request.input.slice(0, -1), b.request.input.slice(0, -1));
  assert.notDeepEqual(a.oracle.selected, b.oracle.selected);
  assert.equal(scoreProbeAnswer(JSON.stringify(a.oracle.expected), a.oracle).passed, true);
  assert.equal(scoreProbeAnswer(JSON.stringify(a.oracle.expected), b.oracle).passed, false);
  assert.ok(!a.request.input.at(-1).content.includes(a.oracle.selected[0].value));
  assert.equal(scoreProbeAnswer('{}', a.oracle).canClaimWebCapacity, false);
  const key = Object.keys(a.oracle.expected)[0];
  const duplicate = JSON.stringify(a.oracle.expected).replace('{', '{' + JSON.stringify(key) + ':"wrong",');
  assert.equal(scoreProbeAnswer(duplicate, a.oracle).passed, false, 'duplicate keys cannot be hidden by JSON.parse');
  const escapedKey = '"\\u' + key.charCodeAt(0).toString(16).padStart(4, '0') + key.slice(1) + '"';
  assert.equal(scoreProbeAnswer(JSON.stringify(a.oracle.expected).replace('{', '{' + escapedKey + ':"wrong",'), a.oracle).passed, false);
});

async function installed(t) {
  const paths = { cli: process.env.NATIVE_REFERENCE_CLI ?? defaultProbePaths().cli,
    bun: process.env.NATIVE_REFERENCE_BUN ?? defaultProbePaths().bun };
  try { await access(paths.cli); await access(paths.bun); }
  catch (error) {
    if (process.env.NATIVE_REFERENCE_CLI || process.env.NATIVE_REFERENCE_BUN || error.code !== 'ENOENT') throw error;
    t.skip('pinned runtime absent; this test never downloads or provisions'); return;
  }
  return paths;
}

test('checksum, unique anchors and startup-disabled source reject incompatible or re-patched bundles', async t => {
  const paths = await installed(t); if (!paths) return;
  const source = await readFile(paths.cli, 'utf8');
  for (const anchor of Object.values(WINDOW_POLICY_ANCHORS)) assert.equal(source.split(anchor).length, 2);
  const candidate = preparePinnedProbeSource(source);
  assert.ok(candidate.includes('Cs as Worker'));
  assert.ok(!candidate.includes(PROBE_STARTUP));
  assert.ok(preparePinnedProbeSource(source, { mode: 'reference' }).includes('o.contextWindow*Ir'));
  for (const bad of [source + '\n', source.replace(WINDOW_POLICY_ANCHORS.aggregate, ''), candidate, '', null]) {
    assert.throws(() => preparePinnedProbeSource(bad), /checksum/);
  }
  assert.throws(() => patchNativeWindowPolicy({}), TypeError);
  assert.throws(() => preparePinnedProbeSource(source, { mode: 'live' }), /mode/);
});

test('real pinned parser/compiler/tokenizer: baseline, 128K two/six parts, 256K and 380K six parts; both Pro families', { timeout: 540000 }, async t => {
  const paths = await installed(t); if (!paths) return;
  const report = await runNativeWindowProbe(paths);
  assert.equal(report.status, 'offline-pinned-compiler-pass');
  assert.equal(report.canClaimWebCapacity, false); assert.equal(report.onlineRequests, 0);
  assert.equal(report.runs.length, 2);
  for (const run of report.runs) {
    assert.equal(run.cases.length, 8); assert.deepEqual(run.blockedCalls, []);
    for (const row of run.cases) {
      assert.equal(row.physicalMessages.length, 6);
      assert.equal(row.selectedMarkerParts.every(marker => marker.part >= 1 && marker.part <= 6), true);
      assert.ok(row.inputTokens <= row.targetInputTokens && row.inputTokens >= row.targetInputTokens - 192);
      assert.equal(row.sixPart.passed, run.mode === 'candidate' || row.targetInputTokens < 336579);
      if (row.targetInputTokens === 128000) assert.equal(row.twoPart.passed, true);
      if (row.targetInputTokens === 380000) assert.equal(row.twoPart.passed, false);
      if (run.mode === 'candidate') {
        assert.equal(row.stageEffort, 'max'); assert.equal(row.compaction.completeHistory, true);
        assert.equal(row.compaction.trimmedMessages, 0);
      }
    }
  }
  t.diagnostic(JSON.stringify(report.runs.map(run => ({ mode: run.mode, checks: run.checks.length,
    cases: run.cases.map(row => ({ family: row.family, target: row.targetInputTokens, actual: row.inputTokens, six: row.sixPart.passed })) }))));
});
