import { BackendError } from './bridge.mjs';
import { prepare } from './wire/prepare.mjs';
import { translate, reconstruct, errorEvent, errorType, backendFrameError } from './wire/translate.mjs';
import { requireAuth } from './hooks/auth.mjs';
import { compile } from '../backend/prompt.mjs';
import { compactToolDefinitions } from './tool-emulation.mjs';
import { API, PROVIDER } from './hooks/config.mjs';
import { nativeRoute } from './native/models.mjs';
import { restore, NONCE } from './native/provenance.mjs';
import { isCompaction, textFallback } from './native/fallback.mjs';
import { nativeTurnHeaders } from './native/compaction.mjs';
import { adaptResponsesStream } from './native/stream.mjs';
import {
  assertPreparedInputFits,
  estimatePreparedInput,
} from './usage/context.mjs';

export function makeLoader({ bridge, profileRoot, input, native }) {
  return async getAuth => {
    const auth = await getAuth();
    if (!auth) return {};
    requireAuth(auth);
    const loader = {
      baseURL: native ? 'http://127.0.0.1:1/v1' : API, apiKey: 'managed-locally',
      async fetch(resource, init = {}) {
        let upstream;
        let request;
        let preflight = true;
        let signal;
        try {
          const current = requireAuth(await getAuth());
          try { request = JSON.parse(init.body ?? (resource instanceof Request ? await resource.text() : '')); }
          catch { throw new BackendError('invalidRequest'); }
          signal = init.signal ?? (resource instanceof Request ? resource.signal : undefined);
          signal?.throwIfAborted();
          const path = new URL(resource instanceof Request ? resource.url : resource).pathname;
          if (/\/responses(?:\/compact)?$/.test(path)) {
            const headers = init.headers ?? (resource instanceof Request ? resource.headers : undefined);
            const headerEffort = new Headers(headers).get('x-magpie-effort') ?? undefined;
            let canonicalCompaction;
            // Check only the selected model/account before restoration. Vendor
            // reasoning and compaction markers cannot select the native endpoint.
            const route = nativeRoute(request.model);
            if (route && route.profile !== current.profile) throw new BackendError('invalidRequest');
            if (route?.daemonSupported && native && (input?.magpie?.option?.(PROVIDER, 'native-tools') ?? true)) {
              // restore replaces root fields with a detached snapshot. Preserve
              // the transformed request for text fallback if native is unavailable.
              const nativeRequest = { ...request };
              const hasProof = nativeRequest.client_metadata?.[NONCE] !== undefined;
              const restoreNative = () => {
                try { restore(nativeRequest, current.profile, PROVIDER, { headerEffort }); }
                catch (err) { throw Object.assign(new BackendError('invalidRequest'), { diagnostic: { reason: err?.message } }); }
              };
              if (hasProof) restoreNative();
              const forwardedHeaders = nativeTurnHeaders(nativeRequest, headers);
              const compact = isCompaction(nativeRequest, path, forwardedHeaders);
              if (hasProof) canonicalCompaction = compact;
              const target = nativeRoute(nativeRequest.model, nativeRequest.reasoning?.effort ?? headerEffort);
              if (target?.daemonSupported) {
                let runtime;
                try { runtime = await native.runtime(current); } catch { /* use text when startup failed */ }
                const payload = { ...nativeRequest, model: target.model,
                  ...(target.effort ? { reasoning: { ...nativeRequest.reasoning, effort: target.effort } } : {}),
                  ...(path.endsWith('/responses/compact') && nativeRequest.stream === undefined ? { stream: false } : {}) };
                if (compact && runtime?.compaction) {
                  // Header/path-only compaction without proof remains read-only.
                  preflight = false;
                  return await runtime.compaction(payload, forwardedHeaders, signal, path);
                }
                if (!compact && runtime && await runtime.health(signal)) {
                  if (!hasProof) restoreNative(); // Ordinary native turns require proof.
                  preflight = false;
                  // Once submitted, never replay through text: tools may have run.
                  return adaptResponsesStream(await runtime.responses(payload, forwardedHeaders, signal), request);
                }
              }
            }
            preflight = false;
            const compact = canonicalCompaction ?? isCompaction(request, path, headers);
            if (path.endsWith('/responses/compact') && request.stream === undefined) request.stream = false;
            const fallbackHeaders = new Headers(headers);
            const fallbackRoute = nativeRoute(request.model, request.reasoning?.effort ?? headerEffort);
            const effort = request.reasoning?.effort ?? headerEffort ?? fallbackRoute?.effort ?? (route ? route.slug.endsWith('-pro') ? 'max' : route.slug.endsWith('-instant') || route.slug.endsWith('-luna') ? 'low' : 'high' : undefined);
            if (effort) fallbackHeaders.set('x-magpie-effort', effort);
            return await textFallback(request, compact, text => loader.fetch(`${API}/messages`, {
              body: JSON.stringify(text), headers: fallbackHeaders, signal,
            }), signal);
          }
          const prepared = prepare(request, init.headers ?? (resource instanceof Request ? resource.headers : undefined));
          let inputEstimate = estimatePreparedInput(prepared);
          for (const level of [1, 2, 3, 4]) {
            if (!prepared.tools?.length || prepared.promptTools?.length === 0 ||
                inputEstimate.inputTokens < Math.floor(inputEstimate.contextLimit * 0.5)) break;
            prepared.promptTools = compactToolDefinitions(prepared.tools, level);
            prepared.toolCompaction = { level, toolCount: prepared.tools.length, exposedToolCount: prepared.tools.length };
            prepared.prompt = compile(prepared);
            inputEstimate = estimatePreparedInput(prepared);
          }
          prepared.usageEstimate = inputEstimate;
          assertPreparedInputFits(prepared, inputEstimate);
          preflight = false;
          signal = init.signal ?? (resource instanceof Request ? resource.signal : undefined);
          const visibleTurns = input?.magpie?.option?.(PROVIDER, 'visible-turns') ?? false;
          upstream = await bridge.open({ method: 'complete', auth: current, profileRoot, ...prepared, visibleTurns }, signal);
          const headers = { 'x-magpie-sign-in': 'kept', 'cache-control': 'no-store' };
          if (upstream.metadata?.route) headers['x-chatgptweb-route'] = upstream.metadata.route;
          if (upstream.metadata?.degraded) {
            await input?.client?.app?.log?.({ body: { service: PROVIDER, level: 'info', message: 'observationDegraded', extra: { ...upstream.metadata } } });
          }
          if (request.stream === false) {
            const frames = [];
            let bytes = 0;
            for await (const frame of upstream) {
              signal?.throwIfAborted();
              bytes += Buffer.byteLength(JSON.stringify(frame));
              if (bytes > 8 << 20) throw new BackendError('protocol');
              frames.push(frame);
            }
            if (!frames.length) throw new BackendError('empty');
            const translated = translate(frames, prepared);
            const message = await reconstruct(translated);
            upstream.close();
            return Response.json(message, { headers });
          }
          // Bridge.open returns a head before the browser has produced anything.
          // Await actual data so an immediate logout can still set HTTP headers.
          const iterator = upstream[Symbol.asyncIterator]();
          const first = await iterator.next();
          signal?.throwIfAborted();
          if (first.done) throw new BackendError('empty');
          if (first.value?.type === 'error') throw backendFrameError(first.value);
          async function* frames() {
            try {
              yield first.value;
              for (;;) {
                const next = await iterator.next();
                if (next.done) return;
                yield next.value;
              }
            } finally { await iterator.return?.(); }
          }
          const translated = translate(frames(), prepared);
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            async pull(controller) {
              try {
                signal?.throwIfAborted();
                const next = await translated.next();
                if (next.done) {
                  controller.close();
                  upstream.close();
                } else {
                  controller.enqueue(encoder.encode(next.value));
                }
              } catch (error) {
                if (signal?.aborted) controller.error(signal.reason);
                else { controller.enqueue(encoder.encode(errorEvent(error))); controller.close(); }
                upstream.close();
              }
            },
            async cancel() {
              upstream.close();
              await translated.return();
            },
          });
          return new Response(body, { headers: { ...headers, 'content-type': 'text/event-stream' } });
        } catch (failure) {
          upstream?.close();
          const cancelled = signal?.aborted === true;
          const error = cancelled
            ? new BackendError('upstream')
            : failure instanceof BackendError ? failure : new BackendError('upstream');
          if (preflight) {
            console.error(JSON.stringify({
              event: 'preflightRejected',
              shape: requestShape(request, error.code, error.diagnostic),
            }));
            try { await input?.client?.app?.log?.({ body: { service: PROVIDER, level: 'error', message: 'preflightRejected ' + JSON.stringify(requestShape(request, error.code, error.diagnostic)) } }); } catch {}
          }
          return Response.json({ error: { type: errorType(error), ...error.toJSON() } }, { status: error.status, headers: error.headers });
        }
      },
    };
    return loader;
  };
}

