import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from '../backend/conversations.mjs';

const request = { conversationKey: 'caller', model: 'auto', system: '', history: [{ role: 'user', content: 'one' }] };
const continued = { ...request, history: [...request.history, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'two' }] };
const page = () => ({ isClosed: () => false, close: async () => {} });

test('matching history resumes after the completed assistant message', async () => {
  const bindings = new Conversations();
  const first = await bindings.take(request, 'account');
  first.page = page();
  bindings.finish(first, request, 'answer');
  const result = await bindings.take(continued, 'account');
  assert.equal(result.resumeFrom, 2);
  assert.equal(result.entry, first);
  assert.equal(result.entry.resumeIndex, 2);
  assert.equal(result.entry.page, first.page);
  assert.equal(result.entry.busy, true);
});

for (const history of [request.history, [{ role: 'user', content: 'compacted' }], [{ role: 'user', content: 'changed' }, ...continued.history.slice(1)]]) {
  test(`changed or shortened history rebuilds the binding: ${JSON.stringify(history)}`, async () => {
    const bindings = new Conversations();
    const first = await bindings.take(request, 'account');
    let closed = 0;
    first.page = { ...page(), close: async () => { closed++; } };
    bindings.finish(first, request, 'answer');
    const result = await bindings.take({ ...request, history }, 'account');
    assert.notEqual(result.entry, first);
    assert.equal(result.resumeFrom, 0);
    assert.equal(result.entry.page, undefined);
    assert.equal(closed, 1);
    assert.equal(bindings.entries.get('caller'), result.entry);
  });
}

for (const [field, value] of [['account', 'other'], ['model', 'other'], ['system', 'other']]) {
  test(`${field} mismatch rejects without replacing the binding`, async () => {
    const bindings = new Conversations();
    const first = await bindings.take(request, 'account');
    bindings.finish(first, request, 'answer');
    await assert.rejects(bindings.take(field === 'account' ? continued : { ...continued, [field]: value }, field === 'account' ? value : 'account'), { code: 'binding' });
    assert.equal(bindings.entries.get('caller'), first);
  });
}

test('busy bindings reject another take and discard until finish', async () => {
  const bindings = new Conversations();
  const first = await bindings.take(request, 'account');
  await assert.rejects(bindings.take(request, 'account'), { code: 'binding' });
  await assert.rejects(bindings.discard('caller'), { code: 'binding' });
  bindings.finish(first, request, 'answer');
  await bindings.discard('caller');
  assert.equal(bindings.entries.size, 0);
});

for (const closed of [false, true]) {
  test(`missing remote page forces full history (closed=${closed})`, async () => {
    const bindings = new Conversations();
    const first = await bindings.take(request, 'account');
    if (closed) first.page = { ...page(), isClosed: () => true };
    bindings.finish(first, request, 'answer');
    const result = await bindings.take(continued, 'account');
    assert.equal(result.resumeFrom, 0);
    assert.equal(result.entry.resumeIndex, 0);
    assert.equal(result.entry.page, undefined);
  });
}

test('idle expiry closes the page at thirty minutes but leaves busy bindings alone', async () => {
  let now = 0;
  const bindings = new Conversations({ now: () => now });
  const first = await bindings.take(request, 'account');
  let closed = 0;
  first.page = { ...page(), close: async () => { closed++; } };
  now = 1800000;
  await assert.rejects(bindings.take(request, 'account'), { code: 'binding' });
  bindings.finish(first, request, 'answer');
  now += 1799999;
  const resumed = await bindings.take(continued, 'account');
  assert.equal(resumed.entry, first);
  bindings.finish(first, continued, 'second answer');
  now += 1800000;
  const fresh = await bindings.take(continued, 'account');
  assert.notEqual(fresh.entry, first);
  assert.equal(fresh.resumeFrom, 0);
  assert.equal(closed, 1);
});

test('keyless turns stay independent even when all 64 bindings are busy', async () => {
  const bindings = new Conversations();
  for (let index = 0; index < 64; index++) await bindings.take({ ...request, conversationKey: String(index) }, 'account');
  await assert.rejects(bindings.take(request, 'account'), { code: 'capacity' });
  const first = await bindings.take({ ...request, conversationKey: undefined }, 'account');
  const second = await bindings.take({ ...request, conversationKey: undefined }, 'account');
  assert.notEqual(first.entry, second.entry);
  assert.equal(first.resumeFrom, 0);
  assert.equal(bindings.entries.size, 64);
});

test('capacity evicts the least recently used idle binding', async () => {
  let now = 0;
  const bindings = new Conversations({ now: () => now++ });
  let closed = 0;
  for (let index = 0; index < 64; index++) {
    const entry = await bindings.take({ ...request, conversationKey: String(index) }, 'account');
    if (index === 1) entry.page = { ...page(), close: async () => { closed++; } };
    if (index > 0) bindings.finish(entry, request, 'answer');
  }
  await bindings.take(request, 'account');
  assert.equal(bindings.entries.size, 64);
  assert.equal(bindings.entries.has('0'), true);
  assert.equal(bindings.entries.has('1'), false);
  assert.equal(closed, 1);
});

test('replacement is reserved while the old page is still closing', async () => {
  const bindings = new Conversations();
  const first = await bindings.take(request, 'account');
  let releaseClose;
  first.page = { ...page(), close: () => new Promise(resolve => { releaseClose = resolve; }) };
  bindings.finish(first, request, 'answer');
  const pending = bindings.take(request, 'account');
  await assert.rejects(bindings.take(request, 'account'), { code: 'binding' });
  releaseClose();
  const fresh = await pending;
  assert.equal(bindings.entries.get('caller'), fresh.entry);
  await bindings.failed(first);
  assert.equal(bindings.entries.get('caller'), fresh.entry);
});

test('completed history is a snapshot and the compatibility getter is non-enumerable', async () => {
  const bindings = new Conversations();
  const input = structuredClone(request);
  const first = await bindings.take(input, 'account');
  bindings.finish(first, input, 'answer');
  input.history[0].content = 'mutated';
  assert.equal(first.history[0].content, 'one');
  assert.equal(Object.keys(first).includes('entry'), false);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test('failed turns close and remove the binding and allow a fresh retry', async () => {
  const bindings = new Conversations();
  const first = await bindings.take(request, 'account');
  first.page = { ...page(), close: async () => { throw new Error('already gone'); } };
  await bindings.failed(first);
  assert.equal(first.busy, false);
  assert.equal(bindings.entries.size, 0);
  assert.equal('conversationUrl' in first, false);
  const retry = await bindings.take(request, 'account');
  assert.notEqual(retry.entry, first);
  assert.equal(retry.resumeFrom, 0);
});
