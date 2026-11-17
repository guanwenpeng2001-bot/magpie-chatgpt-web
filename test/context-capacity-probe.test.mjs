import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { TIERS, generateCorpus, createChallenge, checkResult, measure } from '../scripts/context-capacity-probe.mjs';

const dataset = generateCorpus({ seed: 'offline-corpus-seed' });
const challenge = createChallenge({ ...dataset, seed: 'selected-after-corpus' });

function fixture(bundle = challenge) {
  const requestCapture = Buffer.from(bundle.payload);
  const responseCapture = Buffer.from(JSON.stringify(Object.fromEntries(bundle.manifest.selected.map(n => [n.key, n.value]))));
  const record = (boundary, bytes) => ({ boundary, ...measure(bytes), complete: true, truncated: false });
  return {
    ...bundle, requestCapture, responseCapture,
    evidence: {
      schemaVersion: 1, kind: 'synthetic', runId: 'offline-test', model: 'fixture-no-model',
      payloadSha256: measure(bundle.payload).sha256, httpStatus: 200,
      request: record('provider-outbound-input', requestCapture),
      receiver: record('provider-received-input', requestCapture),
      response: { ...record('model-final-output', responseCapture), finishReason: 'stop' },
    },
  };
}

for (const [tier, tokens] of Object.entries(TIERS)) test(`${tier}: reproducible corpus, dispersed records and exact payload accounting`, () => {
  const a = generateCorpus({ tier, seed: 'repeatable' });
  const b = generateCorpus({ tier, seed: 'repeatable' });
  assert.deepEqual(a, b);
  assert.equal(Buffer.byteLength(a.corpus), tokens * 4);
  assert.equal(a.manifest.corpus.estimatedTokens, tokens);
  assert.equal(new Set(a.manifest.needles.map(n => n.key)).size, 96);
  assert.equal(new Set(a.manifest.needles.map(n => n.value)).size, 96);
  for (const n of a.manifest.needles) {
    assert.equal(Buffer.from(a.corpus).subarray(n.byteOffset, n.byteOffset + n.byteLength).toString(), `\nRECORD ${n.key}=${n.value}\n`);
  }
  const c = createChallenge({ ...a, seed: 'later' });
  assert.equal(c.manifest.payload.bytes, Buffer.byteLength(c.payload));
  assert.ok(c.manifest.payload.bytes > a.manifest.corpus.bytes);
  for (const [span, start, end] of [['early', 0, 0.2], ['middle', 0.4, 0.6], ['late', 0.8, 1]]) {
    const selected = c.manifest.selected.filter(n => n.span === span);
    assert.equal(selected.length, 3);
    assert.ok(selected.every(n => n.byteOffset >= start * tokens * 4 && n.byteOffset < end * tokens * 4));
  }
  assert.equal(checkResult(fixture(c)).status, 'offline-fixture-pass');
});

test('challenge is independently selected after generation and contains no oracle or seeds', () => {
  const other = createChallenge({ ...dataset, seed: 'another-later-choice' });
  assert.notDeepEqual(other.manifest.selected, challenge.manifest.selected);
  assert.deepEqual(createChallenge({ ...dataset, seed: 'selected-after-corpus' }), challenge);
  assert.ok(other.payload.startsWith(dataset.corpus));
  for (const n of dataset.manifest.needles) assert.ok(!challenge.challenge.includes(n.value));
  for (const secret of [dataset.manifest.seed, challenge.manifest.challengeSeed]) assert.ok(!challenge.payload.includes(secret));
  for (const n of challenge.manifest.selected) assert.equal(challenge.payload.split(n.value).length - 1, 1);
  assert.notEqual(generateCorpus({ seed: 'different' }).manifest.corpus.sha256, dataset.manifest.corpus.sha256);
});

