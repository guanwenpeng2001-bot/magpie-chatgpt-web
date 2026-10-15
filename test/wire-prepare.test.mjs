import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { prepare } from '../src/wire/prepare.mjs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { serve } from '../backend/main.mjs';
import { TurnDriver } from '../backend/turn.mjs';

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

test('caller conversation id takes precedence over the header', () => {
  assert.equal(prepare({ ...request('hello'), conversation_id: 'caller' }, { 'x-chatgptweb-conversation': 'session' }).conversationKey, 'caller');
  assert.equal(prepare({ ...request('hello'), conversation_id: 'x'.repeat(512) }).conversationKey, 'x'.repeat(512));
});

for (const id of ['', 42, 'x'.repeat(513), null]) test(`invalid conversation id ${JSON.stringify(id)} is rejected`, () => {
  assert.throws(() => prepare({ ...request('hello'), conversation_id: id }), { code: 'invalidRequest' });
});

test('absent conversation id falls back to the header hash', () => {
  assert.equal(prepare(request('hello'), { 'x-chatgptweb-conversation': 'session' }).conversationKey, createHash('sha256').update('session').digest('hex'));
  assert.equal(prepare(request('hello')).conversationKey, undefined);
});

test('tool definitions and tool history suppress caller conversation binding', () => {
  assert.equal(prepare({ ...request('hello'), conversation_id: 'caller', tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }).conversationKey, undefined);
  assert.equal(prepare({ ...request([{ type: 'tool_result', tool_use_id: 'call', content: 'result' }]), conversation_id: 'caller' }).conversationKey, undefined);
});

test('backend dispatch renders the image size limit in MiB', { timeout: 5000 }, async t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const work = serve(input, output);
  t.after(async () => { input.end(); await work; lines.close(); output.destroy(); });
  input.write(JSON.stringify({ id: 'invalid-images', method: 'complete', model: 'auto', history: [], auth: { profile: 'fixture' }, images: [{}] }) + '\n');
  for await (const line of lines) {
    const frame = JSON.parse(line);
    if (frame.event !== 'error') continue;
    assert.equal(frame.error.code, 'attachmentUnsupported');
    assert.equal(frame.error.values.maxBytes, '10 MiB');
    assert.match(frame.error.message, /10 MiB/);
    assert.doesNotMatch(frame.error.message, /10485760/);
    return;
  }
  assert.fail('Expected an attachmentUnsupported frame');
});

test('turn driver renders the unavailable upload size limit in MiB', () => {
  const driver = new TurnDriver();
  assert.throws(() => driver.assertResult({ ok: false, kind: 'attach-unavailable' }, 'auto'), error => {
    assert.equal(error.code, 'attachmentUnsupported');
    assert.equal(error.toJSON().values.maxBytes, '10 MiB');
    assert.match(error.message, /10 MiB/);
    assert.doesNotMatch(error.message, /10485760/);
    return true;
  });
});

test('attachment envelope preserves its code, interpolation values and message', () => {
  assert.throws(() => prepare(request([{ type: 'document' }])), error => {
    const envelope = JSON.parse(JSON.stringify(error));
    assert.deepEqual(envelope, { status: 400, code: 'attachmentUnsupported', values: { kind: 'an unsupported content block', maxCount: 4, maxBytes: '10 MiB' }, message: error.message });
    assert.equal(envelope.message.includes('{kind}'), false);
    assert.match(envelope.message, /10 MiB/);
    assert.doesNotMatch(envelope.message, /10485760/);
    return true;
  });
});
