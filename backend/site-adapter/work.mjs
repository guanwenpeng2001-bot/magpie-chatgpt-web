import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from '../guard.mjs';
import { workSelectionPlans } from './compatibility.mjs';
import { ADAPTER_VERSION } from './selectors.mjs';

const pickerSelector = 'button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]';
const missing = component => new BackendError('pickerMissing', { values: { component, selector: pickerSelector, adapterVersion: ADAPTER_VERSION } });

export async function initializeWorkPage(page, { budget }) {
  const mode = page.getByRole('button', { name: /^(Work|工作)$/, exact: true });
  await mode.waitFor({ state: 'visible', timeout: budget });
  if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click({ timeout: budget });
  if (await mode.getAttribute('aria-pressed') !== 'true') throw missing('Work mode');
  await page.locator(pickerSelector).filter({ visible: true }).waitFor({ state: 'visible', timeout: budget });
}

export async function selectWorkModel(page, slug) {
  const plan = workSelectionPlans[slug];
  const family = plan.family;
  const picker = page.locator(pickerSelector).filter({ visible: true });
  if (await picker.count() !== 1) throw missing('Work model picker');
  await picker.click();
  try {
    const row = page.getByRole('menuitemradio', { name: family, exact: true }).filter({ visible: true });
    const toggle = page.locator('[role="menu"] [data-model-picker-view-toggle="true"]').filter({ visible: true });
    if (!await row.count() && await toggle.count() === 1) await toggle.click();
    if (await row.count() !== 1 || !await row.isEnabled() || await row.getAttribute('aria-disabled') === 'true') return { ok: false, kind: 'model-not-offered', detail: { slug } };
    await row.click();
    // Selecting a Work family closes the menu and commits Medium. Reopen the same picker
    // before selecting the slider position measured for the requested variant.
    await page.keyboard.press('Escape');
    await page.waitForFunction(expected => [...document.querySelectorAll('button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]')].some(button => button.innerText.split('\n')[0].trim() === expected), family, { timeout: 5000 });
    await picker.click();
    const effort = await selectWorkEffort(page, picker, slug, plan);
    if (effort) return effort;
    await page.keyboard.press('Escape');
    await page.waitForFunction(expected => [...document.querySelectorAll('button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]')].some(button => button.innerText.split('\n')[0].trim() === expected), family, { timeout: 5000 });
    const selected = (await picker.innerText()).split('\n')[0].trim();
    if (selected !== family) return { ok: false, kind: 'model-not-offered', detail: { slug } };
    return { ok: true };
  } finally { await page.keyboard.press('Escape'); }
}

async function selectWorkEffort(page, picker, slug, plan) {
  let control = page.locator('[role="menu"] [data-reasoning-slider="true"]').filter({ visible: true });
  // The current Work picker can land on its model list after reopening. A second click on
  // the picker switches that same menu to the effort slider.
  for (let attempt = 0; attempt < 2 && !await control.count(); attempt++) {
    await picker.click();
    await delay(150);
    control = page.locator('[role="menu"] [data-reasoning-slider="true"]').filter({ visible: true });
  }
  if (!await control.count()) return plan.effort === 'Medium' ? undefined : { ok: false, kind: 'model-not-offered', detail: { slug, stage: 'effort-control' } };
  const thumb = page.locator('[role="menu"] [data-model-picker-power-slider] [role="slider"]');
  if (await control.count() !== 1 || await thumb.count() !== 1) return { ok: false, kind: 'model-not-offered', detail: { slug, stage: 'effort-control' } };
  const maximum = Number(await thumb.getAttribute('aria-valuemax'));
  if (!Number.isInteger(maximum) || maximum < 5) return { ok: false, kind: 'model-not-offered', detail: { slug, stage: 'effort-range' } };
  const targets = { Light: 0, Medium: 1, High: 2, 'Extra High': 3, Max: 4, Ultra: 5 };
  const expectedEfforts = { Light: 'low', Medium: 'medium', High: 'high', 'Extra High': 'xhigh', Max: 'max', Ultra: 'ultra' };
  const target = Math.min(targets[plan.effort], maximum);
  const selectedState = async () => {
    const value = Number(await thumb.getAttribute('aria-valuenow'));
    const selectedEffort = await picker.getAttribute('data-selected-reasoning-effort');
    return {
      accepted: value === target && selectedEffort === expectedEfforts[plan.effort],
      value,
    };
  };
  for (let step = 0; step <= 12; step++) {
    const { accepted, value } = await selectedState();
    if (!Number.isInteger(value) || value < 0 || value > maximum) break;
    if (accepted) {
      await delay(150);
      if ((await selectedState()).accepted) return { ok: true };
      continue;
    }
    if (step === 12) break;
    await control.press(value < target ? 'ArrowRight' : 'ArrowLeft');
    try {
      await page.waitForFunction(previous => document.querySelector('[role="menu"] [data-model-picker-power-slider] [role="slider"]')?.getAttribute('aria-valuenow') !== previous, String(value), { timeout: 3000 });
    } catch { break; }
  }
  return { ok: false, kind: 'model-not-offered', detail: { slug, stage: 'effort-verification' } };
}

export async function stopWork(page) {
  if (page.isClosed()) return;
  const stop = page.getByRole('button', { name: /^(Stop|Stop generating|Stop task|停止|停止生成|停止任务)$/i }).filter({ visible: true });
  if (await stop.count() === 1) await stop.click({ timeout: 3000 });
}
