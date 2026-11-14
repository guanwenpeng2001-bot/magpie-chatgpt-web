import { CHATGPT_PLANS } from '../../backend/quota.mjs';
import { BackendError } from '../bridge.mjs';
import { requireAuth } from './auth.mjs';
import { localUsageWindows } from '../usage/display.mjs';
import { cleanSetupResult } from '../native/setup.mjs';

const reasons = Object.freeze({
  'not-reported': '接口未返回额度',
  'plan-not-reported': '套餐未识别',
  'payment-attention': '订阅付款异常',
  expired: '登录已过期，请重新登录',
  verification: '账号需要验证',
  cooldown: '查询限流，请稍后重试',
  requestBudget: '查询超时',
  backendDown: '插件后端不可用',
  protocol: '账号响应格式不支持',
  upstream: '账号信息读取失败',
});

function unknown(reason, planType, local) {
  const why = Object.hasOwn(reasons, reason) ? reason : 'protocol';
  const localWindows = local === undefined ? [] : localUsageWindows(local);
  if (localWindows === null) return unknown('protocol', planType);
  return {
    ...(typeof planType === 'string' && Object.hasOwn(CHATGPT_PLANS, planType) ? { plan: CHATGPT_PLANS[planType] } : {}),
    // Missing used is essential: the host treats 0 as a measured 100% left.
    // A text-only window keeps the card visible without ranking this account
    // as full or exhausted. Transient read failures must not clear sign-in state.
    windows: [...localWindows, { name: '账号额度', display: why === 'not-reported' ? '未提供' : `未知：${reasons[why]}`, aside: true }],
    signIn: why === 'expired' ? 'expired' : 'kept',
  };
}

// Magpie 0.1.3930 auth.usage(getAuth, provider, { signal }), distinct from
// input.magpie.usage(), which records tokens for individual model requests.
export function usageHook({ bridge, profileRoot, native, input }) {
  return async (getAuth, _provider, { signal } = {}) => {
    signal?.throwIfAborted();
    let setup;
    const withSetup = result => {
      if (setup) result.windows.push({ name: 'Native tools setup', display: setup.message, aside: true });
      return result;
    };
    try {
      const auth = requireAuth(await getAuth());
      signal?.throwIfAborted();
      if (native?.status && input?.magpie?.option?.('chatgpt-web', 'native-tools') !== false) {
        try { setup = cleanSetupResult(await native.status(auth)); }
        catch { setup = cleanSetupResult({ state: 'failed', stage: 'verify' }); }
      }
      signal?.throwIfAborted();
      const quota = await bridge.call({ method: 'quota', auth, profileRoot }, signal);
      signal?.throwIfAborted();
      if (quota?.state !== 'unknown' || !['not-reported', 'plan-not-reported', 'payment-attention'].includes(quota.reason)) {
        return withSetup(unknown('protocol'));
      }
      return withSetup(unknown(quota.reason, quota.planType, quota.local));
    } catch (error) {
      signal?.throwIfAborted();
      return withSetup(unknown(error instanceof BackendError ? error.code : 'upstream'));
    }
  };
}
