import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { historyRecords, captureNativeHistory, installNativeHistory, dispatchNativeHistory, patchNativeHistory, NativeHistoryError } from '../src/native/history.mjs';
import { createHistoryStore } from '../src/native/history-store.mjs';
import { compactionPreloadSource } from '../src/native/runtime.mjs';

const message = (role, content) => ({ type: 'message', role, content });
const identity = () => ({ threadId: randomUUID(), turnId: randomUUID() });
const request = text => ({ context: {}, _rawBody: { input: [message('user', text)] } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const wire = name => 'magpie_history__' + name;
const anchors = [
  'if(f._compactionRequest){console.info("[chatgpt-web] compaction_phase entered");',
  'let o=e.wireName?.trim();if(!o)throw Error("wire tool name is required");',
  'Rk().catch((e)=>{process.stderr.write(',
];
const patchFixture = () => patchNativeHistory(anchors.join('\n'));
const captureBlock = source => source.slice(source.indexOf('if(D||f._compactionRequest)'), source.indexOf(anchors[0]));

class BrokerFixture {
  channels = new Map(); bindings = new Map();
  async register(environment) {
    const token = randomUUID();
    this.channels.set(token, { environment: { ...environment }, compactionDeliveryCount: 0 });
    return token;
  }
  updateEnvironment(token, environment) { this.channels.get(token).environment = { ...environment }; }
  prune() {
    for (const [id, binding] of this.bindings) if (binding.channel.environment.expiresAt <= Date.now()) {
      this.bindings.delete(id); this.channels.delete(binding.token);
    }
  }
  assertSafeHarnessRunning(channel) { if (channel.safe?.state === 'revoked') throw Error('safe harness revoked'); }
}
installNativeHistory(BrokerFixture);

async function bound(store) {
  const broker = new BrokerFixture(), environment = { tools: [] }, nativeIdentity = identity(), input = request('original NEEDLE_518 value');
  await captureNativeHistory(input, environment, nativeIdentity, { store });
  const token = await broker.register(environment), channel = broker.channels.get(token), bindingId = randomUUID();
  broker.bindings.set(bindingId, { token, channel });
  const invoke = (name, args = {}, freeform, signal) => dispatchNativeHistory(channel, wire(name), args, freeform, { broker, bindingId, signal });
  return { broker, channel, environment, token, bindingId, input, nativeIdentity, invoke };
}

test('only observed text is archived verbatim, including tool inputs; opaque and missing content is not reconstructed', () => {
  assert.deepEqual(historyRecords([
    message('system', 'private system'), message('developer', 'private developer'),
    message('user', [{ type: 'input_text', text: 'hello\r\n' }, { type: 'input_image', image_url: 'data:image/opaque' }]),
    message('assistant', [{ type: 'output_text', text: '' }]),
    { ...message('user', 'environment'), internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } },
    { type: 'function_call', arguments: '{ "cmd": "x" }' }, { type: 'custom_tool_call', input: 'literal code\n' },
    { type: 'function_call_output', output: 'all original output' },
    { type: 'custom_tool_call_output', output: [{ text: 'one' }, { text: 'two' }] },
    { type: 'reasoning', encrypted_content: 'opaque' }, { type: 'compaction', encrypted_content: 'opaque' },
    { type: 'function_call_output', output: { omitted: 'unobserved' } },
  ]), [
    { type: 'message', role: 'user', text: 'hello\r\n' }, { type: 'message', role: 'assistant', text: '' },
    { type: 'function_call', role: 'assistant', text: '{ "cmd": "x" }' }, { type: 'custom_tool_call', role: 'assistant', text: 'literal code\n' },
    { type: 'function_call_output', role: 'tool', text: 'all original output' },
    { type: 'custom_tool_call_output', role: 'tool', text: 'one' }, { type: 'custom_tool_call_output', role: 'tool', text: 'two' },
  ]);
  assert.deepEqual(historyRecords('literal input'), [{ type: 'message', role: 'user', text: 'literal input' }]);
  assert.deepEqual(historyRecords(undefined), []);
});

test('omitted message type follows pinned Fn without accepting explicit non-message kinds or private roles', () => {
  const input = [
    { role: 'user', content: 'exact omitted-type user\r\n历史 🧭' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'exact assistant block' }, { type: 'output_text', text: '' }] },
    { role: 'system', content: 'private system' }, { role: 'developer', content: 'private developer' },
    { role: 'user', content: 'environment', internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } },
    { role: 'user', content: 'skill', internal_chat_message_metadata_passthrough: { content_item_kinds: ['skills.selected_skill_instructions'] } },
    { type: 'reasoning', role: 'user', content: 'explicit non-message' },
    { type: 'compaction', role: 'assistant', content: 'explicit compaction' },
    { type: '', role: 'user', content: 'explicit empty type is not missing' },
    { content: 'missing role' },
  ];
  const before = structuredClone(input);
  assert.deepEqual(historyRecords(input), [
    { type: 'message', role: 'user', text: 'exact omitted-type user\r\n历史 🧭' },
    { type: 'message', role: 'assistant', text: 'exact assistant block' },
    { type: 'message', role: 'assistant', text: '' },
  ]);
  assert.deepEqual(input, before, 'capture must not normalize or mutate raw input');
});

