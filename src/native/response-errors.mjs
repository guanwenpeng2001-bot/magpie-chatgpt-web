// The native daemon sends response.created before checking the browser. Once
// that HTTP 200 reaches Magpie, its stream decoder turns response.failed into
// 502. Hold only the empty prelude so verification and quota refusals keep their
// HTTP status. Never buffer or replay a turn after any output/tool event.
function nativeRefusal(response) {
  if (!Array.isArray(response?.output) || response.output.length) return;
  const error = response.error;
  let status;
  if (error?.type === 'permission_error' && error.code === 'chatgpt_security_check') status = 403;
  else if (error?.type === 'rate_limit_error' && error.code === 'rate_limit_exceeded'
    || error?.type === 'insufficient_quota' && error.code === 'insufficient_quota') status = 429;
  else if (error?.type === 'server_error' && error.code === 'account_model_unavailable') status = 503;
  if (!status) return;
  const retry = Number(error.retry_after ?? error.retryAfter);
  return Response.json({ error: { ...error, status, ...(status === 403 ? { retryable: false } : {}) } }, { status,
    headers: { 'cache-control': 'no-store', 'x-magpie-sign-in': 'kept',
      ...(status === 403 ? { 'x-should-retry': 'false' } : {}),
      ...(status === 429 && Number.isFinite(retry) && retry > 0 ? { 'retry-after': String(Math.min(604800, Math.ceil(retry))) } : {}) } });
}

export async function preserveNativeVerification(response, signal) {
  if (response.ok && response.body && /application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    const reader = response.clone().body.getReader();
    const budget = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    budget.addEventListener('abort', cancel, { once: true });
    let bytes = 0, text = '', complete = false; const decoder = new TextDecoder();
    try {
      while (!budget.aborted) {
        const part = await reader.read(); if (part.done) { complete = true; break; }
        bytes += part.value.byteLength; if (bytes > 65536) break;
        text += decoder.decode(part.value, { stream: true });
      }
      if (complete && !budget.aborted) {
        const value = JSON.parse(text + decoder.decode());
        if (value.status === 'failed') {
          const refusal = nativeRefusal(value);
          if (refusal) { void response.body.cancel().catch(() => {}); return refusal; }
        }
      }
    } catch { /* A bounded observation cannot replace an unrelated response. */ }
    finally { budget.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
    return response;
  }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0, ended = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    scan: while (bytes < 65536) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) { ended = true; break; }
      chunks.push(next.value);
      bytes += next.value.byteLength;
      if (bytes > 65536) break;
      buffer += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { break scan; }
        const refusal = event?.type === 'response.failed' && nativeRefusal(event.response);
        if (refusal) {
          await reader.cancel();
          reader.releaseLock();
          return refusal;
        }
        if (!['response.created', 'response.in_progress'].includes(event?.type)
            || !Array.isArray(event.response?.output) || event.response.output.length) break scan;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        if (chunks.length) { controller.enqueue(chunks.shift()); return; }
        if (ended) { reader.releaseLock(); controller.close(); return; }
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }), { status: response.status, statusText: response.statusText, headers });
}
