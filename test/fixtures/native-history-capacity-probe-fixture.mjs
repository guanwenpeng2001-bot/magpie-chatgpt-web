// Runs only in a new Bun process with a startup-disabled, checksum-pinned CLI.
// All permission proof is explicitly synthetic and confined to the temp home.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';

const [entry, root, phase] = process.argv.slice(2);
assert.ok(['ingest', 'reopen'].includes(phase));
assert.equal(resolve(process.env.CODEX_HOME), resolve(join(root, 'codex')));
assert.equal(resolve(process.env.MAGPIE_NATIVE_CHECKPOINT_HOME), resolve(join(root, 'account')));
const blockedCalls = [];
// Native diagnostics include ephemeral broker capability hashes. Count only
// known diagnostic categories; never print their arguments or token material.
const print = console.log.bind(console), diagnostics = {};
const diagnosticKinds = [
  ['environmentRecovery', /^\[chatgpt-web\] trusted_environment_recovery /],
  ['brokerRegistered', /^\[chatgpt-web\] broker trace=.* registered tokenHash=/],
  ['brokerClaim', /^\[chatgpt-web\] broker claim received /],
  ['brokerRetired', /^\[chatgpt-web\] broker_retired /],
];
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = (...args) => {
  const category = diagnosticKinds.find(([, pattern]) => pattern.test(String(args[0])));
  if (!category) throw new Error('Unexpected native diagnostic in offline history fixture');
  diagnostics[category[0]] = (diagnostics[category[0]] ?? 0) + 1;
};
const deny = name => () => { blockedCalls.push(name); throw new Error(`Offline history probe forbids ${name}`); };
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

const native = await import(pathToFileURL(entry).href);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const tokenizer = native.tokenizer();
assert.equal(tokenizer.encode_ordinary(' amber').length, 1, 'pinned tokenizer calibration');
const pageChars = 12_000, owner = '11111111-1111-4111-8111-111111111111';
const foreign = '33333333-3333-4333-8333-333333333333';
const corpus = Array.from({ length: 16 }, (_, index) => {
  const key = sha256(`offline-history-capacity-v1:${index}`).slice(0, 24);
  const markers = ['START', 'MIDDLE', 'END'].map(position => `HISTORY_${position}_${key}`);
  let text = markers[0] + ' amber'.repeat(31_250) + '\r\n' + markers[1]
    + '\nOriginal unicode: 历史 🦉 e\u0301 \uFEFF; escaping: "quote" \\path\tNUL:\0\r\n'
    + ' amber'.repeat(31_250) + '\r\n' + markers[2];
  // An actual surrogate pair crosses the first page boundary. Hash after joining
  // UTF-16 pages, not by independently UTF-8-encoding broken surrogate halves.
  text = text.slice(0, pageChars - 1) + '🧭' + text.slice(pageChars - 1);
  return { text, markers };
});
const resume = { text: 'HISTORY_RESUME_CONTROL: inspect the isolated synthetic archive.', markers: ['HISTORY_RESUME_CONTROL'] };
const records = [...corpus, resume].map(record => ({ ...record, id: sha256(record.text), bytes: Buffer.byteLength(record.text),
  chars: record.text.length, tokens: tokenizer.encode_ordinary(record.text).length }));
const corpusTokens = records.slice(0, 16).reduce((sum, record) => sum + record.tokens, 0);
assert.ok(corpusTokens >= 1_000_000, 'measure raw corpus only; no metadata or continuation padding');
assert.equal(new Set(records.map(record => record.id)).size, records.length);
const corpusMetadata = {
  capacityRecords: 16, capacityTokens: corpusTokens, records: records.length,
  tokens: records.reduce((sum, record) => sum + record.tokens, 0),
  utf8Bytes: records.reduce((sum, record) => sum + record.bytes, 0),
  utf16Chars: records.reduce((sum, record) => sum + record.chars, 0),
  sha256: sha256(records.map(record => record.text).join('')),
  recordDigests: records.map(({ id, tokens, bytes, chars }) => ({ id, tokens, bytes, chars })),
};
const home = join(root, 'codex'), cwd = join(root, 'workspace');
const sessions = join(home, 'sessions/2026/11/18');
await Promise.all([mkdir(sessions, { recursive: true }), mkdir(cwd, { recursive: true })]);
const archive = join(root, 'account/history-v1/history', owner + '.bin');
const fileHash = async () => sha256(await readFile(archive));
let canonicalProofs = 0, corpusCaptures = 0, missingProofRejected = false;

