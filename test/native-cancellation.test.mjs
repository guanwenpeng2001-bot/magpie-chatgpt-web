import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeClient } from '../src/native/index.mjs';
import { makeLoader } from '../src/loader.mjs';

const auth = { type: 'oauth', refresh: 'fixture', profile: 'cancel-fixture' };

test('native runtime lookup passes caller cancellation to the backend RPC', async () => {
  const controller = new AbortController();
  const client = nativeClient({ profileRoot: 'fixture', bridge: {
    async call(command, signal) {
      assert.equal(command.method, 'nativeRuntime');
      assert.equal(signal, controller.signal);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  } });
  const pending = client.runtime(auth, controller.signal);
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
});

for (const outcome of ['returned', 'rejected']) {
  test(`cancellation during a ${outcome} runtime lookup never falls through to text`, async () => {
    const controller = new AbortController();
    let received;
    let textCalls = 0;
    const loader = await makeLoader({
      bridge: { open() { textCalls++; throw new Error('unexpected text submission'); } },
      native: { async runtime(_auth, signal) {
        received = signal;
        controller.abort();
        if (outcome === 'rejected') throw controller.signal.reason;
        return null;
      } },
    })(async () => auth);
    const response = await loader.fetch('http://127.0.0.1:1/v1/responses', {
      body: JSON.stringify({ model: 'native/cancel-fixture/gpt-6-sol', input: 'hello' }),
      signal: controller.signal,
    });
    assert.equal(received, controller.signal);
    assert.equal(textCalls, 0);
    assert.equal(response.ok, false);
  });
}
