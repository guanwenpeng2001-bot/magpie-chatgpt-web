// One-off offline audit of the ORIGINAL pinned CLI. Only browser generation is
// substituted; broker, adapter, parser and Responses encoder execute unchanged.
// Usage: <pinned bun.exe> test/fixtures/native-tool-emission-proof.mjs <pinned cli.js>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const entry = resolve(process.argv[2]);
const original = readFileSync(entry);
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
assert.equal(createHash('sha256').update(original).digest('hex'), pin);
const source = original.toString('utf8');
assert.equal(source.includes('onToolCall'), false, 'the pinned bundle uses minified callback functions');
for (const anchor of ['function xg(e,t,n){', 'WT(f,ee.requests),N.setOutstanding(',
  'case"tool_call_start":{', 'b("response.output_item.added",{output_index:y,item:et})']) {
  assert.equal(source.split(anchor).length, 2, anchor);
}
const home = await mkdtemp(join(tmpdir(), 'native-tool-emission-proof-'));
const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
assert.equal(source.split(startup).length, 2);
for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CODEX_CHATGPT_WEB_HOME', 'MAGPIE_NATIVE_CHECKPOINT_HOME']) process.env[key] = home;
for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) process.env[key] = join(home, key.toLowerCase());
process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '[]';
globalThis.fetch = () => { throw new Error('Offline audit forbids network'); };
Bun.plugin({ name: 'original-pinned-tool-emission-audit', setup(build) {
  build.onLoad({ filter: /[\\/]cli\.js$/ }, ({ path }) => {
    assert.equal(resolve(path), entry);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), pin);
    return { loader: 'js', contents: source.replace(startup, '') +
      '\nexport { dn as Broker, Cs as Worker, Bi as createAdapter, Ls as responses, q as AdapterError };' };
  });
} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audit stalled: ' + label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function collect(response) {
  const text = await response.text();
  return text.split(/\r?\n/).filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map(line => JSON.parse(line.slice(5)));
}