// Every environment is resolved by actual Fn/Uh/Vu against a canonical current
// turn in the isolated home. Neither a historical cwd nor a stub environment is
// substituted for that proof. These are offline fixtures, never live evidence.
async function capture(thread, text) {
  const turn = randomUUID();
  const message = (id, value, kind) => ({ type: 'message', role: 'user', id, content: [{ type: 'input_text', text: value }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] } });
  const history = [
    message('capacity_environment', `<environment_context><cwd>${cwd}</cwd><shell>powershell</shell><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, 'environments.environment_context'),
    { type: 'compaction', id: 'capacity_synthetic_compaction', encrypted_content: 'magpie1:' + Buffer.from('Synthetic offline summary, not permission authority.').toString('base64') },
  ];
  const request = native.parse({ model: 'chatgpt-web/gpt-5.6-sol', tools: [],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: turn, request_kind: 'turn',
      agent_name: '/root', sandbox_mode: 'danger-full-access' }) },
    input: [...history, message('capacity_current_user', text, 'user.text')] });
  assert.throws(() => native.claim(request), /missing cwd/, 'must require canonical compacted recovery');
  assert.ok(native.compacted(request));
  const resolver = () => new native.Store(undefined, Date.now, home, home, []);
  if (phase === 'ingest' && canonicalProofs === 0) {
    assert.throws(() => resolver().resolve(request), /missing cwd|canonical rollout/);
    missingProofRejected = true;
  }
  await writeFile(join(sessions, `rollout-2026-11-18T02-07-57-${thread}.jsonl`), [
    { type: 'session_meta', payload: { id: thread, source: 'vscode' } },
    { type: 'compacted', payload: { replacement_history: history } },
    { type: 'turn_context', payload: { turn_id: turn, cwd, approval_policy: 'never',
      permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } },
  ].map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  const store = resolver(), environment = store.resolve(request);
  assert.equal(resolve(environment.cwd), resolve(cwd));
  assert.equal(native.identity(request).threadId, thread);
  assert.equal(native.identity(request).turnId, turn);
  canonicalProofs++;
  await native.archiveBoundary(request, environment, store);
  return environment;
}

if (phase === 'ingest') {
  for (const record of corpus) { await capture(owner, record.text); corpusCaptures++; }
}
const beforeContinuation = phase === 'reopen' ? await fileHash() : undefined;
// Already captured at the end of phase one. Deduplication may bind the new turn,
// but must not rewrite or repopulate any corpus text in the restart process.
const ownerEnvironment = await capture(owner, resume.text);
const archiveAfterContinuation = await fileHash();
if (phase === 'reopen') assert.equal(archiveAfterContinuation, beforeContinuation, 'resume cannot mask lost archive records');
const foreignText = 'FOREIGN_THREAD_ONLY: distinct synthetic archive owner.';
const foreignEnvironment = await capture(foreign, foreignText);
const broker = new native.Broker('unused-offline-history-capacity');
broker.start = async () => {}; // Local dispatch only; no socket or native harness.
const tokens = [];
let brokerInvocations = 0;
async function binding(environment) {
  const token = await broker.register(environment); tokens.push(token);
  const claim = await broker.dispatch({ method: 'claim', token, activityId: 'activity_' + randomUUID() });
  assert.deepEqual(claim.environment.tools.map(native.wireName), ['magpie_history__search', 'magpie_history__read', 'magpie_history__stats']);
  return async (name, args = {}) => {
    brokerInvocations++;
    const result = await broker.dispatch({ method: 'invoke', bindingId: claim.bindingId,
      wireName: 'magpie_history__' + name, arguments: args });
    assert.ok(result.isError === undefined || result.isError === false, 'pinned MCP success omits isError');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    const envelope = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, envelope, 'actual pinned MCP conversion agrees with text block');
    assert.equal(envelope.source, 'untrusted_chat_history');
    assert.equal(envelope.scope, 'current_chat');
    assert.equal(envelope.coverage, 'authenticated_native_request_text_only');
    assert.equal(envelope.error, undefined);
    return envelope.result;
  };
}

let report;
try {
  const own = await binding(ownerEnvironment), other = await binding(foreignEnvironment);
  const stats = await own('stats');
  assert.equal(stats.records, records.length); assert.equal(stats.bytes, corpusMetadata.utf8Bytes);
  assert.equal(stats.maxReadChars, pageChars);
  assert.equal((await other('stats')).records, 1, 'foreign thread sees only its own record');
  let markerHits = 0, pages = 0, recoveredChars = 0, recoveredBytes = 0, recoveredTokens = 0, splitSurrogatePages = 0;
  let foreignSearchesEmpty = 0, foreignReadsNull = 0, scopeArgumentsRejected = 0;
  for (const record of records) {
    let discoveredId;
    for (const marker of record.markers) {
      const hits = await own('search', { query: JSON.stringify(marker), limit: 10 });
      assert.equal(hits.length, 1); assert.equal(hits[0].id, record.id);
      assert.equal(hits[0].untrusted, true); assert.ok(hits[0].snippet.includes(marker));
      assert.ok(hits[0].snippet.length <= stats.maxSnippetChars);
      discoveredId = hits[0].id; markerHits++;
      assert.deepEqual(await other('search', { query: JSON.stringify(marker) }), []); foreignSearchesEmpty++;
    }
    const parts = []; let offset = 0;
    do {
      const page = await own('read', { id: discoveredId, offset, limit: pageChars });
      assert.equal(page.id, record.id); assert.equal(page.offset, offset); assert.equal(page.totalChars, record.chars);
      assert.equal(page.bytes, record.bytes); assert.equal(page.untrusted, true);
      assert.ok(page.text.length > 0 && page.text.length <= pageChars);
      assert.equal(page.nextOffset, offset + page.text.length);
      assert.equal(page.done, page.nextOffset === record.chars);
      assert.equal(page.role, 'user'); assert.equal(page.type, 'message');
      if (/[\uD800-\uDBFF]$/.test(page.text)) splitSurrogatePages++;
      parts.push(page.text); offset = page.nextOffset; pages++;
      if (page.done) break;
      assert.ok(offset < record.chars, 'pagination must make bounded forward progress');
    } while (true);
    const restored = parts.join('');
    assert.equal(sha256(restored), record.id, 'full exact original text survives paging');
    assert.ok(restored === record.text);
    const counted = tokenizer.encode_ordinary(restored).length;
    assert.equal(counted, record.tokens);
    recoveredChars += restored.length; recoveredBytes += Buffer.byteLength(restored); recoveredTokens += counted;
    assert.equal(await other('read', { id: record.id }), null); foreignReadsNull++;
  }
  assert.equal(recoveredChars, corpusMetadata.utf16Chars); assert.equal(recoveredBytes, corpusMetadata.utf8Bytes);
  assert.equal(recoveredTokens, corpusMetadata.tokens); assert.equal(splitSurrogatePages, 16);
  assert.deepEqual(await own('search', { query: 'FOREIGN_THREAD_ONLY' }), []);
  assert.equal(await own('read', { id: sha256(foreignText) }), null);
  for (const args of [{ thread: owner }, { threadId: owner }, { account: join(root, 'account') }]) {
    await assert.rejects(other('read', { id: records[0].id, ...args }), error => error.code === 'history_invalid_argument');
    scopeArgumentsRejected++;
  }
  await assert.rejects(broker.dispatch({ method: 'invoke', bindingId: 'unclaimed', wireName: 'magpie_history__stats', arguments: {} }));
  assert.equal(await fileHash(), archiveAfterContinuation, 'all retrievals are read-only');
  assert.deepEqual(blockedCalls, []);
  report = { phase, pid: process.pid, processNonce: randomUUID(), live: false,
    corpus: corpusMetadata, corpusCaptures, canonicalProofs, missingProofRejected,
    archiveUnchangedByContinuation: phase === 'reopen', archiveSha256: archiveAfterContinuation,
    stats, markerHits, pages, pageChars, splitSurrogatePages, recoveredChars, recoveredBytes, recoveredTokens, brokerInvocations,
    isolation: { foreignSearchesEmpty, foreignReadsNull, foreignRecords: 1, reverseDirectionBlocked: true,
      scopeArgumentsRejected, invalidBindingRejected: true }, blockedCalls, diagnostics };
} finally {
  for (const token of tokens) await broker.revoke(token);
}
print(JSON.stringify(report));
