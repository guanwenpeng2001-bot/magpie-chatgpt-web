import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const module = await import('../src/bridge.mjs');

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
  assert.equal(typeof module.Bridge, 'function', 'Bridge must launch the backend');
  const bridge = new module.Bridge();
  t.after(() => bridge.dispose());
  const results = await Promise.all(['first', 'second'].map(account => bridge.call({ method: 'loginStatus', account })));
  assert.deepEqual(results, [{ state: 'cancelled' }, { state: 'cancelled' }]);
});

test('production child rejects fixture origins before contacting a local server', async t => {
  let hits = 0;
  const server = createServer((request, response) => { hits++; response.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = new module.Bridge();
  t.after(async () => { await bridge.dispose(); server.close(); });
  await assert.rejects(bridge.call({ method: 'models', origin: 'http://127.0.0.1:' + server.address().port, auth: { refresh: randomUUID() } }), error => error.code === 'protocol');
  assert.equal(hits, 0);
});