try {
  const native = await import(pathToFileURL(entry).href);
  for (const scenario of ['delivered-to-client', 'quota-before-delivery']) {
    const prepared = deferred(), finishBrowser = deferred();
    const thread = randomUUID(), turn = randomUUID();
    const broker = new native.Broker('unused-offline-' + randomUUID());
    broker.start = async () => {}; // No socket needed: use real dispatch in-process.
    const adapterEvents = [];
    let options, invocationSettled = false, mockClientExecutions = 0;
    const quota = new native.AdapterError('Synthetic rate limit at browser boundary', {
      status: 429, errorType: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: false,
    });
    const config = { mode: 'full', subagentProtocol: 'native', contextWindow: 256000,
      appName: 'Offline audit ' + scenario, browserHost: 'managed-chrome', browserInteractionMode: 'automatic',
      storageStatePath: join(home, 'unused-storage.json'), brokerSocketPath: 'unused-' + scenario,
      headed: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    native.Worker.forProvider = () => ({ appName: config.appName, async run(value) {
      options = value;
      await value.prepare();
      prepared.resolve();
      if (scenario === 'delivered-to-client') {
        const batch = await value.externalProgress.waitForChange(0, value.abortSignal);
        await value.externalProgress.acknowledgeToolBatch(batch.lastToolBatchRevision);
      }
      await finishBrowser.promise;
      throw quota;
    } });
    const environment = `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
    const body = { model: 'chatgpt-web/gpt-5.6-sol', stream: true, reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'fixture_noop', description: 'Inert client counter only; never execute a real tool', parameters: { type: 'object', properties: {} } }],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: turn }) },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } },
      { type: 'message', role: 'user', id: 'instruction', content: [{ type: 'input_text', text: 'Use only the synthetic fixture_noop contract.' }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } }],
    };
    const rollout = join(home, 'sessions', '2026', '11', '18', 'rollout-audit-' + thread + '.jsonl');
    await mkdir(dirname(rollout), { recursive: true });
    await writeFile(rollout, [
      { type: 'session_meta', payload: { id: thread, source: 'vscode' } },
      { type: 'turn_context', payload: { turn_id: turn, cwd: home, approval_policy: 'never', permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } },
    ].map(JSON.stringify).join('\n') + '\n');
    const factory = provider => {
      const adapter = native.createAdapter(provider, { broker });
      return { ...adapter, runTurn(parsed, incoming, emit) {
        return adapter.runTurn(parsed, incoming, event => { adapterEvents.push(event.type); emit(event); });
      } };
    };
    const send = value => native.responses(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(value) }), config, factory);
    let invoke;
    try {
      const response = await send(body);
      const incoming = collect(response);
      await bounded(prepared.promise, 'browser preparation');
      const token = [...broker.channels.keys()][0];
      assert.ok(token);
      const claim = await broker.dispatch({ method: 'claim', token, activityId: 'activity_' + randomUUID() });
      invoke = broker.dispatch({ method: 'invoke', bindingId: claim.bindingId, wireName: 'fixture_noop', arguments: {} })
        .then(result => { invocationSettled = true; return { result }; }, error => { invocationSettled = true; return { error }; });
      assert.equal(invocationSettled, false);
      assert.equal(mockClientExecutions, 0, 'enqueue/claim never executes a client tool');
      if (scenario === 'quota-before-delivery') {
        finishBrowser.resolve();
        const frames = await bounded(incoming, 'early quota response');
        assert.ok(frames.some(event => event.type === 'response.failed' && event.response.error.code === 'rate_limit_exceeded'));
        assert.equal(frames.some(event => event.type === 'response.output_item.added' && event.item.type === 'function_call'), false);
        assert.ok((await bounded(invoke, 'revoke pending invocation')).error);
        assert.equal(mockClientExecutions, 0);
        console.log('pinned-tool-proof: ' + JSON.stringify({ scenario, adapterEvents, responseEvents: frames.map(event => event.type),
          output: frames.at(-1).response?.output?.map(item => item.type), clientExecutions: mockClientExecutions, pendingMcpRejected: true }));
      } else {
        const frames = await bounded(incoming, 'tool response');
        const added = frames.find(event => event.type === 'response.output_item.added' && event.item.type === 'function_call');
        const done = frames.find(event => event.type === 'response.output_item.done' && event.item.type === 'function_call');
        assert.ok(added && done);
        assert.equal(done.item.name, 'fixture_noop');
        assert.equal(invocationSettled, false, 'MCP call still waits even after its Responses tool item was delivered');
        mockClientExecutions++; // Sole substitute for a host client; no command, file edit or network.
        const continuation = structuredClone(body);
        continuation.input.push({ type: 'function_call', call_id: done.item.call_id, name: 'fixture_noop', arguments: '{}' },
          { type: 'function_call_output', call_id: done.item.call_id, output: 'synthetic-complete-once' });
        const next = await send(continuation);
        const nextFrames = collect(next);
        assert.ok((await bounded(invoke, 'client result delivery')).result);
        finishBrowser.resolve();
        const failure = await bounded(nextFrames, 'continuation quota');
        assert.ok(failure.some(event => event.type === 'response.failed' && event.response.error.code === 'rate_limit_exceeded'));
        assert.equal(mockClientExecutions, 1);
        console.log('pinned-tool-proof: ' + JSON.stringify({ scenario, adapterEvents, responseEvents: frames.map(event => event.type),
          firstToolItemPrecedesClientExecution: true, mcpPendingUntilClientResult: true, clientExecutions: mockClientExecutions,
          continuationEvents: failure.map(event => event.type), continuationContainsPriorResult: true }));
      }
    } finally {
      finishBrowser.resolve();
      await broker.close();
      await invoke;
    }
  }
  console.log('PINNED_TOOL_EMISSION_PROOF_OK ' + pin);
} finally {
  assert.deepEqual(await readFile(entry), original, 'installed pinned runtime unchanged');
  assert.equal(dirname(home), resolve(tmpdir()));
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
