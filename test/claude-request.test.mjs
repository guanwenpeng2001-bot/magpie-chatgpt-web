import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/wire/prepare.mjs';
import { checkSchema, validateInput } from '../src/tool-emulation.mjs';

test('Codex-shaped requests accept 330 tools while schema annotations, patterns, and trailing system messages remain valid', () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
    id: { type: 'string', pattern: '^[a-z]+$', format: 'custom-id' },
  }, required: ['id'] };
  const request = { model: 'gpt-5-6-pro', system: 'Initial instruction', messages: [
    { role: 'user', content: [{ type: 'text', text: 'Use the supplied tool.' }] },
    { role: 'system', content: 'Additional client instruction' },
  ], tools: Array.from({ length: 330 }, (_, i) => ({ name: `tool_${i}`, input_schema: schema })) };
  const p = prepare(request);
  assert.equal(p.tools.length, 330);
  assert.deepEqual(p.history, [{ role: 'user', content: 'Use the supplied tool.' }]);
  assert.equal(p.system, 'Initial instruction\n\nAdditional client instruction');
  validateInput({ id: 'valid' }, schema);
  assert.throws(() => validateInput({ id: '123' }, schema), { code: 'toolSchema' });
});

test('invalid regex patterns remain rejected and pathological matching is bounded', () => {
  assert.throws(() => checkSchema({ pattern: '[' }), { code: 'toolDefinition' });
  const started = Date.now();
  assert.throws(() => validateInput('a'.repeat(80) + '!', { pattern: '^(a+)+$' }), { code: 'toolLimit' });
  assert.ok(Date.now() - started < 1500);
});

test('a request with only system messages and an oversized tool catalogue are still rejected', () => {
  assert.throws(() => prepare({ model: 'auto', messages: [{ role: 'system', content: 'No conversation' }] }), { code: 'invalidRequest' });
  assert.throws(() => prepare({ model: 'auto', messages: [{ role: 'user', content: 'Hi' }], tools: Array.from({ length: 513 }, (_, i) => ({ name: `tool_${i}`, input_schema: {} })) }), { code: 'toolDefinition' });
});
