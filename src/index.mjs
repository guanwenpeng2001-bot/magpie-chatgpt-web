import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, BackendError } from './bridge.mjs';
import { prepare, translate, errorEvent } from './protocol.mjs';

const PROVIDER = 'chatgpt-web';
const API = 'https://chatgpt-web.invalid/v1';
const REFRESH_LEAD = 24 * 3600_000;

function modelEntry(slug, name) {
  return {
    name, api: { id: slug, url: API, npm: '@ai-sdk/anthropic' },
    limit: { context: 200_000, output: 34_834 },
    // Prompt-level tool emulation compliance matrix ran 2026-10-12: auto failed the bar at probe A;
    // gpt-6 was never reached (model-selection failure). Both keep toolcall: false.
    capabilities: { reasoning: false, toolcall: false, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
  };
}

function mapModels(catalogue) {
  const models = catalogue?.models;
  if (!Array.isArray(models) || !models.length || models.some(model => typeof model?.slug !== 'string' || !model.slug || typeof model.title !== 'string' || !model.title)) throw new BackendError('protocol');
  const titles = new Map();
  for (const model of models) titles.set(model.title, (titles.get(model.title) ?? 0) + 1);
  // Dated compatibility filter from 2026-10-11. The smoke measured selection and
  // submission for Auto and GPT-6; the observed DOM node was never proven to be
  // assistant answer text, so generation and incremental delivery stay unverified
  // and no exposed model carries a generation claim. GPT-5.5 was selectable but
  // its instrument timed out, which is UNDECIDED rather than a proven failure.
  // Other slugs have no supported picker mapping.
  // Keep account discovery authoritative: never synthesize an absent catalogue entry.
  const supported = new Set(['auto', 'gpt-6']);
  const ordered = models.filter(model => supported.has(model.slug)).sort((left, right) => Number(right.slug === 'auto') - Number(left.slug === 'auto'));
  if (!ordered.length) throw new BackendError('protocol');
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
        return bridge.call({ method: 'session', auth: requireAuth(auth), profileRoot });
      },
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requireAuth(auth);
        return {
          baseURL: API, apiKey: 'managed-locally',
          async fetch(input, init = {}) {
            let upstream;
            try {
              const current = requireAuth(await getAuth());
              let request;
              try { request = JSON.parse(init.body ?? (input instanceof Request ? await input.text() : '')); }
              catch { throw new BackendError('invalidRequest'); }
              const prepared = prepare(request, init.headers ?? (input instanceof Request ? input.headers : undefined));
              const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
              upstream = await bridge.open({ method: 'complete', auth: current, profileRoot, ...prepared }, signal);
              const first = await upstream.next();
              if (first.done) throw new BackendError('empty');
              async function* frames() { yield first.value; yield* upstream; }
              const translated = translate(frames(), prepared);
              if (request.stream === false) {
                let message;
                const blocks = [];
                for await (const chunk of translated) {
                  signal?.throwIfAborted();
                  const event = JSON.parse(chunk.split('\ndata: ')[1]);
                  if (event.type === 'message_start') message = event.message;
                  if (event.type === 'content_block_start') blocks[event.index] = event.content_block;
                  if (event.type === 'content_block_delta') {
                    if (event.delta.type === 'text_delta') blocks[event.index].text += event.delta.text;
                    else blocks[event.index].input = JSON.parse(event.delta.partial_json);
                  }
                  if (event.type === 'message_delta') { Object.assign(message, event.delta); message.usage.output_tokens = event.usage.output_tokens; }
                }
                message.content = blocks;
                upstream.close();
                return Response.json(message, { headers: { 'cache-control': 'no-store' } });
              }
              const encoder = new TextEncoder();
              const body = new ReadableStream({
                async pull(controller) {
                  try {
                    const next = await translated.next();
                    if (next.done) { controller.close(); upstream.close(); }
                    else controller.enqueue(encoder.encode(next.value));
                  } catch (error) {
                    if (signal?.aborted) controller.error(signal.reason);
                    else { controller.enqueue(encoder.encode(errorEvent(error))); controller.close(); }
                    upstream.close();
                  }
                },
                async cancel() { upstream.close(); await translated.return(); },
              });
              return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
            } catch (failure) {
              upstream?.close();
              const error = failure instanceof BackendError ? failure : new BackendError('upstream');
              return Response.json({ error: error.toJSON() }, { status: error.status, headers: error.headers });
            }
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
        return mapModels(await bridge.call({ method: 'models', auth: requireAuth(auth), profileRoot }));
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
