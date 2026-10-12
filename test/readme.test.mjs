import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('README names where magpie comes from and the bare-name PATH requirement', () => {
  assert.match(readme, /https:\/\/usemagpie\.ai/);
  assert.match(readme, /https:\/\/github\.com\/yetone\/magpie/);
  assert.match(readme, /magpie-windows-amd64\.exe/);
  assert.match(readme, /magpie --version/);
  assert.match(readme, /CommandNotFoundException/);
});

test('README rehearsal states the network requirement without a package-cache alternative', () => {
  assert.match(readme, /a registry connection is required/);
  assert.doesNotMatch(readme, /compatible package cache/);
});

test('README harness description does not claim non-default model selection', () => {
  assert.doesNotMatch(readme, /selects a model through the stock host/);
});
