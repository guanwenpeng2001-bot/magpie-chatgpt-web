import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHistoryStore } from '../../src/native/history-store.mjs';
import { writeAccountContinuityPolicy } from '../../src/native/account-continuity.mjs';

const [entry, scratch, phase] = process.argv.slice(2);
globalThis.fetch = () => { throw Error('network forbidden in continuity fixture'); };
const native = await import(pathToFileURL(entry).href);
const home = process.env.MAGPIE_NATIVE_CHECKPOINT_HOME;
const { thread, turn, other, preTurn } = JSON.parse(await readFile(join(scratch, 'identity.json'), 'utf8'));
const cwd = join(scratch, 'workspace'), canonical = join(scratch, 'canonical');
const rollout = join(canonical, 'sessions', '2026', '11', '18', `rollout-2026-11-18T10-00-00-${thread}.jsonl`);
const taskText = '<codex_internal_context source="goal">Continue the offline long command task exactly.</codex_internal_context>';
const metadata = { thread_id: thread, turn_id: turn, request_kind: 'turn', agent_name: '/root', sandbox_mode: 'danger-full-access', workspaces: { [cwd]: {} } };
const msg = (id, text, kind = 'user.text') => ({ type: 'message', role: 'user', id, content: text,
  internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] } });
const environmentMessage = msg('environment', `<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, 'environments.environment_context');
environmentMessage.content = [{ type: 'input_text', text: environmentMessage.content }];
const task = msg('task', taskText, 'goal.internal_context');
const base = { model: 'chatgpt-web/gpt-5.6-sol', reasoning: { effort: 'high' }, tools: [], stream: false,
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) } };
const config = { mode: 'full', subagentProtocol: 'native', contextWindow: 256000, appName: 'Offline continuity fixture',
  browserHost: 'managed-chrome', browserInteractionMode: 'automatic', storageStatePath: join(home, 'unused-storage.json'),
  brokerSocketPath: `\\\\.\\pipe\\offline-continuity-${process.pid}`, solAvailable: true, proAvailable: true, extraHighAvailable: true };
const parse = body => { const value = native.parseRequest(structuredClone(body)); native.route(value, config); return value; };
const restored = parsed => native.restore(parsed, native.identity(parsed), native.revisions(parsed));
const countTask = parsed => restored(parsed).filter(message => message.content === taskText).length;
const summaryItem = summary => ({ type: 'compaction', encrypted_content: 'magpie1:' + Buffer.from(summary).toString('base64') });
const replayFile = join(scratch, 'replay.json');
const store = createHistoryStore(join(home, 'history-v1'));

async function saveProof(change = {}) {
  await mkdir(dirname(rollout), { recursive: true });
  await writeFile(rollout, [
    { type: 'session_meta', payload: { id: change.thread ?? thread, source: 'vscode' } },
    { type: 'turn_context', payload: { turn_id: change.turn ?? turn, cwd, approval_policy: 'never',
      permission_profile: { type: 'disabled' }, sandbox_policy: change.sandbox ?? { type: 'danger-full-access' } } },
  ].map(JSON.stringify).join('\n') + '\n');
}
function resolver() { return new native.EnvironmentStore(undefined, Date.now, join(home, 'codex'), undefined, [canonical]); }
async function archive(body) {
  const request = parse(body), proof = resolver(), environment = proof.resolve(request);
  await native.archiveBoundary(request, environment, proof);
  return { request, environment };
}
async function compact(body, summary) {
  native.Worker.forProvider = () => ({ appName: 'Offline fixture', async run(options) {
    assert.equal(options.compaction, true);
    assert.equal(options.capabilities.localToolsEnabled, false);
    const prepared = await options.prepare();
    assert.ok(prepared.text.includes('Continue the offline long command task exactly.'), 'actual pinned prompt lost the task');
    options.onTextDelta?.(summary); prepared.release?.(); return summary;
  } });
  const response = await native.responseRequest(new Request('http://127.0.0.1/v1/responses', { method: 'POST',
    body: JSON.stringify({ ...body, input: [...body.input, { type: 'compaction_trigger' }] }) }), config);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return { ...base, input: [environmentMessage, summaryItem(summary)] };
}

try {
  if (phase === 'seed') {
    await saveProof();
    // >4 MiB cumulative retrieval memory is never added to the active model prompt.
    const original = 'EARLY_COMMAND_OUTPUT ' + '原文🧭\r\n'.repeat(400_000) + ' LATE_COMMAND_OUTPUT';
    assert.ok(Buffer.byteLength(original) > 4 * 1024 * 1024);
    await archive({ ...base, input: [environmentMessage, task,
      { type: 'function_call_output', call_id: 'old-command', output: original }] });
    const replay = await compact({ ...base, input: [environmentMessage, task,
      { type: 'function_call_output', call_id: 'last-command', output: 'COMPACT_FINAL_COMMAND_OUTPUT' }] }, 'Checkpoint one: long command work recorded.');
    assert.equal(countTask(parse(replay)), 1);
    assert.equal([...native.registry.values()][0].continuityGeneration, 1);
    await writeFile(replayFile, JSON.stringify(replay));
    await writeFile(join(scratch, 'original-hash'), createHash('sha256').update(original).digest('hex'));
    await store.append(other, [{ text: 'FOREIGN_CHAT_SECRET', role: 'user', type: 'message' }]);
  } else if (phase === 'continue') {
    const replay = JSON.parse(await readFile(replayFile, 'utf8'));
    assert.equal(native.registry.size, 0);
    assert.equal(countTask(parse(replay)), 0, 'the live B daemon initially has only B in its policy');
    await archive({ ...base, input: [environmentMessage, msg('warmup', 'B_POLICY_WARMUP')] });
    assert.deepEqual(await store.search(thread, 'EARLY_COMMAND_OUTPUT'), []);
    const policyEnv = await writeAccountContinuityPolicy(home, ['a', 'b', 'c']);
    assert.equal(policyEnv.MAGPIE_NATIVE_CONTINUITY_POLICY, process.env.MAGPIE_NATIVE_CONTINUITY_POLICY,
      'same process, registry, cached history store and launch env; only the owned policy file changes');
    const warmup = await readFile(join(home, 'history-v1', 'history', thread + '.bin'));
    // Exercise actual pinned parsing, summary decoder, source registry and restore.
    for (const kind of ['thread', 'turn', 'model', 'effort', 'summary', 'source', 'summary-owner']) {
      const body = structuredClone(replay);
      if (kind === 'thread' || kind === 'turn') body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ ...metadata, [kind + '_id']: randomUUID() });
      if (kind === 'summary') body.input[1] = summaryItem('client invented summary');
      if (kind === 'source') body.input.push(msg('steering', 'Stop the old task.'));
      if (kind === 'summary-owner') body.input[1].internal_chat_message_metadata_passthrough = { turn_id: randomUUID() };
      const parsed = parse(body);
      if (kind === 'model') parsed.modelId = 'foreign-model';
      if (kind === 'effort') parsed.options.reasoning = 'low';
      assert.equal(countTask(parsed), 0, kind + ' must not restore the authorized task');
    }
    // Even a valid peer checkpoint cannot give a foreign/stale rollout history scope.
    for (const change of [{ thread: other }, { turn: randomUUID() }, { sandbox: { type: 'read-only' } }]) {
      await saveProof(change);
      const parsed = parse(replay); parsed._compactionRequest = true;
      await native.archiveBoundary(parsed, undefined, resolver());
      assert.deepEqual(await readFile(join(home, 'history-v1', 'history', thread + '.bin')), warmup);
    }
    await saveProof();
    assert.equal(countTask(parse(replay)), 1);
    const { environment } = await archive({ ...replay, input: [...replay.input,
      { type: 'function_call_output', call_id: 'after-failover', output: 'B_COMMAND_OUTPUT' }] });
    const broker = new native.Broker('unused-offline'); broker.start = async () => {};
    const token = await broker.register(environment);
    const claim = await broker.dispatch({ method: 'claim', token, activityId: 'activity_' + randomUUID() });
    const invoke = (name, args = {}) => broker.dispatch({ method: 'invoke', bindingId: claim.bindingId,
      wireName: 'magpie_history__' + name, arguments: args });
    try {
      for (const marker of ['EARLY_COMMAND_OUTPUT', 'LATE_COMMAND_OUTPUT', 'COMPACT_FINAL_COMMAND_OUTPUT', 'B_COMMAND_OUTPUT']) {
        const result = await invoke('search', { query: marker });
        assert.equal(result.structuredContent.result.length, 1, marker);
        assert.equal(result.structuredContent.source, 'untrusted_chat_history');
      }
      const hits = (await invoke('search', { query: 'EARLY_COMMAND_OUTPUT' })).structuredContent.result;
      const page = (await invoke('read', { id: hits[0].id, limit: 12000 })).structuredContent.result;
      assert.ok(page.text.startsWith('EARLY_COMMAND_OUTPUT')); assert.equal(page.done, false);
      const original = (await store.snapshot(thread)).find(row => row.id === hits[0].id).text;
      assert.equal(createHash('sha256').update(original).digest('hex'), await readFile(join(scratch, 'original-hash'), 'utf8'));
      assert.deepEqual((await invoke('search', { query: 'FOREIGN_CHAT_SECRET' })).structuredContent.result, []);
      for (const args of [{ threadId: other }, { root: scratch }, { peers: ['a'] }, { account: 'a' }]) {
        await assert.rejects(invoke('stats', args), /scope cannot be supplied/);
      }
      const clone = await broker.register(structuredClone(environment));
      assert.equal(broker.channels.get(clone).environment.tools.some(tool => tool.namespace === 'magpie_history'), false);
      await broker.revoke(clone);
    } finally { await broker.revoke(token); }
    const next = await compact(replay, 'Checkpoint two: continued on B and retained the task.');
    assert.equal([...native.registry.values()][0].continuityGeneration, 2);
    assert.equal(countTask(parse(replay)), 0, 'old peer snapshot cannot revive a superseded checkpoint');
    assert.equal(countTask(parse(next)), 1);
    await writeFile(replayFile, JSON.stringify(next));
  } else if (phase === 'return' || phase === 'restart') {
    const replay = JSON.parse(await readFile(replayFile, 'utf8'));
    if (phase === 'return') assert.equal([...native.registry.values()][0].continuityGeneration, 1);
    assert.equal(countTask(parse(replay)), 1);
    assert.equal([...native.registry.values()][0].continuityGeneration, 2);
    await archive(replay);
    for (const marker of ['EARLY_COMMAND_OUTPUT', 'LATE_COMMAND_OUTPUT', 'B_COMMAND_OUTPUT']) assert.equal((await store.search(thread, marker)).length, 1);
  } else if (phase === 'pre-turn') {
    const replay = JSON.parse(await readFile(replayFile, 'utf8'));
    const body = { ...replay, input: [replay.input[1], { type: 'compaction_trigger' }], client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ ...metadata,
      turn_id: preTurn, request_kind: 'compaction', compaction: { trigger: 'auto', phase: 'pre_turn', implementation: 'responses', strategy: 'memento' } }) } };
    assert.equal(native.registry.size, 0);
    const request = parse(body); request._compactionRequest = true;
    assert.equal(native.compactionSource(request).content, taskText, 'pre-turn source lookup must include only same-thread peer scopes');
    await native.archiveBoundary(request, undefined, resolver());
    assert.equal((await store.search(thread, 'EARLY_COMMAND_OUTPUT')).length, 1);
  } else throw Error('Unexpected fixture phase');
  console.log('PINNED_CONTINUITY_OK ' + phase);
} finally { await native.close(); }
