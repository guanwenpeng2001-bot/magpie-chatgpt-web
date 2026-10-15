import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/index.mjs';

const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const request = extra => ({ model: 'auto', messages: [{ role: 'user', content: 'fixture' }], tools, ...extra });
async function loaderFor(reply) {
  let opened = 0, closed = 0, command;
  const bridge = { async open(prepared) {
    opened++; command = prepared;
    const source = (async function* () {
      yield { type: 'delta', index: 0, text: reply(prepared) };
      yield { type: 'finish', reason: 'complete' };
    })();
    source.close = () => { closed++; };
    return source;
  } };
  const hooks = _internal.createHooks({ bridge, profileRoot: '.' });
  const loader = await hooks.auth.loader(async () => ({ type: 'oauth', refresh: crypto.randomUUID() }));
  return { loader, get opened() { return opened; }, get closed() { return closed; }, get command() { return command; } };
}

test('nonstreaming callers receive actionable tool blocks as JSON and release the source', async () => {
  const fixture = await loaderFor(prepared => prepared.start + '{"name":"lookup","input":{"query":"garden"}}' + prepared.end);
  const response = await fixture.loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify(request({ stream: false })) });
  assert.match(response.headers.get('content-type'), /application\/json/);
  const message = await response.json();
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.content[0].type, 'tool_use');
  assert.deepEqual(message.content[0].input, { query: 'garden' });
  assert.equal(fixture.closed, 1);
});

test('unknown forced tool is an explicit preflight HTTP error without a backend turn', async () => {
  const fixture = await loaderFor(() => 'never');
  const response = await fixture.loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify(request({ tool_choice: { type: 'tool', name: 'absent' } })) });
  assert.equal(response.status, 400);
  assert.equal(fixture.opened, 0);
  assert.equal((await response.json()).error.message, 'The tool choice is invalid or names an undefined tool.');
});

test('streaming enforcement error never emits message_stop or model arguments', async () => {
  const marker = crypto.randomUUID();
  const fixture = await loaderFor(prepared => prepared.start + JSON.stringify({ name: marker, input: {} }) + prepared.end);
  const response = await fixture.loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify(request({ stream: true })) });
  const wire = await response.text();
  assert.match(wire, /event: error/);
  assert.match(wire, /ChatGPT requested an undefined tool/);
  assert.equal(wire.includes('event: message_stop'), false);
  assert.equal(wire.includes(marker), false);
  assert.equal(fixture.closed, 1);
});

test('inbound workspace and other headers never enter the backend command or prompt', async () => {
  const fixture = await loaderFor(() => 'plain answer');
  const response = await fixture.loader.fetch('https://chatgpt-web.invalid/v1/messages', {
    headers: { 'x-magpie-work-dir': 'private-directory', 'x-magpie-work-git': 'private-repository', 'x-unrelated': 'private-header' },
    body: JSON.stringify(request({ stream: true })),
  });
  await response.text();
  assert.equal(Object.hasOwn(fixture.command, 'headers'), false);
  for (const value of ['private-directory', 'private-repository', 'private-header']) assert.equal(JSON.stringify(fixture.command).includes(value), false);
});

test('image cap rejects before the loader opens a backend turn', async () => {
  const fixture = await loaderFor(() => 'never');
  const content = Array.from({ length: 5 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }));
  const response = await fixture.loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify(request({ messages: [{ role: 'user', content }] })) });
  assert.equal(response.status, 400);
  assert.equal(fixture.opened, 0);
  assert.match((await response.json()).error.message, /Images are supported up to 4 files/);
});
