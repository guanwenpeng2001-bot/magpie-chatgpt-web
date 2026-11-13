// Capture the canonical local Codex request before Magpie fits it to a vendor.
// Snapshots are memory-only, bounded, account-scoped and revoked on completion.
import { createHash, randomBytes } from 'node:crypto';

const PROVIDER = 'chatgpt-web';
export const NONCE = 'x-magpie-native-nonce';
export const CHECKED = 'x-magpie-native-checked';
export const TICKET = '__magpie_native_ticket'; // scrub older client/plugin proof
const records = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;
const CLAIMED_TTL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 128;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_LIVE_BYTES = 64 * 1024 * 1024;
const routePattern = /^native\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,100})$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
let liveBytes = 0;
function forget(nonce) {
  const record = records.get(nonce);
  if (!record) return;
  liveBytes -= record.bytes;
  records.delete(nonce);
}
function prune() {
  const now = Date.now();
  for (const [nonce, record] of records) {
    if (now - (record.claimedAt || record.created) > (record.claimed ? CLAIMED_TTL_MS : PENDING_TTL_MS)) forget(nonce);
  }
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function scrub(body) {
  if (object(body.client_metadata)) {
    delete body.client_metadata[NONCE];
    delete body.client_metadata[CHECKED];
  }
  if (Array.isArray(body.input)) for (const item of body.input) if (object(item)) delete item[TICKET];
}
function validate(body) {
  let turn = body.client_metadata?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    if (turn.length > 65536) throw new Error('Native turn metadata is too large');
    turn = JSON.parse(turn);
  }
  if (turn !== undefined && !object(turn)) throw new Error('Invalid native turn metadata');
  if (body.input.length > 20000 || body.input.some(item => !object(item))) throw new Error('Invalid native input');
  for (const item of body.input) {
    const metadata = item.internal_chat_message_metadata_passthrough;
    if (metadata === undefined) continue;
    if (!object(metadata) || JSON.stringify(metadata).length > 256 * 1024) throw new Error('Invalid native item metadata');
    if (metadata.turn_id !== undefined && (typeof metadata.turn_id !== 'string' || metadata.turn_id.length > 1024)) throw new Error('Invalid native turn identity');
    const kinds = metadata.content_item_kinds;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length > 100
        || kinds.some(kind => typeof kind !== 'string' || kind.length > 1024))) throw new Error('Invalid native content kinds');
  }
}

export function prepare(body, ctx = {}, provider = PROVIDER) {
  if (!object(body) || typeof body.model !== 'string') return;
  const activeProvider = [provider, provider + '-plugin'].find(id => body.model.startsWith(id + '/'));
  if (!activeProvider) return;
  scrub(body);
  if (ctx.protocol !== 'responses' || !['local', 'magpie-key'].includes(ctx.origin)) return body;
  const route = body.model.slice(activeProvider.length + 1);
  if (!routePattern.test(route) || !Array.isArray(body.input)) return body;
  prune();
  if (records.size >= MAX_RECORDS) return body;
  if (!object(body.client_metadata)) body.client_metadata = {};
  let encoded;
  try { validate(body); encoded = JSON.stringify({...body, model:route}); } catch { return body; }
  const bytes = Buffer.byteLength(encoded);
  if (bytes > MAX_RECORD_BYTES || liveBytes + bytes > MAX_LIVE_BYTES) return body;
  const nonce = randomBytes(16).toString('hex');
  records.set(nonce, {created:Date.now(), provider:activeProvider, route, bytes, snapshot:JSON.parse(encoded), claimed:false});
  liveBytes += bytes;
  body.client_metadata[NONCE] = nonce;
  if (object(ctx.state)) ctx.state.webGptNonce = nonce;
  return body;
}

// Mirrored in middleware.js: this restricted runtime shares no Node state.
export function mark(body, ctx, provider = PROVIDER) {
  const activeProvider = ctx?.provider?.id;
  if (!object(body) || ![provider, provider + '-plugin'].includes(activeProvider) || !object(body.client_metadata)) return;
  const nonce = body.client_metadata[NONCE], route = ctx.provider.model;
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || typeof route !== 'string' || !routePattern.test(route)) return;
  body.client_metadata[CHECKED] = JSON.stringify({nonce, provider:activeProvider, route});
  return body;
}

export function restore(body, profile, provider = PROVIDER, { headerEffort } = {}) {
  if (!object(body) || !object(body.client_metadata)) throw new Error('Native request provenance is missing');
  const nonce = body.client_metadata[NONCE];
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Native request nonce is missing');
  prune();
  const record = records.get(nonce);
  let checked;
  try { checked = JSON.parse(body.client_metadata[CHECKED]); } catch { throw new Error('Native routing information is missing'); }
  const match = record && routePattern.exec(record.route);
  if (!record || !match || checked?.nonce !== nonce
      || ![provider, provider + '-plugin'].includes(record.provider) || checked.provider !== record.provider
      || checked.route !== record.route || match[1] !== profile || body.model !== record.route) {
    throw new Error('Native request account or routing proof is invalid');
  }
  // Only a missing canonical effort permits the provider's effort header to
  // select execution mode. Bind that choice (including absence) to this nonce.
  const boundHeaderEffort = record.snapshot.reasoning?.effort == null ? headerEffort ?? null : null;
  const digest = createHash('sha256').update(canonical({ body, headerEffort: boundHeaderEffort })).digest('hex');
  if (record.claimed && record.digest !== digest) throw new Error('Native request retry changed after forwarding');
  if (!record.claimed) { record.claimed = true; record.claimedAt = Date.now(); record.digest = digest; }
  // Magpie can translate protocols, merge messages, lift additional_tools,
  // rewrite tool_search and cache keys, or mask local paths. Item tickets cannot
  // survive those transforms. Forward the exact request captured at the trusted
  // local entry, bound to this account by the nonce + onProvider route proof.
  // Never infer another pending request when proof was masked or lost.
  const snapshot = structuredClone(record.snapshot);
  for (const key of Object.keys(body)) delete body[key];
  Object.assign(body, snapshot);
  return body;
}

export function complete(nonce) { if (typeof nonce === 'string') forget(nonce); }