test('ordinary capture binds only the current environment, preserves raw input and injects guidance once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'history-bound-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createHistoryStore(home), f = await bound(store), raw = structuredClone(f.input._rawBody);
  await captureNativeHistory(f.input, f.environment, f.nativeIdentity, { store });
  assert.equal(f.input.context.systemPrompt.length, 1);
  assert.match(f.input.context.systemPrompt[0], /magpie_history__search/);
  assert.deepEqual(f.input._rawBody, raw);
  const hits = JSON.parse((await f.invoke('search', { query: 'NEEDLE_518' })).content);
  assert.equal(hits.result.length, 1);
  const page = JSON.parse((await f.invoke('read', { id: hits.result[0].id })).content);
  assert.equal(page.result.text, 'original NEEDLE_518 value');
  assert.equal(page.coverage, 'observed_text_only');
  assert.equal(f.environment.tools.length, 0, 'only broker copy is decorated');
  const next = { tools: [] };
  await captureNativeHistory(f.input, next, { ...f.nativeIdentity, turnId: randomUUID() }, { store });
  f.broker.updateEnvironment(f.token, next);
  assert.equal(f.channel.environment.tools.length, 3);
  assert.throws(() => f.broker.updateEnvironment(f.token, structuredClone(next)), /ownership changed/);
  await captureNativeHistory(f.input, next, identity(), { store });
  assert.throws(() => f.broker.updateEnvironment(f.token, next), /ownership changed/);
  const cloneToken = await f.broker.register(structuredClone(f.environment));
  assert.equal(f.broker.channels.get(cloneToken).environment.tools.length, 0);
});

test('exact wire names, collisions and structured parameter bounds are enforced before storage access', async () => {
  let calls = 0;
  const f = await bound({ append: async () => {}, search: async () => { calls++; return []; }, read: async () => { calls++; return null; }, stats: async () => { calls++; return {}; } });
  const bad = [
    ['search', { query: 'x', limit: null }], ['search', { query: 'x', limit: 11 }], ['search', { query: 'x', limit: '1' }],
    ['search', { query: 'x'.repeat(501) }], ['search', {}], ['read', { id: 'f'.repeat(64), limit: 12001 }],
    ['read', { id: 'f'.repeat(64), offset: -1 }], ['read', { id: 'f'.repeat(64), offset: null }],
    ['read', { id: '../file' }], ['stats', { threadId: f.nativeIdentity.threadId }], ['stats', null],
  ];
  for (const [name, args] of bad) await assert.rejects(f.invoke(name, args), { code: 'history_invalid_argument', retryable: false });
  await assert.rejects(f.invoke('stats', {}, true), /structured/);
  await assert.rejects(f.invoke('stats', {}, 'false'), /structured/);
  await assert.rejects(dispatchNativeHistory(f.channel, 'magpie_history.stats', {}, false, { broker: f.broker, bindingId: f.bindingId }), /unavailable/);
  await assert.rejects(dispatchNativeHistory(f.channel, wire('stats'), {}, false), /unavailable/);
  assert.equal(calls, 0);
  for (const tool of [{ name: 'magpie_history__search' }, { name: 'search', namespace: 'magpie_history' }, { name: 'magpie_history.search' }]) {
    const environment = { tools: [tool] };
    await captureNativeHistory(request('x'), environment, identity(), { store: { append: async () => {} } });
    await assert.rejects(f.broker.register(environment), /collision/);
  }
  await f.invoke('search', { query: 'x' }); assert.equal(calls, 1);
});

test('compaction requires proof, awaits the final tool-result append and adds no scope or guidance', async () => {
  const flushed = deferred(), entered = deferred(), input = request('source');
  input._compactionRequest = true;
  input._rawBody.input.push({ type: 'function_call_output', output: 'LAST_RESULT_' + randomUUID() });
  const snapshot = structuredClone(input), nativeIdentity = identity(), environment = { tools: [] };
  const saved = [];
  const store = { async append(thread, records) { saved.push({ thread, records }); entered.resolve(); await flushed.promise; } };
  await assert.rejects(captureNativeHistory(input, environment, nativeIdentity, { store }), { code: 'history_scope_unverified', status: 403, retryable: false });
  assert.equal(saved.length, 0);
  let complete = false;
  const pending = captureNativeHistory(input, undefined, nativeIdentity, { store, verifyCompaction: () => environment }).then(() => { complete = true; });
  await entered.promise; assert.equal(complete, false);
  assert.equal(saved[0].records.at(-1).text, input._rawBody.input.at(-1).output);
  flushed.resolve(); await pending;
  assert.deepEqual(input, snapshot);
  const broker = new BrokerFixture(), token = await broker.register(environment);
  assert.deepEqual(broker.channels.get(token).environment.tools, []);
  await assert.rejects(captureNativeHistory(input, environment, nativeIdentity, { store, verifyCompaction() { throw Error('missing rollout'); } }), { code: 'history_scope_unverified' });
  assert.equal(saved.length, 1);
});

