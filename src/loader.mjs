import { BackendError } from './bridge.mjs';
import { prepare } from './wire/prepare.mjs';
import { translate, reconstruct, errorEvent } from './wire/translate.mjs';
import { requireAuth } from './hooks/auth.mjs';
import { API, PROVIDER } from './hooks/config.mjs';

export function makeLoader({ bridge, profileRoot, input }) {
  return async getAuth => {
    const auth = await getAuth();
    if (!auth) return {};
    requireAuth(auth);
    return {
      baseURL: API, apiKey: 'managed-locally',
      async fetch(resource, init = {}) {
        let upstream;
        let request;
        let preflight = true;
        try {
          const current = requireAuth(await getAuth());
          try { request = JSON.parse(init.body ?? (resource instanceof Request ? await resource.text() : '')); }
          catch { throw new BackendError('invalidRequest'); }
          const prepared = prepare(request, init.headers ?? (resource instanceof Request ? resource.headers : undefined));
          preflight = false;
          const signal = init.signal ?? (resource instanceof Request ? resource.signal : undefined);
          const visibleTurns = input?.magpie?.option(PROVIDER, 'visible-turns') !== false;
          upstream = await bridge.open({ method: 'complete', auth: current, profileRoot, ...prepared, visibleTurns }, signal);
          const frames = [];
          let bytes = 0;
          for await (const frame of upstream) {
            signal?.throwIfAborted();
            bytes += Buffer.byteLength(JSON.stringify(frame));
            if (bytes > 8 << 20) throw new BackendError('protocol');
            frames.push(frame);
          }
          if (!frames.length) throw new BackendError('empty');
          if (frames.some(frame => frame.type === 'error')) await reconstruct(translate(frames, prepared));
          const headers = { 'x-magpie-sign-in': 'kept', 'cache-control': 'no-store' };
          if (upstream.metadata?.route) headers['x-chatgptweb-route'] = upstream.metadata.route;
          if (upstream.metadata?.degraded) {
            await input?.client?.app?.log?.({ body: { service: PROVIDER, level: 'info', message: 'observationDegraded', extra: { ...upstream.metadata } } });
          }
          const translated = translate(frames, prepared);
          if (request.stream === false) {
            const message = await reconstruct(translated);
            upstream.close();
            return Response.json(message, { headers });
          }
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            async pull(controller) {
              try {
                signal?.throwIfAborted();
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
          return new Response(body, { headers: { ...headers, 'content-type': 'text/event-stream' } });
        } catch (failure) {
          upstream?.close();
          const error = failure instanceof BackendError ? failure : new BackendError('upstream');
          if (preflight) {
            try { await input?.client?.app?.log?.({ body: { service: PROVIDER, level: 'error', message: 'preflightRejected ' + JSON.stringify(requestShape(request, error.code, error.diagnostic)) } }); } catch {}
          }
          return Response.json({ error: error.toJSON() }, { status: error.status, headers: error.headers });
        }
      },
    };
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
