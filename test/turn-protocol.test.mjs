import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, reconstruct } from '../src/wire/translate.mjs';
import { parseSSE } from '../src/wire/sse.mjs';
import { handoffFrames } from '../integrations/turn-fixture.mjs';

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
  const events = chunks.map(chunk => JSON.parse(parseSSE(chunk).events[0].data));
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

const handoff = { event: '', data: { type: 'stream_handoff', conversation_id: '6acd141c-6b40-83e9-a915-fbdf180e0a3d', turn_exchange_id: '24373ad2-694f-4cfe-bebb-d25be8bcef56', options: [{ type: 'resume_sse_endpoint', topic_id: 'conversation-turn-24373ad2-694f-4cfe-bebb-d25be8bcef56' }, { type: 'subscribe_ws_topic', topic_id: 'conversation-turn-24373ad2-694f-4cfe-bebb-d25be8bcef56' }] } };

test('stream handoff leaves the answer open for DOM continuation', () => {
  const answer = new protocol.AnswerStream();
  assert.doesNotThrow(() => assert.equal(answer.accept(handoff), ''));
  assert.equal(answer.complete, false);
  assert.throws(() => answer.finish(), { code: 'truncated' });
  assert.equal(answer.accept({ event: 'dom', data: { text: 'pong', complete: true } }), 'pong');
  assert.doesNotThrow(() => answer.finish());
});

test('handoff without a DOM answer never emits a successful terminal', async () => {
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of protocol.translate([handoff], { model: 'auto', prompt: '' })) chunks.push(chunk);
  }, { code: 'truncated' });
  assert.equal(chunks.join('').includes('event: message_stop'), false);
});

test('eight-frame handoff routing fixture never sets answer text or completes', () => {
  const answer = new protocol.AnswerStream();
  assert.equal(handoffFrames.length, 8);
  assert.deepEqual(handoffFrames.at(-1), handoff);
  for (const [index, frame] of handoffFrames.entries()) {
    assert.doesNotThrow(() => assert.equal(answer.accept(frame), ''), `frame ${index + 1}`);
    assert.equal(answer.text, '', `frame ${index + 1} must not produce assistant text`);
    assert.equal(answer.complete, false, `frame ${index + 1} must not complete`);
  }
});

test('an unrelated unnamed frame type still fails with protocol', () => {
  assert.throws(() => new protocol.AnswerStream().accept({ event: '', data: { type: 'unknown_handoff' } }), { code: 'protocol' });
});

const midAdd = messageBody => ({ event: 'delta', data: { p: '', o: 'add', v: { message: messageBody } } });
const toolCall = { author: { role: 'assistant' }, recipient: 'web.run', channel: 'commentary', content: { content_type: 'text', parts: ['tool use'] }, status: 'finished_successfully' };
const toolResult = { author: { role: 'tool' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: ['tool output'] }, status: 'finished_successfully' };
const commentary = { author: { role: 'assistant' }, recipient: 'all', channel: 'commentary', content: { content_type: 'text', parts: ['thinking...'] }, status: 'in_progress' };
const userMessage = { author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['a user note'] }, status: 'finished_successfully' };
const finishAnswer = [{ event: 'delta', data: { o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] } }, { event: '', data: '[DONE]' }];

for (const [label, intruder] of [['tool call', toolCall], ['tool result', toolResult], ['commentary thoughts', commentary], ['user message', userMessage]]) test(`a mid-answer ${label} message-add does not truncate the answer`, async () => {
  const frames = [message(), append('First half. '), midAdd(intruder), append('Second half.'), ...finishAnswer];
  const chunks = [];
  for await (const chunk of protocol.translate(frames, { model: 'auto', prompt: '' })) chunks.push(chunk);
  const deltas = chunks.map(chunk => JSON.parse(parseSSE(chunk).events[0].data)).filter(event => event.type === 'content_block_delta').map(event => event.delta.text);
  assert.deepEqual(deltas, ['First half. ', 'Second half.']);
  assert.equal(chunks.join('').includes('event: message_stop'), true);
});

test('a truncated answer after a mid-answer message-add never emits a successful terminal', async () => {
  const frames = [message(), append('First half. '), midAdd(userMessage), append('Second half.')];
  const output = [];
  await assert.rejects(async () => { for await (const chunk of protocol.translate(frames, { model: 'auto', prompt: '' })) output.push(chunk); }, error => error.code === 'truncated');
  assert.equal(output.join('').includes('event: message_stop'), false);
});

