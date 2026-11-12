import { setTimeout as delay } from 'node:timers/promises';
import { ADAPTER_VERSION, shape } from './selectors.mjs';
import { BackendError } from '../guard.mjs';
import { selectionPlans, unsupportedModels, workSelectionPlans, wireModels } from './compatibility.mjs';
import { selectWorkModel } from './work.mjs';
export { initializeWorkPage, stopWork } from './work.mjs';
import { IMAGE_MODEL, selectImageTool } from './images.mjs';
export { initializeImagePage, readGeneratedImages } from './images.mjs';

const visible = (page, selector) => page.locator(selector).filter({ visible: true });
function failure(kind, detail) {
  const result = { ok: false, kind, detail: { ...detail, adapterVersion: ADAPTER_VERSION } };
  console.warn(JSON.stringify({ event: 'site-adapter-failure', ...result }));
  return result;
}

export async function selectModel(page, slug) {
  if (slug === 'auto') return { ok: true };
  if (Object.hasOwn(wireModels, slug)) return selectModel(page, wireModels[slug].uiModel);
  if (slug === IMAGE_MODEL) {
    const instant = await selectModel(page, 'gpt-6-instant');
    if (!instant.ok) return instant;
    return selectImageTool(page);
  }
  if (Object.hasOwn(workSelectionPlans, slug)) return selectWorkModel(page, slug);
  if (Object.hasOwn(unsupportedModels, slug)) return failure('model-unsupported', { slug });
  const plan = Object.hasOwn(selectionPlans, slug) ? selectionPlans[slug] : undefined;
  const choose = async entries => {
    const matches = [];
    for (const entry of await entries.all()) if (await entry.getAttribute(shape.modelId) === slug) matches.push(entry);
    if (matches.length > 1) return failure('picker-ambiguous', { slug, count: matches.length });
    if (matches.length === 1) { await matches[0].click(); return { ok: true }; }
  };
  const direct = await choose(visible(page, shape.modelRows));
  if (direct) return direct;
  const picker = visible(page, shape.picker).first();
  try { await picker.waitFor({ state: 'visible', timeout: shape.pickerTimeout }); }
  catch { return failure('picker-missing', { component: 'picker', selector: shape.picker }); }
  await picker.click();
  try {
    let toggled = false;
    const deadline = Date.now() + shape.transitionTimeout;
    while (Date.now() < deadline) {
      const entries = visible(page, shape.entries);
      const machine = await choose(visible(page, shape.modelRows));
      if (machine) return machine;
      const toggle = visible(page, shape.toggle);
      if (!toggled && await toggle.count()) {
        await toggle.first().click();
        toggled = true;
        await delay(shape.pollInterval);
        continue;
      }
      if (await entries.count()) {
        const matches = [];
        for (const entry of await entries.all()) {
          const id = await entry.getAttribute(shape.modelId);
          const title = (await entry.innerText()).split('\n')[0].trim();
          if (!id && (shape.titles[slug]?.includes(title) || (plan && title === plan.family))) matches.push(entry);
        }
        if (matches.length > 1) return failure('picker-ambiguous', { slug, count: matches.length });
        if (matches.length === 1) {
          await matches[0].click();
          return plan ? await selectPickerEffort(page, picker, slug, plan) : { ok: true };
        }
        return failure('model-not-offered', { slug, stage: 'model-rows' });
      }
      await delay(shape.pollInterval);
    }
    return failure('picker-missing', { component: 'model entries', selector: shape.entries });
  } finally { await page.keyboard.press('Escape'); }
}

