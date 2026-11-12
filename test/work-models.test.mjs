import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeWorkPage, selectWorkModel } from '../backend/site-adapter/work.mjs';
import { workModels, workSelectionPlans } from '../backend/site-adapter/compatibility.mjs';

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

test('Work selects all six effort slots by slider position', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');document.querySelector('#picker').hidden=false">工作</button>
      <button id="picker" hidden data-composer-navigation-target="reasoning" aria-haspopup="menu" data-selected-reasoning-effort="medium" onclick="const m=document.querySelector('[role=menu]');const s=document.querySelector('[data-reasoning-slider=true]');if(!m.hidden&&s.hidden){s.hidden=false;this.textContent='选择推理强度'}else m.hidden=false">GPT-6.1 Sol</button>
      <div role="menu" hidden>
        <div role="menuitemradio" aria-checked="true" onclick="document.querySelector('#picker').textContent='GPT-6.1 Sol';this.parentElement.hidden=true">GPT-6.1 Sol</div>
        <div data-reasoning-slider="true" tabindex="0" hidden style="height:40px;width:240px" onkeydown="if(event.key==='ArrowRight'||event.key==='ArrowLeft'){const t=document.querySelector('[role=slider]');const d=event.key==='ArrowRight'?1:-1;const n=Math.max(0,Math.min(5,Number(t.getAttribute('aria-valuenow'))+d));t.setAttribute('aria-valuenow',String(n));const e=['low','medium','high','xhigh','max','ultra'][n];document.querySelector('#picker').setAttribute('data-selected-reasoning-effort',e)}">
          <div data-model-picker-power-slider="true"><div role="slider" aria-valuemin="0" aria-valuemax="5" aria-valuenow="1"></div></div>
        </div>
      </div>
      <script>document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;document.querySelector('[role=menu]').hidden=true;document.querySelector('#picker').textContent='GPT-6.1 Sol'})</script>`);
    await initializeWorkPage(page, { budget: 2000 });
    const expected = {
      Light: 'low', Medium: 'medium', High: 'high',
      'Extra High': 'xhigh', Max: 'max', Ultra: 'ultra',
    };
    for (const [effort, internal] of Object.entries(expected)) {
      const slug = workSelectionPlans['gpt-6.1-sol-wm']
        ? Object.entries(workSelectionPlans).find(([, plan]) => plan.family === 'GPT-6.1 Sol' && plan.effort === effort)[0]
        : undefined;
      assert.deepEqual(await selectWorkModel(page, slug), { ok: true });
      assert.equal(await page.locator('#picker').getAttribute('data-selected-reasoning-effort'), internal);
    }
  } finally { await browser.close(); }
});
