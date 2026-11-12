import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../backend/site-adapter/index.mjs';

for (const [base, family, version] of [['gpt-5-6', 'GPT-5.6 Sol', '5.6'], ['gpt-6', 'GPT-6', '']])
for (const [suffix, effort] of [['', 'Medium'], ['-instant', 'Instant'], ['-thinking', 'Medium'], ['-pro', 'Pro']])
for (const available of [true, false]) test(`inline model picker verifies ${base + suffix} without a silent downgrade (available=${available})`, async () => {
  const slug = base + suffix;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-haspopup="menu" onclick="document.querySelector('[role=menu]').hidden=false">Medium</button>
      <div role="menu" hidden>
        <div role="menuitem" data-model-picker-view-toggle="true" onclick="document.querySelector('[role=menuitemradio]').hidden=false">${version}Unknown</div>
        <div role="menuitemradio" hidden aria-checked="false" onclick="this.setAttribute('aria-checked','true')">${family}</div>
        <div role="menuitem" data-reasoning-slider="true" tabindex="0">Effort
          <div data-model-picker-power-slider><span role="slider" aria-valuenow="3" aria-valuemax="4"></span></div>
        </div>
      </div>
      <script>
        window.steps=0;
        document.querySelector('[data-reasoning-slider]').onkeydown=e=>{
          if(!['ArrowRight','ArrowLeft'].includes(e.key))return;
          const thumb=document.querySelector('[role=slider]');
          const next=Math.max(0,Math.min(4,Number(thumb.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1)));
          window.steps++;thumb.setAttribute('aria-valuenow',next);
          document.querySelector('[data-model-picker-view-toggle]').textContent='${version}'+(${available} ? ['即时','中','高','极高','Pro'][next] : 'Unavailable');
        };
      </script>`);
    const result = await selectModel(page, slug);
    assert.equal(result.ok, available);
    if (!available) assert.equal(result.kind, 'model-not-offered');
    if (available) {
      const value = { Instant: '0', Medium: '1', Pro: '4' }[effort];
      assert.equal(await page.locator('[role="slider"]').getAttribute('aria-valuenow'), value);
    }
  } finally { await browser.close(); }
});
