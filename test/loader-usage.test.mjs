import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLoader } from '../src/loader.mjs';
import { parseSSE } from '../src/wire/sse.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { estimatePreparedInput, estimateTextTokens } from '../src/usage/context.mjs';

const auth = async () => ({ type: 'oauth', refresh: 'fixture', access: 'fixture' });
const request = overrides => ({
  model: 'gpt-6-instant',
  stream: false,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

function preparedInput(expectedRequest) {
  return estimatePreparedInput(prepare(expectedRequest)).inputTokens;
}

function upstream(text, { truncated = false } = {}) {
  return {
    metadata: { route: 'dom' },
    async *[Symbol.asyncIterator]() {
      yield { type: 'delta', index: 0, text };
      yield { type: 'finish', reason: truncated ? 'truncated' : 'complete' };
    },
    close() {},
  };
}

async function readAll(response) {
  const chunks = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(decoder.decode(next.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

function sseValues(body) {
  return parseSSE(body).events.flatMap(event => {
    try { return [JSON.parse(event.data)]; } catch { return []; }
  });
}

test('nonstream response carries exact local input and output usage once', async () => {
  const expectedRequest = request({ stream: false });
  let outOfBandReported = false;
  const load = makeLoader({
    bridge: { async open() { return upstream('hello from ChatGPT'); } },
    profileRoot: '.',
    input: { magpie: { usage() { outOfBandReported = true; } } },
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(expectedRequest),
  });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.usage.input_tokens, preparedInput(expectedRequest));
  assert.equal(message.usage.output_tokens, estimateTextTokens('hello from ChatGPT'));
  assert.equal(message.usage.cache_creation_input_tokens, 0);
  assert.equal(message.usage.cache_read_input_tokens, 0);
  assert.equal(outOfBandReported, false, 'the proxied stream owns accounting');
});

test('streaming response has one message_start and one estimated message_delta', async () => {
  const expectedRequest = request({ stream: true });
  let outOfBandReported = false;
  const load = makeLoader({
    bridge: { async open() { return upstream('streamed answer'); } },
    profileRoot: '.',
    input: { magpie: { usage() { outOfBandReported = true; } } },
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(expectedRequest),
  });
  const body = await readAll(response);
  const events = sseValues(body);
  const starts = events.filter(event => event.type === 'message_start');
  const deltas = events.filter(event => event.type === 'message_delta');
  assert.equal(starts.length, 1);
  assert.equal(deltas.length, 1);
  assert.equal(starts[0].message.usage.input_tokens, preparedInput(expectedRequest));
  assert.equal(starts[0].message.usage.output_tokens, 0);
  assert.equal(starts[0].message.usage.cache_creation_input_tokens, 0);
  assert.equal(starts[0].message.usage.cache_read_input_tokens, 0);
  assert.equal(deltas[0].usage.output_tokens, estimateTextTokens('streamed answer'));
  assert.equal(outOfBandReported, false);
});

test('streaming failure never emits successful terminal usage', async () => {
  const expectedRequest = request({ stream: true });
  const load = makeLoader({
    bridge: { async open() { return upstream('partial', { truncated: true }); } },
    profileRoot: '.',
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(expectedRequest),
  });
  const body = await readAll(response);
  const events = sseValues(body);
  assert.equal(events.filter(event => event.type === 'message_start').length, 1);
  assert.equal(events.filter(event => event.type === 'message_delta').length, 0);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
});

test('cancellation leaves one input-bearing start and no duplicate terminal usage', async () => {
  let release;
  let closed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = {
    metadata: { route: 'dom' },
    async *[Symbol.asyncIterator]() {
      yield { type: 'delta', index: 0, text: 'partial before cancel' };
      await gate;
      if (!closed) yield { type: 'finish', reason: 'complete' };
    },
    close() {
      closed = true;
      release();
    },
  };
  const load = makeLoader({
    bridge: { async open() { return pending; } },
    profileRoot: '.',
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(request({ stream: true })),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let observed = '';
  while (!observed.includes('partial before cancel')) {
    const next = await reader.read();
    assert.equal(next.done, false);
    observed += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  const events = sseValues(observed);
  assert.equal(events.filter(event => event.type === 'message_start').length, 1);
  assert.equal(events.filter(event => event.type === 'message_delta').length, 0);
});

test('over-context is rejected before bridge.open without out-of-band accounting', async () => {
  let opened = false;
  let outOfBandReported = false;
  const load = makeLoader({
    bridge: { async open() { opened = true; throw new Error('must not open'); } },
    profileRoot: '.',
    input: { magpie: { usage() { outOfBandReported = true; } } },
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(request({ messages: [{ role: 'user', content: 'a'.repeat(150_000) }] })),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'contextLength');
  assert.equal(opened, false);
  assert.equal(outOfBandReported, false);
});

test('a large tool catalogue is compacted dynamically before dispatch and keeps the full schemas locally', async () => {
  const verbose = 'Detailed host tool guidance. '.repeat(80);
  const tools = Array.from({ length: 330 }, (_, index) => ({
    name: `host_tool_${index}`,
    description: `${verbose}${index}`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: verbose, minLength: 1 },
        workdir: { type: 'string', description: verbose },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }));
  let command;
  const load = makeLoader({
    bridge: {
      async open(value) {
        command = value;
        return upstream(`${value.start}${JSON.stringify({
          name: 'host_tool_0',
          input: { command: 'Get-Content package.json' },
        })}${value.end}`);
      },
    },
    profileRoot: '.',
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(request({
      model: 'gpt-5-6-pro',
      tools,
      messages: [{ role: 'user', content: 'Inspect this project and its files.' }],
    })),
  });
  assert.equal(response.status, 200);
  assert.equal(command.tools.length, 330);
  assert.equal(command.promptTools.length, 330);
  assert.equal(command.toolCompaction.exposedToolCount, 330);
  assert.ok(command.toolCompaction.level >= 1);
  assert.ok(command.usageEstimate.inputTokens < command.usageEstimate.contextLimit);
  assert.ok(command.prompt.length < JSON.stringify(tools).length);
  assert.match(command.promptTools.find(tool => tool.name === 'host_tool_0').description, /Detailed host tool guidance/);
  assert.deepEqual(command.tools[0].input_schema.properties.command, {
    type: 'string',
    description: verbose,
    minLength: 1,
  });
});

test('a compacted all-tool catalogue that still exceeds context fails before browser dispatch', async () => {
  const properties = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [
    `property_${index}_${'x'.repeat(80)}`,
    { type: 'string' },
  ]));
  const tools = Array.from({ length: 512 }, (_, index) => ({
    name: `host_tool_${index}`,
    input_schema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
    },
  }));
  let opened = false;
  const load = makeLoader({
    bridge: { async open() { opened = true; throw new Error('must not open'); } },
    profileRoot: '.',
  });
  const client = await load(auth);
  const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify(request({
      messages: [{ role: 'user', content: 'Inspect everything.' }],
      tools,
    })),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'contextLength');
  assert.equal(opened, false);
});

test('successive tool-round requests each emit their own stream usage', async () => {
  const parts = [];
  const load = makeLoader({
    bridge: {
      async open() {
        const text = 'round complete';
        parts.push(text);
        return upstream(text);
      },
    },
    profileRoot: '.',
  });
  const client = await load(auth);
  const toolRequest = request({
    stream: false,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result' }] },
    ],
  });
  for (let round = 0; round < 2; round++) {
    const response = await client.fetch('https://chatgpt-web.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify(toolRequest),
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.usage.output_tokens, estimateTextTokens('round complete'));
  }
  assert.deepEqual(parts, ['round complete', 'round complete']);
});
