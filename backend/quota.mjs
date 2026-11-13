import { BackendError } from './guard.mjs';

export const CHATGPT_PLANS = Object.freeze({
  free: 'ChatGPT Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro (prolite)', team: 'ChatGPT Team', business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu',
});

// The reference adapter's limits.ts verifies account.planType/isDelinquent in
// /api/auth/session. Neither the plan nor session expiry is an allowance/reset.
// No verified ChatGPT remaining-usage schema is available here. In particular,
// never interpret Codex /wham/usage, local token totals, or plan marketing caps.
export async function readQuota(client, signal) {
  const session = await client.session(signal, { interactive: false });
  if (session?.error != null && session.error !== '' || session?.expires != null
    && (typeof session.expires !== 'string' || !Number.isFinite(Date.parse(session.expires))
      || Date.parse(session.expires) <= Date.now())) throw new BackendError('expired');
  const account = session?.account;
  const planType = typeof account?.planType === 'string' && Object.hasOwn(CHATGPT_PLANS, account.planType)
    ? account.planType : undefined;
  // Only these non-secret, allowlisted fields cross the backend bridge. Do not
  // return session/user objects, access/refresh tokens, ids, or upstream errors.
  return {
    state: 'unknown',
    reason: account?.isDelinquent === true ? 'payment-attention' : planType ? 'not-reported' : 'plan-not-reported',
    ...(planType ? { planType } : {}),
  };
}
