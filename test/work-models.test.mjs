import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeWorkPage, selectWorkModel } from '../backend/site-adapter/work.mjs';
import { workModels } from '../backend/site-adapter/compatibility.mjs';

test('Work initializes its own surface and selects each exact Work model', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');document.querySelector('#picker').hidden=false">工作</button>
      <button id="picker" hidden data-composer-navigation-target="reasoning" aria-haspopup="menu" onclick="document.querySelector('[role=menu]').hidden=false">Default</button>
      <div role="menu" hidden>${Object.values(workModels).map(name => `<div role="menuitemradio" onclick="document.querySelector('#picker').textContent=this.textContent;this.parentElement.hidden=true">${name}</div>`).join('')}</div>`);
    await initializeWorkPage(page, { budget: 2000 });
    for (const [slug, family] of Object.entries(workModels)) {
      assert.deepEqual(await selectWorkModel(page, slug), { ok: true });
      assert.equal(await page.locator('#picker').innerText(), family);
    }
  } finally { await browser.close(); }
});
