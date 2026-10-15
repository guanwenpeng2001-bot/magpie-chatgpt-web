import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/protocol.mjs';

const image = (data = 'aGk=') => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const request = content => ({ model: 'auto', messages: [{ role: 'user', content }], stream: false });

test('prepare accepts image blocks and records decoded size before dispatch', () => {
  const prepared = prepare(request([{ type: 'text', text: 'Describe' }, image()]));
  assert.deepEqual(prepared.images, [{ mediaType: 'image/png', dataBase64: 'aGk=', bytes: 2 }]);
  assert.equal(prepared.stream, false);
  assert.equal(prepared.history[0].content.includes('aGk='), false);
});

for (const [name, content] of [
  ['document', [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aGk=' } }]],
  ['image count', Array.from({ length: 5 }, () => image())],
  ['image bytes', [image(Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'))]],
  ['invalid base64', [image('!invalid!')]],
  ['non-image media', [{ ...image(), source: { ...image().source, media_type: 'application/pdf' } }]],
]) test(`prepare rejects ${name} with attachmentUnsupported`, () => {
  assert.throws(() => prepare(request(content)), error => error.code === 'attachmentUnsupported' && error.status === 400);
});

test('conversation key derives only from the host header', () => {
  const prepared = prepare({ ...request('hello'), conversation_id: 'caller' }, { 'x-chatgptweb-conversation': 'session' });
  assert.match(prepared.conversationKey, /^[a-f0-9]{64}$/);
  assert.equal(prepare({ ...request('hello'), conversation_id: 'caller' }).conversationKey, undefined);
});
