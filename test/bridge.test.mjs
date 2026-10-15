import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const module = await import('../src/bridge.mjs');
import { spawn } from 'node:child_process';
import { prepare } from '../src/wire/prepare.mjs';

test('maximum legal images cross bridge and backend command limits', async t => {
  const backendURL = new URL('../backend/main.mjs', import.meta.url).href;
  const script = `import { serve } from ${JSON.stringify(backendURL)}; await serve(process.stdin, process.stdout, { handlers: { complete: async (command, signal, emit) => { await emit({ type: 'delta', index: 0, text: String(command.images.reduce((sum, image) => sum + image.bytes, 0)) }); await emit({ type: 'finish', reason: 'complete' }); return { route: 'dom' }; } } });`;
  const bridge = new module.Bridge({ spawnProcess: (executable, args, options) => spawn(executable, ['--input-type=module', '-e', script], options) });
  t.after(() => bridge.dispose());
  const data = Buffer.alloc(10 << 20).toString('base64');
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: Array.from({ length: 4 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })) }] });
  const stream = await bridge.open({ method: 'complete', ...prepared });
  const frames = [];
  for await (const frame of stream) frames.push(frame);
  assert.equal(frames[0].text, String(40 << 20));
  assert.equal(stream.metadata.route, 'dom');
  await assert.rejects(bridge.open({ method: 'complete', padding: 'x'.repeat(64 << 20) }), error => error.code === 'protocol');
});

test('real backend preserves account cooldown across ancillary-cookie changes', async t => {
  let count = 0;
  const server = createServer((request, response) => { count++; response.writeHead(429, { 'retry-after': '60' }); response.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = new module.Bridge({ backend: fileURLToPath(new URL('./fixture-backend.mjs', import.meta.url)) });
  t.after(async () => { await bridge.dispose(); server.close(); });
  const session = randomUUID();
  for (const ancillary of ['first', 'second']) {
    await assert.rejects(bridge.call({ method: 'models', origin: `http://127.0.0.1:${server.address().port}`, auth: { refresh: `__Secure-next-auth.session-token=${session}; ancillary=${ancillary}` } }), error => error.status === 429);
  }
  assert.equal(count, 1);
});
test('real child handshakes and correlates concurrent status calls', async t => {
  try { await import('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts.');
    return;
  }
  assert.equal(typeof module.Bridge, 'function', 'Bridge must launch the backend');
  const bridge = new module.Bridge();
  t.after(() => bridge.dispose());
  const results = await Promise.all(['first', 'second'].map(account => bridge.call({ method: 'loginStatus', account })));
  assert.deepEqual(results, [{ state: 'cancelled' }, { state: 'cancelled' }]);
});

test('production child rejects fixture origins before contacting a local server', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch { t.skip('playwright-core is not installed; run npm ci --ignore-scripts.'); return; }
  let hits = 0;
  const server = createServer((request, response) => { hits++; response.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = new module.Bridge();
  t.after(async () => { await bridge.dispose(); server.close(); });
  await assert.rejects(bridge.call({ method: 'models', origin: 'http://127.0.0.1:' + server.address().port, auth: { refresh: randomUUID() } }), error => error.code === 'protocol');
  assert.equal(hits, 0);
});