// Structural diagnostics only: never record prompts, schemas, tool names or credentials.
export function requestShape(request, code, definitionFailure) {
  const schemaKeys = new Set();
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 32 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['$schema', '$id', '$ref', 'format', 'pattern', 'nullable', 'readOnly', 'writeOnly', 'deprecated', 'prefixItems', 'unevaluatedProperties', 'dependentRequired'].includes(key)) schemaKeys.add(key);
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  for (const tool of tools) walk(tool?.input_schema ?? tool?.function?.parameters);
  return { code, definitionFailure, hasModel: typeof request?.model === 'string', messagesArray: Array.isArray(request?.messages),
    messageCount: request?.messages?.length ?? null, roles: [...new Set((Array.isArray(request?.messages) ? request.messages : []).map(m => ['user','assistant','system','tool'].includes(m?.role) ? m.role : 'other'))],
    contentTypes: [...new Set((Array.isArray(request?.messages) ? request.messages : []).flatMap(m => Array.isArray(m?.content) ? m.content.map(b => ['text','image','tool_use','tool_result','thinking','redacted_thinking','tool_reference'].includes(b?.type) ? b.type : 'other') : [typeof m?.content]))],
    toolCount: tools.length, missingInputSchemas: tools.filter(t => !t?.input_schema).length,
    functionWrappedTools: tools.filter(t => !!t?.function).length, schemaKeywords: [...schemaKeys].sort(),
    choiceType: ['auto','any','tool','none'].includes(request?.tool_choice?.type) ? request.tool_choice.type : typeof request?.tool_choice };
}
