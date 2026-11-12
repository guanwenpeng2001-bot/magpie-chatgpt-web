import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/wire/prepare.mjs';
import { compile } from '../backend/prompt.mjs';

const request = () => ({ model: 'auto', system: 'Be concise', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }] });
const full = () => {
  const prepared = prepare(request());
  return { prepared, prompt: compile(prepared) };
};

test('full compile keeps every transcript entry in prompt order', () => {
  const { prompt } = full();
  assert.equal(prompt, '[System]\nBe concise\n\n[Human]\none\n\n[Assistant]\ntwo\n\n[Human]\nthree');
});

test('prefix-matching resumeFrom compiles only the suffix without the system preamble', () => {
  const { prepared } = full();
  const suffix = compile(prepared, 2);
  assert.equal(suffix, '[Human]\nthree');
  assert.match(suffix, /\bthree\b/);
  assert.doesNotMatch(suffix, /Be concise/);
});

test('compile regenerates tool protocol definitions when tools are present', () => {
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: 'Inspect this project.' }], tools: [{ name: 'lookup', input_schema: { type: 'object' } }] });
  const prompt = compile(prepared);
  assert.ok(prompt.indexOf('[Client action format]') < prompt.indexOf('[Human]'));
  assert.match(prompt, /\[Client action format\]/);
  assert.match(prompt, /app-side actions executed by the host/);
  assert.match(prompt, /Never emit the opening delimiter by itself/);
  assert.ok(prompt.includes(prepared.start));
  assert.ok(prompt.includes(`${prepared.start}{"name":"lookup","input":{"query":"example"}}${prepared.end}`));
  assert.match(prompt, /"name":"lookup"/);
  assert.match(prompt, /tool definitions may be compacted/);
  assert.match(prompt, /Tool choice: \{"type":"auto"\}/);
  assert.doesNotMatch(prompt, /\[Assistant\]\s*$/);
  assert.match(prompt, /\[Client action reminder\]\s*If this turn needs a listed app-side action/);
  assert.match(prompt, /prefer the listed action when the user explicitly asks you to operate on them/);
});

test('required tool choice is stated explicitly in the system protocol', () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'one' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  });
  assert.match(compile(prepared), /requires a tool call: emit at least one listed tool and no final prose/);
});

test('a completed tool result tells the model not to repeat the action', () => {
  const prepared = prepare({
    model: 'auto',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'found' }] },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  });
  const prompt = compile(prepared, prepared.history.length - 1);
  assert.match(prompt, /preceding client action has completed/i);
  assert.match(prompt, /Do not repeat it/i);
  assert.match(prompt, /Re-read the original user request and its ordered requirements/i);
  assert.match(prompt, /If any requested action or dependent step remains/i);
  assert.match(prompt, /Only return the final answer after every requested action is complete/i);
});

test('history changed prefixes reject the resume index instead of compiling wrong context', () => {
  const { prepared } = full();
  assert.throws(() => compile(prepared, 5), RangeError);
  assert.throws(() => compile(prepared, -1), RangeError);
});
