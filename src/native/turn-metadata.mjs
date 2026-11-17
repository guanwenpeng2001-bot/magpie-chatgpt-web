const key = 'x-codex-turn-metadata';

export function nativeTurnHeaders(body, headers) {
  const forwarded = new Headers(headers);
  const metadata = body.client_metadata?.[key];
  if (metadata !== undefined) {
    const json = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    // Headers requires ByteString; preserve canonical Unicode through JSON escapes.
    forwarded.set(key, json.replace(/[\u007f-\uffff]/g,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')));
  }
  return forwarded;
}

// Transport normalization only. Do not infer identity, permissions or cwd; the
// native parser and current-turn rollout proof still establish execution authority.
export function normalizeNativeTurnMetadata(body, headers) {
  const bodyPresent = body.client_metadata?.[key] !== undefined;
  const headerPresent = new Headers(headers).has(key);
  const forwarded = nativeTurnHeaders(body, headers);
  const metadata = forwarded.get(key);
  const recovered = !bodyPresent && metadata !== null;
  const normalized = recovered
    ? { ...body, client_metadata: { ...body.client_metadata, [key]: metadata } }
    : body;
  let fields = normalized.client_metadata?.[key];
  try { if (typeof fields === 'string') fields = JSON.parse(fields); }
  catch { fields = undefined; }
  const present = name => fields !== null && typeof fields === 'object'
    && !Array.isArray(fields) && Object.hasOwn(fields, name);
  // Fixed recovery types and booleans only, never values or parse errors.
  const diagnostic = {
    recovery: recovered ? 'header_to_body' : bodyPresent ? 'body_authoritative' : 'missing',
    bodyMetadataPresent: bodyPresent, headerMetadataPresent: headerPresent,
    threadIdPresent: present('thread_id'), turnIdPresent: present('turn_id'),
    requestKindPresent: present('request_kind'), sandboxModePresent: present('sandbox_mode'),
    sandboxPresent: present('sandbox'),
  };
  try { console.info('[chatgpt-web] native_turn_metadata ' + JSON.stringify(diagnostic)); }
  catch { /* Diagnostics must not change forwarding. */ }
  return { body: normalized, headers: forwarded };
}
