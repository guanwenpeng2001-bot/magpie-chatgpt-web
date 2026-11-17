import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Offline only. No provider imports, account discovery, configuration or network access.
// K/M are decimal; tiers size the corpus using a heuristic, NOT a model tokenizer.
export const TIERS = Object.freeze({ '128K': 128_000, '256K': 256_000, '512K': 512_000, '1M': 1_000_000 });
const WORDS = 'able acid aged also area army away baby back ball band bank base bath bear beat been beer bell belt best bill bird blow blue boat body bomb bond bone book boom'.split(' ');
const SPANS = { early: [0, 0.2], middle: [0.4, 0.6], late: [0.8, 1] };
const HEADER = 'CONTEXT DATASET v1\nEach RECORD contains an independent key and value.\n';
const FOOTER = '\nEND CONTEXT DATASET\n';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const derive = (...parts) => hash(JSON.stringify(parts));
const freshSeed = () => randomBytes(32).toString('hex');

function seedValue(seed) {
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 256) throw new Error('Seed must contain 1..256 characters.');
  return seed;
}

export function measure(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return {
    bytes: buffer.length, sha256: hash(buffer), estimatedTokens: Math.ceil(buffer.length / 4),
    tokenEstimateMethod: 'ceil(UTF-8 bytes / 4); heuristic only, not tokenizer-measured',
  };
}

function filler(length, seed) {
  const entropy = createHash('shake256', { outputLength: Math.ceil(length / 5) }).update(seed).digest();
  return Array.from(entropy, byte => `${WORDS[byte % WORDS.length]} `).join('').slice(0, length);
}

export function generateCorpus({ tier = '128K', seed = freshSeed() } = {}) {
  if (!Object.hasOwn(TIERS, tier)) throw new Error('Tier must be 128K, 256K, 512K or 1M.');
  seedValue(seed);
  const targetBytes = TIERS[tier] * 4;
  const available = targetBytes - HEADER.length - FOOTER.length;
  const parts = [HEADER];
  const needles = [];
  let offset = HEADER.length;
  // One random position in each of 96 equal strata prevents clustering at the ends.
  for (let i = 0; i < 96; i++) {
    const length = Math.floor((i + 1) * available / 96) - Math.floor(i * available / 96);
    const key = `K_${derive(seed, tier, 'key', i).slice(0, 32)}`;
    const value = `V_${derive(seed, tier, 'value', i).slice(0, 32)}`;
    const record = `\nRECORD ${key}=${value}\n`;
    const at = parseInt(derive(seed, tier, 'position', i).slice(0, 8), 16) % (length - record.length + 1);
    const padding = filler(length - record.length, derive(seed, tier, 'filler', i));
    parts.push(padding.slice(0, at), record, padding.slice(at));
    needles.push({ key, value, byteOffset: offset + at, byteLength: record.length });
    offset += length;
  }
  parts.push(FOOTER);
  const corpus = parts.join('');
  return {
    corpus,
    manifest: { schemaVersion: 1, kind: 'private-corpus', tier, seed, targetEstimatedTokens: TIERS[tier], corpus: measure(corpus), needles },
  };
}

function validateCorpus(corpus, manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'private-corpus') throw new Error('Invalid corpus manifest.');
  const regenerated = generateCorpus({ tier: manifest.tier, seed: manifest.seed });
  if (corpus !== regenerated.corpus || json(manifest) !== json(regenerated.manifest)) throw new Error('Corpus/manifest integrity failure.');
}

