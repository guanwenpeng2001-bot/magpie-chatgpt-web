import { randomUUID } from 'node:crypto';
import { accountKeyFromSession, beginTracking, recordSubmission, recordTrackingGap } from './store.mjs';

// Same identity as the reference Limits receipt: user + account, never email,
// cookies, access tokens, or a previously cached browser account.
export async function readSubmissionAccount(page) {
  if (new URL(page.url()).origin !== 'https://chatgpt.com') return;
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== 'https://chatgpt.com' || url.pathname !== '/api/auth/session') return;
    const value = await response.json();
    if (value?.error != null && value.error !== '' || value?.expires != null &&
      (typeof value.expires !== 'string' || !Number.isFinite(Date.parse(value.expires)) || Date.parse(value.expires) <= Date.now())) return;
    return { user: { id: value?.user?.id }, account: { id: value?.account?.id } };
  });
  const accountKey = accountKeyFromSession(session);
  return accountKey ? { accountKey } : undefined;
}

export function nativeUsageModel(mode) {
  const family = ['5.6', '6'].includes(mode?.modelFamily) ? mode.modelFamily : undefined;
  if (mode?.effort === 'max') return family ? `gpt-${family}-pro` : 'pro-unknown';
  return family ? `gpt-${family}` : 'other';
}

/** Prepare before physical Send, confirm only after acceptance evidence. A new
 * physical Send gets a new object/ID; observation recovery retains the same one.
 * Accounting is optional and cannot fail, replay, or block a model response. */
export async function prepareSubmissionReceipt({ page, readAccount = () => readSubmissionAccount(page),
  profile, model, effort, stage = 'message', source, id = randomUUID(),
  now = Date.now, begin = beginTracking, record = recordSubmission, gap = recordTrackingGap,
  identityTimeoutMs = 5500, flushTimeoutMs = 500 } = {}) {
  let pending = Promise.resolve(), confirmed = false, uncertain = false, identity;
  const within = async (work, ms) => {
    let timeout;
    try { return await Promise.race([work, new Promise(resolve => { timeout = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timeout); }
  };
  // Failures and a hung optional identity observer never submit a different turn.
  try { identity = await within(Promise.resolve().then(readAccount), identityTimeoutMs); } catch {}
  const accountKey = identity?.accountKey;
  const usable = typeof accountKey === 'string' && /^[a-f0-9]{64}$/.test(accountKey);
  const base = { profile, accountKey, id, source, model, effort, stage };
  const enqueue = work => { pending = pending.then(work).catch(() => {}); };
  if (usable) enqueue(() => begin(base, { now: now() }));
  return {
    confirm() {
      if (confirmed) return;
      confirmed = true;
      if (usable) { const at = now(); enqueue(() => record({ ...base, at })); }
    },
    uncertain() {
      if (confirmed || uncertain) return;
      uncertain = true;
      if (usable) { const at = now(); enqueue(() => gap({ ...base, at })); }
    },
    async flush() { await within(pending, flushTimeoutMs); },
  };
}