async function selectPickerEffort(page, picker, slug, plan) {
  // Older pickers offer a base model directly without an effort surface.
  // Only exact base IDs may use that contract; named effort variants must
  // still prove their requested setting.
  if (['gpt-5-6', 'gpt-6'].includes(slug) && await page.locator('[data-model-picker-power-slider]').count() === 0) return { ok: true };
  let control = visible(page, '[role="menu"] [data-reasoning-slider="true"]');
  if (!await control.count()) await picker.click();
  control = visible(page, '[role="menu"] [data-reasoning-slider="true"]');
  const thumb = page.locator('[role="menu"] [data-model-picker-power-slider] [role="slider"]');
  if (await control.count() !== 1 || await thumb.count() !== 1) return failure('picker-missing', { component: 'model effort control', selector: '[data-reasoning-slider="true"]' });
  const maximum = Number(await thumb.getAttribute('aria-valuemax'));
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5) return failure('model-not-offered', { slug, stage: 'effort-verification' });
  const targets = { Instant: 0, Medium: 1, High: 2, 'Extra High': 3, Pro: 4 };
  const target = targets[plan.effort];
  if (!Number.isInteger(target) || maximum < target) {
    return failure('model-not-offered', { slug, stage: 'effort-verification' });
  }
  const selectedState = async () => {
    const selected = page.locator('[role="menu"] [role="menuitemradio"][aria-checked="true"]');
    const family = await selected.count() === 1 ? (await selected.textContent()).trim() : '';
    const value = Number(await thumb.getAttribute('aria-valuenow'));
    const header = (await visible(page, shape.toggle).textContent() ?? '').replace(/\s+/g, '');
    return { accepted: family === plan.family && value === target && !/unavailable|notavailable|locked|不可用|無法使用|已锁定|已鎖定/i.test(header), value };
  };
  for (let step = 0; step <= 10; step++) {
    const { accepted, value } = await selectedState();
    if (!Number.isInteger(value) || value < 0 || value > maximum) break;
    if (accepted) {
      await delay(shape.pollInterval);
      if ((await selectedState()).accepted) return { ok: true };
      continue;
    }
    if (step === 10) break;
    await control.press(value < target ? 'ArrowRight' : 'ArrowLeft');
    try {
      await page.waitForFunction(previous => document.querySelector('[role="menu"] [data-model-picker-power-slider] [role="slider"]')?.getAttribute('aria-valuenow') !== previous, value, { timeout: shape.transitionTimeout });
    } catch { break; }
  }
  return failure('model-not-offered', { slug, stage: 'effort-verification' });
}

export async function assertTemporaryChat(page) {
  const indicated = async () => {
    if (await visible(page, shape.temporaryIndicator).count()) return true;
    for (const label of shape.temporaryLabels) if (await page.getByText(label, { exact: true }).filter({ visible: true }).count()) return true;
    for (const label of shape.temporaryButtonLabels) if (await page.getByRole('button', { name: label, exact: true }).filter({ visible: true }).count()) return true;
    return false;
  };
  if (await indicated()) return true;
  const url = new URL(new URL(page.url()).origin);
  url.searchParams.set(shape.temporaryParam, shape.temporaryValue);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  if (await indicated()) return true;
  failure('temp-chat-unconfirmed');
  return { ok: false, kind: 'temp-chat-unconfirmed' };
}