export function createChallenge({ corpus, manifest, seed = freshSeed(), perSpan = 3 }) {
  validateCorpus(corpus, manifest);
  seedValue(seed);
  if (!Number.isSafeInteger(perSpan) || perSpan < 1 || perSpan > 16) throw new Error('perSpan must be an integer in 1..16.');
  // Selection is a separate step, after the complete corpus has been committed.
  // The selection seed and answer oracle must never be included in model input.
  const selected = Object.entries(SPANS).flatMap(([span, [start, end]]) => {
    const candidates = manifest.needles.filter(n => n.byteOffset / manifest.corpus.bytes >= start && n.byteOffset / manifest.corpus.bytes < end);
    return candidates.map(n => ({ ...n, span, rank: derive(seed, manifest.corpus.sha256, n.key) }))
      .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0).slice(0, perSpan)
      .map(({ rank, ...needle }) => needle);
  });
  const challenge = '\nCHALLENGE\nRead the records above. Return only a JSON object mapping each requested key to its exact value. '
    + 'Use null if a value cannot be found. Do not use tools or external files.\nRequested keys:\n'
    + selected.map(n => n.key).join('\n') + '\n';
  const payload = corpus + challenge;
  return {
    payload, challenge,
    manifest: {
      schemaVersion: 1, kind: 'private-challenge', tier: manifest.tier,
      corpusSeed: manifest.seed, challengeSeed: seed, perSpan,
      corpus: manifest.corpus, payload: measure(payload), selected,
    },
  };
}

function validateBundle(payload, manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'private-challenge') throw new Error('Invalid challenge manifest.');
  const dataset = generateCorpus({ tier: manifest.tier, seed: manifest.corpusSeed });
  const expected = createChallenge({ ...dataset, seed: manifest.challengeSeed, perSpan: manifest.perSpan });
  if (payload !== expected.payload || json(manifest) !== json(expected.manifest)) throw new Error('Payload/oracle integrity failure.');
}

// Evidence contract: requestCapture is the exact UTF-8 model-input text extracted
// at the provider outbound boundary, not the original file or a terminal preview.
// The separate receiver receipt must describe the same decoded text, not HTTP
// envelope bytes. Without a receipt, delivery remains unknown even with HTTP 200.
// These are caller-supplied attestations, not authenticated server measurements.
export function checkResult({ payload, manifest, requestCapture, responseCapture, evidence }) {
  const failures = [];
  let validBundle = true;
  try { validateBundle(payload, manifest); }
  catch { failures.push('payload-or-oracle-integrity'); validBundle = false; }
  const expected = measure(payload);
  const request = Buffer.isBuffer(requestCapture) ? measure(requestCapture) : null;
  const response = Buffer.isBuffer(responseCapture) ? measure(responseCapture) : null;
  const matches = (record, actual) => actual !== null && record?.bytes === actual.bytes && record?.sha256 === actual.sha256;
  const complete = record => record?.complete === true && record?.truncated === false;
  const bound = evidence?.schemaVersion === 1 && evidence.payloadSha256 === expected.sha256
    && typeof evidence.runId === 'string' && evidence.runId.trim().length > 0
    && typeof evidence.model === 'string' && evidence.model.trim().length > 0
    && ['live', 'synthetic'].includes(evidence.kind);
  if (!bound) failures.push('missing-or-unbound-evidence');
  const exactRequest = request !== null && request.bytes === expected.bytes && request.sha256 === expected.sha256;
  const outboundComplete = bound && validBundle && exactRequest && complete(evidence.request)
    && matches(evidence.request, request) && evidence.request.boundary === 'provider-outbound-input';
  if (!outboundComplete) failures.push('outbound-input-incomplete-or-unverified');
  const deliveryComplete = outboundComplete && complete(evidence.receiver)
    && matches(evidence.receiver, expected) && evidence.receiver.boundary === 'provider-received-input';
  if (!deliveryComplete) failures.push('complete-transmission-not-established');
  const responseComplete = bound && complete(evidence.response) && matches(evidence.response, response)
    && evidence.response.boundary === 'model-final-output' && evidence.response.finishReason === 'stop';
  if (!responseComplete) failures.push('response-incomplete-or-unverified');
  if (Number.isInteger(evidence?.httpStatus) && (evidence.httpStatus < 200 || evidence.httpStatus >= 300)) failures.push('http-error');
  let answers = null;
  try {
    if (!response) throw new Error('Missing response');
    answers = JSON.parse(responseCapture.toString('utf8'));
    if (!answers || Array.isArray(answers) || typeof answers !== 'object') throw new Error('Expected object');
  } catch { failures.push('invalid-answer-json'); }
  const checks = validBundle ? manifest.selected.map(n => ({
    key: n.key, span: n.span, byteOffset: n.byteOffset,
    correct: answers !== null && Object.hasOwn(answers, n.key) && answers[n.key] === n.value,
  })) : [];
  if (!checks.length || checks.some(n => !n.correct)) failures.push('recall-failed');
  if (answers && validBundle && (Object.keys(answers).length !== checks.length || Object.keys(answers).some(key => !checks.some(n => n.key === key)))) failures.push('unexpected-answer-keys');
  const passed = failures.length === 0;
  return {
    schemaVersion: 1, tier: validBundle ? manifest.tier : null,
    status: passed ? (evidence.kind === 'synthetic' ? 'offline-fixture-pass' : 'sampled-recall-pass') : 'failed',
    passed, canClaimSupport: false,
    claim: passed ? 'Sampled recall only; cannot claim full retention or advertised context capacity.' : 'FAIL: cannot claim context support.',
    payload: expected, requestCapture: request, responseCapture: response,
    transmission: deliveryComplete ? 'attested-complete' : 'unknown-or-incomplete',
    outboundComplete, responseComplete, evidenceKind: bound ? evidence.kind : null,
    runId: bound ? evidence.runId : null, model: bound ? evidence.model : null,
    evidenceSha256: evidence === undefined ? null : hash(json(evidence)),
    recall: {
      correct: checks.filter(n => n.correct).length, total: checks.length,
      spans: Object.fromEntries(Object.keys(SPANS).map(span => [span, {
        correct: checks.filter(n => n.span === span && n.correct).length,
        total: checks.filter(n => n.span === span).length,
      }])), checks,
    },
    failures,
    limitations: [
      'Token counts are byte-based estimates; actual model tokenizer and wrapper overhead are not measured.',
      'Transmission attestations are supplied by the operator and are not authenticated by this offline checker.',
      'Matching scattered needles does not establish lossless full-context retention; no tier implies another tier.',
      'Synthetic fixtures, HTTP 200, local file sizes and truncated tool output cannot establish live model capacity.',
    ],
  };
}

