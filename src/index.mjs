import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, BackendError } from './bridge.mjs';

const PROVIDER = 'chatgpt-web';
const API = 'https://chatgpt-web.invalid/v1';
const REFRESH_LEAD = 24 * 3600_000;

function modelEntry(slug, name) {
  return {
    name, api: { id: slug, url: API, npm: '@ai-sdk/anthropic' },
    limit: { context: 200_000, output: 34_834 },
    capabilities: { reasoning: false, toolcall: true, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
  };
}

function mapModels(catalogue) {
  const models = catalogue?.models;
  if (!Array.isArray(models) || !models.length || models.some(model => typeof model?.slug !== 'string' || !model.slug || typeof model.title !== 'string' || !model.title)) throw new BackendError('protocol');
  const titles = new Map();
  for (const model of models) titles.set(model.title, (titles.get(model.title) ?? 0) + 1);
  const ordered = [...models.filter(model => model.slug === 'auto'), ...models.filter(model => model.slug !== 'auto')];
  return Object.fromEntries(ordered.map(model => [model.slug, modelEntry(model.slug,
    titles.get(model.title) > 1 && model.slug.endsWith('-mini') ? `${model.title} (${model.slug})` : model.title)]));
}

function requireAuth(auth) {
  if (auth?.type !== 'oauth' || typeof auth.refresh !== 'string' || !auth.refresh) throw new BackendError('expired');
  return auth;
}

function createHooks({ bridge, profileRoot, pollMilliseconds = 2000 }) {
  return {
    async config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= { name: 'ChatGPT Web', npm: '@ai-sdk/anthropic', api: API, models: { auto: modelEntry('auto', 'Auto') } };
    },
    auth: {
      provider: PROVIDER,
      refreshLead: REFRESH_LEAD,
      async refresh(auth) {
        return bridge.call({ method: 'session', auth: requireAuth(auth) });
      },
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requireAuth(auth);
        return {
          baseURL: API, apiKey: 'managed-locally',
          async fetch(input, init) {
            let error;
            try {
              await bridge.call({ method: 'session', auth: requireAuth(await getAuth()) }, init?.signal);
              error = new BackendError('backendDown');
            } catch (failure) { error = failure instanceof BackendError ? failure : new BackendError('upstream'); }
            return Response.json({ error: error.toJSON() }, { status: error.toJSON().status, headers: error.headers });
          },
        };
      },
      methods: [{
        type: 'oauth', label: 'ChatGPT account (browser sign-in)',
        async authorize() {
          const account = randomUUID();
          await bridge.call({ method: 'login', account, profileRoot });
          return {
            url: '', method: 'auto',
            instructions: 'A normal Chrome window owned by magpie is opening on chatgpt.com. Sign in there; this finishes by itself.',
            async callback() {
              try {
                for (;;) {
                  const result = await bridge.call({ method: 'loginStatus', account });
                  if (result.state === 'signed-in') return { ...result.credential, type: 'success' };
                  if (result.state === 'cancelled') return { type: 'failed', error: 'The sign-in window was closed. Start sign-in again.' };
                  if (result.state === 'failed') return { type: 'failed', error: result.reason };
                  if (result.state !== 'pending') throw new BackendError('protocol');
                  await delay(pollMilliseconds);
                }
              } finally { await bridge.call({ method: 'logout', account }).catch(() => {}); }
            },
          };
        },
      }],
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        return mapModels(await bridge.call({ method: 'models', auth: requireAuth(auth) }));
      },
    },
    async 'chat.headers'(input, output) {
      if (input.model?.providerID === PROVIDER && typeof input.sessionID === 'string') {
        output.headers ??= {};
        output.headers['x-chatgptweb-conversation'] = input.sessionID;
      }
    },
  };
}

export default {
  id: PROVIDER,
  async server() {
    return createHooks({ bridge: new Bridge(), profileRoot: resolve(homedir(), '.config', 'magpie', 'chatgpt-web-profile') });
  },
};
export const _internal = { createHooks, mapModels };