test('passing fixtures are explicitly synthetic, never a capacity or full retention claim', () => {
  const result = checkResult(fixture());
  assert.equal(result.status, 'offline-fixture-pass');
  assert.equal(result.passed, true);
  assert.equal(result.canClaimSupport, false);
  assert.equal(result.transmission, 'attested-complete');
  assert.equal(result.recall.correct, 9);
  for (const n of challenge.manifest.selected) assert.ok(!JSON.stringify(result).includes(n.value));
  const live = fixture();
  live.evidence.kind = 'live';
  assert.equal(checkResult(live).status, 'sampled-recall-pass');
  assert.equal(checkResult(live).canClaimSupport, false);
});

const failures = [
  ['HTTP 200 only', f => { f.evidence = { httpStatus: 200 }; }, 'complete-transmission-not-established'],
  ['missing evidence', f => { delete f.evidence; }, 'missing-or-unbound-evidence'],
  ['missing receiver receipt', f => { delete f.evidence.receiver; }, 'complete-transmission-not-established'],
  ['missing request capture', f => { delete f.requestCapture; }, 'outbound-input-incomplete-or-unverified'],
  ['truncated tool output', f => { f.requestCapture = f.requestCapture.subarray(0, 40_000); f.evidence.request = { ...f.evidence.request, ...measure(f.requestCapture) }; }, 'outbound-input-incomplete-or-unverified'],
  ['same-size changed payload', f => { f.requestCapture = Buffer.from(f.requestCapture); f.requestCapture[100] ^= 1; f.evidence.request = { ...f.evidence.request, ...measure(f.requestCapture) }; }, 'outbound-input-incomplete-or-unverified'],
  ['capture preview flag', f => { f.evidence.request.truncated = true; }, 'outbound-input-incomplete-or-unverified'],
  ['local file is not outbound capture', f => { f.evidence.request.boundary = 'local-file'; }, 'outbound-input-incomplete-or-unverified'],
  ['receiver hash mismatch', f => { f.evidence.receiver.sha256 = 'bad'; }, 'complete-transmission-not-established'],
  ['receiver only has a byte count', f => { delete f.evidence.receiver.sha256; }, 'complete-transmission-not-established'],
  ['unknown receiver completeness', f => { f.evidence.receiver.complete = null; }, 'complete-transmission-not-established'],
  ['stale run payload', f => { f.evidence.payloadSha256 = 'stale'; }, 'missing-or-unbound-evidence'],
  ['missing model', f => { delete f.evidence.model; }, 'missing-or-unbound-evidence'],
  ['nonboolean completion', f => { f.evidence.request.complete = 'true'; }, 'outbound-input-incomplete-or-unverified'],
  ['response truncation flag', f => { f.evidence.response.truncated = true; }, 'response-incomplete-or-unverified'],
  ['token-limited answer', f => { f.evidence.response.finishReason = 'length'; }, 'response-incomplete-or-unverified'],
  ['missing final answer', f => { delete f.responseCapture; }, 'response-incomplete-or-unverified'],
  ['HTTP failure despite matching files', f => { f.evidence.httpStatus = 413; }, 'http-error'],
  ['modified oracle', f => { f.manifest = structuredClone(f.manifest); f.manifest.selected[0].value = 'forged'; }, 'payload-or-oracle-integrity'],
  ['removed early challenge', f => { f.manifest = structuredClone(f.manifest); f.manifest.selected = f.manifest.selected.filter(n => n.span !== 'early'); }, 'payload-or-oracle-integrity'],
  ['modified saved payload', f => { f.payload += 'injected'; }, 'payload-or-oracle-integrity'],
];
for (const [name, mutate, reason] of failures) test(`fail closed: ${name}`, () => {
  const f = fixture();
  mutate(f);
  const result = checkResult(f);
  assert.equal(result.passed, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.canClaimSupport, false);
  assert.match(result.claim, /cannot claim/);
  assert.ok(result.failures.includes(reason), JSON.stringify(result.failures));
});

for (const span of ['early', 'middle', 'late']) test(`wrong or missing ${span} answers fail despite complete transport`, () => {
  const f = fixture();
  const answers = JSON.parse(f.responseCapture);
  const needle = f.manifest.selected.find(n => n.span === span);
  answers[needle.key] = null;
  f.responseCapture = Buffer.from(JSON.stringify(answers));
  Object.assign(f.evidence.response, measure(f.responseCapture));
  const result = checkResult(f);
  assert.equal(result.transmission, 'attested-complete');
  assert.equal(result.passed, false);
  assert.equal(result.recall.spans[span].correct, 2);
  assert.ok(result.failures.includes('recall-failed'));
});

