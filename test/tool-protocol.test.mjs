import test from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../src/protocol.mjs';

const tool = { name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const request = extra => ({ model: 'auto', messages: [{ role: 'user', content: 'Look up a fictional garden.' }], tools: [tool], ...extra });
const call = (prepared, input = { query: 'garden' }, name = 'lookup') => prepared.start + JSON.stringify({ name, input }) + prepared.end;
const frames = texts => [...texts.map(text => ({ event: 'answer', data: { text } })), { event: '', data: '[DONE]' }];
const parseEvent = chunk => JSON.parse(chunk.split('\ndata: ')[1]);
const collect = async (source, prepared) => { const events = []; for await (const chunk of protocol.translate(source, prepared)) events.push(parseEvent(chunk)); return events; };

test('prepare accepts client tools and injects a fresh prompt-level protocol', () => {
  let prepared;
  assert.doesNotThrow(() => { prepared = protocol.prepare(request()); });
  assert.match(prepared.prompt, /\[Tool protocol\]/);
  assert.match(prepared.start, /^\[MAGPIE_TOOL_[a-f0-9]{32}\]$/);
  assert.ok(prepared.prompt.includes(prepared.start));
  assert.notEqual(prepared.start, protocol.prepare(request()).start);
});

test('parser survives every offset inside opening and closing ASCII delimiters', () => {
  const prepared = protocol.prepare(request());
  const text = 'Before ' + call(prepared) + ' after';
  for (const marker of [prepared.start, prepared.end]) for (let offset = 1; offset < marker.length; offset++) {
    const split = text.indexOf(marker) + offset;
    const parser = new protocol.ToolParser(prepared);
    const items = [...parser.feed(text.slice(0, split)), ...parser.feed(text.slice(split), true)];
    assert.equal(items.filter(item => item.text).map(item => item.text).join(''), 'Before  after');
    assert.deepEqual(items.find(item => item.tool).tool.input, { query: 'garden' });
    assert.equal(items.filter(item => item.tool).length, 1);
  }
});

test('parser preserves delimiters, escaped quotes, closing brackets and nested braces inside JSON strings', () => {
  const prepared = protocol.prepare(request({ tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }));
  const input = { query: 'quote " slash \\ bracket ] } ' + prepared.end + prepared.start, nested: { list: [{ leaf: 'value' }] } };
  const parser = new protocol.ToolParser(prepared);
  const items = [...call(prepared, input)].flatMap(char => parser.feed(char));
  items.push(...parser.feed('', true));
  assert.deepEqual(items.map(item => item.tool.input), [input]);
});

test('two calls render two blocks and one tool_use stop reason', async () => {
  const prepared = protocol.prepare(request());
  const events = await collect(frames([call(prepared) + call(prepared, { query: 'lake' })]), prepared);
  assert.deepEqual(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(events.filter(event => event.delta?.type === 'input_json_delta').map(event => JSON.parse(event.delta.partial_json)), [{ query: 'garden' }, { query: 'lake' }]);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.notEqual(events[1].content_block.id, events[4].content_block.id);
});

for (const [label, extra, text, code] of [
  ['unknown tool', {}, prepared => call(prepared, {}, 'missing'), 'toolUnknown'],
  ['malformed JSON', {}, prepared => prepared.start + '{"name":"lookup","input":{oops}}' + prepared.end, 'toolJSON'],
  ['schema mismatch', {}, prepared => call(prepared, {}), 'toolSchema'],
  ['wrong named tool', { tools: [tool, { ...tool, name: 'other' }], tool_choice: { type: 'tool', name: 'other' } }, prepared => call(prepared), 'toolChoiceViolation'],
  ['none forbids calls', { tool_choice: { type: 'none' } }, prepared => call(prepared), 'toolChoiceViolation'],
  ['disabled parallel calls', { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }, prepared => call(prepared) + call(prepared), 'toolParallel'],
  ['unfinished JSON', {}, prepared => prepared.start + '{"name":', 'toolIncomplete'],
  ['unfinished closing marker', {}, prepared => call(prepared).slice(0, -3), 'toolIncomplete'],
  ['missing required call', { tool_choice: { type: 'any' } }, () => 'Only prose.', 'toolRequired'],
  ['malformed closing delimiter', {}, prepared => call(prepared).replace(prepared.end, 'wrong'), 'toolDelimiter'],
]) test(`${label} raises ${code} without successful termination`, async () => {
  const prepared = protocol.prepare(request(extra));
  const output = [];
  await assert.rejects(async () => { for await (const chunk of protocol.translate(frames([text(prepared)]), prepared)) output.push(parseEvent(chunk)); }, error => error.name === 'BackendError' && error.code === code);
  assert.equal(output.some(event => event.type === 'message_stop'), false);
});

test('undefined forced tool is rejected before dispatch', () => {
  assert.throws(() => protocol.prepare(request({ tool_choice: { type: 'tool', name: 'missing' } })), error => error.code === 'toolChoice' && error.status === 400);
});

test('prose before and after a call arrives before the next upstream batch is released', async context => {
  const prepared = protocol.prepare(request());
  let releaseCall, releaseEnd;
  const callGate = new Promise(resolve => { releaseCall = resolve; });
  const endGate = new Promise(resolve => { releaseEnd = resolve; });
  let callReleased = false, endReleased = false;
  async function* source() {
    yield { event: 'answer', data: { text: 'Before the call. ' } };
    await callGate;
    yield { event: 'answer', data: { text: call(prepared) } };
    yield { event: 'answer', data: { text: 'After the call.' } };
    await endGate;
    yield { event: '', data: '[DONE]' };
  }
  const output = protocol.translate(source(), prepared);
  const started = performance.now();
  const arrivals = [];
  const events = [];
  const next = async () => {
    let timer;
    try { return await Promise.race([output.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('text blocked behind an unreleased upstream gate')), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    while (!events.some(event => event.delta?.text === 'Before the call. ')) events.push(parseEvent((await next()).value));
    assert.equal(callReleased, false);
    arrivals.push({ phase: 'before-call', milliseconds: performance.now() - started });
    callReleased = true; releaseCall();
    while (!events.some(event => event.delta?.text === 'After the call.')) events.push(parseEvent((await next()).value));
    assert.equal(endReleased, false);
    arrivals.push({ phase: 'after-call-before-completion', milliseconds: performance.now() - started });
  } finally { endReleased = true; releaseCall(); releaseEnd(); }
  for await (const chunk of output) events.push(parseEvent(chunk));
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.deepEqual(events.filter(event => event.type === 'content_block_start').map(event => event.content_block.type), ['text', 'tool_use', 'text']);
  context.diagnostic(JSON.stringify({ arrivals, events }));
});

test('tool result history preserves identifiers and errors and uses full-history replay', () => {
  const prepared = protocol.prepare(request({ conversation_id: 'existing', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-id', name: 'lookup', input: { query: 'garden' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-id', is_error: true, content: [{ type: 'text', text: 'No matching entry.' }] }] },
  ] }));
  assert.match(prepared.prompt, /\[Previous tool call\]/);
  assert.match(prepared.prompt, /"tool_use_id":"call-id","is_error":true,"content":"No matching entry\."/);
  assert.equal(prepared.conversationKey, undefined);
});

test('call limits exclude trailing prose and bound whitespace before the closing delimiter', () => {
  const prepared = protocol.prepare(request());
  const large = 'x'.repeat(1024 * 1024 + 1);
  const items = new protocol.ToolParser(prepared).feed(call(prepared) + large, true);
  assert.equal(items[1].text, large);
  assert.throws(() => new protocol.ToolParser(prepared).feed(call(prepared, { query: large })), error => error.code === 'toolLimit');
  assert.throws(() => new protocol.ToolParser(prepared).feed(call(prepared).replace(prepared.end, ' '.repeat(8193))), error => error.code === 'toolLimit');
});

test('ordinary prose is not retained and only a possible delimiter suffix is buffered', () => {
  const prepared = protocol.prepare(request());
  const parser = new protocol.ToolParser(prepared);
  assert.deepEqual(parser.feed('A'.repeat(20000)), [{ text: 'A'.repeat(20000) }]);
  assert.equal(parser.buffer, '');
  assert.deepEqual(parser.feed('ready ' + prepared.start.slice(0, -1)), [{ text: 'ready ' }]);
  assert.ok(parser.buffer.length < prepared.start.length);
});
