import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../backend/site-adapter/index.mjs';

// Captured structural attributes; the delayed replacement models the view transition.
function pickerHtml(mode) {
  const decoyMenu = mode === 'hidden-decoy-menu' ? '<div role="menu" style="display:none"></div>'
    : mode === 'empty-decoy-menu' ? '<div role="menu"></div>'
    : mode === 'populated-decoy-menu' ? '<div role="menu"><div>Other dropdown</div></div>' : '';
  return `<!doctype html><title>Offline picker</title>
    ${decoyMenu}
    <button data-codex-intelligence-trigger="true" aria-haspopup="menu" data-composer-navigation-target="reasoning">选择 ChatGPT 模型</button>
    <div role="menu" id="picker-menu"></div>
    <script>
      const mode = ${JSON.stringify(mode)};
      const trigger = document.querySelector('button');
      const menu = document.getElementById('picker-menu');
      window.toggleClicks = 0;
      const models = () => {
        menu.innerHTML = '<div role="menuitemradio" aria-checked="true">GPT-6</div><div role="menuitemradio">GPT-5.6 Sol</div><div role="menuitemradio">GPT-5.5<br>Leaving on October 14</div>';
        if (mode === 'ambiguous') menu.innerHTML += '<div role="menuitemradio">GPT-6</div>';
        if (mode === 'hidden') menu.innerHTML += '<div role="menuitemradio" style="display:none">GPT-6</div>';
        for (const entry of menu.querySelectorAll('[role="menuitemradio"]')) entry.onclick = () => { window.selected = entry.innerText.split('\\n')[0]; };
      };
      const toggle = () => {
        const node = document.createElement('div'); node.setAttribute('role', 'menuitem'); node.dataset.modelPickerViewToggle = 'true'; node.textContent = 'Instant';
        node.onclick = () => { window.toggleClicks++; menu.replaceChildren(); setTimeout(models, 200); };
        menu.prepend(node);
      };
      if (mode === 'late-trigger') trigger.remove();
      if (mode === 'never-trigger') trigger.remove();
      if (mode === 'two-triggers') document.body.append(trigger.cloneNode(true));
      const attachTrigger = () => document.body.prepend(trigger);
      trigger.onclick = () => {
        if (mode === 'delayed') { toggle(); const empty = document.createElement('div'); empty.setAttribute('role', 'menuitem'); menu.append(empty); }
        else if (mode === 'slow-menu') { setTimeout(toggle, 3500); }
        else { models(); if (mode === 'already-applied') toggle(); }
      };
      if (['late-trigger', 'never-trigger'].includes(mode)) {
        trigger.setAttribute('aria-expanded', 'false');
        if (mode === 'late-trigger') setTimeout(attachTrigger, 3000);
      }
    </script>`;
}

const ALWAYS = ['delayed', 'no-toggle', 'already-applied', 'ambiguous', 'hidden', 'late-trigger', 'slow-menu', 'two-triggers', 'hidden-decoy-menu', 'empty-decoy-menu', 'populated-decoy-menu'];

test('picker view transitions in an offline browser', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  if (process.env.PICKER_TRACE) await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    for (const mode of ALWAYS) await t.test(mode, async () => {
      const page = await context.newPage();
      try {
        const started = Date.now();
        await page.setContent(pickerHtml(mode));
        const result = await selectModel(page, 'gpt-6');
        const state = await page.evaluate(() => ({ selected: window.selected, toggleClicks: window.toggleClicks }));
        console.log(JSON.stringify({ mode, kind: result.kind, milliseconds: Date.now() - started, ...state }));
        if (mode === 'ambiguous') { assert.equal(result.kind, 'picker-ambiguous'); assert.equal(state.selected, undefined); }
        else { assert.equal(result.ok, true); assert.equal(state.selected, 'GPT-6'); }
        assert.equal(state.toggleClicks, ['delayed', 'slow-menu'].includes(mode) ? 1 : 0);
      } finally { await page.close(); }
    });
    await t.test('never-trigger fails bounded with picker-missing', async () => {
      const page = await context.newPage();
      try {
        const started = Date.now();
        await page.setContent(pickerHtml('never-trigger'));
        const result = await selectModel(page, 'gpt-6');
        const milliseconds = Date.now() - started;
        console.log(JSON.stringify({ mode: 'never-trigger', kind: result.kind, milliseconds }));
        assert.equal(result.kind, 'picker-missing');
        assert.ok(milliseconds >= 7000 && milliseconds < 15000, `bounded wait took ${milliseconds} ms`);
      } finally { await page.close(); }
    });
  } finally {
    if (process.env.PICKER_TRACE) await context.tracing.stop({ path: process.env.PICKER_TRACE });
    await browser.close();
  }
});