test('archive failures remain typed nonretryable adapter errors and prevent compaction entry', async () => {
  class AdapterError extends Error { constructor(message, fields) { super(message); Object.assign(this, fields); } }
  for (const compaction of [false, true]) for (const [code, expectedCode, status] of [
    ['ERR_HISTORY_LIMIT', 'history_capacity_exceeded', 413], ['ERR_HISTORY_CRYPTO', 'history_archive_unavailable', 409],
  ]) {
    const input = request('required original'); input._compactionRequest = compaction;
    const environment = { tools: [] }, nativeIdentity = identity();
    let entered = false;
    const task = runInNewContext(`(async()=>{${captureBlock(patchFixture())};enter()})()`, {
      f: input, D: compaction ? undefined : environment, m: {}, ue: () => nativeIdentity, q: AdapterError,
      magpieVerifyHistoryCompaction: () => environment,
      captureNativeHistory: (f, d, id, opts) => captureNativeHistory(f, d, id, { ...opts, store: { append: async () => { throw Object.assign(Error('private failure'), { code }); } } }),
      enter: () => { entered = true; },
    });
    await assert.rejects(task, error => error instanceof AdapterError && error.code === expectedCode && error.status === status
      && error.retryable === false && error.cause instanceof NativeHistoryError);
    assert.equal(entered, false);
    assert.equal(input.context.systemPrompt, undefined);
  }
  await captureNativeHistory(request('ignored'), undefined, undefined, { home: '' });
});

for (const mutation of ['revoke', 'rebind', 'channel replaced', 'expire', 'completion', 'safe revoke', 'abort', 'remove tool']) {
  test(`async history read rechecks authority after ${mutation}`, async () => {
    const pending = deferred(), signal = new AbortController();
    const f = await bound({ append: async () => {}, search: () => pending.promise });
    const result = f.invoke('search', { query: 'needle' }, false, signal.signal);
    const rejected = assert.rejects(result);
    if (mutation === 'revoke') { f.broker.bindings.delete(f.bindingId); f.broker.channels.delete(f.token); }
    if (mutation === 'rebind') f.broker.bindings.set(f.bindingId, { token: f.token, channel: f.channel });
    if (mutation === 'channel replaced') f.broker.channels.set(f.token, { ...f.channel });
    if (mutation === 'expire') f.channel.environment.expiresAt = 1;
    if (mutation === 'completion') f.channel.completionCommitted = true;
    if (mutation === 'safe revoke') f.channel.safe = { state: 'revoked' };
    if (mutation === 'abort') signal.abort();
    if (mutation === 'remove tool') f.channel.environment.tools = [];
    pending.resolve([{ snippet: 'must never be returned' }]);
    await rejected;
  });
}

test('compaction that starts during reading wins over either successful data or a storage failure', async () => {
  for (const failure of [false, true]) {
    const pending = deferred(), f = await bound({ append: async () => {}, search: () => pending.promise });
    const result = f.invoke('search', { query: 'needle' });
    f.channel.compactionRequested = true;
    f.channel.compactionResult = { content: [{ type: 'text', text: 'compaction control' }], isError: true };
    if (failure) pending.reject(Error('private storage error')); else pending.resolve([{ snippet: 'private original' }]);
    assert.deepEqual(await result, f.channel.compactionResult);
    assert.equal(f.channel.compactionDeliveryCount, 1);
  }
});

test('storage errors produce bounded tool errors without disclosing original text or inventing missing evidence', async () => {
  const f = await bound({ append: async () => {}, read: async () => { throw Error('SECRET_ERROR_DATA'); } });
  const result = await f.invoke('read', { id: 'a'.repeat(64) });
  assert.equal(result.isError, true);
  assert.equal(result.content.includes('SECRET_ERROR_DATA'), false);
  assert.equal(JSON.parse(result.content).error.code, 'history_unavailable');
  assert.ok(f.broker.bindings.has(f.bindingId));
});

