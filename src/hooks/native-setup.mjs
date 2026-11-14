import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { cleanSetupResult, SETUP_RETRY } from '../native/setup.mjs';
import { PROVIDER } from './config.mjs';

const valid = auth => auth?.type === 'oauth' && typeof auth.refresh === 'string' && auth.refresh.length > 0
  && /^[A-Za-z0-9_-]{1,64}$/.test(auth.profile ?? '');
const failed = error => ({ type: 'failed', error });
export async function reportSetupStatus(env, result) {
  const clean = cleanSetupResult(result);
  // This host logs toast events; real visibility is the usage status row and
  // failed OAuth result, not a presumed notification UI.
  try { await env.input?.client?.app?.log?.({ body: { service: PROVIDER, message: clean.message,
    level: clean.state === 'ready' ? 'info' : 'warn' } }); } catch { /* persisted status remains readable */ }
  return clean;
}

export function nativeSetupMethod(env) {
  // Installed Magpie 0.1.3930 passes settings.Dir() as input.directory and
  // stores AuthPath() at its plugin-auth.json. Its authorize hook has no
  // getAuth/client.auth.get API. Read this store only; host save/settle owns
  // writes and deduplicates the returned unchanged credential. Never guess HOME.
  async function accounts() {
    const directory = env.input?.directory;
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Native recovery requires Magpie');
    const all = JSON.parse(await readFile(join(directory, 'plugin-auth.json'), 'utf8'));
    return Object.fromEntries(Object.entries(all).filter(([key, auth]) =>
      (key === PROVIDER || /^chatgpt-web#[A-Za-z0-9_-]+$/.test(key)) && valid(auth)));
  }
  const unavailable = () => failed(`Select an existing signed-in ChatGPT Web account. Its saved session must be available. ${SETUP_RETRY}`);
  return {
    type: 'oauth', label: 'Resume Native setup (existing account)',
    // Host authorize forwards inputs only when prompts.length is nonzero;
    // nextPrompt awaits ask(), so the choices reflect the current auth store.
    prompts: [{ type: 'select', key: 'account', message: 'Existing ChatGPT Web account', options: [] }],
    async ask(inputs = {}) {
      if (inputs.account) return null;
      let saved = {};
      try { saved = await accounts(); } catch { /* authorize returns safe instructions */ }
      if (!Object.keys(saved).length) return null;
      return { type: 'select', key: 'account', message: 'Resume Native setup for an existing ChatGPT Web account',
        options: Object.entries(saved).map(([key, auth]) => ({ value: key,
          label: typeof auth.accountId === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(auth.accountId)
            ? `${auth.accountId} (${key})` : key })) };
    },
    async authorize(inputs, { signal } = {}) {
      signal?.throwIfAborted();
      if (!env.native || env.input?.magpie?.option?.(PROVIDER, 'native-tools') === false) {
        return failed('Enable Native tools mode in this provider’s options, then choose Resume Native setup (existing account).');
      }
      let saved, original;
      const key = inputs?.account;
      try { saved = await accounts(); original = saved[key]; } catch { return unavailable(); }
      const scope = env.input?.magpie?.account?.(PROVIDER);
      if (!original || typeof scope !== 'string' || saved[scope] && scope !== key) return unavailable();
      const current = async () => {
        const auth = (await accounts())[key];
        if (!auth || auth.profile !== original.profile || auth.accountId !== original.accountId) throw new Error('Account changed');
        return auth;
      };
      return { url: '', method: 'auto', instructions: 'Resuming Native setup for the selected saved account. Its ChatGPT sign-in is kept; OpenAI Platform may ask you to sign in.',
        async callback(_code, { signal: callbackSignal } = {}) {
          const activeSignal = callbackSignal && signal && callbackSignal !== signal ? AbortSignal.any([signal, callbackSignal]) : callbackSignal ?? signal;
          activeSignal?.throwIfAborted();
          try {
            const auth = await current();
            activeSignal?.throwIfAborted();
            const result = await env.native.provision(auth, activeSignal);
            activeSignal?.throwIfAborted();
            const clean = await reportSetupStatus(env, result);
            if (clean.state !== 'ready') return failed(clean.message);
            const latest = await current();
            activeSignal?.throwIfAborted();
            return { ...latest, type: 'success' };
          } catch {
            activeSignal?.throwIfAborted();
            const clean = await reportSetupStatus(env, { state: 'failed', stage: 'verify' });
            return failed(clean.message);
          }
        } };
    },
  };
}
