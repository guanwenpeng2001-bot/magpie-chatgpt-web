import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLoader } from '../src/loader.mjs';
import { prepare, complete } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';

const auth = { type: 'oauth', refresh: 'fixture', profile: 'effort-test' };

function capturedRequest(t, { reasoning, metadata = { thread_id: 'effort-thread', turn_id: 'effort-turn' }, trigger = false, source = {} } = {}) {
  const model = `native/${auth.profile}/gpt-6`;
  const body = { model: `chatgpt-web/${model}`, stream: false,
    input: [{ type: 'message', id: 'user-1', role: 'user', content: 'Inspect the fixture.',
      internal_chat_message_metadata_passthrough: { turn_id: 'effort-turn', content_item_kinds: ['user_message'] } },
    ...(trigger ? [{ type: 'compaction_trigger' }] : [])],
    client_metadata: { 'x-codex-turn-metadata': metadata },
    ...(reasoning ? { reasoning } : {}), ...source };
  const context = { protocol: 'responses', origin: 'local', state: {} };
  prepare(body, context);
  t.after(() => complete(context.state.webGptNonce));
  body.model = model;
  onProvider(body, { provider: { id: 'chatgpt-web', model } });
  return body;
}

async function forwardingFixture() {
  const forwarded = [];
  const stats = { lookups: 0 };
  const capture = (kind, body, headers) => {
    forwarded.push({ kind, body, headers: new Headers(headers) });
    return Promise.resolve(Response.json({ output: [] }));
  };
  const loader = await makeLoader({
    bridge: { open: () => assert.fail('native request entered text fallback') },
    native: { runtime: async () => { stats.lookups++; return { health: async () => true,
      responses: (body, headers) => capture('responses', body, headers),
      compaction: (body, headers) => capture('compact', body, headers) }; } },
  })(async () => auth);
  return { forwarded, stats, send: (body, headers = {}, endpoint = 'responses') => loader.fetch(`http://127.0.0.1:1/v1/${endpoint}`, {
    body: JSON.stringify(body), headers,
  }) };
}