test('reject malformed JSON, prose-wrapped responses, arrays and extra keys', () => {
  for (const answer of ['{', '[]', 'null', `Here is the answer: ${fixture().responseCapture}`, JSON.stringify({ ...JSON.parse(fixture().responseCapture), unexpected: 'value' })]) {
    const f = fixture();
    f.responseCapture = Buffer.from(answer);
    Object.assign(f.evidence.response, measure(f.responseCapture));
    assert.equal(checkResult(f).passed, false);
  }
});

test('invalid tiers, seeds, sample counts and modified corpora are rejected', () => {
  for (const tier of ['64K', 'toString', '__proto__']) assert.throws(() => generateCorpus({ tier }));
  for (const seed of ['', null, 123]) assert.throws(() => generateCorpus({ seed }));
  for (const perSpan of [0, 17, 1.5, NaN]) assert.throws(() => createChallenge({ ...dataset, perSpan }));
  assert.throws(() => createChallenge({ ...dataset, corpus: dataset.corpus.slice(1) }), /integrity/);
  assert.equal(measure('汉字').bytes, 6);
  assert.equal(measure('汉字').estimatedTokens, 2);
});

test('CLI generates all tiers, selects later, writes complete files, checks evidence and refuses overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-capacity-probe-'));
  const script = fileURLToPath(new URL('../scripts/context-capacity-probe.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  try {
    const output = join(root, 'corpora');
    const bundle = join(root, 'challenge');
    const generated = run('generate', '--out', output, '--seed', 'cli-corpus');
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(generated.stdout).tiers.length, 4);
    assert.ok(generated.stdout.length < 4096);
    for (const [tier, tokens] of Object.entries(TIERS)) assert.equal((await readFile(join(output, tier, 'corpus.txt'))).length, tokens * 4);
    const selected = run('challenge', '--input', join(output, '1M'), '--out', bundle, '--seed', 'cli-challenge');
    assert.equal(selected.status, 0, selected.stderr);
    const manifest = JSON.parse(await readFile(join(bundle, 'private-challenge.json'), 'utf8'));
    const payload = await readFile(join(bundle, 'payload.txt'), 'utf8');
    assert.equal(Buffer.byteLength(payload), manifest.payload.bytes);
    assert.ok(payload.length > 4_000_000);
    assert.ok(selected.stdout.length < 1024);
    const template = JSON.parse(await readFile(join(bundle, 'evidence-template.json'), 'utf8'));
    assert.equal(template.receiver.complete, null);
    const f = fixture({ payload, manifest });
    const request = join(root, 'request.txt');
    const response = join(root, 'response.json');
    const evidence = join(root, 'evidence.json');
    await writeFile(request, f.requestCapture);
    await writeFile(response, f.responseCapture);
    await writeFile(evidence, JSON.stringify(f.evidence));
    const args = ['check', '--bundle', bundle, '--request', request, '--response', response, '--evidence', evidence];
    const report = join(root, 'report.json');
    assert.equal(run(...args, '--out', report).status, 0);
    const saved = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(saved.status, 'offline-fixture-pass');
    assert.equal(saved.canClaimSupport, false);
    assert.equal(run(...args, '--out', report).status, 2);
    await writeFile(evidence, JSON.stringify(template));
    assert.equal(run(...args, '--out', join(root, 'failed.json')).status, 1);
    await writeFile(evidence, '{');
    const invalid = run(...args, '--out', join(root, 'invalid.json'));
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Cannot claim/);
    assert.equal(run('generate', '--out', output).status, 2);
    assert.equal(run('generate', '--out', join(root, 'bad'), '--tier', '64K').status, 2);
    assert.equal(run('challenge', '--out', join(root, 'bad')).status, 2);
    assert.equal(run('--help').status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