test('strict compaction helper requires canonical proof before resolver/cache use and passes the source turn', () => {
  const helper = patchFixture().slice(patchFixture().indexOf('function magpieVerifyHistoryCompaction('));
  const ids = identity(), oldTurn = randomUUID(), environment = { tools: [] };
  const events = [], f = { _compactionRequest: true, context: { tools: [] } };
  let proof = { environment }, conflicts = [];
  const resolver = { codexHomes: ['/synthetic/a', '/synthetic/b'], sqliteHome: '/synthetic/sqlite', resolve() { events.push('resolve'); return environment; } };
  const verify = runInNewContext(helper + ';magpieVerifyHistoryCompaction', {
    ue: () => ids, Zh: () => undefined, Xh: () => ({ threadId: ids.threadId }), jn: () => ({ turnId: oldTurn }),
    tg(args) { events.push('proof'); assert.equal(args.compactionSourceTurnId, oldTurn); assert.equal(args.turnId, ids.turnId);
      assert.equal(args.codexHome, '/synthetic/a'); assert.equal(args.additionalCodexHomes[0], '/synthetic/b'); return proof; },
    wT: () => conflicts,
  });
  assert.equal(verify(f, resolver), environment);
  assert.deepEqual(events, ['proof', 'resolve']);
  proof = undefined; events.length = 0;
  assert.throws(() => verify(f, resolver), /canonical/);
  assert.deepEqual(events, ['proof'], 'cached environment cannot authorize a missing rollout');
  proof = { environment }; conflicts = ['workspace_roots'];
  assert.throws(() => verify(f, resolver), /conflicts/);
});

