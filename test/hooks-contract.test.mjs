import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/index.mjs';
import { BackendError } from '../src/bridge.mjs';

const auth = { type: 'oauth', refresh: 'fixture', profile: 'fixture' };
const hooksFor = bridge => _internal.createHooks({ bridge, profileRoot: '.', pollMilliseconds: 0 });

test('config starts empty and preserves user configuration', async () => {
  const hooks = hooksFor({});
  const config = {};
  await hooks.config(config);
  assert.deepEqual(config.provider['chatgpt-web'].models, {});
  assert.equal(config.provider['chatgpt-web'].api, 'https://chatgpt.com/backend-api');
  assert.equal(config.provider['chatgpt-web'].npm, '@ai-sdk/anthropic');
  const custom = { models: { custom: {} } };
  config.provider['chatgpt-web'] = custom;
  await hooks.config(config);
  assert.equal(config.provider['chatgpt-web'], custom);
});

for (const result of [{ models: [] }, { models: [{ title: 'No slug' }] }, new BackendError('upstream')]) {
  test(`catalogue fallback preserves prior models: ${JSON.stringify(result)}`, async () => {
    const prior = { saved: { name: 'Saved' } };
    const hooks = hooksFor({ call: async () => { if (result instanceof Error) throw result; return result; } });
    const models = await hooks.provider.models({ models: prior }, { auth });
    assert.equal(models[Symbol.for('magpie.fellBack')], true);
    assert.deepEqual(Object.keys(models), ['saved']);
  });
}

for (const state of ['signed-in', 'cancelled', 'failed', 'timeout']) {
  test(`authorize maps ${state} and always cleans up`, async () => {
    const commands = [];
    const hooks = hooksFor({ call: async command => {
      commands.push(command);
      return command.method === 'loginStatus' ? { state, credential: auth, reason: 'Fixture failure' } : { ok: true };
    } });
    const flow = await hooks.auth.methods[0].authorize();
    assert.equal(flow.url, '');
    assert.equal(flow.method, 'auto');
    assert.match(flow.instructions, /including any verification/);
    const result = await flow.callback();
    assert.equal(result.type, state === 'signed-in' ? 'success' : 'failed');
    if (state === 'timeout') { assert.ok(result.error instanceof Error); assert.equal(result.error.toJSON().values.windowMinutes, '5'); assert.equal(result.error.code, 'signinTimeout'); assert.match(result.error.message, /within 5 minutes.*Start sign-in again/); }
    if (state === 'failed') assert.equal(result.error, 'Fixture failure');
    if (state === 'cancelled') assert.match(result.error, /window was closed/);
    assert.deepEqual(commands.map(command => command.method), ['login', 'loginStatus', 'logout']);
  });
}

test('chat headers merge only a nonempty matching session', async () => {
  const hook = hooksFor({})['chat.headers'];
  const output = { headers: { existing: 'kept' } };
  await hook({ sessionID: 'session', model: { providerID: 'other' } }, output);
  await hook({ sessionID: '', model: { providerID: 'chatgpt-web' } }, output);
  assert.deepEqual(output.headers, { existing: 'kept' });
  await hook({ sessionID: 'session', model: { providerID: 'chatgpt-web' } }, output);
  assert.deepEqual(output.headers, { existing: 'kept', 'x-chatgptweb-conversation': 'session' });
});

test('cached loader reads current auth, live option and merged headers on each fetch', async () => {
  let current = auth, visible = false;
  const commands = [];
  const logs = [];
  const hooks = _internal.createHooks({ profileRoot: '.', input: { magpie: { option: (provider, key) => {
    assert.equal(provider, 'chatgpt-web'); assert.equal(key, 'visible-turns'); return visible;
  } }, client: { app: { log: async value => logs.push(value) } } }, bridge: { async open(command) {
    commands.push(command);
    const source = (async function* () { yield { type: 'delta', index: 0, text: 'answer' }; yield { type: 'finish', reason: 'complete' }; })();
    source.metadata = { route: 'dom', degraded: 'clone-unavailable' };
    source.close = () => {};
    return source;
  } } });
  assert.equal(hooks.auth.options[0].default, false);
  const loader = await hooks.auth.loader(async () => current);
  for (const stream of [true, false]) {
    const output = { headers: { unrelated: 'private' } };
    await hooks['chat.headers']({ model: { providerID: 'chatgpt-web' }, sessionID: 'session' }, output);
    const response = await loader.fetch('https://chatgpt.com/backend-api/messages', { headers: output.headers, body: JSON.stringify({ model: 'auto', stream, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }] }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-chatgptweb-route'), 'dom');
    assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
    assert.match(await response.text(), /answer/);
    assert.equal(commands.at(-1).auth, current);
    assert.equal(commands.at(-1).visibleTurns, visible);
    assert.equal(commands.at(-1).images.length, 1);
    assert.equal(commands.at(-1).conversationKey.length, 64);
    assert.equal(JSON.stringify(commands.at(-1)).includes('private'), false);
    current = { ...auth, refresh: 'rotated' }; visible = true;
  }
  assert.equal(logs.length, 2);
  assert.deepEqual(await hooks.auth.loader(async () => null), {});
});

for (const stream of [true, false]) {
  test('normalized cooldown keeps retry-after for stream=' + stream, async () => {
    const hooks = hooksFor({ async open() {
      const source = (async function* () { yield { type: 'error', code: 'cooldown', message: 'The account is cooling down after a rate limit.', retryAfter: 120 }; })();
      source.close = () => {};
      return source;
    } });
    const loader = await hooks.auth.loader(async () => auth);
    const response = await loader.fetch('https://chatgpt.com/backend-api/messages', { body: JSON.stringify({ model: 'auto', stream, messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '120');
    assert.equal((await response.json()).error.retryAfter, '120');
  });
}

test('login polling errors still clean up and timeout is readable by the host', async () => {
  const calls = [];
  const hooks = hooksFor({ call: async command => {
    calls.push(command.method);
    if (command.method === 'loginStatus') throw new BackendError('upstream');
    return { ok: true };
  } });
  const flow = await hooks.auth.methods[0].authorize();
  await assert.rejects(flow.callback(), { code: 'upstream' });
  assert.equal(calls.at(-1), 'logout');
});

test('_internal keeps the pinned callable surface', () => {
  assert.deepEqual(Object.keys(_internal).sort(), ['createHooks', 'describeCatalogue', 'makeLoader', 'mapModels']);
  assert.equal(_internal.mapModels, _internal.describeCatalogue);
});
