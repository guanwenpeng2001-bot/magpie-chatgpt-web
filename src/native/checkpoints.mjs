import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, mkdirSync, lstatSync, fstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accountContinuity } from './account-continuity.mjs';

const VERSION = 'magpie-native-checkpoints:1:codex-chatgpt-web:6.1.18';
const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => new Error('Native checkpoint persistence unavailable; preserve the account checkpoint files and retry after restoring storage access.');

function regular(path, maximum) {
  const stat = lstatSync(path);
  const valid = item => item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.size <= maximum
    && (process.platform === 'win32' || !(item.mode & 0o077));
  if (!valid(stat)) throw fail();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!valid(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail();
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size || bytes.length > maximum) throw fail();
    return bytes;
  } finally { closeSync(descriptor); }
}

function scopeParts(scope) {
  const parts = typeof scope === 'string' ? JSON.parse(scope) : null;
  if (!Array.isArray(parts) || parts.length !== 4 || parts.slice(0, 3).some(part => typeof part !== 'string' || !part)
    || !(parts[3] === null || typeof parts[3] === 'string')) throw fail();
  return parts;
}

function validated(entries) {
  if (!Array.isArray(entries) || entries.length > 256) throw fail();
  const map = new Map();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw fail();
    const [scope, value] = pair;
    scopeParts(scope);
    if (map.has(scope)) throw fail();
    if (!value || typeof value !== 'object' || !HASH.test(value.summaryHash)
      || !Array.isArray(value.sourceHashes) || !value.sourceHashes.length || value.sourceHashes.length > 256
      || value.sourceHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))
      || !value.source || typeof value.source !== 'object' || !Object.hasOwn(value.source, 'content')
      || typeof value.sourceWasSyntheticInstruction !== 'boolean') throw fail();
    if (value.continuityGeneration !== undefined
      && (!Number.isSafeInteger(value.continuityGeneration) || value.continuityGeneration < 1)) throw fail();
    for (const field of ['turnId', 'itemId', 'nativeTurnId']) {
      if (value.source[field] !== undefined && typeof value.source[field] !== 'string') throw fail();
    }
    if (!value.sourceHashes.includes(digest([value.source.turnId, value.source.content]))) throw fail();
    if ((value.taskMessage === undefined) !== (value.taskItemId === undefined)) throw fail();
    if (value.taskMessage !== undefined && (!value.taskMessage || typeof value.taskMessage !== 'object'
      || !['user', 'agentMessage'].includes(value.taskMessage.role) || !Object.hasOwn(value.taskMessage, 'content')
      || typeof value.taskItemId !== 'string' || !value.taskItemId)) throw fail();
    map.set(scope, { ...value, sourceHashes: new Set(value.sourceHashes) });
  }
  return map;
}

function serialize(map) {
  return JSON.stringify([...map].map(([scope, value]) => [scope, { ...value, sourceHashes: [...value.sourceHashes] }]));
}

function associatedData(canonical) {
  const account = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return Buffer.from(`${VERSION}\n${account}`, 'utf8');
}

function decrypt(encrypted, key, aad) {
  if (key.length !== 32 || encrypted.length < 28) throw fail();
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
  decipher.setAAD(aad); decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
}

// Read peers in place, never create a peer store or copy its key/ciphertext.
// Only a fully authenticated snapshot which passed the original record validator
// participates. Missing state is empty; existing but unreadable state is fatal.
function peerSnapshot(home) {
  const canonical = realpathSync(home);
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== home.toLowerCase() : canonical !== home)) throw fail();
  let encrypted;
  try { encrypted = regular(join(home, 'checkpoints.bin'), MAX_BYTES + 64); }
  catch (cause) { if (cause.code === 'ENOENT') return new Map(); throw cause; }
  const key = regular(join(home, 'checkpoints.key'), 32);
  // Bind to the path approved by the policy, not a subsequently redirected peer.
  return validated(JSON.parse(decrypt(encrypted, key, associatedData(home))));
}

/** Only the account-owned daemon writes this store. Never derive checkpoint
 * authority from user history: the pinned runtime calls commit after its own
 * rememberCompactionContinuation has accepted the source and generated summary.
 */