test('transform is standalone, uses ag at native invoke, and rejects drift, duplicates and repeat application', () => {
  const source = anchors.join('\n'), transformed = patchFixture();
  const serialized = runInNewContext('(' + patchNativeHistory.toString() + ')');
  assert.equal(serialized(source), transformed);
  assert.match(transformed, /return ag\(await dispatchNativeHistory/);
  assert.match(transformed, /e.method!=="invoke"/);
  for (const anchor of anchors) {
    assert.throws(() => patchNativeHistory(source.replace(anchor, 'changed')), /anchor mismatch/);
    assert.throws(() => patchNativeHistory(source + anchor), /anchor mismatch/);
  }
  assert.throws(() => patchNativeHistory(transformed), /already patched/);
});

const pinned = { skip: process.env.NATIVE_HISTORY_SMOKE !== '1', timeout: 60000 };
async function runPinned(t, suite) {
  const base = join(homedir(), '.config/magpie/chatgpt-web-native/runtime-6.1.18/payload');
  const entry = join(base, 'app/cli.js'), bun = join(base, 'runtime/bun.exe'), original = await readFile(entry);
  assert.equal(createHash('sha256').update(original).digest('hex'), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const home = await mkdtemp(join(tmpdir(), 'history-pinned-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); assert.deepEqual(await readFile(entry), original); });
  const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  const preload = compactionPreloadSource(entry).replace("return { contents, loader: 'js' };", `
    const archiveStart=contents.indexOf('if(D||f._compactionRequest)');
    const archiveEnd=contents.indexOf(${JSON.stringify(anchors[0])},archiveStart);
    if(archiveStart<0||archiveEnd<archiveStart)throw Error('Missing actual archive boundary');
    const archive=contents.slice(archiveStart,archiveEnd);
    return {contents:contents.replace(${JSON.stringify(startup)},'')+
      '\\nexport { dn as Broker, mt as wireName, qv as mcpResult, Vu as EnvironmentStore, Fn as parseRequest, ue as identity, q as AdapterError, jn as compactionSource, tg as rolloutProof, Xh as rootLineage, Ls as responseRequest, Cs as Worker, vs as close, magpieVerifyHistoryCompaction as verifyCompaction };'+
      '\\nexport async function archiveBoundary(f,D,m,entered){'+archive+';entered?.()}',loader:'js'};`);
  const fixture = `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
    import {randomUUID} from 'node:crypto';import {join,dirname} from 'node:path';
    import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
    import {captureNativeHistory} from ${JSON.stringify(new URL('../src/native/history.mjs', import.meta.url).href)};
    import {createHistoryStore} from ${JSON.stringify(new URL('../src/native/history-store.mjs', import.meta.url).href)};
    globalThis.fetch=()=>{throw Error('network forbidden')};
    const native=await import(pathToFileURL(${JSON.stringify(entry)}).href);
    const home=${JSON.stringify(home)};await (${suite.toString()})(native,home);console.log('PINNED_HISTORY_OK');`;
  await writeFile(join(home, 'preload.mjs'), preload);
  await writeFile(join(home, 'fixture.mjs'), fixture);
  const result = await promisify(execFile)(bun, ['--preload', join(home, 'preload.mjs'), join(home, 'fixture.mjs')], {
    windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, CODEX_HOME: home, CODEX_CHATGPT_WEB_HOME: home,
      CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '[]', MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  assert.match(result.stdout, /PINNED_HISTORY_OK/);
}

test('pinned real broker inventory/invoke/MCP format, updates and asynchronous retirement', pinned, async t => {
  await runPinned(t, async (native, home) => {
    const broker = new native.Broker('unused-offline-pipe'); broker.start = async () => {};
    const store = createHistoryStore(join(home, 'archive')), identity = { threadId: randomUUID(), turnId: randomUUID() };
    const environment = { cwd: home, roots: [home], writableRoots: [home], sandboxPolicy: { type: 'dangerFullAccess' }, tools: [] };
    const input = { context: {}, _rawBody: { input: [{ type: 'message', role: 'user', content: 'PINNED_HISTORY_MARKER exact original' }] } };
    await captureNativeHistory(input, environment, identity, { store });
    const token = await broker.register(environment);
    const claim = await broker.dispatch({ method: 'claim', token, activityId: 'activity_' + randomUUID() });
    assert.deepEqual(claim.environment.tools.map(native.wireName), ['magpie_history__search', 'magpie_history__read', 'magpie_history__stats']);
    const invoke = (name, args = {}, signal) => broker.dispatch({ method: 'invoke', bindingId: claim.bindingId, wireName: 'magpie_history__' + name, arguments: args }, signal);
    await assert.rejects(broker.dispatch({ method: 'invoke', bindingId: 'invalid', wireName: 'magpie_history__stats', arguments: {} }));
    await assert.rejects(broker.dispatch({ method: 'call', bindingId: claim.bindingId, wireName: 'magpie_history__stats', arguments: {} }), /native invoke/);
    const result = native.mcpResult(await invoke('search', { query: 'PINNED_HISTORY_MARKER' }));
    assert.equal(Array.isArray(result.content), true);
    assert.equal(result.content[0].type, 'text');
    assert.equal(JSON.parse(result.content[0].text).result[0].snippet, 'PINNED_HISTORY_MARKER exact original');
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    const channel = broker.channels.get(token);
    assert.equal(channel.invocations.size, 0); assert.equal(channel.queuedCallIds.length, 0);
    const next = { ...environment, tools: [] };
    await captureNativeHistory(input, next, { ...identity, turnId: randomUUID() }, { store });
    broker.updateEnvironment(token, next);
    assert.equal((await invoke('stats')).structuredContent.result.records, 1);
    assert.throws(() => broker.updateEnvironment(token, structuredClone(next)), /ownership changed/);
    let finish;
    store.search = () => new Promise(resolve => { finish = resolve; });
    const pending = invoke('search', { query: 'secret' });
    broker.requestCompaction(token, { content: [{ type: 'text', text: 'stop for compaction' }], isError: true });
    finish([{ snippet: 'must not return' }]);
    const compact = await pending;
    assert.equal(compact.content[0].text, 'stop for compaction'); assert.equal(compact.isError, true);
    channel.compactionRequested = false;
    const revoked = invoke('search', { query: 'secret' });
    const rejected = assert.rejects(revoked);
    await broker.revoke(token); finish([{ snippet: 'must not return' }]); await rejected;
    await assert.rejects(invoke('stats'));
  });
});

test('pinned Fn/Vu archiveBoundary captures omitted-type historical messages with current canonical rollout proof', pinned, async t => {
  await runPinned(t, async (native, home) => {
    const thread = randomUUID(), turn = randomUUID(), cwd = join(home, 'workspace');
    await mkdir(cwd);
    const originals = [
      { role: 'user', text: 'UNTYPED_USER_MARKER\r\n历史 🧭\0 exact original' },
      { role: 'assistant', text: 'UNTYPED_ASSISTANT_MARKER\n"quoted" \\path' },
      { role: 'assistant', text: 'UNTYPED_SECOND_BLOCK_MARKER\r\nindependent block' },
    ];
    const msg = (id, text, kind) => ({ type: 'message', role: 'user', id, content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] } });
    const history = [
      { role: 'user', content: originals[0].text },
      { role: 'assistant', content: originals.slice(1).map(({ text }) => ({ type: 'output_text', text })) },
      msg('msg_environment', `<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, 'environments.environment_context'),
      { type: 'compaction', id: 'synthetic_compaction', encrypted_content: 'magpie1:' + Buffer.from('Synthetic offline continuation; not execution authority.').toString('base64') },
    ];
    const body = { model: 'chatgpt-web/gpt-5.6-sol', tools: [],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: turn, request_kind: 'turn',
        agent_name: '/root', sandbox_mode: 'danger-full-access' }) },
      input: [...history, msg('msg_current_user', 'CURRENT_TYPED_MARKER', 'user.text')] };
    const request = native.parseRequest(body), before = structuredClone(request._rawBody);
    assert.equal(Object.hasOwn(request._rawBody.input[0], 'type'), false);
    assert.equal(Object.hasOwn(request._rawBody.input[1], 'type'), false);
    for (const marker of ['UNTYPED_USER_MARKER', 'UNTYPED_ASSISTANT_MARKER', 'UNTYPED_SECOND_BLOCK_MARKER']) {
      assert.ok(JSON.stringify(request.context.messages).includes(marker), 'actual Fn accepted the original text');
    }
    const resolver = new native.EnvironmentStore(undefined, Date.now, home, home, []);
    assert.throws(() => resolver.resolve(request), /missing cwd|canonical rollout/, 'historical environment is not sufficient proof');
    const rollout = join(home, 'sessions', '2026', '11', '18', `rollout-2026-11-18T10-00-00-${thread}.jsonl`);
    await mkdir(dirname(rollout), { recursive: true });
    await writeFile(rollout, [
      { type: 'session_meta', payload: { id: thread, source: 'vscode' } },
      { type: 'compacted', payload: { replacement_history: history } },
      { type: 'turn_context', payload: { turn_id: turn, cwd, approval_policy: 'never',
        permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } },
    ].map(JSON.stringify).join('\n') + '\n');
    const environment = resolver.resolve(request);
    assert.equal(environment.cwd.toLowerCase(), cwd.toLowerCase());
    process.env.MAGPIE_NATIVE_CHECKPOINT_HOME = join(home, 'owner');
    let entered = 0;
    await native.archiveBoundary(request, environment, resolver, () => { entered++; });
    assert.equal(entered, 1);
    assert.deepEqual(request._rawBody, before);
    const broker = new native.Broker('unused-offline'); broker.start = async () => {};
    const token = await broker.register(environment);
    try {
      const claim = await broker.dispatch({ method: 'claim', token, activityId: 'activity_' + randomUUID() });
      const invoke = async (name, args = {}) => {
        const result = await broker.dispatch({ method: 'invoke', bindingId: claim.bindingId,
          wireName: 'magpie_history__' + name, arguments: args });
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
        assert.equal(result.structuredContent.source, 'untrusted_chat_history');
        return result.structuredContent.result;
      };
      assert.equal((await invoke('stats')).records, 4, 'three omitted-type text blocks plus the typed current user');
      for (const original of [...originals, { role: 'user', text: 'CURRENT_TYPED_MARKER' }]) {
        const hits = await invoke('search', { query: JSON.stringify(original.text) });
        assert.equal(hits.length, 1);
        const page = await invoke('read', { id: hits[0].id });
        assert.equal(page.text, original.text); assert.equal(page.role, original.role);
        assert.equal(page.type, 'message'); assert.equal(page.done, true);
      }
    } finally { await broker.revoke(token); }
  });
});

test('pinned tg proof captures last compaction tool result, rejects stale/foreign/missing proof and wraps archive failure', pinned, async t => {
  await runPinned(t, async (native, home) => {
    const thread = randomUUID(), sourceTurn = randomUUID(), compactTurn = randomUUID(), root = join(home, 'workspace');
    await mkdir(root);
    const rollout = join(home, 'sessions', '2026', '11', '18', `rollout-2026-11-18T10-00-00-${thread}.jsonl`);
    await mkdir(dirname(rollout), { recursive: true });
    const session = { type: 'session_meta', payload: { id: thread, source: 'vscode' } };
    const context = { type: 'turn_context', payload: { turn_id: sourceTurn, cwd: root, workspace_roots: [root],
      approval_policy: 'never', permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } };
    const save = () => writeFile(rollout, [session, context].map(JSON.stringify).join('\n') + '\n'); await save();
    const msg = (id, text, kind) => ({ type: 'message', role: 'user', id, content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurn, content_item_kinds: [kind] } });
    const metadata = { thread_id: thread, turn_id: compactTurn, request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' },
      agent_name: '/root', sandbox_mode: 'danger-full-access', workspaces: { [root]: {} } };
    const needle = 'LAST_COMPACTION_RESULT_' + randomUUID();
    const body = { model: 'chatgpt-web/gpt-5.6-sol', tools: [], client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) }, input: [
      msg('msg_environment', `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, 'environments.environment_context'),
      msg('msg_source', 'Retain the tool result exactly.', 'user.text'),
      { type: 'function_call', call_id: 'call_last', name: 'offline_tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_last', output: needle },
    ] };
    const parsed = () => { const value = native.parseRequest(structuredClone(body)); value._compactionRequest = true; return value; };
    const resolver = new native.EnvironmentStore(undefined, Date.now, home, home, []);
    process.env.MAGPIE_NATIVE_CHECKPOINT_HOME = join(home, 'owner');
    const input = parsed(), before = structuredClone(input);
    let entered = 0;
    await native.archiveBoundary(input, undefined, resolver, () => { entered++; });
    assert.equal(entered, 1, 'read-only compaction entered only after archival');
    assert.deepEqual(input, before, 'no guidance, tools, raw body or capability mutation');
    const archive = createHistoryStore(join(home, 'owner', 'history-v1'));
    const hits = await archive.search(thread, JSON.stringify(needle));
    assert.equal(hits.length, 1);
    assert.equal((await archive.read(thread, hits[0].id)).text, needle);
    const saved = await readFile(join(home, 'owner', 'history-v1', 'history', thread + '.bin'));
    for (const mutation of ['missing', 'stale', 'foreign', 'conflicting permissions']) {
      if (mutation === 'missing') await rm(rollout);
      if (mutation === 'stale') { context.payload.turn_id = randomUUID(); await save(); }
      if (mutation === 'foreign') { session.payload.id = randomUUID(); await save(); }
      if (mutation === 'conflicting permissions') { context.payload.sandbox_policy = { type: 'read-only' }; await save(); }
      await assert.rejects(native.archiveBoundary(parsed(), undefined, resolver, () => { entered++; }), error => error instanceof native.AdapterError
        && error.code === 'history_scope_unverified' && error.status === 403 && error.retryable === false);
      assert.equal(entered, 1);
      assert.deepEqual(await readFile(join(home, 'owner', 'history-v1', 'history', thread + '.bin')), saved);
      session.payload.id = thread; context.payload.turn_id = sourceTurn; context.payload.sandbox_policy = { type: 'danger-full-access' }; await save();
    }
    const environment = native.verifyCompaction(parsed(), resolver);
    const broker = new native.Broker('unused-offline'); broker.start = async () => {};
    const token = await broker.register(environment);
    assert.equal(broker.channels.get(token).environment.tools.length, 0, 'compaction verification does not authorize history tools');
    const ordinary = parsed(); ordinary._compactionRequest = false;
    await writeFile(join(home, 'owner', 'history-v1', 'history', thread + '.bin'), Buffer.alloc(5));
    await assert.rejects(native.archiveBoundary(ordinary, environment, resolver, () => { entered++; }), error => error instanceof native.AdapterError
      && error.code === 'history_archive_unavailable' && error.status === 409 && error.retryable === false);
    assert.equal(entered, 1);
  });
});

test('pinned pre-turn compaction authenticates resumed source messages before a new turn_context exists', pinned, async t => {
  await runPinned(t, async (native, home) => {
    const thread = randomUUID(), contextTurn = randomUUID(), resumeA = randomUUID(), resumeB = randomUUID(), compactTurn = randomUUID();
    const cwd = join(home, 'workspace'); await mkdir(cwd);
    const message = (id, text, turn, kind = 'user.text') => ({ type: 'message', role: 'user', id,
      content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] } });
    const environment = message('environment', `<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, contextTurn, 'environments.environment_context');
    const original = message('original', 'Read the synthetic command samples in order.', contextTurn);
    const firstResume = message('resume-a', 'Continue the retained synthetic task.', resumeA);
    const latestResume = message('resume-b', 'Continue after the interrupted pre-sampling compaction.', resumeB);
    const result = { type: 'function_call_output', call_id: 'synthetic-command', output: 'EARLY_COMMAND_ORIGINAL_UNCHANGED' };
    const start = turn => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
    const item = value => ({ type: 'response_item', payload: value });
    const session = { type: 'session_meta', payload: { id: thread, source: 'exec', runtime_workspace_roots: [cwd] } };
    const context = { type: 'turn_context', payload: { turn_id: contextTurn, cwd,
      approval_policy: 'never', permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } };
    const rows = [session, start(contextTurn), item(environment), context, item(original),
      item({ type: 'function_call', call_id: result.call_id, name: 'offline_command', arguments: '{}' }), item(result),
      start(resumeA), item(firstResume), start(resumeB), item(latestResume), start(compactTurn)];
    const rollout = join(home, 'sessions', '2026', '11', '18', `rollout-2026-11-18T00-00-00-${thread}.jsonl`);
    await mkdir(dirname(rollout), { recursive: true });
    const save = values => writeFile(rollout, values.map(JSON.stringify).join('\n') + '\n'); await save(rows);
    const metadata = { thread_id: thread, turn_id: compactTurn, agent_name: '/root', request_kind: 'compaction',
      sandbox_mode: 'danger-full-access', compaction: { trigger: 'auto', phase: 'pre_turn', reason: 'context_limit',
        implementation: 'responses_compaction_v2', strategy: 'memento' } };
    const body = { model: 'chatgpt-web/gpt-6-pro', reasoning: { effort: 'max' }, stream: false, tools: [],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) },
      input: [...rows.filter(row => row.type === 'response_item').map(row => row.payload), { type: 'compaction_trigger' }] };
    const parsed = value => native.parseRequest(structuredClone(value ?? body));
    const resolver = () => new native.EnvironmentStore(undefined, Date.now, home, undefined, []);
    const request = parsed(), source = native.compactionSource(request);
    assert.equal(source.turnId, resumeB); assert.equal(request._compactionRequest, true);
    assert.throws(() => native.rolloutProof({ codexHome: home, lineage: native.rootLineage(request),
      turnId: compactTurn, compactionSourceTurnId: source.turnId }), /no canonical rollout for the requested current turn/,
    'the original failure is tg source scope, before resolver.resolve or wT');
    assert.throws(() => resolver().resolve(request), /no canonical rollout for the requested current turn/);
    const verified = native.verifyCompaction(request, resolver());
    assert.equal(verified.cwd, cwd); assert.deepEqual(verified.roots, [cwd]);
    assert.equal(verified.sandboxPolicy.type, 'dangerFullAccess');
    process.env.MAGPIE_NATIVE_CHECKPOINT_HOME = join(home, 'owner');
    const before = structuredClone(request);
    let entered = 0;
    await native.archiveBoundary(request, undefined, resolver(), () => entered++);
    assert.equal(entered, 1); assert.deepEqual(request, before);
    const archive = createHistoryStore(join(home, 'owner', 'history-v1'));
    assert.equal((await archive.search(thread, 'EARLY_COMMAND_ORIGINAL_UNCHANGED')).length, 1);
    const historyPath = join(home, 'owner', 'history-v1', 'history', thread + '.bin'), durable = await readFile(historyPath);
    const mutations = [
      ['invented source content', data => { data.input.find(value => value.id === 'resume-b').content[0].text = 'FORGED_SOURCE'; }],
      ['unissued source id', data => { data.input.find(value => value.id === 'resume-b').id = 'not-on-disk'; }],
      ['forged source attribution', data => { data.input.find(value => value.id === 'resume-b').internal_chat_message_metadata_passthrough.turn_id = resumeA; }],
      ['duplicate source', data => { data.input.push(structuredClone(latestResume)); }],
      ['mid-turn', (_data, _rows, meta) => { meta.compaction.phase = 'mid_turn'; }],
      ['manual compaction', (_data, _rows, meta) => { meta.compaction.trigger = 'manual'; }],
      ['foreign thread', (_data, _rows, meta) => { meta.thread_id = randomUUID(); }],
      ['foreign session metadata', (_data, values) => { values[0].payload.id = randomUUID(); }],
      ['missing current boundary', (_data, values) => { values.pop(); }],
      ['stale current boundary', (_data, values) => { values.push(start(randomUUID())); }],
      ['missing resumed source boundary', (_data, values) => { values.splice(values.findIndex(row => row.type === 'event_msg' && row.payload.turn_id === resumeB), 1); }],
      ['source after current boundary', (_data, values) => { const index = values.findIndex(row => row.payload.id === 'resume-b'); values.push(...values.splice(index, 1)); }],
      ['canonical source attribution changed', (_data, values) => { values.find(row => row.payload.id === 'resume-b').payload.internal_chat_message_metadata_passthrough.turn_id = contextTurn; }],
      ['canonical environment attribution changed', (_data, values) => { values.find(row => row.payload.id === 'environment').payload.internal_chat_message_metadata_passthrough.turn_id = resumeA; }],
      ['newer unrelated context', (_data, values) => { values.push({ ...context, payload: { ...context.payload, turn_id: randomUUID() } }); }],
      ['environment permissions conflict', (data, values) => {
        const changed = structuredClone(environment);
        changed.content[0].text = changed.content[0].text.replace('<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>', '<sandbox_mode>read-only</sandbox_mode>');
        data.input[0] = changed; values.find(row => row.payload.id === 'environment').payload = changed;
      }],
    ];
    for (const [name, mutate] of mutations) {
      const data = structuredClone(body), values = structuredClone(rows), meta = structuredClone(metadata);
      mutate(data, values, meta); data.client_metadata['x-codex-turn-metadata'] = JSON.stringify(meta); await save(values);
      await assert.rejects(native.archiveBoundary(parsed(data), undefined, resolver(), () => entered++),
        error => error instanceof native.AdapterError && error.code === 'history_scope_unverified' && error.status === 403, name);
      assert.equal(entered, 1, name); assert.deepEqual(await readFile(historyPath), durable, name);
    }
    await save(rows);
    const broker = new native.Broker('unused-pre-turn'); broker.start = async () => {};
    const token = await broker.register(verified);
    assert.equal(broker.channels.get(token).environment.tools.length, 0, 'read-only proof never grants history tool scope');
    await broker.revoke(token);
    // Exercise the actual Responses adapter, not only the extracted boundary.
    native.Worker.forProvider = () => ({ appName: 'Offline pre-turn fixture', async run(options) {
      assert.equal(options.compaction, true); assert.equal(options.capabilities.localToolsEnabled, false);
      const prepared = await options.prepare();
      assert.ok(prepared.text.includes('Continue after the interrupted pre-sampling compaction.'));
      assert.equal((await archive.search(thread, 'EARLY_COMMAND_ORIGINAL_UNCHANGED')).length, 1);
      const summary = 'Synthetic pre-turn summary after canonical archival.';
      options.onTextDelta?.(summary); prepared.release?.(); return summary;
    } });
    try {
      const response = await native.responseRequest(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(body) }), {
        mode: 'full', subagentProtocol: 'native', contextWindow: 256000, appName: 'Offline pre-turn fixture',
        browserHost: 'managed-chrome', browserInteractionMode: 'automatic', storageStatePath: join(home, 'unused-storage.json'),
        brokerSocketPath: 'unused-pre-turn-fixture', solAvailable: true, proAvailable: true, extraHighAvailable: true,
      });
      const result = await response.json(); assert.equal(result.status, 'completed', JSON.stringify(result));
    } finally { await native.close(); }
  });
});
