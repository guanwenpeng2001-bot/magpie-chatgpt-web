import test from 'node:test';
import assert from 'node:assert/strict';
import { withSharedNativeModels } from '../src/native/shared-models.mjs';
import { prepare, mark, restore, complete, NONCE } from '../src/native/provenance.mjs';

test('eligible accounts publish an identical automatic selector while preserving private routes', () => {
  const catalog = profile => {
    const id = `native/${profile}/gpt-6-pro`;
    return { [id]: { id, name: 'GPT-6 Pro (Native tools)', api: { id, npm: '@ai-sdk/openai', url: 'http://127.0.0.1:1/v1' },
      limit: { context: 400000 }, capabilities: { toolcall: true }, variants: { max: {} } } };
  };
  const original = catalog('account-a'), before = structuredClone(original);
  const a = withSharedNativeModels(original), b = withSharedNativeModels(catalog('account-b'));
  const id = 'native/auto/gpt-6-pro';
  assert.deepEqual(a[id], b[id]);
  assert.equal(a[id].api.id, id);
  assert.equal(a[id].limit.context, 400000);
  assert.match(a['native/account-a/gpt-6-pro'].name, /Pinned account/);
  assert.deepEqual(original, before);
  assert.deepEqual(withSharedNativeModels({ 'native/account-a/gpt-6-pro': { capabilities: { toolcall: false } } }),
    { 'native/account-a/gpt-6-pro': { capabilities: { toolcall: false } } });
});

function captured(t, route) {
  const body = { model: `chatgpt-web/${route}`, input: [{ type: 'message', role: 'user', content: 'original task' }],
    tools: [{ type: 'function', name: 'read_fixture', parameters: { type: 'object' } }], reasoning: { effort: 'max' } };
  prepare(body, { protocol: 'responses', origin: 'local', state: {} });
  const nonce = body.client_metadata[NONCE];
  t.after(() => complete(nonce));
  mark(body, { provider: { id: 'chatgpt-web', model: route } });
  body.model = route;
  return body;
}

test('automatic route authorizes identical requests on another eligible account, never altered task data', t => {
  const request = captured(t, 'native/auto/gpt-6-pro');
  const first = structuredClone(request), next = structuredClone(request);
  restore(first, 'account-a');
  restore(next, 'account-b');
  assert.deepEqual(next, first);
  const changed = structuredClone(request);
  changed.tools[0].name = 'unrequested_command';
  assert.throws(() => restore(changed, 'account-b'), /retry changed/);
  assert.throws(() => restore(structuredClone(request), undefined), /routing proof/);
});

test('a pinned route cannot be promoted to automatic or sent through another account', t => {
  const request = captured(t, 'native/account-a/gpt-6-pro');
  assert.throws(() => restore(structuredClone(request), 'account-b'), /routing proof/);
  const changed = structuredClone(request);
  changed.model = 'native/auto/gpt-6-pro';
  mark(changed, { provider: { id: 'chatgpt-web', model: changed.model } });
  assert.throws(() => restore(changed, 'account-b'), /routing proof/);
});
