import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/protocol.mjs';
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
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: 'one' }], tools: [{ name: 'lookup', input_schema: { type: 'object' } }] });
  const prompt = compile(prepared);
  assert.match(prompt, /\[Tool protocol\]/);
  assert.ok(prompt.includes(prepared.start));
  assert.match(prompt, /"name":"lookup"/);
  assert.match(prompt, /Tool choice: \{"type":"auto"\}/);
});

test('history changed prefixes reject the resume index instead of compiling wrong context', () => {
  const { prepared } = full();
  assert.throws(() => compile(prepared, 5), RangeError);
  assert.throws(() => compile(prepared, -1), RangeError);
});
