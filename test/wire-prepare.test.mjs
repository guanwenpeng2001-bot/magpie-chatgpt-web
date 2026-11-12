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

test('Magpie effort variants map to the verified browser selections without changing the wire model', () => {
  const cases = [
    ['gpt-5-6', 'low', 'gpt-5-6-instant'],
    ['gpt-5-6', 'medium', 'gpt-5-6'],
    ['gpt-5-6', 'high', 'gpt-5-6-high'],
    ['gpt-5-6', 'xhigh', 'gpt-5-6-extra-high'],
    ['gpt-5-6', 'max', 'gpt-5-6-pro'],
    ['gpt-6', 'low', 'gpt-6-instant'],
    ['gpt-6', 'xhigh', 'gpt-6-extra-high'],
    ['gpt-6', 'max', 'gpt-6-pro'],
    ['gpt-6.1-sol-wm', 'low', 'gpt-6.1-sol-wm-low'],
    ['gpt-6.1-sol-wm', 'medium', 'gpt-6.1-sol-wm'],
    ['gpt-6.1-sol-wm', 'high', 'gpt-6.1-sol-wm-high'],
    ['gpt-6.1-sol-wm', 'xhigh', 'gpt-6.1-sol-wm-xhigh'],
    ['gpt-6.1-sol-wm', 'max', 'gpt-6.1-sol-wm-max'],
    ['gpt-6.1-sol-wm', 'ultra', 'gpt-6.1-sol-wm-ultra'],
  ];
  for (const [model, effort, selectionModel] of cases) {
    const prepared = prepare(
      { model, messages: [{ role: 'user', content: 'hello' }], stream: false },
      { 'x-magpie-effort': effort },
    );
    assert.equal(prepared.model, model);
    assert.equal(prepared.selectionModel, selectionModel);
  }
  assert.equal(prepare({ model: 'gpt-6', messages: [{ role: 'user', content: 'hello' }] }).selectionModel, 'gpt-6');
});

test('an unknown Magpie effort is rejected instead of silently using the base model', () => {
  for (const [model, effort] of [
    ['gpt-6', 'pro'],
    ['gpt-6.1-sol-wm', 'persistent'],
  ]) {
    assert.throws(
      () => prepare(
        { model, messages: [{ role: 'user', content: 'hello' }], stream: false },
        { 'x-magpie-effort': effort },
      ),
      { code: 'invalidRequest', status: 400 },
    );
  }
});

test('prepare accepts image blocks and records decoded size before dispatch', () => {
  const prepared = prepare(request([{ type: 'text', text: 'Describe' }, image()]));
  assert.deepEqual(prepared.images, [{ mediaType: 'image/png', dataBase64: 'aGk=', bytes: 2 }]);
  assert.equal(prepared.stream, false);
  assert.equal(prepared.history[0].content.includes('aGk='), false);
});