const HELP = `Offline context-capacity probe (Node >=20; no network or dependencies).
  generate --out DIR [--tier all|128K|256K|512K|1M] [--seed TEXT]
  challenge --input DIR/128K --out NEW_DIR [--seed TEXT] [--per-span 3]
  check --bundle NEW_DIR --request CAPTURE.txt --response ANSWER.json --evidence EVIDENCE.json --out REPORT.json

generate creates a NEW directory with one tier subdirectory per requested tier.
Each contains corpus.txt and private-corpus.json. K/M are decimal estimates.
Run challenge only AFTER corpus generation. Its default seed is newly random;
explicit private seeds allow exact replay. It writes payload.txt, challenge.txt,
private-challenge.json and evidence-template.json. Send ONLY payload.txt as the
complete model input. Never send private manifests, seeds or an answer oracle;
do not let the model access those files. challenge.txt contains keys, no answers.
The full payload stays on disk; stdout contains only small metadata summaries.

For check, save exact outbound model-input text and final model answer to files;
do not use terminal previews. Fill evidence-template.json from independent
observations. Request and receiver records describe the same decoded UTF-8 input
text, not serialized HTTP bodies. Required fields: schemaVersion=1, kind=live or
synthetic, runId, model, payloadSha256; request, receiver, response records each
need bytes, sha256, complete=true, truncated=false and the prescribed boundary.
response also needs finishReason=stop. Unknown receiver evidence MUST stay null.
HTTP 200 alone is insufficient. A receipt is an operator attestation, not proof
authenticated by this tool. Do not copy generated hashes into observed fields.
Only exact JSON key/value answers pass. Output contains no expected values.
Exit 0: generation or sampled check passed; 1: check failed; 2: usage/I/O error.
Even a pass never certifies actual 1M tokens or complete retention. No real call
is made. Output paths must not exist; no existing files are overwritten.
`;

