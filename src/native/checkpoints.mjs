import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';

const VERSION = 'magpie-native-checkpoints:1:codex-chatgpt-web:6.1.18';
const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => new Error('Native checkpoint persistence unavailable; preserve the account checkpoint files and retry after restoring storage access.');

function regular(path, maximum) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum
    || (process.platform !== 'win32' && (stat.mode & 0o077))) throw fail();
  return readFileSync(path);
}

function validated(entries) {
  if (!Array.isArray(entries) || entries.length > 256) throw fail();
  const map = new Map();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw fail();
    const [scope, value] = pair;
    const parts = typeof scope === 'string' ? JSON.parse(scope) : null;
    if (!Array.isArray(parts) || parts.length !== 4 || parts.slice(0, 3).some(part => typeof part !== 'string' || !part)
      || !(parts[3] === null || typeof parts[3] === 'string') || map.has(scope)) throw fail();
    if (!value || typeof value !== 'object' || !HASH.test(value.summaryHash)
      || !Array.isArray(value.sourceHashes) || !value.sourceHashes.length || value.sourceHashes.length > 256
      || value.sourceHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))
      || !value.source || typeof value.source !== 'object' || !Object.hasOwn(value.source, 'content')
      || typeof value.sourceWasSyntheticInstruction !== 'boolean') throw fail();
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

/** Only the account-owned daemon writes this store. Never derive checkpoint
 * authority from user history: the pinned runtime calls commit after its own
 * rememberCompactionContinuation has accepted the source and generated summary.
 */
export function checkpointStore(home) {
  try {
    if (!isAbsolute(home)) throw fail();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (lstatSync(home).isSymbolicLink()) throw fail();
    const canonical = realpathSync(resolve(home));
    const account = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const aad = Buffer.from(`${VERSION}\n${account}`, 'utf8');
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
    if (encrypted !== undefined) {
      if (encrypted.length < 28) throw fail();
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(encrypted.subarray(12, 28));
      durable = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
    }
    const map = validated(JSON.parse(durable));
    return { map, commit() {
      let temporary;
      try {
        while (map.size > 256) map.delete(map.keys().next().value);
        const next = serialize(map);
        validated(JSON.parse(next));
        const bytes = Buffer.from(next, 'utf8');
        if (bytes.length > MAX_BYTES) throw fail();
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