test('a second visible assistant message-add after answer text exists fails closed', async () => {
  const frames = [message(), append('First half. '), message('Second answer'), append(' more')];
  const output = [];
  await assert.rejects(async () => { for await (const chunk of protocol.translate(frames, { model: 'auto', prompt: '' })) output.push(chunk); }, error => error.code === 'protocol');
  assert.equal(output.join('').includes('event: message_stop'), false);
});

test('a repeated visible assistant message-add before answer text exists is harmless', async () => {
  const frames = [message(), message(), append('Only half.'), ...finishAnswer];
  const chunks = [];
  for await (const chunk of protocol.translate(frames, { model: 'auto', prompt: '' })) chunks.push(chunk);
  const deltas = chunks.map(chunk => JSON.parse(parseSSE(chunk).events[0].data)).filter(event => event.type === 'content_block_delta').map(event => event.delta.text);
  assert.deepEqual(deltas, ['Only half.']);
  assert.equal(chunks.join('').includes('event: message_stop'), true);
});

test('prepare preserves text history and hashes host conversation identity', () => {
  const request = { model: 'auto', system: [{ type: 'text', text: 'Be concise' }], messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, { role: 'user', content: 'three' }], conversation_id: 'caller' };
  const prepared = protocol.prepare(request, { 'x-chatgptweb-conversation': 'host-session' });
  assert.match(prepared.conversationKey, /^[a-f0-9]{64}$/);
  assert.equal(prepared.prompt, '[System]\nBe concise\n\n[Human]\none\n\n[Assistant]\ntwo\n\n[Human]\nthree');
  delete request.conversation_id;
  assert.match(protocol.prepare(request, { 'x-chatgptweb-conversation': 'host-session' }).conversationKey, /^[a-f0-9]{64}$/);
  assert.equal(protocol.prepare(request).conversationKey, undefined);
  assert.throws(() => protocol.prepare({ ...request, tools: [{}] }), error => error.code === 'toolDefinition');
});

for (const batches of [['whole answer'], ['whole ', 'answer']]) test(`normalized translation reconstructs ${batches.length} answer batches`, async () => {
  const frames = [...batches.map(text => ({ type: 'delta', index: 0, text })), { type: 'finish', reason: 'complete' }];
  const chunks = [];
  for await (const chunk of translate(frames, { model: 'auto' })) chunks.push(chunk);
  const message = await reconstruct(chunks.join('').split(''));
  assert.deepEqual(message.content, [{ type: 'text', text: 'whole answer' }]);
  assert.equal(message.stop_reason, 'end_turn');
});

for (const type of ['status', 'failure', 'fallback', 'eof', 'answer']) test(`normalized translation rejects ${type} frame`, async () => {
  await assert.rejects(async () => { for await (const chunk of translate([{ type }], { model: 'auto' })) void chunk; }, { code: 'protocol' });
});

test('normalized EOF requires explicit finish and reconstruction rejects trailing bytes', async () => {
  const delta = { type: 'delta', index: 0, text: 'answer' };
  await assert.rejects(reconstruct(translate([delta], { model: 'auto' })), { code: 'truncated' });
  const chunks = [];
  for await (const chunk of translate([delta, { type: 'finish', reason: 'complete' }], { model: 'auto' })) chunks.push(chunk);
  await assert.rejects(reconstruct([...chunks, 'data: tail']), { code: 'truncated' });
  assert.equal(parseSSE(chunks.at(-1)).events[0].event, 'message_stop');
});

test('normalized errors preserve new taxonomy status and actionable message', async () => {
  const message = 'ChatGPT refused the image upload (unsupported format). Retry; if it persists, send the message without the image.';
  await assert.rejects(reconstruct(translate([{ type: 'error', code: 'imageRejected', message }], { model: 'auto' })), error => error.code === 'imageRejected' && error.status === 502 && error.toJSON().message === message);
});

test('whitespace-only normalized answer is empty and never completes successfully', async () => {
  await assert.rejects(reconstruct(translate([{ type: 'delta', index: 0, text: '  ' }, { type: 'finish', reason: 'complete' }], { model: 'auto' })), { code: 'empty' });
});
