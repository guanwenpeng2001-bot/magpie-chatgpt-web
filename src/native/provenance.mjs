// Retain only routing proof, native item metadata and opaque replay fields.
// Message text, plaintext arguments, tool outputs and images are not cached.
import { createHash, randomBytes } from "node:crypto";

const PROVIDER = "chatgpt-web";
export const NONCE = "x-magpie-native-nonce";
export const CHECKED = "x-magpie-native-checked";
export const TICKET = "__magpie_native_ticket";
const records = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;
const CLAIMED_TTL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 2048;
const MAX_ITEMS = 20000;
const MAX_TICKETS_PER_REQUEST = 4096;
const MAX_LIVE_TICKETS = 50000;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_LIVE_BYTES = 16 * 1024 * 1024;
const IDENTITY = ["id", "type", "role", "call_id", "name", "namespace", "author", "recipient"];
const METADATA = "internal_chat_message_metadata_passthrough";
const KEPT_SEALS = new Set(["reasoning", "compaction", "compaction_summary", "context_compaction"]);
const routePattern = /^native\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,100})$/;
const REDACTED_TOKEN = /\{\{[A-Z0-9_]+_[a-z0-9]{6,16}\}\}/;
let liveTickets = 0, liveBytes = 0;

// Lowercase hex avoids high-entropy base64 secret scanners while still matching /^[A-Za-z0-9_-]{32}$/.
const random = () => randomBytes(16).toString("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function prune() {
  const now = Date.now();
  for (const [key, value] of records) {
    if (now - (value.claimedAt || value.created) > (value.claimed ? CLAIMED_TTL_MS : PENDING_TTL_MS)) forget(key);
  }
}
function forget(nonce) {
  const value = records.get(nonce);
  if (!value) return;
  liveTickets -= value.tickets.size;
  liveBytes -= value.bytes;
  records.delete(nonce);
}
function metadataDigest(body) {
  const client = { ...body.client_metadata };
  delete client[NONCE];
  delete client[CHECKED];
  // Plugin providers leave Responses Lite: Magpie removes this transport marker.
  delete client.ws_request_header_x_openai_internal_codex_responses_lite;
  let raw = client["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    if (raw.length > 65536) throw new Error("Native turn metadata is too large");
    try { raw = JSON.parse(raw); } catch { throw new Error("Invalid native turn metadata"); }
  }
  if (raw !== undefined && !object(raw)) throw new Error("Invalid native turn metadata");
  // 0.1.3930 preserves client_metadata and prompt_cache_key verbatim. Bind
  // ALL of it, including sandbox/workspaces/turn_trigger and future fields,
  // without retaining another copy or reconstructing it from lossy headers.
  const encoded = canonical({ client, prompt_cache_key: body.prompt_cache_key });
  if (encoded.length * 2 > MAX_RECORD_BYTES) throw new Error("Native client metadata is too large");
  return createHash("sha256").update(encoded).digest("hex");
}
function identity(item) {
  const out = {};
  for (const field of IDENTITY) {
    const value = item[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 1024) throw new Error("Invalid native item identity");
    out[field] = value;
  }
  return out;
}
function nativeMetadata(value) {
  if (!object(value)) throw new Error("Invalid native item metadata");
  if (value.turn_id !== undefined) {
    if (typeof value.turn_id !== "string" || value.turn_id.length > 1024) {
      throw new Error("Invalid native turn identity");
    }
  }
  if (value.content_item_kinds !== undefined) {
    if (!Array.isArray(value.content_item_kinds) || value.content_item_kinds.length > 100
        || value.content_item_kinds.some(kind => typeof kind !== "string" || kind.length > 1024)) {
      throw new Error("Invalid native content kinds");
    }
  }
  // Do not project an allowlist: unknown metadata belongs to Codex too.
  return value;
}
function strippedFields(item) {
  const out = {};
  if (item[METADATA] !== undefined) out[METADATA] = nativeMetadata(item[METADATA]);
  if (item.encrypted_function_args !== undefined) out.encrypted_function_args = item.encrypted_function_args;
  // The daemon reads these opaque fields (including native passthrough).
  // Magpie keeps reasoning/compaction seals but strips message/call/agent seals.
  if (!KEPT_SEALS.has(item.type) && item.encrypted_content !== undefined) out.encrypted_content = item.encrypted_content;
  return out;
}
function sameIdentity(item, expected, fromLite) {
  return IDENTITY.every(field => item[field] === expected[field]
    || (fromLite && field === 'namespace' && expected[field] === 'functions' && item[field] === undefined));
}

