import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validateInput } from '../src/tool-emulation.mjs';
import { prepare } from '../src/wire/prepare.mjs';

for (const keyword of ['$schema', '$id', 'pattern', 'format', 'multipleOf', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'prefixItems', 'contains', 'minContains', 'maxContains', 'if', 'then', 'else', 'propertyNames', 'contentEncoding']) {
  test(`unsupported ${keyword} is rejected before dispatch`, () => {
    assert.throws(() => prepare({ model: 'auto', messages: [{ role: 'user', content: 'fixture' }], tools: [{ name: 'lookup', input_schema: { type: 'object', [keyword]: true } }] }), error => error.code === 'toolDefinition' && error.status === 400);
  });
}

for (const [name, schema, valid, invalid] of [
  ['required, optional, enum and extra fields', { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' }, unit: { enum: ['metric', 'imperial'] } }, required: ['query', 'unit'], additionalProperties: false }, { query: 'garden', unit: 'metric' }, [{ unit: 'metric' }, { query: 'garden', unit: 'other' }, { query: 'garden', unit: 'metric', extra: 1 }, { query: 'garden', unit: 'metric', count: 1.5 }]],
  ['number bounds', { type: 'number', minimum: 1, maximum: 5, exclusiveMinimum: 0, exclusiveMaximum: 6 }, 3, [0, 6, '3']],
  ['exclusive bounds', { exclusiveMinimum: 1, exclusiveMaximum: 5 }, 3, [1, 5]],
  ['Unicode string length', { type: 'string', minLength: 2, maxLength: 3 }, 'a\u{1F98A}', ['x', 'abcd']],
  ['object property count', { type: 'object', minProperties: 1, maxProperties: 2, additionalProperties: { type: 'boolean' } }, { active: true }, [{}, { active: 1 }, { a: true, b: false, c: true }]],
  ['array items and semantic uniqueness', { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'object' } }, [{ a: 1 }, { a: 2 }], [[], [1], [{ a: 1, b: 2 }, { b: 2, a: 1 }], [{}, {}, {}]]],
  ['const object equality', { const: { a: 1, b: 2 } }, { b: 2, a: 1 }, [{ a: 1 }]],
  ['union types', { type: ['null', 'boolean'] }, null, [1, 'true']],
  ['allOf', { allOf: [{ type: 'integer' }, { minimum: 2 }] }, 3, [1, 2.5]],
  ['anyOf', { anyOf: [{ const: 1 }, { const: 'one' }] }, 'one', [2]],
  ['oneOf', { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5, [1, '1']],
  ['not', { not: { type: 'null' } }, 1, [null]],
  ['boolean schema', false, undefined, [1]],
  ['local references', { $defs: { 'a/b': { type: 'integer' } }, $ref: '#/$defs/a~1b' }, 3, ['3']],
  ['legacy definitions', { definitions: { value: { type: 'string' } }, $ref: '#/definitions/value' }, 'yes', [1]],
]) test(`schema validates ${name}`, () => {
  checkSchema(schema);
  if (valid !== undefined) assert.doesNotThrow(() => validateInput(valid, schema));
  for (const value of invalid) assert.throws(() => validateInput(value, schema), error => error.code === 'toolSchema');
});

test('annotation keywords are accepted without constraining arguments', () => {
  const schema = { title: 'Entry', description: 'Fixture', default: {}, examples: [{}], $comment: 'Annotation only' };
  checkSchema(schema);
  validateInput({}, schema);
  checkSchema(true);
  validateInput({}, true);
});

for (const schema of [{ type: 'bogus' }, { type: [] }, { required: [1] }, { enum: [] }, { minLength: -1 }, { maximum: '3' }, { uniqueItems: 'yes' }, { items: [] }, { anyOf: [] }, { properties: [] }, { $ref: 'https://example.invalid/schema' }, { $ref: '#/absent' }, { $ref: '#/%invalid' }, { $defs: { value: { pattern: 'x' } } }]) {
  test(`malformed schema ${JSON.stringify(schema)} is rejected in preflight`, () => assert.throws(() => checkSchema(schema), error => error.code === 'toolDefinition'));
}

test('recursive schema validation fails with a bounded typed error', () => {
  const schema = { $ref: '#' };
  checkSchema(schema);
  assert.throws(() => validateInput({}, schema), error => error.code === 'toolLimit');
});

test('definition depth and node counts are bounded', () => {
  let schema = true;
  for (let depth = 0; depth < 34; depth++) schema = { items: schema };
  assert.throws(() => checkSchema(schema), error => error.code === 'toolDefinition');
  assert.throws(() => checkSchema({ allOf: Array(10001).fill(true) }), error => error.code === 'toolDefinition');
});
