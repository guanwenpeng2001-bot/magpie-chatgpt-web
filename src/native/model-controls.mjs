// Pinned 6.1.18 selection-error classification only. The caller must validate
// the original CLI checksum before composing source transforms. No runtime,
// account binding, model availability, or selected model is changed here.

// Self-contained DOM callbacks: serialized into the checksum-pinned bundle.
export function nativeDisabledProRow(root) {
  if (!root?.isConnected || root.getAttribute('role') !== 'menu') return null;
  const normalize = text => (text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const rows = [...root.querySelectorAll('[role="menuitemradio"]')]
    .filter(row => row.closest('[role="menu"]') === root && normalize(row.textContent) === 'Pro');
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row.isConnected || row.getAttribute('aria-disabled') !== 'true' || row.hasAttribute('aria-labelledby')
      || row.hasAttribute('aria-label') && normalize(row.getAttribute('aria-label')) !== 'Pro') return null;
  return row;
}

export async function nativeProExplicitlyDisabled(menu) {
  const handle = await menu.evaluateHandle(nativeDisabledProRow);
  try { return handle.asElement() !== null; } finally { await handle.dispose(); }
}

/** Only this row's linked, unique, visible tooltip is eligible evidence.
 * A portal tooltip outside the menu is valid if this exact row references it.
 * Do not collect general page text or fabricate/reset-time arithmetic.
 */
export async function nativeBoundProTooltip(row, root) {
  const document = row.ownerDocument, view = document.defaultView;
  const visible = element => {
    if (!element.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const deadline = Date.now() + 1000;
  do {
    if (!root.isConnected || !row.isConnected || row.ownerDocument !== root.ownerDocument
        || row.closest('[role="menu"]') !== root || row.getAttribute('aria-disabled') !== 'true') return null;
    const ids = (row.getAttribute('aria-describedby') ?? '').trim().split(/\s+/).filter(Boolean);
    if (ids.length > 8 || new Set(ids).size !== ids.length) return null;
    const tooltips = [];
    for (const id of ids) {
      const nodes = [...document.querySelectorAll('[id]')].filter(node => node.id === id);
      if (nodes.length > 1) return null;
      const node = nodes[0];
      if (node?.getAttribute('role') === 'tooltip' && visible(node)) tooltips.push(node);
    }
    if (tooltips.length > 1) return null;
    if (tooltips.length === 1) {
      const text = tooltips[0].textContent?.trim();
      if (text?.length > 2048) return null; // never truncate away the real reset text
      if (text) return text;
    }
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}

export function nativeProQuotaReason(reason) {
  if (typeof reason !== 'string' || reason.length > 2048) return false;
  const text = reason.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  return /^(?:\u5df2\u8fbe\u9650\u989d(?=[\u3002.!?\s]|$)|Usage limit (?:reached|exceeded)(?=[.!:\s]|$)|(?:You've|You\u2019ve|You have) (?:reached|hit|exceeded) (?:your |the )?(?:Pro )?usage limit\b)/i.test(text);
}

/** Open only the model-list view, then hover the disabled row. Never click Pro,
 * change slider values, change models, or accept an unbound caller reason.
 */
export async function nativeProLockEvidence(menu, { revealModelList }) {
  let root, handle, row, check;
  try {
    root = await menu.elementHandle({ timeout: 1000 });
    if (!root) return null;
    handle = await root.evaluateHandle(nativeDisabledProRow);
    row = handle.asElement();
    if (!row) return null;
    let reason = null;
    try {
      if (!await row.isVisible()) await revealModelList(menu);
      await row.waitForElementState('visible', { timeout: 2000 });
      await row.hover({ timeout: 1500 });
      reason = await row.evaluate(nativeBoundProTooltip, root);
    } catch { /* Explicitly disabled without readable quota evidence stays 400. */ }
    check = await root.evaluateHandle(nativeDisabledProRow);
    const current = check.asElement();
    if (!current || !await current.evaluate((element, original) => element === original, row)) return null;
    return { reason, quotaConfirmed: nativeProQuotaReason(reason) };
  } catch { return null; }
  finally {
    await Promise.allSettled([check, handle, root].filter(Boolean).map(value => value.dispose()));
  }
}

export function patchNativeModelControls(source, helpers = [nativeDisabledProRow, nativeBoundProTooltip, nativeProQuotaReason, nativeProLockEvidence]) {
  const proRangeGuard = 'if(u>L.max-L.min){let W=u===4?await l_(P):void 0;';
  if (typeof source !== 'string' || source.split(proRangeGuard).length !== 2) throw new Error('Native Pro range guard anchor mismatch');
  if (source.includes('magpieNativePro') || helpers.some(fn => source.includes(fn.name))) throw new Error('Native model-controls helper collision');
  return source.replace(proRangeGuard, proRangeGuard
    + 'if(u===4){let magpieProLock=await nativeProLockEvidence(P,{revealModelList:qd});if(magpieProLock)throw new q(magpieProLock.quotaConfirmed?"ChatGPT Pro usage limit reached for this account. The pending message was not sent. ChatGPT: "+magpieProLock.reason:"ChatGPT currently marks Pro unavailable for this account. The requested model was not selected and the pending message was not sent."+(magpieProLock.reason?" ChatGPT: "+magpieProLock.reason:""),{status:magpieProLock.quotaConfirmed?429:400,errorType:magpieProLock.quotaConfirmed?"rate_limit_error":"invalid_request_error",code:magpieProLock.quotaConfirmed?"rate_limit_exceeded":"chatgpt_effort_locked",retryable:!1,cause:Error(`ChatGPT Pro is explicitly disabled; requested effort index ${u}, slider range ${L.min}..${L.max}`)});}')
    + '\n' + helpers.map(fn => fn.toString()).join('\n') + '\n';
}
