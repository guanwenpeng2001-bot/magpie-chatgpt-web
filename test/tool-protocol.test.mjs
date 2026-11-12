import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from '../backend/conversations.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { reconstruct, translate } from '../src/wire/translate.mjs';
import {
  ToolParser,
  compactToolDefinitions,
  normalizeAssistantContent,
} from '../src/tool-emulation.mjs';
import { parseSSE } from '../src/wire/sse.mjs';
const protocol = { prepare, translate, ToolParser };

const tool = { name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const request = extra => ({ model: 'auto', messages: [{ role: 'user', content: 'Look up a fictional garden.' }], tools: [tool], ...extra });
const call = (prepared, input = { query: 'garden' }, name = 'lookup') => prepared.start + JSON.stringify({ name, input }) + prepared.end;
const frames = texts => [...texts.map(text => ({ type: 'delta', index: 0, text })), { type: 'finish', reason: 'complete' }];
const parseEvent = chunk => JSON.parse(parseSSE(chunk).events[0].data);
const collect = async (source, prepared) => { const events = []; for await (const chunk of protocol.translate(source, prepared)) events.push(parseEvent(chunk)); return events; };

test('prepare accepts client tools and injects a fresh prompt-level protocol', () => {
  let prepared;
  assert.doesNotThrow(() => {
    prepared = protocol.prepare(request({ messages: [{ role: 'user', content: 'Look up this project in the tool.' }] }));
  });
  assert.match(prepared.prompt, /\[Client action format\]/);
  assert.match(prepared.start, /^\[MAGPIE_TOOL_[a-f0-9]{32}\]$/);
  assert.ok(prepared.prompt.includes(prepared.start));
  assert.notEqual(prepared.start, protocol.prepare(request()).start);
});

test('ordinary questions containing action words remain text-eligible with tools available', async () => {
  const prepared = protocol.prepare(request({
    messages: [{ role: 'user', content: 'What does run mean in JavaScript, and how do I test it?' }],
  }));
  assert.equal(prepared.toolChoice.type, 'auto');
  const events = await collect(frames(['It executes a statement or function.']), prepared);
  assert.equal(events.at(-2).delta.stop_reason, 'end_turn');
  assert.equal(events.some(event => event.content_block?.type === 'tool_use'), false);
});

test('automatic tool choice preserves tools unless the host explicitly forbids them', () => {
  const tools = [{ name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  const text = protocol.prepare(request({ messages: [{ role: 'user', content: 'Explain why recursion terminates.' }], tools }));
  assert.equal(text.toolExposure, 'available');
  assert.equal(text.toolExposureReason, 'host-auto');
  assert.equal(text.promptTools, undefined);
  assert.match(text.prompt, /\[Client action format\]/);

  const exactReply = protocol.prepare(request({ messages: [{ role: 'user', content: 'Reply exactly TEXT_OK and nothing else.' }], tools }));
  assert.equal(exactReply.toolExposure, 'available');
  assert.equal(exactReply.promptTools, undefined);
  assert.match(exactReply.prompt, /\[Client action format\]/);

  const ambiguous = protocol.prepare(request({ messages: [{ role: 'user', content: 'Continue with the next step.' }], tools }));
  assert.equal(ambiguous.toolExposure, 'available');
  assert.equal(ambiguous.promptTools, undefined);
  assert.match(ambiguous.prompt, /\[Client action format\]/);

  const politeAmbiguous = protocol.prepare(request({ messages: [{ role: 'user', content: 'Can you help me edit a file?' }], tools }));
  assert.equal(politeAmbiguous.toolExposure, 'available');
  assert.equal(politeAmbiguous.promptTools, undefined);

  const action = protocol.prepare(request({ messages: [{ role: 'user', content: 'Use exec_command to inspect this project.' }], tools }));
  assert.equal(action.toolExposure, 'selected');
  assert.equal(action.toolExposureReason, 'explicit-named-action');
  assert.equal(action.promptTools, undefined);
  assert.match(action.prompt, /\[Client action format\]/);

  const forbidden = protocol.prepare(request({
    messages: [{ role: 'user', content: 'Answer with text only.' }],
    tools,
    tool_choice: { type: 'none' },
  }));
  assert.equal(forbidden.toolExposure, 'none');
  assert.equal(forbidden.toolExposureReason, 'host-choice');
  assert.deepEqual(forbidden.promptTools, []);
  assert.doesNotMatch(forbidden.prompt, /\[Client action format\]/);
});

test('ambiguous and indirect Agent requests fail open to model-selected tools', () => {
  const tools = [{ name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  for (const content of [
    '看一下这一个项目有一些什么东西。',
    '请检查当前仓库并说明目录结构。',
    '运行检查这个项目。',
    'Inspect this project and explain its structure.',
    'Can you fix the bug in auth?',
    'Could you run the tests?',
    'Would you inspect this project and update the README?',
    'Do you mind fixing this file?',
    'Explain the bug and fix it.',
    'What is wrong? Then fix this file.',
    'How does this work? Update the README.',
    'Please explain the error and then run the tests.',
    'Why is this failing? Please patch it.',
    'Summarize this repository and identify risky code.',
    'Run a risk analysis on this plan.',
    'The repo seems broken; take care of it.',
    '先解释一下；然后修改这个文件。',
    'Can you investigate what changed here?',
  ]) {
    const prepared = protocol.prepare(request({ messages: [{ role: 'user', content }], tools }));
    assert.equal(prepared.toolChoice.type, 'auto', content);
    assert.equal(prepared.toolExposure, 'available', content);
    assert.equal(prepared.toolExposureReason, 'host-auto', content);
  }
  for (const content of [
    'What does run mean in JavaScript?',
    'Explain how to inspect a project.',
    'How do I fix this?',
    'Explain how to fix this.',
    'Compare read and write performance.',
    'Explain unit and test coverage.',
    'What are read and write throughput differences?',
  ]) {
    const prepared = protocol.prepare(request({ messages: [{ role: 'user', content }], tools }));
    assert.equal(prepared.toolChoice.type, 'auto', content);
    assert.equal(prepared.toolExposure, 'available', content);
  }
  const chinese = protocol.prepare(request({ messages: [{ role: 'user', content: '这个项目是什么？' }], tools }));
  assert.equal(chinese.toolChoice.type, 'auto');
  assert.equal(chinese.toolExposure, 'available');
  assert.match(chinese.prompt, /inspect or change local files/);
});

test('an exact tool name in the user turn requests that tool without using broad keyword matching', () => {
  const prepared = protocol.prepare(request({
    messages: [{ role: 'user', content: 'Use exec_command once, then report the result.' }],
    tools: [{ name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  }));
  assert.deepEqual(prepared.toolChoice, { type: 'tool', name: 'exec_command' });
});

test('an ordered multi-tool request forces the first named tool', () => {
  const prepared = protocol.prepare(request({
    messages: [{ role: 'user', content: 'Use apply_patch to edit the file, then call exec_command to read it.' }],
    tools: [
      { name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { name: 'apply_patch', input_schema: { type: 'object', properties: { patch: { type: 'string' } } } },
    ],
  }));
  assert.deepEqual(prepared.toolChoice, { type: 'tool', name: 'apply_patch' });
});

test('mentioning or explicitly excluding a tool name never forces a call', () => {
  const tools = [{ name: 'exec_command', input_schema: { type: 'object' } }];
  for (const content of [
    'Explain what exec_command means.',
    'Do not call exec_command for this question.',
    'Can I use exec_command to inspect a repository?',
    'How can an agent invoke exec_command?',
  ]) {
    const prepared = protocol.prepare(request({ messages: [{ role: 'user', content }], tools }));
    assert.equal(prepared.toolChoice.type, 'auto', content);
  }
});

test('tool compaction preserves every tool name and required input property', () => {
  const tools = Array.from({ length: 330 }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index} description`,
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }));
  for (const level of [1, 2, 3, 4]) {
    const compacted = compactToolDefinitions(tools, level);
    assert.equal(compacted.length, tools.length);
    assert.deepEqual(compacted.map(tool => tool.name), tools.map(tool => tool.name));
    assert.deepEqual(compacted[0].input_schema.required, ['command']);
    assert.equal(compacted[0].input_schema.properties.command.type, 'string');
  }
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
  ['missing required call', { tool_choice: { type: 'any' } }, () => 'Only prose.', 'toolRequired'],
  ['malformed closing delimiter', {}, prepared => call(prepared).replace(prepared.end, 'wrong'), 'toolDelimiter'],
]) test(`${label} raises ${code} without successful termination`, async () => {
  const prepared = protocol.prepare(request(extra));
  const output = [];
  await assert.rejects(async () => { for await (const chunk of protocol.translate(frames([text(prepared)]), prepared)) output.push(parseEvent(chunk)); }, error => error.name === 'BackendError' && error.code === code);
  assert.equal(output.some(event => event.type === 'message_stop'), false);
});

test('a complete JSON action is accepted when the model omits the redundant closing marker', async () => {
  const prepared = protocol.prepare(request());
  const events = await collect(frames([call(prepared).slice(0, -3)]), prepared);
  assert.deepEqual(events.filter(event => event.delta?.type === 'input_json_delta').map(event => JSON.parse(event.delta.partial_json)), [{ query: 'garden' }]);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
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
    yield { type: 'delta', index: 0, text: 'Before the call. ' };
    await callGate;
    yield { type: 'delta', index: 0, text: call(prepared) };
    yield { type: 'delta', index: 0, text: 'After the call.' };
    await endGate;
    yield { type: 'finish', reason: 'complete' };
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
  assert.equal(prepared.conversationKey, 'existing');
});

test('a completed tool round resumes the same browser binding with its normalized assistant history', async () => {
  const firstRequest = protocol.prepare(request({ conversation_id: 'caller' }));
  const bindings = new Conversations();
  const first = await bindings.take(firstRequest, 'account');
  const page = { isClosed: () => false, close: async () => {} };
  first.page = page;
  const raw = 'Before the call. ' + call(firstRequest);
  const message = await reconstruct(protocol.translate(frames([raw]), firstRequest));
  const toolBlock = message.content.find(block => block.type === 'tool_use');
  const assistantContent = normalizeAssistantContent(firstRequest, raw);
  assert.match(assistantContent, /Before the call\. \n\[Previous tool call\]/);

  bindings.finish(first, firstRequest, raw, assistantContent);
  const nextRequest = protocol.prepare({
    model: 'auto',
    conversation_id: 'caller',
    tools: [tool],
    messages: [
      { role: 'user', content: 'Look up a fictional garden.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Before the call. ' }, { type: 'tool_use', ...toolBlock }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: 'A matching garden exists.' }] },
    ],
  });
  const next = await bindings.take(nextRequest, 'account');
  assert.equal(next.entry, first);
  assert.equal(next.entry.page, page);
  assert.equal(next.resumeFrom, firstRequest.history.length + 1);
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
