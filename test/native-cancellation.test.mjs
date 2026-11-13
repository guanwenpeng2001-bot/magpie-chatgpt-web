import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeClient } from '../src/native/index.mjs';
import { makeLoader } from '../src/loader.mjs';
import { prepare, complete } from '../src/native/provenance.mjs';
import { onProvider } from '../src/native/middleware.js';

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
  test(`cancellation during a ${outcome} runtime lookup never falls through to text`, async t => {
    const controller = new AbortController();
    // Runtime lookup requires a captured, provider-bound request. An unproven
    // request intentionally bypasses native and cannot exercise this race.
    const model = 'native/cancel-fixture/gpt-6-sol';
    const body = { model: `chatgpt-web/${model}`, input: [{ role: 'user', content: 'hello' }] };
    const context = { protocol: 'responses', origin: 'local', state: {} };
    prepare(body, context);
    t.after(() => complete(context.state.webGptNonce));
    body.model = model;
    onProvider(body, { provider: { id: 'chatgpt-web', model } });
    let received;
    let textCalls = 0;
    let runtimeCalls = 0, healthCalls = 0, nativeCalls = 0;
    const loader = await makeLoader({
      bridge: { open() { textCalls++; throw new Error('unexpected text submission'); } },
      native: { async runtime(_auth, signal) {
        runtimeCalls++;
        received = signal;
        controller.abort();
        if (outcome === 'rejected') throw controller.signal.reason;
        return {
          async health() { healthCalls++; return true; },
          async responses() { nativeCalls++; return Response.json({ output: [] }); },
        };
      } },
    })(async () => auth);
    const response = await loader.fetch('http://127.0.0.1:1/v1/responses', {
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    assert.equal(received, controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.equal(runtimeCalls, 1);
    assert.equal(healthCalls, 0);
    assert.equal(nativeCalls, 0);
    assert.equal(textCalls, 0);
    assert.equal(response.ok, false);
  });
}
