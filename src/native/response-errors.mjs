// The native daemon sends response.created before checking the browser. Once
// that HTTP 200 reaches Magpie, its stream decoder turns response.failed into
// 502. Hold only the empty prelude so verification and quota refusals keep their
// HTTP status. Never buffer or replay a turn after any output/tool event.
export async function preserveNativeVerification(response, signal) {
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
        const error = event?.response?.error;
        if (event?.type === 'response.failed' && error?.code === 'chatgpt_security_check'
            && error.type === 'permission_error' && event.response.retryable === false
            && Array.isArray(event.response.output) && event.response.output.length === 0) {
          await reader.cancel();
          reader.releaseLock();
          return Response.json({ error: { ...error, status: 403, retryable: false } }, {
            status: 403,
            headers: { 'cache-control': 'no-store', 'x-magpie-sign-in': 'kept', 'x-should-retry': 'false' },
          });
        }
        if (event?.type === 'response.failed' && Array.isArray(event.response?.output) && !event.response.output.length
            && ((error?.type === 'rate_limit_error' && error.code === 'rate_limit_exceeded')
              || (error?.type === 'insufficient_quota' && error.code === 'insufficient_quota'))) {
          await reader.cancel();
          reader.releaseLock();
          // This account rests; the host may choose another eligible account.
          // A quota refusal never expires the saved browser sign-in.
          const retry = Number(error.retry_after ?? error.retryAfter);
          const seconds = Number.isFinite(retry) && retry > 0 ? Math.min(604800, Math.ceil(retry)) : undefined;
          return Response.json({ error: { ...error, status: 429 } }, { status: 429,
            headers: { 'cache-control': 'no-store', 'x-magpie-sign-in': 'kept',
              ...(seconds === undefined ? {} : { 'retry-after': String(seconds) }) } });
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
