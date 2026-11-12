import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../backend/site-adapter/index.mjs';

for (const available of [true, false]) test(`inline model picker verifies GPT-5.6 Pro rather than silently selecting Sol (available=${available})`, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-haspopup="menu" onclick="document.querySelector('[role=menu]').hidden=false">Medium</button>
      <div role="menu" hidden>
        <div role="menuitem" data-model-picker-view-toggle="true" onclick="document.querySelector('[role=menuitemradio]').hidden=false">5.6Medium</div>
        <div role="menuitemradio" hidden aria-checked="false" onclick="this.setAttribute('aria-checked','true')">GPT-5.6 Sol</div>
        <div role="menuitem" data-reasoning-slider="true" tabindex="0">Effort
          <div data-model-picker-power-slider><span role="slider" aria-valuenow="1" aria-valuemax="4"></span></div>
        </div>
      </div>
      <script>
        window.steps=0;
        document.querySelector('[data-reasoning-slider]').onkeydown=e=>{
          if(e.key!=='ArrowRight')return;
          const thumb=document.querySelector('[role=slider]');
          const next=Math.min(4,Number(thumb.getAttribute('aria-valuenow'))+1);
          setTimeout(()=>{window.steps++;thumb.setAttribute('aria-valuenow',next);
            document.querySelector('[data-model-picker-view-toggle]').textContent='5.6'+(next===4?'${available ? 'Pro' : 'Extended'}':'High');},20);
        };
      </script>`);
    const result = await selectModel(page, 'gpt-5-6-pro');
    assert.equal(result.ok, available);
    if (!available) assert.equal(result.kind, 'model-not-offered');
    assert.equal(await page.evaluate(() => window.steps), 3);
  } finally { await browser.close(); }
});
