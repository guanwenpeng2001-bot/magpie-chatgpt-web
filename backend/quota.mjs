import { BackendError } from './guard.mjs';
import { accountKeyFromSession, readUsage } from '../src/usage/store.mjs';
import { POLICY_EVIDENCE } from '../src/usage/policy.mjs';

export const CHATGPT_PLANS = Object.freeze({
  free: 'ChatGPT Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro (prolite)', team: 'ChatGPT Team', business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu',
});

// The reference adapter's limits.ts verifies account.planType/isDelinquent in
// /api/auth/session. Neither the plan nor session expiry is an allowance/reset.
// No verified ChatGPT remaining-usage schema is available here. In particular,
// never interpret Codex /wham/usage, local token totals, or reference budget
// scenarios as measured Chat allowance. Local Send records remain separate.
export async function readQuota(client, signal, { profile, now } = {}) {
  const session = await client.session(signal, { interactive: false });
  if (session?.error != null && session.error !== '' || session?.expires != null
    && (typeof session.expires !== 'string' || !Number.isFinite(Date.parse(session.expires))
      || Date.parse(session.expires) <= Date.now())) throw new BackendError('expired');
  const account = session?.account;
  const planType = typeof account?.planType === 'string' && Object.hasOwn(CHATGPT_PLANS, account.planType)
    ? account.planType : undefined;
  let local;
  if (profile !== undefined) {
    const accountKey = accountKeyFromSession(session);
    if (!accountKey) local = { status: 'identity-unavailable' };
    else {
      try { local = await readUsage({ profile, accountKey }, { signal, now }); }
      catch { signal?.throwIfAborted(); local = { status: 'unavailable' }; }
    }
  }
  // Only these non-secret, allowlisted fields cross the backend bridge. Do not
  // return session/user objects, access/refresh tokens, ids, or upstream errors.
  return {
    state: 'unknown',
    reason: account?.isDelinquent === true ? 'payment-attention' : planType ? 'not-reported' : 'plan-not-reported',
    ...(planType ? { planType } : {}),
    ...(local ? { local, policy: POLICY_EVIDENCE, accountScope: account?.structure === 'personal' ? 'personal' : 'unknown' } : {}),
  };
}