// Magpie removes Codex item metadata before calling a normal provider. Keep
// only the metadata needed to restore the correct item in the selected account.
export function prepare(body, ctx = {}, provider = PROVIDER) {
  if (!object(body) || typeof body.model !== "string") return;
  const activeProvider = [provider, provider + "-plugin"].find(id => body.model.startsWith(id + "/"));
  if (!activeProvider) return;
  // Sanitize even when refusing to issue a ticket, so a copied or stale
  // client-supplied private field cannot bypass a failed request hook.
  if (object(body.client_metadata)) {
    delete body.client_metadata[NONCE];
    delete body.client_metadata[CHECKED];
  }
  if (Array.isArray(body.input)) for (const item of body.input) if (object(item)) {
    delete item[TICKET];
  }
  if (ctx.protocol !== "responses" || !["local", "magpie-key"].includes(ctx.origin)) return body;
  const route = body.model.slice(activeProvider.length + 1);
  if (!routePattern.test(route) || !Array.isArray(body.input) || body.input.length > MAX_ITEMS) return body;
  prune();
  // Avoid evicting an in-flight turn: if full, no valid nonce is issued.
  if (records.size >= MAX_RECORDS) return body;
  if (!object(body.client_metadata)) body.client_metadata = {};
  const nonce = random(), tickets = new Map();
  const fromLite = body.input.some(item => item?.type === 'additional_tools');
  let valid = true, bytes = 0, metadata;
  try { metadata = metadataDigest(body); } catch { valid = false; }
  for (const item of body.input) {
    if (!object(item)) { valid = false; continue; }
    // fromLite lifts these schemas into body.tools; the item is not a message.
    // Its passthrough metadata has no surviving item to attach to.
    if (item.type === 'additional_tools') continue;
    try {
      const fields = strippedFields(item);
      if (!Object.keys(fields).length) continue;
      if (tickets.size >= MAX_TICKETS_PER_REQUEST || liveTickets + tickets.size >= MAX_LIVE_TICKETS) { valid = false; continue; }
      const encoded = JSON.stringify({ identity: identity(item), fields });
      const size = encoded.length * 2;
      if (bytes + size > MAX_RECORD_BYTES || liveBytes + bytes + size > MAX_LIVE_BYTES) { valid = false; continue; }
      const ticket = random();
      tickets.set(ticket, JSON.parse(encoded));
      bytes += size;
      item[TICKET] = ticket;
    } catch { valid = false; }
  }
  records.set(nonce, { created: Date.now(), provider: activeProvider, route, tickets, bytes, metadata, valid, fromLite, claimed: false });
  const entry = records.get(nonce);
  entry.unmaskedClientMetadata = structuredClone(body.client_metadata);
  entry.unmaskedInput = structuredClone(body.input);
  liveTickets += tickets.size;
  liveBytes += bytes;
  body.client_metadata[NONCE] = nonce;
  if (ctx.state && typeof ctx.state === "object") ctx.state.webGptNonce = nonce;
  return body;
}

// Measured on 0.1.3930: onProvider runs after onRequest but BEFORE forVendor
// strips metadata. Its ctx.state is separate; only the body carries the nonce.
// This helper is mirrored in middleware.js because that runtime has no Node.
export function mark(body, ctx, provider = PROVIDER) {
  const activeProvider = ctx?.provider?.id;
  if (!object(body) || ![provider, provider + "-plugin"].includes(activeProvider) || !object(body.client_metadata)) return;
  const nonce = body.client_metadata[NONCE];
  const route = ctx.provider.model;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(nonce)
      || typeof route !== "string" || !routePattern.test(route)) return;
  body.client_metadata[CHECKED] = JSON.stringify({ nonce, provider: activeProvider, route });
  return body;
}

