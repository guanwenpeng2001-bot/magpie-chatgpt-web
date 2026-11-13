import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNative, stopNative, nativeClient } from '../src/native/index.mjs';
import { nativeCatalog, describeNativeCatalogue, nativeRoute } from '../src/native/models.mjs';
import { prepare, restore, complete, NONCE, CHECKED, TICKET } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';
import { makeLoader } from '../src/loader.mjs';
import { _internal } from '../src/index.mjs';
import { isCompaction, toTextRequest, textFallback } from '../src/native/fallback.mjs';

const auth = { type: 'oauth', refresh: 'fixture', profile: 'account-a' };
const model = 'native/account-a/gpt-6-sol';
const turn = '11111111-1111-1111-1111-111111111111';
function capture() {
  const body = { model: `chatgpt-web/${model}`, input: [{ type: 'message', id: 'message-1', role: 'user', content: [{ type: 'input_text', text: 'hello' }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['user_message'] } }],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ turn_id: turn }), extra: 'keep' } };
  const context = { protocol: 'responses', origin: 'local', state: {} };
  prepare(body, context);
  // Reproduce Magpie's privacy filtering and model API-ID substitution.
  for (const item of body.input) delete item.internal_chat_message_metadata_passthrough;
  body.model = model;
  onProvider(body, { provider: { id: 'chatgpt-web', model } });
  return { body, nonce: context.state.webGptNonce };
}

test('hooks restore native item metadata after Magpie filtering without changing top-level metadata', () => {
  const { body, nonce } = capture();
  assert.ok(body.input[0][TICKET]);
  assert.ok(body.client_metadata[CHECKED]);
  restore(body, auth.profile);
  assert.deepEqual(body.input[0].internal_chat_message_metadata_passthrough, { turn_id: turn, content_item_kinds: ['user_message'] });
  assert.equal(body.input[0][TICKET], undefined);
  assert.deepEqual(body.client_metadata, { 'x-codex-turn-metadata': JSON.stringify({ turn_id: turn }), extra: 'keep' });
  complete(nonce);
});

for (const kind of ['account', 'identity', 'turn', 'missing', 'duplicate', 'unverified']) test(`native provenance rejects ${kind} changes`, () => {
  const { body, nonce } = capture();
  if (kind === 'identity') body.input[0].role = 'assistant';
  if (kind === 'turn') body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ turn_id: 'other' });
  if (kind === 'missing') body.input = [];
  if (kind === 'duplicate') body.input.push(structuredClone(body.input[0]));
  if (kind === 'unverified') body.input[0].internal_chat_message_metadata_passthrough = { turn_id: turn };
  assert.throws(() => restore(body, kind === 'account' ? 'account-b' : auth.profile));
  complete(nonce);
});

test('provenance permits only identical filtered retries and expires on response', () => {
  const { body, nonce } = capture();
  const retry = structuredClone(body);
  restore(body, auth.profile);
  restore(structuredClone(retry), auth.profile);
  retry.input[0].content[0].text = 'changed';
  assert.throws(() => restore(retry, auth.profile), /retry changed/);
  complete(nonce);
  assert.throws(() => restore(retry, auth.profile));
});

test('untrusted request origins cannot mint metadata provenance', () => {
  const body = { model: `chatgpt-web/${model}`, input: [], client_metadata: { [NONCE]: 'copied' } };
  prepare(body, { protocol: 'responses', origin: 'remote' });
  assert.equal(body.client_metadata[NONCE], undefined);
});

function loaderFixture(native) {
  const commands = [];
  const bridge = { async open(command) {
    commands.push(command);
    const stream = (async function* () { yield { type: 'delta', index: 0, text: 'plain summary' }; yield { type: 'finish', reason: 'complete' }; })();
    stream.close = () => {};
    return stream;
  } };
  return { commands, loader: makeLoader({ bridge, profileRoot: '.', native })(async () => auth) };
}

