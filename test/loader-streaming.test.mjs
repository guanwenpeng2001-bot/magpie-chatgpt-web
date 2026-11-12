import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLoader } from '../src/loader.mjs';

test('streaming responses emit the first translated frame before the backend finishes', async () => {
  let release;
  let closed = false;
  const finished = new Promise(resolve => { release = resolve; });
  const upstream = {
    metadata: { route: 'dom' },
    async *[Symbol.asyncIterator]() {
      yield { type: 'delta', index: 0, text: 'FIRST_STREAM_FRAME' };
      await finished;
      yield { type: 'finish', reason: 'complete' };
    },
    close() { closed = true; },
  };
  const bridge = { async open() { return upstream; } };
  const load = makeLoader({ bridge, profileRoot: '.' });
  const client = await load(async () => ({ type: 'oauth', refresh: 'fixture-cookie', access: 'fixture-access' }));
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'fixture' }],
    }),
  });
  const reader = response.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 250)),
  ]);
  assert.equal(first.timeout, undefined, 'the response must not wait for the backend to finish');
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /message_start|FIRST_STREAM_FRAME/);

  release();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
  }
  assert.equal(closed, true);
});