export async function probePageError(page) {
  return page.evaluate(s => {
    const visible = node => !!(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
    const nodes = selector => [...document.querySelectorAll(selector)].filter(visible);
    const matches = (pattern, text) => new RegExp(pattern, 'i').test(text);
    const dialogs = nodes(s.dialogs).map(node => node.innerText).join('\n');
    let evidence;
    if (matches(s.challengeTitle, document.title)) evidence = 'challenge-title';
    else if (!nodes(s.composer).length && [...document.scripts].some(script => /\/cdn-cgi\/challenge-platform\//.test(script.src)) && (/__cf_chl_/.test(location.search) || [...document.scripts].some(script => /__cf_chl_/.test(script.textContent)))) evidence = 'challenge-structure';
    else if (nodes(s.frames).some(node => matches(s.challengeFrame, node.title))) evidence = 'challenge-frame';
    else if (nodes(s.challengeCards).some(node => matches(s.challengeCard, node.innerText))) evidence = 'challenge-card';
    else if (matches(s.challengeDialog, dialogs)) evidence = 'challenge-dialog';
    if (evidence) return { kind: 'challenge', evidence };
    if (matches(s.rateLimit, dialogs)) return { kind: 'rate-limit', evidence: 'rate-limit-dialog' };
    if (!nodes(s.composer).length && nodes(s.buttons).some(node => matches(s.signIn, node.innerText.trim()))) return { kind: 'sign-in', evidence: 'sign-in-button-without-composer' };
    return null;
  }, shape);
}

export async function readComposer(page) {
  if (await visible(page, shape.composer).count() === 1) return { ok: true };
  failure('composer-missing', { component: 'composer', selector: shape.composer });
  return { ok: false, kind: 'composer-missing' };
}

export async function submitPrompt(page, composer) {
  const candidates = [
    visible(page, shape.send),
    page.getByRole('button', { name: /^(send|发送)$/i }).filter({ visible: true }),
  ];
  for (const candidate of candidates) {
    if (await candidate.count() && await candidate.last().isEnabled()) {
      await candidate.last().click();
      return { ok: true };
    }
  }
  await composer.press('Enter');
  return { ok: true };
}

// DOMContentLoaded can precede the site's own checks and hydrated composer.
// Observe the same page; never reload, submit or interact with a challenge.
export async function waitForReady(page, { signal, budget, requirePicker = false }) {
  const deadline = Date.now() + budget;
  let state;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new BackendError('browserClosed');
    try {
      state = await probePageError(page);
      if (state?.kind === 'rate-limit' || state?.kind === 'sign-in') return;
      if (!state && await visible(page, shape.composer).count() === 1) {
        const picker = visible(page, shape.picker);
        if (!requirePicker || (await picker.count() === 1 && await picker.isEnabled() && await picker.getAttribute('data-disabled') === null && await picker.getAttribute('aria-disabled') !== 'true')) return;
      }
    } catch (error) {
      // The site may navigate while its initial check completes.
      if (!/Execution context was destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    await delay(Math.min(200, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new BackendError(state?.kind === 'challenge' ? 'verification' : 'pageShape');
}

export async function attachImages(page, images) {
  if (!images.length) return { ok: true };
  const inputs = page.locator(shape.fileInput);
  if (!await inputs.count()) return failure('attach-unavailable', { component: 'file input', selector: shape.fileInput });
  try {
    await inputs.first().setInputFiles(images.map((image, index) => ({ name: `image-${index + 1}`, mimeType: image.mediaType, buffer: Buffer.from(image.dataBase64, 'base64') })));
  } catch { return failure('image-rejected', { reason: 'file input refused the upload' }); }
  for (const alert of await visible(page, shape.uploadError).all()) {
    if (new RegExp(shape.uploadRejected, 'i').test(await alert.innerText())) return failure('image-rejected', { reason: 'upload rejection displayed' });
  }
  return { ok: true };
}

export async function completionState(page) {
  const result = await page.evaluate(s => {
    const turns = [...document.querySelectorAll(s.currentTurn)];
    const current = [...document.querySelectorAll(s.currentAssistant)];
    const stop = [...document.querySelectorAll(s.buttons)].some(node => node.getClientRects().length && new RegExp(s.stop, 'i').test(node.getAttribute('aria-label') ?? node.textContent));
    // Current layout wins even while its newest turn has no assistant yet.
    if (turns.length || current.length) {
      const turn = turns.at(-1);
      const answer = turn ? turn.querySelector(s.currentAssistant) : current.at(-1);
      const state = answer?.closest(s.currentState)?.getAttribute(s.stateAttribute);
      return { complete: !!answer && state === s.completeValue && !stop, layout: 'current', signal: state ?? 'pending' };
    }
    const answer = [...document.querySelectorAll(s.legacyAssistant)].at(-1);
    const container = answer?.closest(s.legacyTurn) ?? answer;
    const stateNode = answer?.closest(s.legacyState) ?? container?.querySelector(s.legacyState);
    const state = s.legacyAttributes.map(attribute => stateNode?.getAttribute(attribute)).find(Boolean);
    return { complete: !!answer && s.legacyComplete.includes(state) && !stop, layout: 'legacy', signal: state ?? 'pending' };
  }, shape);
  console.error(JSON.stringify({ event: 'site-adapter-completion', adapterVersion: ADAPTER_VERSION, ...result }));
  return result;
}
