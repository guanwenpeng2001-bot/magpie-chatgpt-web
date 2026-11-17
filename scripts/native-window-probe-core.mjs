import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PINNED_WINDOW_CLI_SHA256, patchNativeWindowPolicy } from '../src/native/window-policy.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const PROBE_CAPABILITIES = Object.freeze({ solAvailable: true, proAvailable: true,
  extraHighAvailable: false, localToolsEnabled: false, experimentalBiggerContext: true, experimentalWindowPolicy: true });
export const PROBE_STARTUP = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
export const PROBE_EXPORTS = '\nexport { Cs as Worker, Fn as parseRequest, sd as route, Xt as compile, Nt as tokens, Ai as messages, Pe as textTokens, dC as tokenizer, ht as mode, at as limits, rn as transportLimits, gs as messageTokens, fs as messageChars, v_ as stagingMode, y_ as assertMultipart, Iu as assertOrdinary, _r as stagePayload, ao as finalPayload, Pi as imageTokens, pn as skillTokens };\n';

/** Source processing only; does NOT import or run the CLI. The live driver must
 * provide its own explicitly owned Worker/config and capture actual sends.
 */
export function preparePinnedProbeSource(source, { mode = 'candidate', ...policyOptions } = {}) {
  if (typeof source !== 'string' || sha256(source) !== PINNED_WINDOW_CLI_SHA256) throw new Error('Pinned probe checksum mismatch');
  if (!['reference', 'candidate'].includes(mode)) throw new Error('Invalid probe mode');
  const patched = mode === 'candidate' ? patchNativeWindowPolicy(source, policyOptions) : source;
  if (patched.split(PROBE_STARTUP).length !== 2) throw new Error('Unique CLI startup required');
  return patched.replace(PROBE_STARTUP, '') + PROBE_EXPORTS;
}

export function createProbeSource({ family = '6', units, recordCount,
  corpusSeed = 'offline-window-corpus-v1', challengeSeed = 'offline-window-challenge-v1' }) {
  if (!['6', '5.6'].includes(family) || !Number.isSafeInteger(units) || units < 0
      || !Number.isSafeInteger(recordCount) || recordCount < 12 || recordCount > 1000) throw new Error('Invalid corpus shape');
  const records = Array.from({ length: recordCount }, (_, index) => {
    const recordId = `record_${String(index).padStart(4, '0')}`;
    const key = 'k' + sha256(JSON.stringify([corpusSeed, recordId, 'key'])).slice(0, 24);
    const value = 'v' + sha256(JSON.stringify([corpusSeed, recordId, 'value'])).slice(0, 24);
    const count = Math.floor((index + 1) * units / recordCount) - Math.floor(index * units / recordCount);
    const text = `SOURCE ${recordId}\nRECORD ${key}=${value}\nEscapes: "[]<>" 中文 😀 \\ literal.\n${' amber'.repeat(count)}\nEND ${recordId}`;
    return { recordId, key, value, text, sha256: sha256(text) };
  });
  const selected = Array.from({ length: 12 }, (_, stratum) => {
    const start = Math.floor(stratum * recordCount / 12), end = Math.floor((stratum + 1) * recordCount / 12);
    const index = start + parseInt(sha256(JSON.stringify([challengeSeed, stratum])).slice(0, 8), 16) % (end - start);
    const { text, ...item } = records[index]; return { ...item, index, stratum };
  });
  const request = {
    model: `chatgpt-web/gpt-${family}-pro`, reasoning: { effort: 'max' },
    instructions: 'Read the complete source records. Preserve identifiers and values. Do not use tools, files, browsing, retrieval or external memory. Answer the final query with only a JSON object.',
    input: [...records.map(record => ({ type: 'message', id: record.recordId, role: 'user', content: record.text })),
      { type: 'message', id: 'challenge', role: 'user', content: 'Return exactly the value for each requested key as a JSON object. Use null if unavailable. No prose or tools. Requested keys: ' + selected.map(item => item.key).join(', ') }],
  };
  return { request, oracle: { corpusSeed, challengeSeed, selected,
    expected: Object.fromEntries(selected.map(item => [item.key, item.value])),
    records: records.map(({ text, ...item }) => item) } };
}