export function checkpointStore(home, { env = process.env } = {}) {
  try {
    if (!isAbsolute(home)) throw fail();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (lstatSync(home).isSymbolicLink()) throw fail();
    const canonical = realpathSync(resolve(home));
    const aad = associatedData(canonical);
    const continuity = accountContinuity(canonical, env);
    const keyPath = join(home, 'checkpoints.key'), statePath = join(home, 'checkpoints.bin');
    let encrypted;
    try { encrypted = regular(statePath, MAX_BYTES + 64); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let key;
    try { key = regular(keyPath, 32); }
    catch (error) {
      if (error.code !== 'ENOENT' || encrypted !== undefined) throw error;
      const descriptor = openSync(keyPath, 'wx', 0o600);
      try { key = randomBytes(32); writeFileSync(descriptor, key); fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
    }
    if (key.length !== 32) throw fail();
    let durable = '[]';
    if (encrypted !== undefined) durable = decrypt(encrypted, key, aad);
    const map = validated(JSON.parse(durable));
    const borrowed = new WeakSet();
    function* peers() {
      for (const home of continuity?.peerHomes() ?? []) yield peerSnapshot(home);
    }
    function latest(scope, local, snapshots) {
      let selected, generation = -1, conflict = false;
      const consider = value => {
        if (!value) return;
        const next = value.continuityGeneration ?? 0;
        if (next > generation) { selected = value; generation = next; conflict = false; }
        else if (next === generation && !isDeepStrictEqual(selected, value)) conflict = true;
      };
      consider(local.get(scope));
      // Release each decrypted peer snapshot after selecting this exact scope.
      for (const snapshot of snapshots) consider(snapshot.get(scope));
      if (conflict) throw fail();
      return selected;
    }
    return { map,
      lookup(scope, summary) {
        try {
          scopeParts(scope);
          if (typeof summary !== 'string') throw fail();
          const selected = latest(scope, map, peers());
          // No authorization is inserted here. The pinned px validator touches
          // Kt and commits with this account's own key only after its hash check.
          if (selected?.summaryHash !== digest(summary)) return;
          const copy = structuredClone(selected); borrowed.add(copy); return copy;
        } catch { throw fail(); }
      },
      scopes(scope) {
        try {
          const parts = scopeParts(scope), found = new Set();
          const collect = entries => {
            for (const key of entries.keys()) {
              const candidate = scopeParts(key);
              if ([0, 2, 3].every(index => candidate[index] === parts[index])) found.add(key);
            }
          };
          collect(map);
          for (const snapshot of peers()) collect(snapshot);
          return [...found];
        } catch { throw fail(); }
      },
      commit() {
      let temporary;
      try {
        while (map.size > 256) map.delete(map.keys().next().value);
        const prior = validated(JSON.parse(durable));
        for (const [scope, value] of map) {
          if (isDeepStrictEqual(prior.get(scope), value)) continue;
          if (!continuity && prior.get(scope)?.continuityGeneration === undefined) continue;
          const previous = latest(scope, prior, peers());
          if (borrowed.has(value)) {
            if (!isDeepStrictEqual(value, previous)) throw fail();
          } else {
            // A compaction prepared from an older local parent cannot silently
            // supersede a peer that advanced while generation was in flight.
            // Adopt the current authenticated checkpoint before recompacting.
            if (previous && !isDeepStrictEqual(previous, prior.get(scope))) throw fail();
            // Per-scope logical generations preserve supersession across A/B/A.
            // Concurrent branches with the same generation fail closed on read;
            // there is no clock arbitration or shared registry to overwrite.
            const generation = (previous?.continuityGeneration ?? 0) + 1;
            if (!Number.isSafeInteger(generation)) throw fail();
            value.continuityGeneration = generation;
          }
        }
        let next = serialize(map);
        const entries = JSON.parse(next);
        validated(entries);
        let size = Buffer.byteLength(next, 'utf8');
        // Bound both entry count and retained bytes. A full byte budget must
        // not permanently prevent new tasks from replacing older checkpoints.
        let removed = 0;
        while (size > MAX_BYTES && map.size > 1) {
          size -= Buffer.byteLength(JSON.stringify(entries[removed]), 'utf8') + 1;
          map.delete(entries[removed++][0]);
        }
        if (size > MAX_BYTES) throw fail();
        if (removed) next = serialize(map);
        const bytes = Buffer.from(next, 'utf8');
        // Refuse replaced/link targets and keys instead of silently overwriting.
        let current;
        try { current = regular(statePath, MAX_BYTES + 64); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (encrypted === undefined ? current !== undefined : !current?.equals(encrypted)) throw fail();
        if (!regular(keyPath, 32).equals(key)) throw fail();
        if (next === durable) return;
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        temporary = join(home, `.checkpoints-${randomUUID()}.tmp`);
        const descriptor = openSync(temporary, 'wx', 0o600);
        const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
        try { writeFileSync(descriptor, sealed); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        renameSync(temporary, statePath);
        encrypted = sealed;
        durable = next;
      } catch {
        // No successful compaction may expose an unpersisted authorization.
        map.clear();
        for (const [scope, value] of validated(JSON.parse(durable))) map.set(scope, value);
        throw fail();
      } finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch {} } }
    } };
  } catch { throw fail(); }
}
