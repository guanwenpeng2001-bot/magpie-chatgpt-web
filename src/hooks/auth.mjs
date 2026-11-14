import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from '../bridge.mjs';
import { signinProfileClaim, releaseSigninProfileClaim, unlockSigninProfile, signinTimeoutWindow, browserProxy } from '../../backend/browser.mjs';
import { makeLoader } from '../loader.mjs';
import { PROVIDER } from './config.mjs';
import { nativeSetupMethod, reportSetupStatus } from './native-setup.mjs';

export function requireAuth(auth) {
  if (auth?.type !== 'oauth' || typeof auth.refresh !== 'string' || !auth.refresh) throw new BackendError('expired');
  return auth;
}

export function authHook(env) {
  const { bridge, profileRoot, pollMilliseconds = 2000 } = env;
  return {
    provider: PROVIDER,
    refreshLead: 24 * 3600_000,
    options: [{ key: 'visible-turns', label: 'Show browser during chats',
      description: 'Keep installed Chrome visible during chats. Leave this off for background chats; verification automatically reveals the same Chrome window for recovery.', default: false },
      { key: 'native-tools', label: 'Native tools mode', description: 'Set up native Codex tools and an OpenAI tunnel. Native mode sends the original Codex history and local paths to ChatGPT without gateway masking, so tools can use the trusted environment. Text mode remains available.', default: true },
      { key: 'native-bigger-context', label: 'Native Bigger Context', description: 'Experimental staged context for eligible native models. Pro and GPT-6/GPT-5.6 Sol on Pro-capable accounts retain baseline limits; larger-context retention has not passed verification. / Pro 及支持 Pro 的账号上的 GPT-6/GPT-5.6 Sol 保持基础窗口，大窗口保留验证未通过。 Takes effect after restarting Magpie / 重启 Magpie 后生效.', default: false },
      { key: 'native-temporary-chats', label: 'Native temporary chats', description: 'Use temporary ChatGPT chats in native reference mode. Turn off to save ordinary chats in ChatGPT history. Takes effect after restarting Magpie / 重启 Magpie 后生效.', default: true }],
    async refresh(auth) { return bridge.call({ method: 'session', auth: requireAuth(auth), profileRoot }); },
    loader: makeLoader(env),
    methods: [{
      type: 'oauth', label: 'Sign in with ChatGPT (browser)',
      async authorize(_inputs, { signal } = {}) {
        signal?.throwIfAborted();
        const owner = Symbol('sign-in');
        const account = await signinProfileClaim(profileRoot, owner);
        const proxy = browserProxy();
        try { await bridge.call({ method: 'login', account, profileRoot, ...(proxy ? { proxy } : {}) }, signal); }
        catch (error) { await unlockSigninProfile(profileRoot, owner); throw error; }
        return {
          url: '', method: 'auto',
          instructions: 'A Chrome window owned by magpie is opening on chatgpt.com. Sign in there — including any verification the site asks for. This finishes by itself when the session is confirmed. Check Native tools setup on the Usage page afterward; if incomplete, choose Resume Native setup (existing account) to retry without losing this sign-in.',
          async callback(_code, { signal: callbackSignal } = {}) {
            const activeSignal = callbackSignal && signal ? AbortSignal.any([signal, callbackSignal]) : callbackSignal ?? signal;
            try {
              for (;;) {
                activeSignal?.throwIfAborted();
                const result = await bridge.call({ method: 'loginStatus', account }, activeSignal);
                if (result.state === 'signed-in') {
                  if (env.native && (env.input?.magpie?.option?.(PROVIDER, 'native-tools') ?? true)) {
                    try { await reportSetupStatus(env, await env.native.provision(result.credential, activeSignal)); }
                    catch {
                      activeSignal?.throwIfAborted();
                      await reportSetupStatus(env, { state: 'failed', stage: 'verify' });
                    }
                  }
                  activeSignal?.throwIfAborted();
                  await releaseSigninProfileClaim(profileRoot, owner);
                  return { ...result.credential, type: 'success' };
                }
                if (result.state === 'cancelled') return { type: 'failed', error: 'The sign-in window was closed. Start sign-in again to resume the same profile.' };
                if (result.state === 'failed') return { type: 'failed', error: result.reason };
                if (result.state === 'timeout') return { type: 'failed', error: new BackendError('signinTimeout', { values: { windowMinutes: signinTimeoutWindow() } }) };
                if (result.state !== 'pending') throw new BackendError('protocol');
                await delay(pollMilliseconds, undefined, { signal: activeSignal });
              }
            } finally {
              await bridge.call({ method: 'logout', account }).catch(() => {});
              await unlockSigninProfile(profileRoot, owner);
            }
          },
        };
      },
    }, nativeSetupMethod(env)],
  };
}