export function compileProbe(native, source, { capabilities = PROBE_CAPABILITIES, parts = 6, compaction = false } = {}) {
  const raw = structuredClone(source.request);
  const parsed = native.parseRequest(raw);
  native.route(parsed, { mode: 'full', browserInteractionMode: 'automatic', ...capabilities });
  if (compaction) parsed._compactionRequest = true;
  assert.equal(parsed.options.reasoning, 'max', 'route must retain Pro effort');
  assert.ok(['6', '5.6'].includes(parsed._chatgptModelFamily));
  const before = JSON.stringify(parsed);
  const compiled = native.compile(parsed, capabilities, undefined, { appName: 'Offline window probe', experimentalMultipartParts: parts ?? undefined });
  assert.equal(JSON.stringify(parsed), before, 'compiler may not change canonical input');
  return { source, parsed, compiled, parts, capabilities, inputTokens: native.tokens(compiled, parsed.modelId) };
}

export function verifyProbeRecords(bundle) {
  const { source, parsed, compiled, parts } = bundle;
  assert.equal(compiled.multipart.parts.length, parts);
  assert.equal(compiled.trimmedCompactionMessages ?? 0, 0, 'no compaction trimming');
  const decoded = compiled.multipart.parts.map((part, index) => {
    const body = JSON.parse(part);
    assert.equal(body.part_index, index + 1); assert.equal(body.total_parts, parts);
    return body.records;
  });
  const records = decoded.flat();
  const systems = records.filter(record => record.kind === 'system');
  assert.deepEqual(systems.map(record => record.system_index), systems.map((_, index) => index));
  assert.deepEqual(systems.map(record => record.content), parsed.context.systemPrompt);
  const messages = records.filter(record => record.kind === 'message');
  assert.equal(records.length, systems.length + messages.length);
  assert.deepEqual(messages.map(record => record.message_index), messages.map((_, index) => index));
  assert.equal(messages.length, source.request.input.length, 'all original source records and challenge survive');
  for (const [index, record] of messages.entries()) {
    assert.equal(record.message.role, source.request.input[index].role);
    assert.equal(record.message.content, source.request.input[index].content, 'byte-exact source text including Unicode and escaping');
  }
  const partMarkers = decoded.map(rows => rows.filter(row => row.kind === 'message').map(row => source.request.input[row.message_index].id));
  return { canonicalSha256: sha256(JSON.stringify(source.request)),
    multipartRecordsSha256: sha256(JSON.stringify(records)), originalMessages: messages.length,
    originalSystemRecords: systems.length, recordCountsByPart: decoded.map(rows => rows.length),
    selectedMarkerParts: source.oracle.selected.map(marker => ({ recordId: marker.recordId,
      part: partMarkers.findIndex(ids => ids.includes(marker.recordId)) + 1 })) };
}

export function physicalProbeMessages(native, compiled, transactionId) {
  if (!/^ctx_[a-f0-9]{32}$/.test(transactionId)) throw new Error('Invalid transaction ID');
  const count = compiled.multipart.parts.length;
  const stages = compiled.multipart.parts.slice(0, -1).map((part, index) => native.stagePayload(part, transactionId, index + 1, count));
  return { messages: [...stages.map(stage => stage.text), native.finalPayload(compiled.multipart, transactionId)],
    acknowledgements: stages.map(stage => stage.acknowledgement) };
}

