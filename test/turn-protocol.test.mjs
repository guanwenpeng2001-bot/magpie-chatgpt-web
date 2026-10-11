import test from 'node:test';
import assert from 'node:assert/strict';

const protocol = await import('../src/protocol.mjs').catch(() => ({}));
const message = (text = '') => ({ event: 'delta', data: { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: [text] }, status: 'in_progress' } } } });
const append = text => ({ event: 'delta', data: { o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: text }, { p: '/message/metadata/model_dil_v2/constants', o: 'append', v: 'must not escape' }] } });

test('translation releases each answer batch before the next upstream batch exists', async () => {
  assert.equal(typeof protocol.translate, 'function', 'incremental Anthropic translation must exist');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  async function* source() {
    yield message();
    yield append('First batch. ');
    await gate;
    yield { event: 'delta', data: { v: [{ p: '/message/content/parts/0', o: 'append', v: 'Second batch.' }] } };
    yield { event: '', data: { type: 'message_stream_complete' } };
  }
  const output = protocol.translate(source(), { model: 'auto', prompt: 'fixture' });
  const chunks = [];
  try {
    for (;;) {
      const next = await Promise.race([output.next(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('first delta was buffered behind upstream completion')), 1000); timer.unref(); })]);
      chunks.push(next.value);
      if (next.value.includes('First batch. ')) break;
    }
  } finally { release(); }
  for await (const chunk of output) chunks.push(chunk);
  const events = chunks.map(chunk => JSON.parse(chunk.split('\ndata: ')[1]));
  assert.deepEqual(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text), ['First batch. ', 'Second batch.']);
  assert.deepEqual(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(chunks.join('').includes('must not escape'), false);
});

for (const [label, frames, code] of [
  ['truncated', [message('partial')], 'truncated'],
  ['empty', [message(), { event: '', data: '[DONE]' }], 'empty'],
  ['changed vocabulary', [{ event: 'new_encoding', data: {} }], 'protocol'],
  ['hidden', [{ event: 'delta', data: { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, metadata: { is_visually_hidden_from_conversation: true } } } } }], 'hidden'],
]) test(`${label} never emits a successful terminal`, async () => {
  const output = [];
  await assert.rejects(async () => { for await (const chunk of protocol.translate(frames, { model: 'auto', prompt: '' })) output.push(chunk); }, error => error.code === code);
  assert.equal(output.join('').includes('event: message_stop'), false);
});

test('prepare preserves text history and prefers caller conversation identity', () => {
  const request = { model: 'auto', system: [{ type: 'text', text: 'Be concise' }], messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, { role: 'user', content: 'three' }], conversation_id: 'caller' };
  const prepared = protocol.prepare(request, { 'x-chatgptweb-conversation': 'host-session' });
  assert.equal(prepared.conversationKey, 'caller');
  assert.equal(prepared.prompt, '[System]\nBe concise\n\n[Human]\none\n\n[Assistant]\ntwo\n\n[Human]\nthree');
  delete request.conversation_id;
  assert.match(protocol.prepare(request, { 'x-chatgptweb-conversation': 'host-session' }).conversationKey, /^[a-f0-9]{64}$/);
  assert.equal(protocol.prepare(request).conversationKey, undefined);
  assert.throws(() => protocol.prepare({ ...request, tools: [{}] }), error => error.code === 'unsupported');
});
