// Self-contained transform for embedding with .toString() in runtime's preload.
// The caller must verify the ORIGINAL v6.1.18 CLI SHA-256 before any transforms.
// Never edits the installed bundle, retries a turn, or infers types from text.
export function patchNativeCompactionErrors(source) {
  function magpieNativeCompactionErrorFields(error) {
    if (!error || !Number.isInteger(error.status) || error.status < 400 || error.status > 599
        || typeof error.message !== 'string'
        || typeof error.errorType !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(error.errorType)
        || typeof error.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(error.code)
        || (error.retryable !== undefined && typeof error.retryable !== 'boolean')) return;
    const fields = { message: error.message, status: error.status, errorType: error.errorType, code: error.code,
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }) };
    for (const name of ['retry_after', 'retryAfter']) {
      if (typeof error[name] === 'number' && Number.isFinite(error[name]) || typeof error[name] === 'string') fields[name] = error[name];
    }
    return fields;
  }

  function magpieNativeCompactionErrorResponse(events, response) {
    if (response.status !== 'failed') return;
    // These are in-process adapter events, not client input or an upstream JSON
    // error envelope. Preserve the LAST error selected by the original Bg().
    let failure;
    for (const event of events) if (event.type === 'error') failure = event;
    const fields = magpieNativeCompactionErrorFields(failure);
    if (!fields) return;
    const error = { ...response.error, ...fields, type: fields.errorType };
    const headers = { 'cache-control': 'no-store' };
    const authentication = fields.status === 401 || fields.errorType === 'authentication_error'
      || ['chatgpt_session_expired', 'invalid_api_key'].includes(fields.code);
    headers['x-magpie-sign-in'] = authentication ? 'expired' : 'kept';
    // Native retryable:false may mean "do not repeat on this account". Quota
    // still permits the host to choose another account serving the same model.
    if (fields.retryable === false && fields.status !== 429) headers['x-should-retry'] = 'false';
    if (fields.status === 429) {
      const seconds = Number(fields.retry_after ?? fields.retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) headers['retry-after'] = String(Math.min(604800, Math.ceil(seconds)));
    }
    return Response.json({ ...response, error, last_error: { ...error } }, { status: fields.status, headers });
  }

  if (typeof source !== 'string') throw new TypeError('Native compaction errors require source text');
  if (source.includes('magpieNativeCompactionErrorFields') || source.includes('magpieNativeCompactionErrorResponse')) {
    throw new Error('Native compaction errors already patched');
  }
  const caught = '}catch(y){let P={type:"error",message:y instanceof Error?y.message:String(y)};r.onAdapterEvent?.(P),T.push(P)}finally{T.close()}},M=hE(d)';
  const result = 'return g(R),Response.json(R)}async function cd(';
  for (const [name, anchor] of [['Ls adapter catch', caught], ['Ls nonstream result', result]]) {
    if (source.split(anchor).length !== 2) throw new Error(`Native compaction errors ${name} anchor mismatch`);
  }
  // Only real pinned AdapterError instances gain metadata at the catch. Plain
  // Error objects with lookalike properties retain the original generic path.
  return source.replace(caught, caught.replace('String(y)};', 'String(y),...(y instanceof q?magpieNativeCompactionErrorFields(y):void 0)};'))
    .replace(result, 'return g(R),(h?magpieNativeCompactionErrorResponse(_,R):void 0)??Response.json(R)}async function cd(')
    + '\n' + magpieNativeCompactionErrorFields.toString() + '\n' + magpieNativeCompactionErrorResponse.toString() + '\n';
}
