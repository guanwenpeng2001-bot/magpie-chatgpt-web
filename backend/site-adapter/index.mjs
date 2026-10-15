import { setTimeout as delay } from 'node:timers/promises';
import { ADAPTER_VERSION, shape } from './selectors.mjs';

const visible = (page, selector) => page.locator(selector).filter({ visible: true });
function failure(kind, detail) {
  const result = { ok: false, kind, detail: { ...detail, adapterVersion: ADAPTER_VERSION } };
  console.warn(JSON.stringify({ event: 'site-adapter-failure', ...result }));
  return result;
}

export async function selectModel(page, slug) {
  if (slug === 'auto') return { ok: true };
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
          if (!id && shape.titles[slug]?.includes(title)) matches.push(entry);
        }
        if (matches.length > 1) return failure('picker-ambiguous', { slug, count: matches.length });
        if (matches.length === 1) { await matches[0].click(); return { ok: true }; }
        return failure('model-not-offered', { slug });
      }
      await delay(shape.pollInterval);
    }
    return failure('picker-missing', { component: 'model entries', selector: shape.entries });
  } finally { await page.keyboard.press('Escape'); }
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
