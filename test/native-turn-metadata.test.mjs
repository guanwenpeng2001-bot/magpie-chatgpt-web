import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonProxy } from '../src/native/daemon.mjs';
import { compactionProxy } from '../src/native/compaction.mjs';
import { normalizeNativeTurnMetadata } from '../src/native/turn-metadata.mjs';
import { prepare, mark, complete } from '../src/native/provenance.mjs';
import { makeLoader } from '../src/loader.mjs';

const key = 'x-codex-turn-metadata';
const metadata = { thread_id: 'private-thread', turn_id: 'private-turn',
  request_kind: 'turn', sandbox_mode: 'danger-full-access', agent_name: '/root/测试😀' };
const headerValue = JSON.stringify({ ...metadata, agent_name: '/root' });
const factories = {
  responses: fetch => daemonProxy({ port: 12345, controlToken: 'local-secret' }, fetch).responses,
  compact: fetch => compactionProxy({ port: 12345, controlToken: 'local-secret' }, fetch),
};

for (const [route, factory] of Object.entries(factories)) {
  for (const representation of ['header-only', 'string', 'object', 'null', 'malformed', 'missing']) {
    test(`${route}: ${representation} metadata uses the same non-mutating precedence`, async t => {
      const logs = [];
      t.mock.method(console, 'info', line => logs.push(line));
      const value = representation === 'string' ? JSON.stringify(metadata)
        : representation === 'object' ? metadata : representation === 'null' ? null
          : representation === 'malformed' ? '{private-invalid-json' : undefined;
      const body = { model: 'chatgpt-web/gpt-6-pro', input: [],
        client_metadata: { extra: 'private-extra', ...(value === undefined ? {} : { [key]: value }) } };
      const original = structuredClone(body);
      Object.freeze(body.client_metadata);
      Object.freeze(body);
      const headers = new Headers({ cookie: 'private-cookie', authorization: 'private-bearer',
        'x-codex-beta-features': 'fixture', ...(representation === 'missing' ? {} : { [key]: headerValue }) });
      const originalHeaders = [...headers];
      const signal = new AbortController().signal;
      let calls = 0;
      const proxy = factory(async (url, options) => {
        calls++;
        assert.equal(new URL(url).pathname, route === 'responses' ? '/v1/responses' : '/v1/responses/compact');
        assert.equal(options.signal, signal);
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.get('authorization'), 'Bearer local-secret');
        assert.equal(options.headers.get('cookie'), null);
        assert.equal(options.headers.get('x-codex-beta-features'), 'fixture');
        const sent = JSON.parse(options.body);
        const expected = representation === 'header-only' ? headerValue : value;
        assert.deepEqual(sent.client_metadata[key], expected);
        assert.equal(sent.client_metadata.extra, 'private-extra');
        if (representation === 'object' || representation === 'string') {
          assert.deepEqual(JSON.parse(options.headers.get(key)), metadata);
          assert.match(options.headers.get(key), /^[\x20-\x7e]+$/);
        } else assert.equal(options.headers.get(key), expected === undefined ? null : typeof expected === 'string' ? expected : JSON.stringify(expected));
        return Response.json({});
      });
      await proxy(body, headers, signal);
      assert.equal(calls, 1);
      assert.deepEqual(body, original);
      assert.deepEqual([...headers], originalHeaders);
      assert.equal(logs.length, 1);
      const diagnostic = JSON.parse(logs[0].slice('[chatgpt-web] native_turn_metadata '.length));
      assert.equal(diagnostic.recovery, representation === 'header-only' ? 'header_to_body'
        : representation === 'missing' ? 'missing' : 'body_authoritative');
      assert.deepEqual(Object.keys(diagnostic).sort(), ['recovery', 'bodyMetadataPresent', 'headerMetadataPresent',
        'threadIdPresent', 'turnIdPresent', 'requestKindPresent', 'sandboxModePresent', 'sandboxPresent'].sort());
      for (const [name, field] of Object.entries(diagnostic)) if (name !== 'recovery') assert.equal(typeof field, 'boolean');
      assert.doesNotMatch(logs[0], /private-|local-secret|测试|😀/);
    });
  }
}

test('ordinary loader restores provenance then fills header-only identity before the daemon parser', async t => {
  t.mock.method(console, 'info', () => {});
  const turn = 'fixture-turn';
  const request = { model: 'chatgpt-web/native/account-a/gpt-6-pro', input: [
    { type: 'message', role: 'user', id: 'fixture-user', content: [{ type: 'input_text', text: 'private-prompt' }],
      internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['user.text'] } },
  ], client_metadata: { extra: 'keep' } };
  const canonicalInput = structuredClone(request.input);
  const ctx = { protocol: 'responses', origin: 'local', state: {} };
  prepare(request, ctx);
  t.after(() => complete(ctx.state.webGptNonce));
  request.model = 'native/account-a/gpt-6-pro';
  mark(request, { provider: { id: 'chatgpt-web', model: request.model } });
  request.input[0].content = [];
  delete request.input[0].internal_chat_message_metadata_passthrough;
  const expected = { thread_id: 'fixture-thread', turn_id: turn, request_kind: 'turn', sandbox_mode: 'danger-full-access' };
  let calls = 0;
  const proxy = daemonProxy({ port: 12345, controlToken: 'local' }, async (_url, options) => {
    calls++;
    const sent = JSON.parse(options.body);
    // Native Fl()/ue() read this body field, not the HTTP header.
    assert.deepEqual(JSON.parse(sent.client_metadata[key]), expected);
    assert.deepEqual(sent.input, canonicalInput);
    assert.equal(sent.model, 'chatgpt-web/gpt-6-pro');
    return Response.json({ id: 'fixture-response', output: [] });
  });
  const loader = await makeLoader({ native: { runtime: async () => ({ ...proxy, health: async () => true }) },
    bridge: { open() { assert.fail('must not fall back to text'); } } })(
    async () => ({ type: 'oauth', refresh: 'fixture', profile: 'account-a' }));
  const response = await loader.fetch('http://localhost/v1/responses', {
    body: JSON.stringify(request), headers: { [key]: JSON.stringify(expected) },
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls, 1);
});

test('diagnostic failure cannot change forwarding and missing metadata is never manufactured', t => {
  t.mock.method(console, 'info', () => { throw new Error('logging failed'); });
  const body = { input: [{ type: 'message', role: 'user', content: '<cwd>untrusted-history</cwd>' }] };
  const result = normalizeNativeTurnMetadata(body, {});
  assert.equal(result.body, body);
  assert.equal(result.body.client_metadata, undefined);
  assert.equal(result.headers.has(key), false);
});
