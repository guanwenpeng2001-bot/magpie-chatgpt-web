import { BackendError } from '../guard.mjs';
import { workModels } from './compatibility.mjs';
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
  const family = workModels[slug];
  const picker = page.locator(pickerSelector).filter({ visible: true });
  if (await picker.count() !== 1) throw missing('Work model picker');
  await picker.click();
  try {
    const row = page.getByRole('menuitemradio', { name: family, exact: true }).filter({ visible: true });
    const toggle = page.locator('[role="menu"] [data-model-picker-view-toggle="true"]').filter({ visible: true });
    if (!await row.count() && await toggle.count() === 1) await toggle.click();
    if (await row.count() !== 1 || !await row.isEnabled() || await row.getAttribute('aria-disabled') === 'true') return { ok: false, kind: 'model-not-offered', detail: { slug } };
    await row.click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(expected => [...document.querySelectorAll('button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]')].some(button => button.innerText.split('\n')[0].trim() === expected), family, { timeout: 5000 });
    const selected = (await picker.innerText()).split('\n')[0].trim();
    if (selected !== family) return { ok: false, kind: 'model-not-offered', detail: { slug } };
    return { ok: true };
  } finally { await page.keyboard.press('Escape'); }
}

export async function stopWork(page) {
  if (page.isClosed()) return;
  const stop = page.getByRole('button', { name: /^(Stop|Stop generating|Stop task|停止|停止生成|停止任务)$/i }).filter({ visible: true });
  if (await stop.count() === 1) await stop.click({ timeout: 3000 });
}
