import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../backend/site-adapter/index.mjs';
import { siteAdapterHtml } from '../integrations/turn-fixture.mjs';

test('model selection identifies only the requested model', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const cases = [
      ['attribute', { rows: [{ slug: 'new-model', title: 'New model' }] }, 'new-model', undefined, 'new-model'],
      ['title fallback', { rows: [{ title: 'GPT-6' }] }, 'gpt-6', undefined, 'GPT-6'],
      ['unmapped title', { rows: [{ title: 'Unknown' }] }, 'unknown', 'model-not-offered'],
      ['own duplicate', { rows: [{ slug: 'gpt-6', title: 'One' }, { slug: 'gpt-6', title: 'Two' }] }, 'gpt-6', 'picker-ambiguous'],
      ['unrelated duplicate titles', { rows: [{ slug: 'gpt-6', title: 'Shared' }, { slug: 'other', title: 'Shared' }] }, 'gpt-6', undefined, 'gpt-6'],
      ['attribute beats title', { rows: [{ title: 'GPT-6' }, { slug: 'gpt-6', title: 'Different' }] }, 'gpt-6', undefined, 'gpt-6'],
      ['hidden duplicate', { rows: [{ slug: 'gpt-6', title: 'One' }, { slug: 'gpt-6', title: 'Two', hidden: true }] }, 'gpt-6', undefined, 'gpt-6'],
      ['ambiguous fallback', { rows: [{ title: 'GPT-6' }, { title: 'GPT-6' }] }, 'gpt-6', 'picker-ambiguous'],
      ['auto', { picker: 'missing' }, 'auto', undefined, undefined],
      ['direct rows', { picker: 'direct' }, 'gpt-6', undefined, 'gpt-6'],
    ];
    for (const [name, options, slug, kind, selected] of cases) await t.test(name, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(siteAdapterHtml(options));
        const result = await selectModel(page, slug);
        assert.equal(result.kind, kind);
        assert.equal(result.ok, !kind);
        assert.equal(await page.evaluate(() => window.selected), selected);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
