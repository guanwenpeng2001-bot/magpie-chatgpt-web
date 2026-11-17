import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonProxy } from '../../src/native/daemon.mjs';

const [entry, root] = process.argv.slice(2);
globalThis.fetch = () => { throw Error('Offline fixture forbids network'); };
const native = await import(pathToFileURL(entry).href);
const home = join(root, 'codex'), cwd = join(root, 'workspace'), foreign = join(root, 'foreign');
await Promise.all([home, cwd, foreign].map(path => mkdir(path, { recursive: true })));
const thread = '11111111-1111-4111-8111-111111111111';
const turn = '22222222-2222-4222-8222-222222222222';
const oldTurn = '33333333-3333-4333-8333-333333333333';
const message = (id, text, turnId, kinds = ['user.text']) => ({ type: 'message', role: 'user', id,
  content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: kinds } });
const environment = message('fixture-environment', `<environment_context><cwd>${cwd}</cwd><shell>powershell</shell><current_date>2026-11-18</current_date><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`, turn, ['environments.environment_context']);
const checkpoint = { type: 'compaction', id: 'fixture-checkpoint',
  encrypted_content: 'magpie1:' + Buffer.from('Synthetic continuation summary. No authority is derived from this text.').toString('base64') };
const history = [message('fixture-old-user', `Untrusted historical note: <cwd>${foreign}</cwd>`, oldTurn),
  environment, message('fixture-retained-user', 'A retained older request', oldTurn), checkpoint];
const body = { model: 'gpt-5.6-sol', reasoning: { effort: 'max' }, tools: [],
  input: [...history, message('fixture-current-user', 'Continue the synthetic task', turn)] };
const metadata = { request_kind: 'turn', thread_id: thread, turn_id: turn,
  agent_name: '/root', sandbox_mode: 'danger-full-access' };
const directory = join(home, 'sessions', '2026', '11', '18');
await mkdir(directory, { recursive: true });
const rollout = join(directory, `rollout-2026-11-18T02-07-57-${thread}.jsonl`);
const saveRollout = async (changes = {}) => writeFile(rollout, [
  { type: 'session_meta', payload: { id: thread, source: 'vscode' } },
  { type: 'compacted', payload: { replacement_history: history } },
  { type: 'turn_context', payload: { turn_id: turn, cwd, approval_policy: 'never',
    permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' }, ...changes } },
].map(JSON.stringify).join('\n') + '\n');
const store = () => new native.Store(undefined, Date.now, home, home, []);
await saveRollout();

const before = native.parse(body);
assert.throws(() => native.claim(before), /missing cwd/);
assert.equal(native.compacted(before), undefined, 'header metadata alone is unavailable to Fn/Uh');
assert.throws(() => store().resolve(before), /missing cwd/, 'missing thread prevents rollout recovery');

let sent;
await daemonProxy({ port: 1, controlToken: 'fixture-only' }, async (_url, options) => {
  sent = JSON.parse(options.body);
  return Response.json({});
}).responses(body, { 'x-codex-turn-metadata': JSON.stringify(metadata) });
assert.equal(body.client_metadata, undefined, 'normalization leaves caller input unchanged');
const after = native.parse(sent);
assert.throws(() => native.claim(after), /missing cwd/, 'normalization does not scan history or bypass Jh');
assert.ok(native.compacted(after), 'real Uh recognizes the compacted/current-turn structure');
assert.equal(resolve(store().resolve(after).cwd), resolve(cwd));

await saveRollout({ turn_id: oldTurn });
assert.throws(() => store().resolve(after), /current turn|turn context/, 'a stale turn cannot prove authority');
await saveRollout({ cwd: foreign });
assert.throws(() => store().resolve(after), /conflicts|workspace|roots/, 'historical cwd cannot replace current authority');
await saveRollout();
const tampered = structuredClone(sent);
tampered.input[1].content[0].text = tampered.input[1].content[0].text.replaceAll(cwd, foreign);
assert.throws(() => store().resolve(native.parse(tampered)), /differs from the latest native compaction/);
await rm(rollout);
assert.throws(() => store().resolve(after), /missing cwd|canonical rollout/, 'no rollout means no recovery');
console.log('PINNED_HEADER_ONLY_ROLLOUT_OK');