export function preflightProbe(native, bundle, { transactionId = 'ctx_' + 'a'.repeat(32) } = {}) {
  const { compiled, parsed, capabilities, parts } = bundle;
  const physical = physicalProbeMessages(native, compiled, transactionId);
  const tokens = physical.messages.map(text => native.textTokens(text, parsed.modelId));
  const ackTokens = physical.acknowledgements.reduce((sum, text) => sum + native.textTokens(text, parsed.modelId), 0);
  const imageTokens = native.imageTokens(compiled), skillTokens = native.skillTokens(compiled.skillFiles, parsed.modelId);
  const actualInputTokens = 8192 + tokens.reduce((sum, count) => sum + count, 0) + ackTokens + imageTokens + skillTokens;
  const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
  const maxStageChars = Math.max(...physical.messages.slice(0, -1).map(text => text.length));
  const stage = native.stagingMode(parsed.modelId, capabilities, maxStageMessageTokens, maxStageChars);
  native.assertMultipart(Math.max(bundle.inputTokens, actualInputTokens), Math.max(...tokens), parsed.modelId, 'max', capabilities,
    Math.max(...physical.messages.map(text => text.length)), parts, {
      stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars,
      finalMessageTokens: tokens.at(-1) + skillTokens, finalMessageChars: physical.messages.at(-1).length, finalImageTokens: imageTokens,
    }, parsed._chatgptModelFamily);
  return { ...physical, actualInputTokens, acknowledgementTokens: ackTokens, stageEffort: stage.effort,
    physical: physical.messages.map((text, index) => ({ part: index + 1, referenceTokens: tokens[index],
      wholeStringTokens: native.tokenizer().encode_ordinary(text).length,
      utf16Chars: text.length, utf8Bytes: Buffer.byteLength(text), jsonStringBytes: Buffer.byteLength(JSON.stringify(text)), sha256: sha256(text) })) };
}

/** Target is FULL compiled input incl. wrappers/ACK/8192, not corpus net tokens.
 * Deterministic corpus and separate challenge seeds make original/candidate
 * comparisons identical. Live callers should supply their own private seeds.
 */
export function calibrateProbe(native, { family = '6', targetInputTokens, capabilities = PROBE_CAPABILITIES,
  corpusSeed = `offline-corpus-${family}-${targetInputTokens}`, challengeSeed = `offline-challenge-${family}-${targetInputTokens}` } = {}) {
  assert.ok(Number.isSafeInteger(targetInputTokens) && targetInputTokens >= 32_000 && targetInputTokens <= 500_000);
  assert.equal(native.tokenizer().encode_ordinary(' amber').length, 1);
  const recordCount = Math.max(16, Math.ceil(targetInputTokens / 1800));
  let units = targetInputTokens - 12000, bundle;
  for (let iteration = 0; iteration < 12; iteration++) {
    const source = createProbeSource({ family, units, recordCount, corpusSeed, challengeSeed });
    bundle = compileProbe(native, source, { capabilities });
    const delta = targetInputTokens - 64 - bundle.inputTokens;
    if (bundle.inputTokens <= targetInputTokens && bundle.inputTokens >= targetInputTokens - 192) {
      verifyProbeRecords(bundle); return { ...bundle, calibrationIterations: iteration + 1 };
    }
    units = Math.max(0, units + delta);
  }
  throw new Error(`Unable to calibrate ${family}/${targetInputTokens}: ${bundle?.inputTokens}`);
}

export function scoreProbeAnswer(text, oracle) {
  let answer;
  try { answer = JSON.parse(text); } catch { return { passed: false, correct: 0, total: oracle.selected.length, error: 'invalid-json', canClaimWebCapacity: false }; }
  const object = answer && typeof answer === 'object' && !Array.isArray(answer);
  const checks = oracle.selected.map(({ key, recordId, stratum }) => ({ key, recordId, stratum,
    correct: !!object && Object.hasOwn(answer, key) && answer[key] === oracle.expected[key] }));
  const correct = checks.filter(check => check.correct).length;
  // JSON.parse keeps the last duplicate property. A valid answer is a flat
  // string-to-string dictionary, so its lexical string tokens alternate keys
  // and values. Check the original keys as well, including escaped spellings.
  const flat = object && Object.values(answer).every(value => typeof value === 'string');
  const rawKeys = flat ? [...text.matchAll(/"(?:\\.|[^"\\])*"/g)]
    .filter((_, index) => index % 2 === 0).map(match => JSON.parse(match[0])) : [];
  const exactKeys = flat && rawKeys.length === checks.length && new Set(rawKeys).size === rawKeys.length
    && Object.keys(answer).length === checks.length && Object.keys(answer).every(key => Object.hasOwn(oracle.expected, key));
  return { passed: !!exactKeys && correct === checks.length, correct, total: checks.length, checks, canClaimWebCapacity: false };
}
