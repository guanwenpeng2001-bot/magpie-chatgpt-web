import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import * as adapter from '../backend/site-adapter/index.mjs';
import { annotate } from '../backend/site-adapter/compatibility.mjs';
import { createTurnFixture, siteAdapterHtml } from '../integrations/turn-fixture.mjs';

test('adapter fixtures exercise page boundaries', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const picker of ['single', 'duplicate', 'hidden-first', 'toggle']) await t.test(`picker ${picker}`, async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ picker }));
      assert.deepEqual(await adapter.selectModel(page, 'gpt-6'), { ok: true });
      assert.equal(await page.evaluate(() => window.selected), 'gpt-6');
      await page.close();
    });
    for (const rate of ['Usage limit reached', '达到使用上限', 'limite atteinte', 'límite alcanzado', 'Limit erreicht', 'limite atingido', '上限に達しました', '한도에 도달']) await t.test(`rate ${rate}`, async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ rate, composer: 'none', signIn: true }));
      assert.equal((await adapter.probePageError(page)).kind, 'rate-limit');
      await page.close();
    });
    for (const composer of ['textarea', 'editable', 'none']) await t.test(`composer ${composer}`, async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ composer, signIn: true }));
      assert.equal((await adapter.readComposer(page)).ok, composer !== 'none');
      assert.equal((await adapter.probePageError(page))?.kind, composer === 'none' ? 'sign-in' : undefined);
      await page.close();
    });
    for (const layout of ['current', 'legacy']) for (const complete of [true, false]) await t.test(`${layout} ${complete}`, async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ layout, complete }));
      const result = await adapter.completionState(page);
      assert.equal(result.layout, layout); assert.equal(result.complete, complete);
      await page.close();
    });
    await t.test('current pending turn supersedes complete legacy answer and copy button', async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ layout: 'legacy', complete: true }));
      await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div data-turn-key="new"></div><button aria-label="Copy">Copy</button>'); });
      assert.deepEqual(await adapter.completionState(page), { complete: false, layout: 'current', signal: 'pending' });
      await page.close();
    });
    for (const [images, rejectImage, kind] of [[true, false, undefined], [false, false, 'attach-unavailable'], [true, true, 'image-rejected']]) await t.test(`images ${images}/${rejectImage}`, async () => {
      const page = await browser.newPage();
      await page.setContent(siteAdapterHtml({ images, rejectImage }));
      const result = await adapter.attachImages(page, [{ mediaType: 'image/png', dataBase64: 'aGVsbG8=', bytes: 5 }]);
      assert.equal(result.kind, kind);
      if (images) assert.deepEqual(await page.evaluate(() => window.uploaded), [{ name: 'image-1', type: 'image/png', size: 5 }]);
      await page.close();
    });
    await t.test('temporary indicator primary and URL fallback with one retry', async () => {
      const fixture = await createTurnFixture({ siteAdapter: { temporary: false } });
      const page = await browser.newPage();
      try {
        await page.goto(fixture.origin);
        let navigations = 0;
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
        assert.equal(await adapter.assertTemporaryChat(page), true);
        assert.equal(navigations, 1);
        assert.equal(await adapter.assertTemporaryChat(page), true);
        assert.equal(navigations, 1);
        await page.setContent(siteAdapterHtml({ temporary: true }));
        await page.evaluate(() => history.replaceState(null, '', '/'));
        assert.equal(await adapter.assertTemporaryChat(page), true);
        await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<script>history.replaceState(null,"","/")</script>' }));
        await page.goto(fixture.origin);
        const before = navigations;
        assert.deepEqual(await adapter.assertTemporaryChat(page), { ok: false, kind: 'temp-chat-unconfirmed' });
        assert.equal(navigations - before, 2);
      } finally { await page.close(); await fixture.close(); }
    });
  } finally { await browser.close(); }
});

test('annotation preserves unknown and unusual slugs', () => {
  for (const slug of ['auto', 'gpt-6', 'future-slug', '__proto__']) assert.deepEqual(annotate(slug, 'Title'), { name: 'Title', imageOk: false, knownBroken: null });
});

test('missing picker has its own failure kind', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<textarea></textarea>');
    assert.equal((await adapter.selectModel(page, 'gpt-6')).kind, 'picker-missing');
  } finally { await browser.close(); }
});
