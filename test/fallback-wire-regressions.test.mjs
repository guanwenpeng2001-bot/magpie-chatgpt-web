import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/wire/prepare.mjs';
import { translate, reconstruct, errorEvent } from '../src/wire/translate.mjs';
import { compactToolDefinitions, checkSchema, validateInput } from '../src/tool-emulation.mjs';
import { BackendError } from '../backend/guard.mjs';
import { makeLoader } from '../src/loader.mjs';
import { parseSSE } from '../src/wire/sse.mjs';
import { estimateTextTokens } from '../src/usage/context.mjs';

const request = extra => ({ model: 'auto', messages: [{ role: 'user', content: 'hello' }], ...extra });
const frames = chunks => [...chunks.map(text => ({ type: 'delta', index: 0, text })), { type: 'finish', reason: 'complete', usage: { output_tokens: 999 } }];

for (const level of [1, 2, 3, 4]) test(`compaction ${level} cannot leave dangling references`, () => {
  const schema = { type: 'object', properties: { value: { $ref: '#/$defs/value' }, old: { $ref: '#/definitions/old' } },
    $defs: { value: { type: 'integer' } }, definitions: { old: { type: 'string' } }, not: { $ref: '#/$defs/missing-after-limit' } };
  schema.$defs = { ...schema.$defs, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`value${i}`, {}])), 'missing-after-limit': false };
  const [compact] = compactToolDefinitions([{ name: 'run', input_schema: schema }], level);
  assert.doesNotThrow(() => checkSchema(compact.input_schema));
  assert.throws(() => validateInput({ value: 'wrong' }, schema), { code: 'toolSchema' });
});

test('stop sequences select the first occurrence, even across chunks', async () => {
  const p = prepare(request({ stop_sequences: ['END', 'STOP'] }));
  const result = await reconstruct(translate(frames(['first ST', 'OP ignored END']), p));
  assert.deepEqual(result.content, [{ type: 'text', text: 'first ' }]);
  assert.equal(result.stop_reason, 'stop_sequence');
  assert.equal(result.stop_sequence, 'STOP');
  assert.equal(result.usage.output_tokens, estimateTextTokens('first '));
});

test('an unmatched partial stop is released at completion', async () => {
  const result = await reconstruct(translate(frames(['hello ST']), prepare(request({ stop_sequences: ['STOP'] }))));
  assert.equal(result.content[0].text, 'hello ST');
  assert.equal(result.stop_reason, 'end_turn');
});

for (const chunks of [['abcdefg'], ['a', 'bc', 'def', 'g']]) test(`max_tokens is independent of chunking: ${chunks.length}`, async () => {
  const result = await reconstruct(translate(frames(chunks), prepare(request({ max_tokens: 2 }))));
  assert.equal(result.content[0].text, 'abcdef');
  assert.equal(result.stop_reason, 'max_tokens');
  assert.equal(result.usage.output_tokens, 2);
});

test('max_tokens preserves Unicode code points and wins over a later stop', async () => {
  const result = await reconstruct(translate(frames(['😀中END']), prepare(request({ max_tokens: 3, stop_sequences: ['END'] }))));
  assert.equal(result.content[0].text, '😀');
  assert.equal(result.stop_reason, 'max_tokens');
  assert.equal(result.stop_sequence, null);
});

test('a stop at the beginning is a successful empty response', async () => {
  const result = await reconstruct(translate(frames(['STOPignored']), prepare(request({ stop_sequences: ['STOP'] }))));
  assert.deepEqual(result.content, []);
  assert.equal(result.stop_reason, 'stop_sequence');
});

for (const invalid of [{ max_tokens: 0 }, { max_tokens: 1.5 }, { stop_sequences: [''] }, { stop_sequences: 'stop' }]) test(`invalid output limits: ${JSON.stringify(invalid)}`, () => {
  assert.throws(() => prepare(request(invalid)), { code: 'invalidRequest' });
});

for (const late of [false, true]) test(`${late ? 'late' : 'early'} streaming expiry has authentication semantics`, async () => {
  let closed = false;
  const upstream = {
    async *[Symbol.asyncIterator]() {
      if (late) yield { type: 'delta', index: 0, text: 'hello' };
      yield { type: 'error', code: 'expired', message: new BackendError('expired').message };
    },
    close() { closed = true; },
  };
  const client = await makeLoader({ bridge: { open: async () => upstream }, profileRoot: '.' })(async () => ({ type: 'oauth', refresh: 'fixture' }));
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify(request({ stream: true })) });
  if (late) {
    const events = parseSSE(await response.text()).events.map(item => JSON.parse(item.data));
    assert.equal(events.at(-1).error.type, 'authentication_error');
    assert.equal(events.at(-1).error.status, 401);
    assert.equal(events.some(item => item.type === 'message_stop'), false);
  } else {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-magpie-sign-in'), 'expired');
    assert.equal((await response.json()).error.type, 'authentication_error');
  }
  assert.equal(closed, true);
});

test('a text stop before an envelope prevents parsing the rest of the response', async () => {
  const p = prepare(request({ stop_sequences: ['STOP'], tools: [{ name: 'run', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } }));
  const result = await reconstruct(translate(frames([`doneSTOP${p.start}not JSON`]), p));
  assert.deepEqual(result.content, [{ type: 'text', text: 'done' }]);
  assert.equal(result.stop_reason, 'stop_sequence');
});

test('token limit never emits a partial or unvalidated tool call', async () => {
  const p = prepare(request({ max_tokens: 2, tools: [{ name: 'run', input_schema: { type: 'object' } }] }));
  const result = await reconstruct(translate(frames([`${p.start}{"name":"run","input":{"command":"long command"}}${p.end}`]), p));
  assert.deepEqual(result.content, []);
  assert.equal(result.stop_reason, 'max_tokens');
});

test('a stop inside tool arguments suppresses that incomplete call and following output', async () => {
  const p = prepare(request({ stop_sequences: ['STOP'], tools: [{ name: 'run', input_schema: { type: 'object' } }] }));
  const result = await reconstruct(translate(frames([`${p.start}{"name":"run","input":{"cmd":"STOP ignored"}}${p.end}after`]), p));
  assert.deepEqual(result.content, []);
  assert.equal(result.stop_reason, 'stop_sequence');
  assert.equal(result.stop_sequence, 'STOP');
});

for (const code of ['toolIncomplete', 'toolJSON', 'toolDelimiter', 'toolSchema', 'toolUnknown', 'toolChoiceViolation', 'toolParallel', 'toolRequired', 'toolLimit']) test(`${code} survives HTTP/SSE envelopes without resting the account`, () => {
  const error = new BackendError(code);
  assert.equal(error.status, 502);
  assert.equal(error.headers['x-magpie-sign-in'], 'kept');
  assert.equal(error.toJSON().code, code);
  assert.equal(BackendError.fromEnvelope({ ...error.toJSON(), message: 'translated message' }).code, code);
  const frame = JSON.parse(parseSSE(errorEvent(error)).events[0].data);
  assert.equal(frame.error.type, 'api_error');
  assert.equal(frame.error.code, code);
  // Exact gateway/routing.go cutWords contract, followed by failCut's no-rest branch.
  assert.match(frame.error.message, /tool call, written as text, was cut short/i);
});
