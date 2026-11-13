import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, restore, mark, complete, NONCE, CHECKED, TICKET } from '../src/native/provenance.mjs';
import { onRequest, onResponse } from '../src/native/hooks.mjs';
import { onProvider } from '../src/native/middleware.js';

const route = 'native/account-a/gpt-6-sol';
const turn = '11111111-1111-1111-1111-111111111111';
function original() {
  return {model:`chatgpt-web/${route}`, prompt_cache_key:'thread-fixture',
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'thread-fixture', turn_id:turn,
      request_kind:'turn', turn_trigger:'exec', sandbox:'windows-sandbox', sandbox_mode:'workspace-write',
      workspaces:{'C:\\fixture':{git:{branch:'main'}}}, window_number:0, auto_review_enabled:false}), extra:'keep'},
    input:[{type:'message', role:'user', content:[{type:'input_text', text:'fixture'}],
      internal_chat_message_metadata_passthrough:{turn_id:turn, content_item_kinds:['user_message'], extension:{nested:[1, false, null]}},
      encrypted_content:'sealed-message'},
    {type:'function_call', call_id:'call-fixture', name:'echo', arguments:'{}', encrypted_function_args:[]},
    {type:'agent_message', author:'/root', recipient:'/root/worker', encrypted_content:'sealed-agent'},
    {type:'reasoning', id:'reason-fixture', summary:[], encrypted_content:'sealed-reasoning'}]};
}
function routed(t, body = original(), origin = 'local') {
  const ctx = {protocol:'responses', origin, state:{}};
  onRequest(body, ctx);
  t.after(() => complete(ctx.state.webGptNonce));
  onProvider(body, {protocol:'responses', provider:{id:'chatgpt-web', model:route}});
  body.model = route;
  // Measured on 0.1.3930: forVendor runs AFTER onProvider; arbitrary
  // per-item tickets, client_metadata and prompt_cache_key survive.
  for (const item of body.input) {
    delete item.internal_chat_message_metadata_passthrough;
    delete item.encrypted_function_args;
    if (!['reasoning', 'compaction', 'compaction_summary', 'context_compaction'].includes(item.type)) delete item.encrypted_content;
  }
  return {body, ctx};
}

test('restores all native item metadata and opaque fields without retaining message text', t => {
  const expected = original();
  const {body} = routed(t);
  restore(body, 'account-a');
  assert.deepEqual(body, {...expected, model:route});
});

test('Responses Lite routing lifts additional tools and removes only transport metadata', t => {
  const input = original();
  input.input.unshift({type:'additional_tools', role:'system', tools:[{type:'namespace', name:'functions', tools:[]}],
    internal_chat_message_metadata_passthrough:{turn_id:turn, content_item_kinds:['additional_tools']}});
  input.input[2].namespace = 'functions';
  input.reasoning = {effort:'high', context:'all_turns'};
  input.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite = 'true';
  const {body} = routed(t, input);
  assert.equal(body.input[0][TICKET], undefined);
  body.input.shift();
  delete body.input[1].namespace;
  delete body.reasoning.context;
  delete body.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite;
  restore(body, 'account-a');
  assert.equal(body.input[0].internal_chat_message_metadata_passthrough.turn_id, turn);
  assert.deepEqual(body.input[1].encrypted_function_args, []);
  assert.equal(body.input[2].encrypted_content, 'sealed-agent');
  assert.equal(body.client_metadata.extra, 'keep');
});

