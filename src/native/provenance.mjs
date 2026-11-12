// Only request identifiers and native item metadata are retained here. In
// particular, never retain message text, tool outputs, arguments or images.
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
const TURN_FIELDS = ["thread_id", "turn_id", "parent_thread_id", "forked_from_thread_id", "agent_name", "request_kind", "subagent_kind", "thread_source"];
const routePattern = /^native\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,100})$/;
let liveTickets = 0, liveBytes = 0;

const random = () => randomBytes(24).toString("base64url");
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
function turnMetadata(client) {
  let raw = client?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    if (raw.length > 65536) throw new Error("Native turn metadata is too large");
    try { raw = JSON.parse(raw); } catch { throw new Error("Invalid native turn metadata"); }
  }
  if (raw === undefined) return {};
  if (!object(raw)) throw new Error("Invalid native turn metadata");
  const out = {};
  for (const field of TURN_FIELDS) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string" || raw[field].length > 1024) throw new Error("Invalid native turn identity");
    out[field] = raw[field];
  }
  return out;
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
  const out = {};
  if (value.turn_id !== undefined) {
    // Codex generates UUID turn IDs; native auto-compaction uses this
    // separate counter form. Arbitrary text is never promoted to metadata.
    if (typeof value.turn_id !== "string"
        || !/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|auto-compact-[0-9]{1,20})$/i.test(value.turn_id)) {
      throw new Error("Invalid native turn identity");
    }
    out.turn_id = value.turn_id;
  }
  if (value.content_item_kinds !== undefined) {
    if (!Array.isArray(value.content_item_kinds) || value.content_item_kinds.length > 100
        || value.content_item_kinds.some(kind => typeof kind !== "string" || kind.length > 128 || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(kind))) {
      throw new Error("Invalid native content kinds");
    }
    out.content_item_kinds = [...value.content_item_kinds];
  }
  return out;
}
function sameIdentity(item, expected) {
  return IDENTITY.every(field => item[field] === expected[field]);
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
  let valid = true, bytes = 0, turn = {};
  try { turn = turnMetadata(body.client_metadata); } catch { valid = false; }
  for (const item of body.input) {
    if (!object(item)) { valid = false; continue; }
    if (item.internal_chat_message_metadata_passthrough === undefined) continue;
    try {
      if (tickets.size >= MAX_TICKETS_PER_REQUEST || liveTickets + tickets.size >= MAX_LIVE_TICKETS) { valid = false; continue; }
      const saved = { identity: identity(item), metadata: nativeMetadata(item.internal_chat_message_metadata_passthrough) };
      const size = JSON.stringify(saved).length * 2;
      if (bytes + size > MAX_RECORD_BYTES || liveBytes + bytes + size > MAX_LIVE_BYTES) { valid = false; continue; }
      const ticket = random();
      tickets.set(ticket, saved);
      bytes += size;
      item[TICKET] = ticket;
    } catch { valid = false; }
  }
  records.set(nonce, { created: Date.now(), provider: activeProvider, route, tickets, bytes, turn, valid, claimed: false });
  liveTickets += tickets.size;
  liveBytes += bytes;
  body.client_metadata[NONCE] = nonce;
  if (ctx.state && typeof ctx.state === "object") ctx.state.webGptNonce = nonce;
  return body;
}

// Called after Magpie selects a provider, in its gateway middleware runtime.
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
// exactly as Magpie sent them; only the native item metadata is restored.
export function restore(body, profile, provider = PROVIDER) {
  if (!object(body) || !object(body.client_metadata) || !Array.isArray(body.input)) throw new Error("Native request provenance is missing");
  const nonce = body.client_metadata[NONCE];
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) throw new Error("Native request nonce is missing");
  prune();
  const record = records.get(nonce);
  let checked;
  try { checked = JSON.parse(body.client_metadata[CHECKED]); } catch { throw new Error("Native routing information is missing"); }
  const match = record && routePattern.exec(record.route);
  if (!record || !record.valid || !match || checked?.nonce !== nonce
      || ![provider, provider + "-plugin"].includes(record.provider) || checked.provider !== record.provider
      || checked.route !== record.route || match[1] !== profile || body.model !== record.route) {
    throw new Error("Native request account or routing proof is invalid");
  }
  if (JSON.stringify(turnMetadata(body.client_metadata)) !== JSON.stringify(record.turn)) throw new Error("Native turn identity changed during routing");
  const bodyDigest = createHash("sha256").update(canonical(body)).digest("hex");
  if (record.claimed && record.digest !== bodyDigest) throw new Error("Native request retry changed after forwarding");
  const seen = new Set(), changes = [];
  for (const item of body.input) {
    if (!object(item)) throw new Error("Native request item is invalid");
    const ticket = item[TICKET];
    if (ticket === undefined) {
      if (item.internal_chat_message_metadata_passthrough !== undefined) throw new Error("Unverified native metadata");
      continue;
    }
    const stored = typeof ticket === "string" && record.tickets.get(ticket);
    if (!stored || seen.has(ticket) || !sameIdentity(item, stored.identity)) throw new Error("Native item ticket is invalid");
    if (item.internal_chat_message_metadata_passthrough !== undefined) throw new Error("Unexpected native metadata");
    seen.add(ticket);
    changes.push([item, stored.metadata]);
  }
  if (seen.size !== record.tickets.size) throw new Error("A native item was lost during routing");
  // A retry may reuse proof only for the identical filtered body and account.
  // The account runtime owns browser-round replay and cancellation.
  if (!record.claimed) {
    record.claimed = true;
    record.claimedAt = Date.now();
    record.digest = bodyDigest;
  }
  for (const [item, metadata] of changes) {
    delete item[TICKET];
    item.internal_chat_message_metadata_passthrough = metadata;
  }
  delete body.client_metadata[NONCE];
  delete body.client_metadata[CHECKED];
  return body;
}

export function complete(nonce) {
  if (typeof nonce === "string") forget(nonce);
}
