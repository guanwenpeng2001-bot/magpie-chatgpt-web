import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

export function parseTaxonomies(canonical, backend) {
  const source = canonical.match(/export const errors = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  const duplicate = backend.match(/Object\.entries\((\{[\s\S]*?\n\})\)\.map/);
  assert.ok(source && duplicate, 'Both source files must contain their complete taxonomy literal');
  const evaluate = literal => JSON.parse(JSON.stringify(runInNewContext(`(${literal})`, {}, { timeout: 1000 })));
  return [evaluate(source[1]), Object.fromEntries(Object.entries(evaluate(duplicate[1])).map(([code, [status, template]]) => [code, { status, template }]))];
}

test('backend taxonomy matches the canonical source file verbatim', async () => {
  const canonical = await readFile(new URL('../src/errors.mjs', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../backend/guard.mjs', import.meta.url), 'utf8');
  assert.match(backend, /\/\/[^\n]*src\/errors\.mjs/);
  const [expected, actual] = parseTaxonomies(canonical, backend);
  assert.ok(Object.keys(expected).length > 0);
  assert.deepEqual(actual, expected);
});