for (const field of ['sandbox_mode', 'workspaces', 'turn_trigger', 'window_number']) {
  test(`binds full turn metadata, including ${field}`, t => {
    const {body} = routed(t);
    const metadata = JSON.parse(body.client_metadata['x-codex-turn-metadata']);
    metadata[field] = 'changed';
    body.client_metadata['x-codex-turn-metadata'] = JSON.stringify(metadata);
    assert.throws(() => restore(body, 'account-a'), /metadata|identity/);
  });
}
test('binds other client metadata and prompt cache identity', t => {
  for (const mutate of [b => {b.client_metadata.extra = 'changed';}, b => {b.prompt_cache_key = 'other';}]) {
    const {body} = routed(t);
    mutate(body);
    assert.throws(() => restore(body, 'account-a'), /metadata|identity/);
  }
});
test('object turn metadata and future metadata keys round-trip exactly', t => {
  const input = original();
  input.client_metadata['x-codex-turn-metadata'] = JSON.parse(input.client_metadata['x-codex-turn-metadata']);
  input.input[0].internal_chat_message_metadata_passthrough.turn_id = 'future-client-turn';
  input.input[0].internal_chat_message_metadata_passthrough.content_item_kinds = ['future/kind'];
  const expected = structuredClone(input);
  const {body} = routed(t, input, 'magpie-key');
  restore(body, 'account-a');
  assert.deepEqual(body, {...expected, model:route});
});
test('saved metadata is detached from caller mutation and successful retries', t => {
  const input = original();
  const metadata = input.input[0].internal_chat_message_metadata_passthrough;
  const {body} = routed(t, input);
  metadata.extension.nested[0] = 99;
  const retry = structuredClone(body);
  restore(body, 'account-a');
  assert.equal(body.input[0].internal_chat_message_metadata_passthrough.extension.nested[0], 1);
  body.input[0].internal_chat_message_metadata_passthrough.extension.nested[0] = 55;
  restore(retry, 'account-a');
  assert.equal(retry.input[0].internal_chat_message_metadata_passthrough.extension.nested[0], 1);
});
test('unclaimed proof rejects account, route, nonce, missing and duplicate tickets', t => {
  for (const mutate of [b => {b.model = 'native/account-b/gpt-6-sol';},
    b => {b.client_metadata[NONCE] = 'x'.repeat(32);},
    b => {b.client_metadata[CHECKED] = JSON.stringify({nonce:b.client_metadata[NONCE], provider:'chatgpt-web', route:'native/account-b/gpt-6-sol'});},
    b => {delete b.input[0][TICKET];}, b => {b.input.push(structuredClone(b.input[0]));}]) {
    const {body} = routed(t);
    mutate(body);
    assert.throws(() => restore(body, 'account-a'));
  }
});
test('response cleanup revokes proof and leaves unrelated hook state intact', t => {
  const {body, ctx} = routed(t);
  ctx.state.other = true;
  onResponse({}, ctx);
  assert.equal(ctx.state.other, true);
  assert.throws(() => restore(body, 'account-a'));
});
test('bounded metadata rejects oversized records, including turn metadata', t => {
  for (const mutate of [b => {b.input[0].internal_chat_message_metadata_passthrough.extension = 'x'.repeat(600000);},
    b => {b.client_metadata['x-codex-turn-metadata'] = JSON.stringify({workspaces:{huge:'x'.repeat(600000)}});}]) {
    const input = original();
    mutate(input);
    const {body} = routed(t, input);
    assert.throws(() => restore(body, 'account-a'));
  }
});
test('mark and restricted middleware agree; unrelated or missing provider strips private proof', t => {
  const {body} = routed(t);
  const a = structuredClone(body), b = structuredClone(body);
  const ctx = {provider:{id:'chatgpt-web', model:route}};
  mark(a, ctx); onProvider(b, ctx);
  assert.deepEqual(a, b);
  for (const context of [{provider:{id:'other', model:route}}, {}]) {
    const copy = structuredClone(body);
    onProvider(copy, context);
    assert.equal(copy.client_metadata[NONCE], undefined);
    assert.ok(copy.input.every(item => item[TICKET] === undefined));
  }
});

test('restores unmasked local rollout paths and metadata when Magpie privacy masking rewrites tokens', t => {
  const expected = original();
  const {body} = routed(t);
  body.client_metadata['x-codex-turn-metadata'] = body.client_metadata['x-codex-turn-metadata'].replace('C:\\\\fixture', '{{PATH_ab12cd34}}');
  body.input[0].content[0].text = '<environment_context><cwd>{{PATH_ab12cd34}}</cwd></environment_context>';
  restore(body, 'account-a');
  assert.deepEqual(body, {...expected, model:route});
});
test('unsupported origins and protocols cannot reuse supplied private proof', () => {
  for (const ctx of [{protocol:'responses', origin:'remote'}, {protocol:'chat', origin:'local'}]) {
    const body = original();
    body.client_metadata[NONCE] = 'x'.repeat(32);
    body.client_metadata[CHECKED] = 'copied';
    body.input[0][TICKET] = 'copied';
    prepare(body, ctx);
    assert.equal(body.client_metadata[NONCE], undefined);
    assert.equal(body.client_metadata[CHECKED], undefined);
    assert.equal(body.input[0][TICKET], undefined);
  }
});