for (const endpoint of ['responses', 'responses/compact']) {
  for (const scenario of [
    { name: 'inferred Instant effort', slug: 'gpt-6-sol-instant', expected: { effort: 'low' } },
    { name: 'inferred Pro effort', slug: 'gpt-6-pro', expected: { effort: 'max' } },
    { name: 'reasoning options', slug: 'gpt-6-sol-instant', reasoning: { summary: 'detailed' }, expected: { summary: 'detailed', effort: 'low' } },
    { name: 'body effort before header', slug: 'gpt-6-sol', reasoning: { effort: 'medium', summary: 'auto' },
      header: 'high', expected: { effort: 'medium', summary: 'auto' } },
    { name: 'header effort', slug: 'gpt-6-sol', header: 'xhigh', expected: { effort: 'xhigh' } },
    { name: 'unspecified variable effort', slug: 'gpt-6-sol', expected: undefined },
  ]) {
    test(`${endpoint} forwards ${scenario.name}`, async t => {
      const model = `native/${auth.profile}/${scenario.slug}`;
      const body = { model: `chatgpt-web/${model}`, stream: false,
        input: [{ type: 'message', id: 'user-1', role: 'user', content: 'Inspect the fixture.',
          internal_chat_message_metadata_passthrough: { turn_id: 'effort-turn', content_item_kinds: ['user_message'] } }],
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'effort-thread', turn_id: 'effort-turn' }) },
        ...(scenario.reasoning ? { reasoning: scenario.reasoning } : {}) };
      const context = { protocol: 'responses', origin: 'local', state: {} };
      prepare(body, context);
      t.after(() => complete(context.state.webGptNonce));
      for (const item of body.input) delete item.internal_chat_message_metadata_passthrough;
      body.model = model;
      onProvider(body, { provider: { id: 'chatgpt-web', model } });
      const forwarded = [];
      const capture = async (request, kind) => {
        forwarded.push({ request, kind });
        return Response.json({ output: [] });
      };
      const loader = await makeLoader({
        bridge: { open: () => assert.fail('native request entered text fallback') },
        native: { runtime: async () => ({ health: async () => true,
          responses: request => capture(request, 'responses'),
          compaction: request => capture(request, 'compact') }) },
      })(async () => auth);
      const response = await loader.fetch(`http://127.0.0.1:1/v1/${endpoint}`, {
        body: JSON.stringify(body), headers: scenario.header ? { 'x-magpie-effort': scenario.header } : {},
      });
      assert.equal(response.status, 200);
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].kind, endpoint.endsWith('/compact') ? 'compact' : 'responses');
      assert.equal(forwarded[0].request.model, `chatgpt-web/${scenario.slug}`);
      assert.deepEqual(forwarded[0].request.reasoning, scenario.expected);
    });
  }

  for (const transformed of [{ effort: 'low' }, { effort: 'ultra' }, undefined]) {
    test(`${endpoint} derives its target from canonical reasoning after ${JSON.stringify(transformed)}`, async t => {
      const body = capturedRequest(t, { reasoning: { effort: 'xhigh', context: 'all_turns' } });
      body.reasoning = transformed;
      const { forwarded, send } = await forwardingFixture();
      assert.equal((await send(body, { 'x-magpie-effort': 'max' }, endpoint)).status, 200);
      assert.equal(forwarded[0].body.model, 'chatgpt-web/gpt-6-sol');
      assert.deepEqual(forwarded[0].body.reasoning, { effort: 'xhigh', context: 'all_turns' });
    });
  }

  for (const first of ['low', undefined]) {
    test(`${endpoint} binds ${first ?? 'absent'} header effort across retries`, async t => {
      const body = capturedRequest(t);
      body.reasoning = { effort: 'medium' }; // Vendor defaults cannot supply canonical effort.
      const { forwarded, send } = await forwardingFixture();
      const headers = first ? { 'x-magpie-effort': first } : {};
      for (let i = 0; i < 2; i++) assert.equal((await send(body, headers, endpoint)).status, 200);
      assert.equal(forwarded[0].body.reasoning.effort, first ?? 'high');
      assert.equal((await send(body, { 'x-magpie-effort': 'max' }, endpoint)).status, 400);
      assert.equal(forwarded.length, 2, 'changed header must fail before native forwarding');
      assert.equal((await send(body, headers, endpoint)).status, 200, 'rejection must not replace the original binding');
    });
  }

  test(`${endpoint} ignores differing effort headers when canonical reasoning supplies the effort`, async t => {
    const body = capturedRequest(t, { reasoning: { effort: 'high' } });
    delete body.reasoning;
    const { forwarded, send } = await forwardingFixture();
    for (const effort of ['low', 'max']) assert.equal((await send(body, { 'x-magpie-effort': effort }, endpoint)).status, 200);
    assert.ok(forwarded.every(({ body }) => body.model === 'chatgpt-web/gpt-6-sol' && body.reasoning.effort === 'high'));
  });
}

for (const kind of ['memento', 'v2', 'turn']) {
  test(`responses dispatches canonical ${kind} despite transformed compaction markers`, async t => {
    const canonicalMetadata = { thread_id: 'effort-thread', turn_id: 'effort-turn', request_kind: kind === 'memento' ? 'compaction' : 'turn',
      ...(kind === 'memento' ? { compaction: { implementation: 'responses', strategy: 'memento' } } : {}) };
    const body = capturedRequest(t, { metadata: canonicalMetadata, trigger: kind === 'v2' });
    body.input = kind === 'turn' ? [...body.input, { type: 'compaction_trigger' }] : body.input.filter(item => item.type !== 'compaction_trigger');
    const vendorMetadata = JSON.stringify({ thread_id: 'vendor-thread', turn_id: 'vendor-turn', request_kind: kind === 'turn' ? 'compaction' : 'turn' });
    body.client_metadata['x-codex-turn-metadata'] = vendorMetadata;
    const headers = { 'x-codex-turn-metadata': vendorMetadata };
    const { forwarded, send } = await forwardingFixture();
    assert.equal((await send(body, headers)).status, 200);
    assert.equal(forwarded[0].kind, kind === 'turn' ? 'responses' : 'compact');
    assert.deepEqual(forwarded[0].body.client_metadata['x-codex-turn-metadata'], canonicalMetadata);
    assert.deepEqual(JSON.parse(forwarded[0].headers.get('x-codex-turn-metadata')), canonicalMetadata);
    assert.equal(headers['x-codex-turn-metadata'], vendorMetadata, 'caller headers remain unchanged');
  });
}