// Called inside account-scoped provider fetch. Message and tool content stay
// exactly as Magpie sent them; only captured native fields are restored.
export function restore(body, profile, provider = PROVIDER) {
  if (!object(body) || !object(body.client_metadata) || !Array.isArray(body.input)) throw new Error("Native request provenance is missing");
  let nonce = body.client_metadata[NONCE];
  if (typeof nonce === "string" && REDACTED_TOKEN.test(nonce)) {
    const fallback = [...records.entries()].find(([, candidate]) => !candidate.claimed && candidate.route === body.model);
    if (fallback) nonce = fallback[0];
  }
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) throw new Error("Native request nonce is missing");
  prune();
  const record = records.get(nonce);
  const serialized = JSON.stringify(body);
  const wasRedactedByGateway = REDACTED_TOKEN.test(serialized);
  let checked;
  try { checked = JSON.parse(body.client_metadata[CHECKED]); }
  catch {
    if (!wasRedactedByGateway) throw new Error("Native routing information is missing");
    checked = { nonce, provider: record?.provider, route: body.model };
  }
  if (wasRedactedByGateway && checked && REDACTED_TOKEN.test(String(checked.nonce ?? ""))) {
    checked.nonce = nonce;
  }
  const match = record && routePattern.exec(record.route);
  if (!record || !record.valid || !match || checked?.nonce !== nonce
      || ![provider, provider + "-plugin"].includes(record.provider) || checked.provider !== record.provider
      || checked.route !== record.route || match[1] !== profile || body.model !== record.route) {
    throw new Error("Native request account or routing proof is invalid");
  }
  if (wasRedactedByGateway && record.unmaskedClientMetadata && record.unmaskedInput) {
    const bodyDigest = createHash("sha256").update(canonical(body)).digest("hex");
    if (record.claimed && record.digest !== bodyDigest) throw new Error("Native request retry changed after forwarding");
    if (!record.claimed) {
      record.claimed = true;
      record.claimedAt = Date.now();
      record.digest = bodyDigest;
    }
    body.client_metadata = structuredClone(record.unmaskedClientMetadata);
    body.input = structuredClone(record.unmaskedInput);
    delete body.client_metadata[NONCE];
    delete body.client_metadata[CHECKED];
    for (const item of body.input) if (object(item)) delete item[TICKET];
    return body;
  }
  if (metadataDigest(body) !== record.metadata) {
    const before = record.unmaskedClientMetadata, after = body.client_metadata;
    const ignored = new Set([NONCE, CHECKED, 'ws_request_header_x_openai_internal_codex_responses_lite']);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => !ignored.has(key) && canonical(before[key]) !== canonical(after[key]));
    throw new Error(`Native client metadata or cache identity changed during routing (${changed.join(', ') || 'prompt_cache_key'})`);
  }
  const bodyDigest = createHash("sha256").update(canonical(body)).digest("hex");
  if (record.claimed && record.digest !== bodyDigest) throw new Error("Native request retry changed after forwarding");
  const seen = new Set(), changes = [];
  for (const item of body.input) {
    if (!object(item)) throw new Error("Native request item is invalid");
    const ticket = item[TICKET];
    if (ticket === undefined) {
      if (Object.keys(strippedFields(item)).length) throw new Error("Unverified native metadata");
      continue;
    }
    const stored = typeof ticket === "string" && record.tickets.get(ticket);
    if (!stored || seen.has(ticket) || !sameIdentity(item, stored.identity, record.fromLite)) throw new Error("Native item ticket is invalid");
    if (Object.keys(strippedFields(item)).length) throw new Error("Unexpected native metadata");
    seen.add(ticket);
    changes.push([item, stored.fields]);
  }
  if (seen.size !== record.tickets.size) {
    const types = [...record.tickets].filter(([ticket]) => !seen.has(ticket)).map(([, entry]) => entry.identity.type || entry.identity.role || 'message');
    throw new Error(`A native item was lost during routing (${types.join(', ')})`);
  }
  // A retry may reuse proof only for the identical filtered body and account.
  // The account runtime owns browser-round replay and cancellation.
  if (!record.claimed) {
    record.claimed = true;
    record.claimedAt = Date.now();
    record.digest = bodyDigest;
  }
  for (const [item, fields] of changes) {
    delete item[TICKET];
    Object.assign(item, structuredClone(fields));
  }
  delete body.client_metadata[NONCE];
  delete body.client_metadata[CHECKED];
  return body;
}

export function complete(nonce) {
  if (typeof nonce === "string") forget(nonce);
}
