import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionPlans,
  unsupportedModels,
  wireModels,
  workEfforts,
  workModels,
  workSelectionPlans,
} from '../backend/site-adapter/compatibility.mjs';
import { selectModel } from '../backend/site-adapter/index.mjs';
import { describeCatalogue } from '../src/models.mjs';
import { requestShape } from '../src/loader.mjs';

const catalogueSlugs = [
  'gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-thinking',
  'gpt-5.6-sol-wm', 'gpt-6-sol-wm', 'gpt-6-luna-wm', 'gpt-6.1-sol-wm',
  'gpt-5.6-terra-wm', 'gpt-5.6-luna-wm', 'gpt-6-astra-wm', 'gpt-6.1-terra-wm',
  'gpt-5-6-pro', 'gpt-6-pro', 'gpt-5-6-mini', 'gpt-5-6-t-mini', 'research',
  'gpt-6', 'gpt-6-instant', 'gpt-6-thinking', 'gpt-6-t-mini', 'gpt-6-mini',
  'chatgpt_alpha_model_external_access_reserved_gate_13',
  'chatgpt_alpha_model_external_access_reserved_gate_12',
];

test('audited catalogue entries have distinct mapped or explicitly unsupported outcomes', async () => {
  assert.equal(Object.keys(selectionPlans).length, 12);
  assert.equal(Object.keys(workModels).length, 8);
  assert.equal(Object.keys(workSelectionPlans).length, 48);
  assert.equal(workEfforts.length, 6);
  assert.equal(Object.keys(wireModels).length, 5);
  assert.equal(Object.keys(unsupportedModels).length, 2);
  const tables = [selectionPlans, workSelectionPlans, wireModels, unsupportedModels];
  for (const slug of catalogueSlugs) {
    assert.equal(tables.filter(table => Object.hasOwn(table, slug)).length, 1, slug);
  }
  assert.deepEqual(
    [...new Set(tables.flatMap(table => Object.keys(table)))].sort(),
    [...new Set([
      ...catalogueSlugs,
      ...Object.keys(selectionPlans),
      ...Object.keys(workSelectionPlans),
    ])].sort(),
  );
  for (const slug of Object.keys(unsupportedModels)) {
    assert.equal(Object.hasOwn(selectionPlans, slug), false);
    assert.match(describeCatalogue({ models: [{ slug, title: 'Fixture' }] })[slug].name, /not yet supported/);
    assert.equal((await selectModel({}, slug)).kind, 'model-unsupported');
  }
});

test('each Web model family exposes every verified effort slot', () => {
  for (const base of ['gpt-5-6', 'gpt-6']) {
    assert.deepEqual(
      Object.entries(selectionPlans).filter(([, plan]) => plan.version === (base === 'gpt-6' ? '6' : '5.6')).map(([, plan]) => plan.effort),
      ['Medium', 'Instant', 'Medium', 'High', 'Extra High', 'Pro'],
    );
  }
  const families = [...new Set(Object.values(workModels))];
  for (const family of families) {
    assert.deepEqual(
      Object.values(workSelectionPlans).filter(plan => plan.family === family).map(plan => plan.effort),
      [...workEfforts],
    );
  }
});

test('the full account catalogue renders as two Chat and eight Work base families', () => {
  const models = describeCatalogue({ models: catalogueSlugs.map(slug => ({ slug, title: slug })) });
  const chat = Object.values(models).filter(model => model.capabilities.reasoning && Object.keys(model.variants ?? {}).length === 5);
  const work = Object.values(models).filter(model => model.capabilities.reasoning && Object.keys(model.variants ?? {}).length === 6);
  assert.equal(chat.length, 2);
  assert.equal(work.length, 8);
  assert.equal(Object.keys(models).length, 17);
  for (const slug of ['gpt-5-6-instant', 'gpt-5-6-thinking', 'gpt-5-6-pro', 'gpt-6-instant', 'gpt-6-thinking', 'gpt-6-pro']) {
    assert.equal(Object.hasOwn(models, slug), false, slug);
  }
});

test('model descriptors expose effort variants on base families instead of duplicate model rows', () => {
  const models = describeCatalogue({ models: [
    { slug: 'gpt-5-6', title: 'GPT-5.6 Sol' },
    { slug: 'gpt-6', title: 'GPT-6' },
    { slug: 'gpt-6.1-sol-wm', title: 'GPT-6.1 Sol' },
  ] });
  assert.deepEqual(Object.keys(models), ['gpt-5-6', 'gpt-6', 'gpt-6.1-sol-wm']);
  assert.deepEqual(Object.keys(models['gpt-5-6'].variants), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(Object.keys(models['gpt-6'].variants), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(Object.keys(models['gpt-6.1-sol-wm'].variants), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(models['gpt-6.1-sol-wm'].name, 'GPT-6.1 Sol (Work - saved task)');
  assert.equal(models['gpt-5-6-high'], undefined);
  assert.equal(models['gpt-6-extra-high'], undefined);
});

test('request-only repeats use a distinct display name and exact model override', () => {
  assert.deepEqual(wireModels['gpt-6-t-mini'], {
    uiModel: 'gpt-6-thinking',
    name: 'GPT-6 Thinking (mini)',
  });
  const models = describeCatalogue({
    models: [
      { slug: 'gpt-6', title: 'GPT-6' },
      { slug: 'gpt-6-t-mini', title: 'GPT-6' },
    ],
  });
  assert.equal(models['gpt-6-t-mini'].name, 'GPT-6 Thinking (mini)');
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
