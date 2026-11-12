import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionPlans, unsupportedModels } from '../backend/site-adapter/compatibility.mjs';
import { selectModel } from '../backend/site-adapter/index.mjs';
import { describeCatalogue } from '../src/models.mjs';
import { requestShape } from '../src/loader.mjs';

test('audited catalogue entries have distinct mapped or explicitly unsupported outcomes', async () => {
  assert.equal(Object.keys(selectionPlans).length, 8);
  assert.equal(Object.keys(unsupportedModels).length, 15);
  for (const slug of Object.keys(unsupportedModels)) {
    assert.equal(Object.hasOwn(selectionPlans, slug), false);
    assert.match(describeCatalogue({ models: [{ slug, title: 'Fixture' }] })[slug].name, /not yet supported/);
    assert.equal((await selectModel({}, slug)).kind, 'model-unsupported');
  }
});

test('request diagnostics preserve structural clues without conversation or tool data', () => {
  const privateText = 'private-content-must-not-be-logged';
  const summary = requestShape({ model: privateText, messages: [{ role: 'user', content: privateText }],
    tools: [{ name: privateText, description: privateText, input_schema: { type: 'object', $schema: privateText, properties: { secret: { type: 'string', format: 'uri' } } } }],
  }, 'toolDefinition');
  assert.deepEqual(summary.schemaKeywords, ['$schema', 'format']);
  assert.equal(summary.toolCount, 1);
  assert.equal(summary.missingInputSchemas, 0);
  assert.equal(JSON.stringify(summary).includes(privateText), false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});
