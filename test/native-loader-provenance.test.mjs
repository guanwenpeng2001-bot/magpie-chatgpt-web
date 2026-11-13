import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLoader } from '../src/loader.mjs';
import { toTextRequest } from '../src/native/fallback.mjs';
import { prepare, complete, NONCE, CHECKED, TICKET } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';
import { parseSSE } from '../src/wire/sse.mjs';

const auth = { type: 'oauth', refresh: 'fixture', profile: 'proof-fallback' };
const bodyFor = (extra = {}) => ({ model: `native/${auth.profile}/gpt-5.6-pro`, stream: false,
  input: [{ role: 'user', content: 'Inspect {{PATH_fixture}}.' }], reasoning: { effort: 'high' }, ...extra });

function proven(t, extra = {}) {
  const body = bodyFor(extra);
  const model = body.model;
  body.model = `chatgpt-web/${model}`;
  const context = { protocol: 'responses', origin: 'local', state: {} };
  prepare(body, context);
  t.after(() => complete(context.state.webGptNonce));
  body.model = model;
  onProvider(body, { provider: { id: 'chatgpt-web', model } });
  return body;
}

async function fixture({ state = 'healthy', answer = () => 'Fixture title', submit } = {}) {
  const stats = { runtime: 0, health: 0, native: 0, compact: 0 };
  const commands = [];
  const native = { runtime: async () => {
    stats.runtime++;
    if (state === 'startup-failed') throw new Error('fixture startup failure');
    return {
      health: async () => { stats.health++; return state !== 'unhealthy'; },
      responses: async body => { stats.native++; return submit ? submit(body) : Response.json({ output: [] }); },
      compaction: async () => { stats.compact++; return Response.json({ output: [] }); },
    };
  } };
  const loader = await makeLoader({
    native: state === 'absent' ? undefined : native,
    input: { magpie: { option: (_provider, name) => name === 'native-tools' ? state !== 'disabled' : undefined } },
    bridge: { async open(command) {
      commands.push(command);
      const stream = (async function* () {
        yield { type: 'delta', index: 0, text: answer(command) };
        yield { type: 'finish', reason: 'complete' };
      })();
      stream.close = () => {};
      return stream;
    } },
  })(async () => auth);
  return { stats, commands, send: (body, headers = {}, path = '/v1/responses') => loader.fetch(`http://fixture.invalid${path}`, {
    body: JSON.stringify(body), headers,
  }) };
}

