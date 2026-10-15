import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from '../bridge.mjs';
import { signinProfileClaim, releaseSigninProfileClaim, unlockSigninProfile, signinTimeoutWindow } from '../../backend/browser.mjs';
import { makeLoader } from '../loader.mjs';
import { PROVIDER } from './config.mjs';

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
      description: 'Run turns in a visible Chrome window so site checks can be completed by hand.', default: false }],
    async refresh(auth) { return bridge.call({ method: 'session', auth: requireAuth(auth), profileRoot }); },
    loader: makeLoader(env),
    methods: [{
      type: 'oauth', label: 'Sign in with ChatGPT (browser)',
      async authorize() {
        const account = await signinProfileClaim(profileRoot);
        const proxy = process.env.MAGPIE_HTTPS_PROXY || process.env.MAGPIE_HTTP_PROXY || process.env.MAGPIE_ALL_PROXY;
        try { await bridge.call({ method: 'login', account, profileRoot, ...(proxy ? { proxy } : {}) }); }
        catch (error) { await unlockSigninProfile(profileRoot, account); throw error; }
        return {
          url: '', method: 'auto',
          instructions: 'A Chrome window owned by magpie is opening on chatgpt.com. Sign in there — including any verification the site asks for. This finishes by itself when the session is confirmed.',
          async callback() {
            try {
              for (;;) {
                const result = await bridge.call({ method: 'loginStatus', account });
                if (result.state === 'signed-in') {
                  await releaseSigninProfileClaim(profileRoot, account);
                  return { ...result.credential, type: 'success' };
                }
                if (result.state === 'cancelled') return { type: 'failed', error: 'The sign-in window was closed. Start sign-in again to resume the same profile.' };
                if (result.state === 'failed') return { type: 'failed', error: result.reason };
                if (result.state === 'timeout') return { type: 'failed', error: new BackendError('signinTimeout', { values: { windowMinutes: signinTimeoutWindow() } }) };
                if (result.state !== 'pending') throw new BackendError('protocol');
                await delay(pollMilliseconds);
              }
            } finally {
              await bridge.call({ method: 'logout', account }).catch(() => {});
              await unlockSigninProfile(profileRoot, account);
            }
          },
        };
      },
    }],
  };
}
