import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, mkdir, open, readFile, readdir, link, unlink, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const DAY_MS = 86_400_000;
export const RETENTION_MS = 7 * DAY_MS;
const MAX_ENTRIES = 20_000;
const SOURCES = new Set(['native', 'text']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']);
const STAGES = new Set(['message', 'compaction', 'multipart']);
const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const keyValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export class UsageStoreError extends Error {
  constructor(code) { super('Local send accounting unavailable'); this.name = 'UsageStoreError'; this.code = code; }
}
const fail = code => { throw new UsageStoreError(code); };

// Same identity as the reference's readChatGptUsageAccount; never store either ID.
export function accountKeyFromSession(session) {
  const ids = [session?.user?.id, session?.account?.id];
  if (!ids.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0'))) return;
  return hash(ids.join('\0'));
}

// Both text and native producers use the native account home, NOT the browser
// profile directory. An explicit root supports isolated installations/tests.
export function usageProfile(profileId, root = resolve(homedir(), '.config/magpie/chatgpt-web-native')) {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) fail('usage-config');
  return join(resolve(root), 'accounts', profileId);
}

export function normalizeModel(value) {
  if (typeof value !== 'string') return 'unknown';
  const model = value.replace(/^chatgpt-web\//, '').replace(/^gpt-5-6(?=-|$)/, 'gpt-5.6');
  return /^(?:gpt-[a-z0-9.-]{1,64}|o[1-9][a-z0-9.-]{0,64}|pro-unknown|other|unknown)$/.test(model) ? model : 'unknown';
}

function directory({ profile, accountKey }) {
  if (typeof profile !== 'string' || !isAbsolute(profile) || !keyValid(accountKey)) fail('usage-config');
  return join(profile, 'usage-v1', accountKey);
}
function clock(now) { if (!timestamp(now)) fail('usage-clock'); return now; }
async function regularJSON(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) fail('usage-corrupt');
  const text = await readFile(file, 'utf8'); // preserve ENOENT during expiry pruning
  try { return JSON.parse(text); } catch { fail('usage-corrupt'); }
}
async function ensureDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('usage-corrupt');
}
async function names(dir) {
  try {
    const parent = await lstat(dirname(dir));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('usage-corrupt');
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('usage-corrupt');
    return await readdir(dir);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Publish a fully written immutable file with an atomic exclusive hard link.
// No shared read/modify/write state: parallel Node/Bun writers cannot lose sends.
async function publish(dir, name, value) {
  await ensureDirectory(dirname(dir));
  await ensureDirectory(dir);
  const temporary = join(dir, `.pending-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = undefined;
    try { await link(temporary, join(dir, name)); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validCoverage(value, source) {
  return value?.version === 1 && value.kind === 'coverage' && value.source === source && timestamp(value.at)
    && Object.keys(value).length === 4;
}
function validEvent(value, name) {
  const expected = value?.kind === 'send' ? 's' : value?.kind === 'gap' ? 'g' : null;
  if (!expected || name !== `${expected}-${value.id}.json` || !keyValid(value.id) || value.version !== 1
    || !SOURCES.has(value.source) || !timestamp(value.at)) return false;
  return value.kind === 'gap' ? Object.keys(value).length === 5
    : Object.keys(value).length === 8 && typeof value.model === 'string'
      && (normalizeModel(value.model) !== 'unknown' || value.model === 'unknown') && EFFORTS.has(value.effort) && STAGES.has(value.stage);
}

async function readEvents(dir, files, signal) {
  const result = [];
  for (let offset = 0; offset < files.length; offset += 32) {
    signal?.throwIfAborted();
    const batch = await Promise.all(files.slice(offset, offset + 32).map(async name => {
      let value;
      try { value = await regularJSON(join(dir, name)); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!validEvent(value, name)) fail('usage-corrupt');
      return { name, value };
    }));
    result.push(...batch.filter(Boolean));
  }
  return result;
}

// Capacity is a shared invariant even though individual receipts are immutable.
// A kernel-owned listener serializes admission; process exit releases it. Never
// create/delete a lock file or infer that a slow writer's lock is stale.
async function admitted(dir, work) {
  const canonical = await realpath(dir);
  const identity = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\magpie-usage-${identity}`
    : process.platform === 'linux' ? `\0magpie-usage-${identity}`
      // Other platforms have no portable auto-unlinked Unix socket. A collision
      // only serializes unrelated stores or fails optional accounting as busy.
      : { host: '127.0.0.1', port: 49152 + Number.parseInt(identity.slice(0, 8), 16) % 16384 };
  const deadline = performance.now() + 5000;
  do {
    const listener = createServer(socket => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      listener.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(new UsageStoreError('usage-lock')));
      listener.listen(address, () => resolve(true));
    });
    if (acquired) {
      try { return await work(); }
      finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(new UsageStoreError('usage-lock')) : resolve())); }
    }
    await delay(10 + Math.floor(Math.random() * 15));
  } while (performance.now() < deadline);
  fail('usage-busy');
}

/** Call after verified account identity is known, before the first Send. Optional:
 * recordSubmission starts coverage at its first observed send if omitted. */
export async function beginTracking(input, { now = Date.now() } = {}) {
  clock(now);
  if (!SOURCES.has(input.source)) fail('usage-config');
  const dir = directory(input), name = `start-${input.source}.json`;
  const created = await publish(dir, name, { version: 1, kind: 'coverage', source: input.source, at: now });
  const value = await regularJSON(join(dir, name));
  if (!validCoverage(value, input.source)) fail('usage-corrupt');
  if (value.at > now) fail('usage-clock');
  return created;
}

