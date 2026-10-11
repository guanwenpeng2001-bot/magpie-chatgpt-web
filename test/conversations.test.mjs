import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../backend/conversations.mjs').catch(() => ({}));

test('conversation binding continues, rejects replay and rebuilds after idle expiry', async () => {
  assert.equal(typeof module.Conversations, 'function', 'conversation bindings must exist');
  let now = 0;
  const bindings = new module.Conversations({ now: () => now });
  const request = { conversationKey: 'caller', model: 'auto', system: '', history: [{ role: 'user', content: 'one' }] };
  const first = await bindings.take(request, 'account');
  const page = { isClosed: () => false, close: async () => {} };
  first.page = page;
  bindings.finish(first, request, 'answer');
  await assert.rejects(bindings.take(request, 'account'), error => error.code === 'binding');
  const next = { ...request, history: [...request.history, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'two' }] };
  assert.equal((await bindings.take(next, 'account')).page, page);
  await assert.rejects(bindings.take(next, 'different'), error => error.code === 'binding');
  now += 1800001;
  assert.equal((await bindings.take(next, 'account')).page, undefined);
});
