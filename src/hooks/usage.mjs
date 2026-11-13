import { CHATGPT_PLANS } from '../../backend/quota.mjs';
import { BackendError } from '../bridge.mjs';
import { requireAuth } from './auth.mjs';

const reasons = Object.freeze({
  'not-reported': 'ChatGPT did not report remaining allowance or reset times in the verified account response.',
  'plan-not-reported': 'The account response did not provide a recognized ChatGPT plan or remaining allowance.',
  'payment-attention': 'ChatGPT reports a subscription payment issue; check your plan in ChatGPT settings. Remaining allowance is not reported.',
  expired: 'The ChatGPT sign-in has expired; sign in again to read account information.',
  verification: 'ChatGPT requires verification; this allowance read cannot open a browser.',
  cooldown: 'ChatGPT rate-limited the account read. This does not establish the remaining chat allowance.',
  requestBudget: 'The ChatGPT account read timed out.',
  backendDown: 'The ChatGPT Web backend is unavailable.',
  protocol: 'The ChatGPT account response was not in a supported format.',
  upstream: 'The ChatGPT account information could not be read.',
});

function unknown(reason, planType) {
  const why = Object.hasOwn(reasons, reason) ? reason : 'protocol';
  return {
    ...(typeof planType === 'string' && Object.hasOwn(CHATGPT_PLANS, planType) ? { plan: CHATGPT_PLANS[planType] } : {}),
    // Missing used is essential: the host treats 0 as a measured 100% left.
    // A text-only window keeps the card visible without ranking this account
    // as full or exhausted. Transient read failures must not clear sign-in state.
    windows: [{ name: 'ChatGPT allowance', display: `Unknown — ${reasons[why]}`, aside: true }],
    signIn: why === 'expired' ? 'expired' : 'kept',
  };
}

// Magpie 0.1.3930 auth.usage(getAuth, provider, { signal }), distinct from
// input.magpie.usage(), which records tokens for individual model requests.
export function usageHook({ bridge, profileRoot }) {
  return async (getAuth, _provider, { signal } = {}) => {
    signal?.throwIfAborted();
    try {
      const auth = requireAuth(await getAuth());
      signal?.throwIfAborted();
      const quota = await bridge.call({ method: 'quota', auth, profileRoot }, signal);
      signal?.throwIfAborted();
      if (quota?.state !== 'unknown' || !['not-reported', 'plan-not-reported', 'payment-attention'].includes(quota.reason)) {
        return unknown('protocol');
      }
      return unknown(quota.reason, quota.planType);
    } catch (error) {
      signal?.throwIfAborted();
      return unknown(error instanceof BackendError ? error.code : 'upstream');
    }
  };
}