async function record(input, kind, now) {
  clock(now);
  const dir = directory(input);
  if (!SOURCES.has(input.source) || typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 256
    || !timestamp(input.at)) fail('usage-receipt');
  if (input.at > now) fail('usage-clock');
  // Replayed old receipts cannot re-enter a rolling window after pruning.
  if (input.at <= now - RETENTION_MS) return false;
  const id = hash(input.id), name = `${kind === 'send' ? 's' : 'g'}-${id}.json`;
  const value = { version: 1, kind, id, at: input.at, source: input.source,
    ...(kind === 'send' ? { model: normalizeModel(input.model), effort: EFFORTS.has(input.effort) ? input.effort : 'unknown',
      stage: input.stage ?? 'message' } : {}) };
  if (kind === 'send' && !STAGES.has(value.stage)) fail('usage-receipt');
  await beginTracking(input, { now });
  return admitted(dir, () => recordAdmitted(dir, name, value, now));
}

async function recordAdmitted(dir, name, value, now) {
  const { kind } = value;
  // Check replay before capacity: retrying an already persisted Send never needs
  // another slot, even when the store is full.
  try {
    const old = await regularJSON(join(dir, name));
    if (!validEvent(old, name)) fail('usage-corrupt');
    if (old.kind !== kind || old.source !== value.source || (kind === 'send' && normalizeModel(old.model) !== value.model)
      || old.effort !== value.effort || old.stage !== value.stage) fail('usage-conflict');
    return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = (await names(dir)).filter(name => /^[sg]-[a-f0-9]{64}\.json$/.test(name));
  if (files.length >= MAX_ENTRIES) {
    const values = await readEvents(dir, files);
    const expired = values.filter(x => x.value.at <= now - RETENTION_MS);
    for (let offset = 0; offset < expired.length; offset += 32) {
      await Promise.all(expired.slice(offset, offset + 32).map(x => unlink(join(dir, x.name)).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    }
    const retained = values.length - expired.length;
    if (retained >= MAX_ENTRIES) fail('usage-capacity');
  }
  const created = await publish(dir, name, value);
  if (!created) {
    const old = await regularJSON(join(dir, name));
    if (!validEvent(old, name)) fail('usage-corrupt');
    // Replayed observation may have a later callback time. Keep the first time.
    if (old.kind !== kind || old.source !== value.source || (kind === 'send' && normalizeModel(old.model) !== value.model)
      || old.effort !== value.effort || old.stage !== value.stage) fail('usage-conflict');
  }
  return created;
}

/** One call per proven physical Send. Stable receipt ID across observer recovery;
 * distinct ID for each actual multipart Send. Never call from token/tool events. */
export async function recordSubmission(input, { now = Date.now() } = {}) { return record(input, 'send', now); }
export async function recordTrackingGap(input, { now = Date.now() } = {}) { return record(input, 'gap', now); }

/** No auth IDs, receipt IDs, arbitrary descriptions, or prompt text leave here. */
export async function readUsage(input, { now, signal } = {}) {
  if (now !== undefined) clock(now);
  signal?.throwIfAborted();
  const dir = directory(input), files = await names(dir);
  if (files.some(name => !/^(?:[sg]-[a-f0-9]{64}\.json|start-(?:native|text)\.json|\.pending-[a-f0-9-]+)$/.test(name))) fail('usage-corrupt');
  const eventFiles = files.filter(name => /^[sg]-[a-f0-9]{64}\.json$/.test(name));
  if (eventFiles.length > MAX_ENTRIES) fail('usage-capacity');
  const sources = [], events = [];
  for (const source of SOURCES) {
    const name = `start-${source}.json`;
    if (!files.includes(name)) continue;
    const value = await regularJSON(join(dir, name));
    if (!validCoverage(value, source)) fail('usage-corrupt');
    sources.push({ source, since: value.at });
  }
  for (const { value: event } of await readEvents(dir, eventFiles, signal)) {
    if (!sources.some(x => x.source === event.source)) fail('usage-corrupt');
    events.push(event.kind === 'send' ? { ...event, model: normalizeModel(event.model) } : event);
  }
  now = clock(now ?? Date.now());
  if (sources.some(x => x.since > now) || events.some(x => x.at > now)) fail('usage-clock');
  // Receipt callbacks may arrive out of order. Earlier proven sends are retained
  // even if another writer published the first coverage marker moments later.
  for (const source of sources) for (const event of events) if (event.source === source.source) source.since = Math.min(source.since, event.at);
  const recent = events.filter(x => x.at > now - RETENTION_MS);
  const sends = recent.filter(x => x.kind === 'send');
  // A later proven Send resolves an earlier uncertain observation of that ID.
  const confirmed = new Set(events.filter(x => x.kind === 'send').map(x => `${x.source}:${x.id}`));
  const gaps = recent.filter(x => x.kind === 'gap' && !confirmed.has(`${x.source}:${x.id}`));
  const count = (list, window) => list.filter(x => x.at > now - window).length;
  const groups = new Map();
  for (const event of sends) {
    const key = JSON.stringify([event.model, event.effort]);
    const group = groups.get(key) ?? { model: event.model, effort: event.effort, day: 0, week: 0 };
    group.week++; if (event.at > now - DAY_MS) group.day++;
    groups.set(key, group);
  }
  signal?.throwIfAborted();
  return { version: 1, status: sources.length ? 'tracking' : 'not-started', asOf: now,
    since: sources.length ? Math.min(...sources.map(x => x.since)) : null, sources,
    day: count(sends, DAY_MS), week: sends.length, gaps: { day: count(gaps, DAY_MS), week: gaps.length },
    byStage: Object.fromEntries([...STAGES].map(stage => [stage, { day: count(sends.filter(x => x.stage === stage), DAY_MS), week: sends.filter(x => x.stage === stage).length }])),
    byModel: [...groups.values()].sort((a, b) => b.week - a.week || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort)),
  };
}