function evidenceTemplate(manifest) {
  const record = boundary => ({ boundary, bytes: null, sha256: null, complete: null, truncated: null });
  return {
    schemaVersion: 1, kind: null, runId: null, model: null, payloadSha256: manifest.payload.sha256,
    httpStatus: null, request: record('provider-outbound-input'), receiver: record('provider-received-input'),
    response: { ...record('model-final-output'), finishReason: null },
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help') { console.log(HELP); return 0; }
  const command = args[0];
  const allowed = {
    generate: ['out', 'tier', 'seed'], challenge: ['input', 'out', 'seed', 'per-span'],
    check: ['bundle', 'request', 'response', 'evidence', 'out'],
  }[command];
  if (!allowed) throw new Error('Unknown command; use --help.');
  const { values } = parseArgs({ args: args.slice(1), options: Object.fromEntries(allowed.map(key => [key, { type: 'string' }])), strict: true });
  const required = command === 'generate' ? ['out'] : command === 'challenge' ? ['input', 'out'] : allowed;
  for (const key of required) if (!values[key]) throw new Error(`Missing --${key}.`);
  const load = async path => JSON.parse(await readFile(path, 'utf8'));
  const write = (path, value) => writeFile(path, value, { flag: 'wx', mode: 0o600 });
  if (command === 'generate') {
    const tiers = !values.tier || values.tier === 'all' ? Object.keys(TIERS) : [values.tier];
    if (tiers.some(tier => !Object.hasOwn(TIERS, tier))) throw new Error('Invalid tier.');
    const seed = seedValue(values.seed ?? freshSeed());
    await mkdir(values.out, { mode: 0o700 });
    const summaries = [];
    for (const tier of tiers) {
      const dataset = generateCorpus({ tier, seed });
      const directory = join(values.out, tier);
      await mkdir(directory, { mode: 0o700 });
      await write(join(directory, 'corpus.txt'), dataset.corpus);
      await write(join(directory, 'private-corpus.json'), json(dataset.manifest));
      summaries.push({ tier, ...dataset.manifest.corpus });
    }
    console.log(json({ status: 'generated-offline', tiers: summaries, canClaimSupport: false }));
    return 0;
  }
  if (command === 'challenge') {
    const corpus = await readFile(join(values.input, 'corpus.txt'), 'utf8');
    const manifest = await load(join(values.input, 'private-corpus.json'));
    const challenge = createChallenge({ corpus, manifest, seed: values.seed, perSpan: values['per-span'] === undefined ? 3 : Number(values['per-span']) });
    await mkdir(values.out, { mode: 0o700 });
    await write(join(values.out, 'payload.txt'), challenge.payload);
    await write(join(values.out, 'challenge.txt'), challenge.challenge);
    await write(join(values.out, 'private-challenge.json'), json(challenge.manifest));
    await write(join(values.out, 'evidence-template.json'), json(evidenceTemplate(challenge.manifest)));
    console.log(json({ status: 'challenge-ready-offline', tier: manifest.tier, payload: challenge.manifest.payload, canClaimSupport: false }));
    return 0;
  }
  const payload = await readFile(join(values.bundle, 'payload.txt'), 'utf8');
  const manifest = await load(join(values.bundle, 'private-challenge.json'));
  const requestCapture = await readFile(values.request);
  const responseCapture = await readFile(values.response);
  const evidence = await load(values.evidence);
  const result = checkResult({ payload, manifest, requestCapture, responseCapture, evidence });
  await write(values.out, json(result));
  console.log(json({ status: result.status, failures: result.failures, canClaimSupport: false }));
  return result.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    // Do not echo file content, seeds or parser errors that may contain answers.
    console.error('ERROR: invalid arguments, artifacts or I/O; use --help. Cannot claim context support.');
    process.exitCode = 2;
  });
}
