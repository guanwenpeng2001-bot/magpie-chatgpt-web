import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptResponsesStream, flatName } from '../src/native/stream.mjs';

const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const read = async response => (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
const custom = { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', status: 'completed' };
const spaced = { type: 'function_call', id: 'fc_2', call_id: 'call_2', namespace: 'mcp__data', name: 'query', arguments: '{"q":1}', status: 'completed' };
const events = [
  { type: 'response.created', response: { id: 'resp', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...custom, input: '', status: 'in_progress' } },
  { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 0, delta: custom.input },
  { type: 'response.custom_tool_call_input.done', item_id: 'ctc_1', output_index: 0, input: custom.input },
  { type: 'response.output_item.done', output_index: 0, item: custom },
  { type: 'response.output_item.done', output_index: 1, item: spaced },
  { type: 'response.completed', response: { id: 'resp', output: [custom, spaced] } },
];

test('native calls follow the flat functions Magpie offered after translation', async () => {
  const name = flatName('mcp__data', 'query');
  const translated = { tools: [{ type: 'function', name: 'apply_patch', parameters: {} }, { type: 'function', name, parameters: {} }] };
  const output = await read(adaptResponsesStream(sse(events), translated));
  assert.equal(output.some(event => event.type.startsWith('response.custom_tool_call_input')), false);
  const done = output.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  assert.deepEqual(done.map(item => [item.type, item.name]), [['function_call', 'apply_patch'], ['function_call', name]]);
  assert.deepEqual(JSON.parse(done[0].arguments), { input: custom.input });
  assert.equal(done[1].arguments, '{"q":1}');
  assert.equal(output.filter(event => event.type === 'response.output_item.added').length, 2);
  assert.deepEqual(output.at(-1).response.output.map(item => item.type), ['function_call', 'function_call']);
});

test('relayed native requests keep custom and namespaced calls unchanged', async () => {
  const relayed = { tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'namespace', name: 'mcp__data', tools: [{ type: 'function', name: 'query' }] }] };
  const output = await read(adaptResponsesStream(sse(events), relayed));
  assert.deepEqual(output, events);
});