test('invalid routing proof fails before either native endpoint is invoked', async t => {
  const body = capturedRequest(t, { metadata: { request_kind: 'compaction' } });
  body.client_metadata['x-magpie-native-checked'] = JSON.stringify({ nonce: body.client_metadata['x-magpie-native-nonce'],
    provider: 'chatgpt-web', route: 'native/another-account/gpt-6' });
  const { forwarded, stats, send } = await forwardingFixture();
  assert.equal((await send(body)).status, 400);
  assert.equal(forwarded.length, 0);
  assert.equal(stats.lookups, 0);
});

test('native forwarding keeps canonical tool schemas and controls after vendor adaptation', async t => {
  const source = { instructions: 'Inspect the fixture only.', prompt_cache_key: 'canonical-cache', parallel_tool_calls: false,
    tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'read_file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] }],
    tool_choice: { type: 'function', name: 'read_file', namespace: 'functions' } };
  const body = capturedRequest(t, { reasoning: { effort: 'high', context: 'all_turns' }, source });
  Object.assign(body, { instructions: 'Vendor projection', prompt_cache_key: 'vendor-cache', tools: [], tool_choice: 'none', parallel_tool_calls: true });
  const { forwarded, send } = await forwardingFixture();
  assert.equal((await send(body)).status, 200);
  for (const [key, expected] of Object.entries(source)) assert.deepEqual(forwarded[0].body[key], expected);
  assert.deepEqual(forwarded[0].body.reasoning, { effort: 'high', context: 'all_turns' });
});

for (const state of ['unavailable', 'unhealthy']) {
  test(`native ${state} falls back using the masked vendor request`, async t => {
    const body = capturedRequest(t);
    body.input[0].content = 'Inspect {{PATH_ab12cd34}}.';
    const commands = [];
    const loader = await makeLoader({
      native: { runtime: async () => state === 'unavailable' ? null : { health: async () => false } },
      bridge: { async open(command) {
        commands.push(command);
        const stream = (async function* () { yield { type: 'delta', index: 0, text: 'Done.' }; yield { type: 'finish', reason: 'complete' }; })();
        stream.close = () => {};
        return stream;
      } },
    })(async () => auth);
    const response = await loader.fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(commands.length, 1);
    assert.match(commands[0].prompt, /\{\{PATH_ab12cd34\}\}/);
    assert.doesNotMatch(commands[0].prompt, /Inspect the fixture\./);
  });
}

test('unavailable native compaction retains canonical intent while summarizing masked history', async t => {
  const body = capturedRequest(t, { metadata: { thread_id: 'effort-thread', turn_id: 'effort-turn', request_kind: 'compaction' } });
  body.input[0].content = 'Inspect {{PATH_ab12cd34}}.';
  body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ request_kind: 'turn' });
  let sent;
  const loader = await makeLoader({ native: { runtime: async () => null }, bridge: { async open(command) {
    sent = command;
    const stream = (async function* () { yield { type: 'delta', index: 0, text: 'Checkpoint.' }; yield { type: 'finish', reason: 'complete' }; })();
    stream.close = () => {};
    return stream;
  } } })(async () => auth);
  const response = await loader.fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-chatgptweb-engine'), 'text-compaction');
  assert.match(sent.prompt, /\{\{PATH_ab12cd34\}\}/);
  assert.match(sent.system, /Summarize the conversation/);
  assert.deepEqual(sent.tools, []);
});