for (const slug of ['gpt-5.6-pro', 'gpt-6-pro']) for (const stream of [false, true]) {
  for (const metadata of [undefined, {}, { 'x-codex-turn-metadata': JSON.stringify({ thread_source: 'thread_title' }) }]) {
    test(`unproven ${slug} bypasses native with stream=${stream}, metadata=${JSON.stringify(metadata)}`, async () => {
      const { send, stats, commands } = await fixture();
      const response = await send(bodyFor({ model: `native/${auth.profile}/${slug}`, stream,
        ...(metadata === undefined ? {} : { client_metadata: metadata }) }), { 'x-magpie-effort': 'low' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-chatgptweb-engine'), 'text-fallback');
      assert.deepEqual(stats, { runtime: 0, health: 0, native: 0, compact: 0 });
      assert.equal(commands.length, 1);
      assert.equal(commands[0].selectionModel, slug === 'gpt-5.6-pro' ? 'gpt-5-6-pro' : slug);
      assert.match(commands[0].prompt, /\{\{PATH_fixture\}\}/);
      const result = stream ? parseSSE(await response.text()).events.map(event => JSON.parse(event.data))
        .find(event => event.type === 'response.completed').response : await response.json();
      assert.equal(result.output[0].content[0].text, 'Fixture title');
    });
  }
}

const badProofs = [
  ['null nonce', () => bodyFor({ client_metadata: { [NONCE]: null } })],
  ['malformed nonce', () => bodyFor({ client_metadata: { [NONCE]: 'invalid' } })],
  ['unknown nonce', () => bodyFor({ client_metadata: { [NONCE]: '0'.repeat(32),
    [CHECKED]: JSON.stringify({ nonce: '0'.repeat(32), provider: 'chatgpt-web', route: bodyFor().model }) } })],
  ['checked only', t => { const body = proven(t); delete body.client_metadata[NONCE]; return body; }],
  ['null checked only', () => bodyFor({ client_metadata: { [CHECKED]: null } })],
  ['legacy ticket only', () => bodyFor({ input: [{ role: 'user', content: 'Fixture', [TICKET]: 'old-proof' }] })],
  ['null legacy ticket only', () => bodyFor({ input: [{ role: 'user', content: 'Fixture', [TICKET]: null }] })],
  ['missing checked', t => { const body = proven(t); delete body.client_metadata[CHECKED]; return body; }],
  ['malformed checked', t => { const body = proven(t); body.client_metadata[CHECKED] = '{'; return body; }],
  ['wrong checked route', t => { const body = proven(t); const checked = JSON.parse(body.client_metadata[CHECKED]);
    body.client_metadata[CHECKED] = JSON.stringify({ ...checked, route: 'native/other/gpt-5.6-pro' }); return body; }],
  ['expired proof', t => { const body = proven(t); complete(body.client_metadata[NONCE]); return body; }],
];
for (const state of ['healthy', 'unhealthy', 'startup-failed', 'disabled', 'absent']) {
  for (const [label, create] of badProofs) test(`${label} is rejected before all dispatch when native is ${state}`, async t => {
    const { send, stats, commands } = await fixture({ state });
    const response = await send(create(t));
    assert.equal(response.status, 400);
    assert.deepEqual(stats, { runtime: 0, health: 0, native: 0, compact: 0 });
    assert.equal(commands.length, 0);
  });
}

for (const model of ['native/other/gpt-5.6-pro', `native/${auth.profile}/gpt-6.1-sol-wm`, 'gpt-6']) {
  test(`routing ${model} cannot downgrade invalid proof into text`, async t => {
    const body = proven(t);
    body.model = model;
    const { send, commands, stats } = await fixture();
    assert.equal((await send(body)).status, 400);
    assert.equal(commands.length, 0);
    assert.equal(stats.runtime, 0);
  });
}

test('unproven cross-account routing still fails before any dispatch', async () => {
  const { send, commands, stats } = await fixture();
  assert.equal((await send(bodyFor({ model: 'native/other/gpt-5.6-pro' }))).status, 400);
  assert.equal(commands.length, 0);
  assert.equal(stats.runtime, 0);
});

for (const type of ['compaction', 'compaction_summary', 'context_compaction']) {
  test(`unproven ${type} cannot become a text continuation`, async () => {
    const { send, commands, stats } = await fixture();
    const response = await send(bodyFor({ input: [{ type, encrypted_content: 'fixture' }] }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'native_checkpoint_unavailable');
    assert.equal(commands.length, 0);
    assert.equal(stats.runtime, 0);
  });
}

for (const mode of ['healthy', 'disabled']) test(`partial proof cannot enter compaction when ${mode}`, async () => {
  const { send, commands, stats } = await fixture({ state: mode });
  assert.equal((await send(bodyFor({ client_metadata: { [CHECKED]: null } }), {}, '/v1/responses/compact')).status, 400);
  assert.equal(commands.length, 0);
  assert.equal(stats.runtime, 0);
});

test('unproven two-tool request preserves required namespaced custom choice and schemas', async () => {
  const tools = [{ type: 'namespace', name: 'functions', tools: [
    { type: 'function', name: 'read', description: 'Read a fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { type: 'custom', name: 'patch', description: 'Patch a fixture' },
  ] }];
  const { send, commands, stats } = await fixture({ answer: command => `${command.start}${JSON.stringify({ name: 'functions.patch', input: { input: 'fixture patch' } })}${command.end}` });
  const body = bodyFor({ tools, parallel_tool_calls: false, tool_choice: { type: 'custom', namespace: 'functions', name: 'patch' } });
  const response = await send(body);
  assert.equal(response.status, 200);
  assert.equal(stats.runtime, 0);
  assert.deepEqual(commands[0].tools, toTextRequest(body).tools);
  assert.equal(commands[0].tools.length, 2);
  assert.deepEqual(commands[0].toolChoice, { type: 'tool', name: 'functions.patch', disable_parallel_tool_use: true });
  const result = await response.json();
  assert.equal(result.output[0].type, 'custom_tool_call');
  assert.equal(result.output[0].namespace, 'functions');
  assert.equal(result.output[0].input, 'fixture patch');
});

for (const type of ['web_search', 'unknown_fixture_tool']) test(`unproven ${type} fails strict text conversion without submission`, async () => {
  const body = bodyFor({ tools: [{ type }], tool_choice: 'none' });
  assert.throws(() => toTextRequest(body), /Unsupported native tool in text fallback/);
  const { send, commands, stats } = await fixture();
  assert.equal((await send(body)).status, 502);
  assert.equal(commands.length, 0);
  assert.equal(stats.runtime, 0);
});

for (const failure of ['throw', 'http']) test(`proven native ${failure} after submission never replays text`, async t => {
  const { send, commands, stats } = await fixture({ submit: () => {
    if (failure === 'throw') throw new Error('fixture response lost');
    return Response.json({ error: { code: 'fixture' } }, { status: 502 });
  } });
  assert.equal((await send(proven(t))).status, 502);
  assert.equal(stats.native, 1);
  assert.equal(commands.length, 0);
});