test('healthy provisioned native model forwards Responses SSE and metadata, never enters text', async () => {
  let forwarded;
  const native = { runtime: async () => ({ health: async () => true, responses: async (...args) => {
    forwarded = args;
    return new Response('data: native\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }) };
  const { loader, commands } = loaderFixture(native);
  const { body, nonce } = capture();
  const signal = new AbortController().signal;
  const response = await (await loader).fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify(body), signal });
  assert.equal(await response.text(), 'data: native\n\n');
  assert.equal(forwarded[0].model, 'chatgpt-web/gpt-6-sol');
  assert.equal(forwarded[0].input[0].internal_chat_message_metadata_passthrough.turn_id, turn);
  assert.equal(forwarded[0].client_metadata.extra, 'keep');
  assert.equal(forwarded[2], signal);
  assert.equal(commands.length, 0);
  complete(nonce);
});

for (const state of ['unprovisioned', 'unhealthy', 'startup-failed']) test(`native ${state} falls back to Responses-shaped text`, async () => {
  const native = { runtime: async () => {
    if (state === 'startup-failed') throw new Error('fixture');
    return state === 'unprovisioned' ? null : { health: async () => false };
  } };
  const { loader, commands } = loaderFixture(native);
  const response = await (await loader).fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify({ model, input: 'hello', stream: false }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'response');
  assert.equal(result.output[0].content[0].text, 'plain summary');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].model, 'gpt-6');
});

test('native submission failure is never retried via text', async () => {
  const { loader, commands } = loaderFixture({ runtime: async () => ({ health: async () => true, responses: async () => { throw new Error('lost response'); } }) });
  const { body, nonce } = capture();
  const response = await (await loader).fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify(body) });
  assert.equal(response.status, 502);
  assert.equal(commands.length, 0);
  complete(nonce);
});

for (const path of ['/v1/responses', '/v1/responses/compact']) test(`compaction ${path} uses tool-free plain summary even with native available`, async () => {
  const { loader, commands } = loaderFixture({ runtime: async () => { throw new Error('must not start'); } });
  const body = { model, input: 'past work', tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'compaction' }) } };
  const response = await (await loader).fetch(`http://127.0.0.1:1${path}`, { body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-chatgptweb-engine'), 'text-compaction');
  if (path.endsWith('/compact')) assert.equal((await response.json()).object, 'response');
  else assert.match(await response.text(), /response.completed/);
  assert.equal(commands[0].tools.length, 0);
  assert.match(commands[0].system, /plain-text summary/);
});

test('cross-account models fail before native lookup or text fallback', async () => {
  const { loader, commands } = loaderFixture({ runtime: async () => assert.fail('wrong account') });
  const response = await (await loader).fetch('http://127.0.0.1:1/v1/responses', { body: JSON.stringify({ model: 'native/account-b/gpt-6-sol', input: 'hello' }) });
  assert.equal(response.status, 400);
  assert.equal(commands.length, 0);
});

test('fallback converts tools, outputs, inline images and emits tool-call Responses events', async () => {
  const body = { model, input: [{ type: 'function_call', call_id: 'call1', name: 'run', arguments: '{"x":1}' },
    { type: 'function_call_output', call_id: 'call1', output: 'done' }, { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGk=' }] }],
    tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }] };
  const request = toTextRequest(body);
  assert.deepEqual(request.messages[0].content[0].input, { x: 1 });
  assert.equal(request.messages[1].content[0].tool_use_id, 'call1');
  assert.equal(request.messages[2].content[0].source.data, 'aGk=');
  const response = await textFallback(body, false, async () => Response.json({ content: [{ type: 'tool_use', id: 'next', name: 'run', input: { x: 2 } }] }));
  const text = await response.text();
  assert.match(text, /response.function_call_arguments.delta/);
  assert.match(text, /response.completed/);
  assert.match(text, /"call_id":"next"/);
});

test('compaction predicate accepts object metadata and compact endpoint', () => {
  assert.equal(isCompaction({ client_metadata: { 'x-codex-turn-metadata': { request_kind: 'compaction' } } }, '/v1/responses'), true);
  assert.equal(isCompaction({}, '/responses/compact'), true);
  assert.equal(isCompaction({ client_metadata: { 'x-codex-turn-metadata': 'invalid' } }, '/responses'), false);
});

test('fallback preserves output truncation and existing text model identity', async () => {
  assert.equal(toTextRequest({ model: 'gpt-5-3-mini', input: 'hello' }).model, 'gpt-5-3-mini');
  const response = await textFallback({ model, input: 'hello', stream: false }, false,
    async () => Response.json({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }));
  const body = await response.json();
  assert.equal(body.status, 'incomplete');
  assert.equal(body.incomplete_details.reason, 'max_output_tokens');
});

