import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { defaultHistoryProbePaths, HISTORY_PROBE_MIN_TOKENS, HISTORY_PROBE_PIN,
  prepareHistoryProbePreload, runNativeHistoryCapacityProbe } from '../scripts/native-history-capacity-probe.mjs';

async function installed(t) {
  const paths = { cli: process.env.NATIVE_REFERENCE_CLI ?? defaultHistoryProbePaths().cli,
    bun: process.env.NATIVE_REFERENCE_BUN ?? defaultHistoryProbePaths().bun };
  try { await access(paths.cli); await access(paths.bun); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_REFERENCE_CLI || process.env.NATIVE_REFERENCE_BUN) throw error;
    t.skip('Installed offline v6.1.18 pin is required; this test never downloads'); return;
  }
  return paths;
}

test('capacity probe rejects a wrong pin before launching and bounds child timeout', async () => {
  assert.throws(() => prepareHistoryProbePreload('unused', Buffer.from('not the pinned bundle')), /checksum/);
  for (const timeoutMs of [0, -1, Infinity, NaN, 1.5, '1000', 600001]) {
    await assert.rejects(runNativeHistoryCapacityProbe({ timeoutMs }), TypeError);
  }
});

test('offline pinned history: >=1M original tokens, every record paged, process restart and cross-thread denial', { timeout: 540_000 }, async t => {
  const paths = await installed(t); if (!paths) return;
  const before = await readFile(paths.cli);
  const report = await runNativeHistoryCapacityProbe(paths);
  assert.deepEqual(await readFile(paths.cli), before, 'installed pin is never modified');
  assert.equal(report.status, 'offline-pinned-history-capacity-pass');
  assert.equal(report.pinnedCliSha256, HISTORY_PROBE_PIN);
  assert.equal(report.live, false); assert.equal(report.canClaimWebCapacity, false);
  assert.equal(report.onlineRequests, 0); assert.equal(report.realSessionsTouched, false); assert.equal(report.realAccountFilesRead, false);
  assert.ok(report.corpus.capacityTokens >= HISTORY_PROBE_MIN_TOKENS);
  assert.equal(report.corpus.records, 17); assert.equal(report.corpus.capacityRecords, 16);
  assert.ok(report.corpus.utf8Bytes > 6_000_000);
  assert.ok(report.corpus.utf8Bytes > report.corpus.utf16Chars, 'non-ASCII text is included');
  assert.equal(report.runs.length, 2);
  const [ingest, reopen] = report.runs;
  assert.equal(ingest.phase, 'ingest'); assert.equal(reopen.phase, 'reopen');
  assert.notEqual(ingest.pid, reopen.pid); assert.notEqual(ingest.processNonce, reopen.processNonce);
  assert.equal(ingest.corpusCaptures, 16); assert.equal(reopen.corpusCaptures, 0);
  assert.equal(ingest.missingProofRejected, true);
  assert.equal(ingest.canonicalProofs, 18); assert.equal(reopen.canonicalProofs, 2);
  assert.equal(reopen.archiveUnchangedByContinuation, true);
  assert.equal(ingest.archiveSha256, reopen.archiveSha256);
  assert.deepEqual(report.processRestart, { distinctProcesses: true, firstProcessExited: true, corpusRecaptured: false, archiveCiphertextUnchanged: true });
  const expectedPages = report.corpus.recordDigests.reduce((sum, record) => sum + Math.ceil(record.chars / 12000), 0);
  for (const run of report.runs) {
    assert.deepEqual(run.corpus, report.corpus);
    assert.equal(run.live, false); assert.deepEqual(run.blockedCalls, []);
    assert.equal(run.stats.records, report.corpus.records); assert.equal(run.stats.bytes, report.corpus.utf8Bytes);
    assert.equal(run.recoveredChars, report.corpus.utf16Chars); assert.equal(run.recoveredBytes, report.corpus.utf8Bytes);
    assert.equal(run.recoveredTokens, report.corpus.tokens);
    assert.equal(run.markerHits, 49); assert.equal(run.pages, expectedPages); assert.ok(run.pages > 500);
    assert.equal(run.pageChars, 12000); assert.equal(run.splitSurrogatePages, 16);
    assert.deepEqual(run.isolation, { foreignSearchesEmpty: 49, foreignReadsNull: 17, foreignRecords: 1,
      reverseDirectionBlocked: true, scopeArgumentsRejected: 3, invalidBindingRejected: true });
    assert.ok(run.brokerInvocations > run.pages + run.markerHits);
  }
  t.diagnostic(JSON.stringify({ live: false, capacityTokens: report.corpus.capacityTokens, originalTokens: report.corpus.tokens,
    records: report.corpus.records, utf8Bytes: report.corpus.utf8Bytes, utf16Chars: report.corpus.utf16Chars,
    runs: report.runs.map(run => ({ phase: run.phase, pid: run.pid, pages: run.pages, markerHits: run.markerHits,
      brokerInvocations: run.brokerInvocations, isolation: run.isolation })), restart: report.processRestart }));
});