test('prepare preserves the original-detail hint for conservative image accounting', () => {
  const detailed = image();
  detailed.source.detail = 'original';
  assert.deepEqual(prepare(request([detailed])).images, [{
    mediaType: 'image/png',
    dataBase64: 'aGk=',
    bytes: 2,
    detail: 'original',
  }]);
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

test('tool definitions and tool history retain caller conversation binding', () => {
  assert.equal(prepare({ ...request('hello'), conversation_id: 'caller', tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }).conversationKey, 'caller');
  assert.equal(prepare({ ...request([{ type: 'tool_result', tool_use_id: 'call', content: 'result' }]), conversation_id: 'caller' }).conversationKey, 'caller');
});

test('Codex environment context does not force a tool call for a text-only turn', () => {
  const tools = [{ name: 'lookup', input_schema: { type: 'object' } }];
  const content = '<environment_context><cwd>C:\\workspace</cwd><shell>powershell</shell><filesystem><workspace_roots><root>C:\\workspace</root></workspace_roots></filesystem></environment_context>\nReply with exactly TEXT_ONLY.';
  assert.equal(prepare({ ...request(content), tools }).toolChoice.type, 'auto');
});

test('Agent and MCP requests fail open without forcing unrelated tools', () => {
  const tools = [{ name: 'exec_command', input_schema: { type: 'object' } }];
  for (const content of [
    'Use the subagent tool to inspect this project.',
    '运行一个智能体检查这个项目。',
    'Use the MCP tool to inspect this project.',
  ]) {
    const prepared = prepare({ ...request(content), tools });
    assert.equal(prepared.toolChoice.type, 'auto');
    assert.equal(prepared.toolExposure, 'available');
    assert.equal(prepared.toolExposureReason, 'host-auto');
  }
  const agent = prepare({
    ...request('Use the subagent tool to inspect this project.'),
    tools: [{ name: 'multi_agent_v1__spawn_agent', input_schema: { type: 'object' } }],
  });
  assert.equal(agent.toolChoice.type, 'auto');
  assert.equal(agent.toolExposure, 'available');
});

test('completed tool rounds force only the next explicitly requested named action', () => {
  const tools = [
    { name: 'apply_patch', input_schema: { type: 'object', properties: { patch: { type: 'string' } } } },
    { name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
  ];
  const original = { role: 'user', content: 'Use apply_patch to edit the file. Then call exec_command to read it, and call exec_command again to inspect the second file.' };
  const patchCall = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'patch-1', name: 'apply_patch', input: { patch: 'fixture' } }],
  };
  const patchResult = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'patch-1', content: 'applied' }],
  };
  const first = prepare({
    model: 'gpt-6',
    messages: [original, patchCall, patchResult],
    tools,
    stream: false,
  });
  assert.deepEqual(first.toolChoice, { type: 'tool', name: 'exec_command' });

  const execCall = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'exec-1', name: 'exec_command', input: { cmd: 'Get-Content file.txt' } }],
  };
  const execResult = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'exec-1', content: 'contents' }],
  };
  const second = prepare({
    model: 'gpt-6',
    messages: [original, patchCall, patchResult, execCall, execResult],
    tools,
    stream: false,
  });
  assert.deepEqual(second.toolChoice, { type: 'tool', name: 'exec_command' });

  const secondExecCall = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'exec-2', name: 'exec_command', input: { cmd: 'git status' } }],
  };
  const secondExecResult = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'exec-2', content: 'clean' }],
  };
  const complete = prepare({
    model: 'gpt-6',
    messages: [original, patchCall, patchResult, execCall, execResult, secondExecCall, secondExecResult],
    tools,
    stream: false,
  });
  assert.equal(complete.toolChoice.type, 'auto');
});

test('a failed tool result pauses an explicit action queue instead of advancing it', () => {
  const tools = [
    { name: 'apply_patch', input_schema: { type: 'object', properties: { patch: { type: 'string' } } } },
    { name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
  ];
  const prepared = prepare({
    model: 'gpt-6',
    messages: [
      { role: 'user', content: 'Use apply_patch to edit the file. Then call exec_command to read it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'patch-1', name: 'apply_patch', input: { patch: 'fixture' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'patch-1', is_error: true, content: 'patch rejected' }],
      },
    ],
    tools,
    stream: false,
  });
  assert.equal(prepared.toolChoice.type, 'auto');
  assert.equal(prepared.toolExposure, 'available');
  assert.match(prepared.prompt, /\[Client action format\]/);
});

test('parallel successful tool results still advance the remaining named action', () => {
  const tool = { name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } };
  const prepared = prepare({
    model: 'gpt-6',
    messages: [
      { role: 'user', content: 'Call exec_command for alpha, call exec_command for beta, and call exec_command for gamma.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'exec-1', name: 'exec_command', input: { cmd: 'alpha' } },
        { type: 'tool_use', id: 'exec-2', name: 'exec_command', input: { cmd: 'beta' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'exec-1', content: 'alpha done' },
        { type: 'tool_result', tool_use_id: 'exec-2', content: 'beta done' },
      ] },
    ],
    tools: [tool],
    stream: false,
  });
  assert.deepEqual(prepared.toolChoice, { type: 'tool', name: 'exec_command' });
});

test('one failed result in a parallel batch pauses the remaining action queue', () => {
  const tool = { name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } };
  const prepared = prepare({
    model: 'gpt-6',
    messages: [
      { role: 'user', content: 'Call exec_command for alpha, call exec_command for beta, and call exec_command for gamma.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'exec-1', name: 'exec_command', input: { cmd: 'alpha' } },
        { type: 'tool_use', id: 'exec-2', name: 'exec_command', input: { cmd: 'beta' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'exec-1', content: 'alpha done' },
        { type: 'tool_result', tool_use_id: 'exec-2', is_error: true, content: 'beta failed' },
      ] },
    ],
    tools: [tool],
    stream: false,
  });
  assert.equal(prepared.toolChoice.type, 'auto');
  assert.equal(prepared.toolExposure, 'available');
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