test('namespace/custom tools retain their identity through text fallback', async () => {
  const body = { model, stream: false, input: [{ role: 'user', content: 'patch it' }], tools: [
    { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch' }] },
    { type: 'tool_search' },
  ] };
  assert.equal(toTextRequest(body).tools[0].name, 'functions.apply_patch');
  const response = await textFallback(body, false, async () => Response.json({ content: [
    { type: 'tool_use', id: 'patch', name: 'functions.apply_patch', input: { input: '*** patch ***' } },
  ] }));
  const item = (await response.json()).output[0];
  assert.equal(item.type, 'custom_tool_call');
  assert.equal(item.name, 'apply_patch');
  assert.equal(item.namespace, 'functions');
  assert.equal(item.input, '*** patch ***');
});

test('catalog uses reference context windows and per-model OpenAI NPM', () => {
  assert.deepEqual(nativeCatalog({ solAvailable: false }).map(row => row.context_window), [1050000]);
  const plus = describeNativeCatalogue(nativeCatalog({ solAvailable: true }), auth.profile);
  assert.equal(plus[model].limit.context, 90000);
  assert.equal(plus[`${model}-instant`].limit.context, 41000);
  assert.equal(plus[model].api.npm, '@ai-sdk/openai');
  assert.equal(plus[model].capabilities.toolcall, true);
  assert.equal(plus[model].variants.xhigh, undefined);
  const pro = describeNativeCatalogue(nativeCatalog({ solAvailable: true, proAvailable: true, extraHighAvailable: true }), auth.profile);
  assert.equal(pro[model].limit.context, 111193);
  assert.equal(pro['native/account-a/gpt-6-pro'].limit.context, 112193);
  assert.deepEqual(pro[model].variants.xhigh, {});
});

test('provider lists native family first for provisioned accounts and retains text family', async () => {
  const nativeModels = describeNativeCatalogue(nativeCatalog({ solAvailable: true }), auth.profile);
  const hooks = _internal.createHooks({ bridge: { call: async () => ({ models: [{ slug: 'auto', title: 'Auto' }] }) }, native: { models: async () => nativeModels } });
  const models = await hooks.provider.models({}, { auth });
  assert.ok(Object.keys(models)[0].startsWith('native/'));
  assert.equal(models.auto.api.id, 'auto');
});

test('ensureNative starts tunnel before connector creation, saves secrets, coalesces and resumes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-account-'));
  t.after(async () => { await stopNative(); await rm(root, { recursive: true, force: true }); });
  const events = [];
  let healthy = false;
  const account = { profile: 'fixture-profile', chromeExecutablePath: 'fixture', context: { storageState: async () => ({ cookies: [], origins: [] }) } };
  const options = { root, install: async () => ({ runtimeCommand: ['fixture'], tunnelBinary: 'fixture' }),
    createDaemon: settings => ({ health: async () => healthy, start: async credentials => { events.push('start'); assert.equal(credentials.tunnelId, 'fixture'); healthy = true; },
      stop: async () => { healthy = false; }, settings }),
    provision: async (context, { ensureTunnelRunning, saveSecret, profileId }) => {
      assert.equal(context, account.context);
      assert.equal(profileId, account.profile);
      await saveSecret(Buffer.from('fixture-secret'));
      const result = { tunnelId: 'fixture', runtimeKey: 'fixture-secret', connectorId: 'connector', linkId: 'link' };
      await ensureTunnelRunning(result);
      events.push('connector');
      return result;
    } };
  const [one, two] = await Promise.all([ensureNative(account, options), ensureNative(account, options)]);
  assert.equal(one, two);
  assert.deepEqual(events, ['start', 'connector', 'start']);
  assert.equal(one.settings.appName, 'Codex Magpie fixture-');
  assert.equal(await readFile(join(root, 'accounts', account.profile, 'runtime.key'), 'utf8'), 'fixture-secret');
  await stopNative();
  events.length = 0;
  await ensureNative(account, { ...options, provision: undefined, resumeOnly: true });
  assert.deepEqual(events, ['start']);
  assert.equal(await ensureNative({ ...account, profile: 'absent' }, { ...options, resumeOnly: true }), null);
});

test('failed provisioning stops the provisional daemon and does not enable native mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-account-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stopped = false;
  const account = { profile: 'fixture', chromeExecutablePath: 'fixture', context: { storageState: async () => ({}) } };
  await assert.rejects(ensureNative(account, { root, install: async () => ({}), createDaemon: () => ({ start() {}, async stop() { stopped = true; } }),
    provision: async () => { throw new Error('fixture'); } }));
  assert.equal(stopped, true);
  await assert.rejects(readFile(join(root, 'accounts/fixture/native.json')), { code: 'ENOENT' });
});

