import test from 'node:test';
import assert from 'node:assert/strict';
import { identityJson } from '../src/native/identity-json.mjs';

test('identity ignores object order while retaining every JSON value and array order', () => {
  const one = [{ type: 'input_text', text: 'Exact text\n', metadata: { z: 1, a: { y: true, b: null } } }];
  const two = [{ metadata: { a: { b: null, y: true }, z: 1 }, text: 'Exact text\n', type: 'input_text' }];
  const before = JSON.stringify(one);
  assert.equal(identityJson(one), identityJson(two));
  assert.equal(JSON.stringify(one), before);
  assert.notEqual(identityJson(one), identityJson([{ ...two[0], text: 'Exact text' }]));
  assert.notEqual(identityJson(['first', 'second']), identityJson(['second', 'first']));
  assert.notEqual(identityJson({ id: 'a' }), identityJson({ id: 'b' }));
  assert.notEqual(identityJson({ value: 1 }), identityJson({ value: '1' }));
  assert.notEqual(identityJson(JSON.parse('{"__proto__":{"a":1}}')), identityJson({}));
  assert.equal(identityJson({ absent: undefined, list: [undefined, null] }), '{"list":[null,null]}');
});