for (const enabled of [true, false]) test(`sign-in native-tools=${enabled} is non-fatal and logs no secrets`, async t => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'native-auth-'));
  t.after(() => rm(profileRoot, { recursive: true, force: true }));
  const logs = [];
  let count = 0;
  const hooks = _internal.createHooks({ profileRoot,
    bridge: { call: async command => command.method === 'loginStatus' ? { state: 'signed-in', credential: auth } : {} },
    native: { provision: async () => { count++; throw new Error('secret-bearing-error'); } },
    input: { magpie: { option: () => enabled }, client: { app: { log: async value => logs.push(value) } } } });
  assert.equal(hooks.auth.options.find(option => option.key === 'native-tools').default, true);
  assert.equal((await (await hooks.auth.methods[0].authorize()).callback()).type, 'success');
  assert.equal(count, Number(enabled));
  assert.equal(JSON.stringify(logs).includes('secret-bearing-error'), false);
});

test('native catalogue aligns 1-to-1 with text models (18 + 18 = 36) and maps efforts to daemon routes', async () => {
  const rawCatalogue = {
    models: [
      { slug: 'gpt-5-6', title: 'GPT-5.6 Sol', enabled_tools: ['image_gen_tool_enabled'] },
      { slug: 'gpt-6', title: 'GPT-6' },
      { slug: 'gpt-5.6-sol-wm', title: 'GPT-5.6 Sol' },
      { slug: 'gpt-6-sol-wm', title: 'GPT-6 Sol' },
      { slug: 'gpt-6-luna-wm', title: 'GPT-6 Luna' },
      { slug: 'gpt-6.1-sol-wm', title: 'GPT-6.1 Sol' },
      { slug: 'gpt-5.6-terra-wm', title: 'GPT-5.6 Terra' },
      { slug: 'gpt-5.6-luna-wm', title: 'GPT-5.6 Luna' },
      { slug: 'gpt-6-astra-wm', title: 'GPT-6 Astra' },
      { slug: 'gpt-6.1-terra-wm', title: 'GPT-6.1 Terra' },
      { slug: 'gpt-5-6-mini', title: 'GPT-5.6 Luna' },
      { slug: 'gpt-5-6-t-mini', title: 'GPT-5.6 Luna Thinking' },
      { slug: 'gpt-6-t-mini', title: 'GPT-6 Thinking' },
      { slug: 'gpt-6-mini', title: 'GPT-6' },
      { slug: 'research', title: 'Deep Research' },
      { slug: 'chatgpt_alpha_model_external_access_reserved_gate_13', title: 'Gate 13' },
      { slug: 'chatgpt_alpha_model_external_access_reserved_gate_12', title: 'Gate 12' },
    ],
  };
  const bridge = {
    call: async command => command.method === 'models'
      ? rawCatalogue
      : { port: 12345, controlToken: 'tok', capabilities: { solAvailable: true, proAvailable: true, extraHighAvailable: true } },
  };
  const client = nativeClient({ bridge, profileRoot: 'fixture' });
  const hooks = _internal.createHooks({ bridge, native: client });
  const allModels = await hooks.provider.models({}, { auth });
  const keys = Object.keys(allModels);
  const nativeKeys = keys.filter(key => key.startsWith(`native/${auth.profile}/`));
  const textKeys = keys.filter(key => !key.startsWith('native/'));
  assert.equal(textKeys.length, 18);
  assert.equal(nativeKeys.length, 18);
  assert.equal(keys.length, 36);
  assert.deepEqual(nativeKeys.map(key => key.slice(`native/${auth.profile}/`.length)), textKeys);
  assert.deepEqual(Object.keys(allModels[`native/${auth.profile}/gpt-6`].variants), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(Object.keys(allModels[`native/${auth.profile}/gpt-6.1-sol-wm`].variants), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(nativeRoute(`native/${auth.profile}/gpt-6`, 'low'), {
    profile: auth.profile, slug: 'gpt-6', model: 'chatgpt-web/gpt-6-sol-instant', daemonSupported: true, effort: 'low',
  });
  assert.deepEqual(nativeRoute(`native/${auth.profile}/gpt-6`, 'xhigh'), {
    profile: auth.profile, slug: 'gpt-6', model: 'chatgpt-web/gpt-6-sol', daemonSupported: true, effort: 'xhigh',
  });
  assert.deepEqual(nativeRoute(`native/${auth.profile}/gpt-6`, 'max'), {
    profile: auth.profile, slug: 'gpt-6', model: 'chatgpt-web/gpt-6-pro', daemonSupported: true, effort: 'max',
  });
  assert.deepEqual(nativeRoute(`native/${auth.profile}/gpt-6.1-sol-wm`, 'ultra'), {
    profile: auth.profile, slug: 'gpt-6.1-sol-wm', model: 'chatgpt-web/gpt-6-pro', daemonSupported: true, effort: 'max',
  });
  assert.equal(nativeRoute(`native/${auth.profile}/chatgpt-image`).daemonSupported, false);
});
