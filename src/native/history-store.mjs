import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const VERSION = 'magpie-native-history:1';
const MAX_BYTES = 32 * 1024 * 1024; // Unique original UTF-8 text, excluding framing/metadata.
const MAX_RECORDS = 16_384;
const MAX_METADATA_BYTES = 1024;
const MAX_READ = 12_000;
const MAX_SNIPPET = 512;
const MAX_FILE = 8 + MAX_BYTES + MAX_RECORDS * (8 + 2 * MAX_METADATA_BYTES) + 28;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ILL_FORMED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const WORD = /[\p{L}\p{N}_]/u;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const queues = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, message) => Object.assign(new Error(`Native history: ${message}`), { code: `ERR_HISTORY_${code}` });
const input = message => error('INPUT', message);

function thread(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw input('threadId must be a canonical UUID with a valid version and variant.');
  return value.toLowerCase();
}

function textBytes(value, field, maximum) {
  if (typeof value !== 'string' || ILL_FORMED.test(value)) throw input(`${field} must be a well-formed Unicode string.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximum) throw error('LIMIT', `${field} exceeds its ${maximum}-byte limit.`);
  return bytes;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw input(`${name} must be an integer in ${minimum}..${maximum}.`);
  return value;
}

function incomingRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw input(`records must be an array of at most ${MAX_RECORDS} entries.`);
  return records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw input('Each record must contain text, role and type strings.');
    const { text, role, type } = record;
    const bytes = textBytes(text, 'text', MAX_BYTES);
    textBytes(role, 'role', MAX_METADATA_BYTES); textBytes(type, 'type', MAX_METADATA_BYTES);
    return { id: digest(Buffer.from(text)), text, role, type, bytes };
  });
}

function options(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw input('Invalid options.');
  return value;
}

function enqueue(account, operation) {
  const previous = queues.get(account) ?? Promise.resolve();
  const result = previous.then(operation);
  // A rejected write must not poison later reads or retries.
  const settled = result.then(() => {}, () => {});
  queues.set(account, settled);
  settled.then(() => { if (queues.get(account) === settled) queues.delete(account); });
  return result;
}

async function directory(path, { create = false, privateMode = true } = {}) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateMode && process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw error('PATH', 'Storage directories must be private directories, not links.');
  }
}

async function regular(path, maximum) {
  let stat;
  try { stat = await lstat(path); }
  catch (cause) { if (cause.code === 'ENOENT') return undefined; throw cause; }
  const valid = item => item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.size <= maximum
    && (process.platform === 'win32' || !(item.mode & 0o077));
  if (!valid(stat)) throw error('PATH', 'Storage files must be private regular files within the size limit, not links.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!valid(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino) throw error('PATH', 'Storage file changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > maximum) throw error('CORRUPT', 'Storage file changed while reading.');
    return bytes;
  } finally { await handle.close(); }
}

// Binary framing avoids JSON escaping or base64 expansion consuming the text budget.
function encode(records) {
  const header = Buffer.alloc(8);
  header.write('MHS1'); header.writeUInt32BE(records.length, 4);
  const parts = [header];
  for (const record of records) {
    const text = Buffer.from(record.text), role = Buffer.from(record.role), type = Buffer.from(record.type);
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(text.length); lengths.writeUInt16BE(role.length, 4); lengths.writeUInt16BE(type.length, 6);
    parts.push(lengths, text, role, type);
  }
  return Buffer.concat(parts);
}

function decode(bytes) {
  try {
    if (bytes.length < 8 || bytes.subarray(0, 4).toString() !== 'MHS1') throw new Error();
    const count = bytes.readUInt32BE(4);
    if (count > MAX_RECORDS) throw new Error();
    const records = [], ids = new Set();
    let offset = 8, total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > bytes.length) throw new Error();
      const size = bytes.readUInt32BE(offset), roleSize = bytes.readUInt16BE(offset + 4), typeSize = bytes.readUInt16BE(offset + 6);
      offset += 8; total += size;
      if (total > MAX_BYTES || roleSize > MAX_METADATA_BYTES || typeSize > MAX_METADATA_BYTES || offset + size + roleSize + typeSize > bytes.length) throw new Error();
      const raw = bytes.subarray(offset, offset + size), id = digest(raw);
      const text = decoder.decode(raw); offset += size;
      const role = decoder.decode(bytes.subarray(offset, offset + roleSize)); offset += roleSize;
      const type = decoder.decode(bytes.subarray(offset, offset + typeSize)); offset += typeSize;
      if (ids.has(id)) throw new Error();
      ids.add(id); records.push({ id, text, role, type, bytes: size });
    }
    if (offset !== bytes.length) throw new Error();
    return records;
  } catch { throw error('CORRUPT', 'Decrypted history has an invalid format; preserve the files for recovery.'); }
}

function queryParts(query) {
  textBytes(query, 'query', 2000);
  if (query.length > 500) throw error('LIMIT', 'query exceeds its 500-character limit.');
  const trimmed = query.trim();
  if (!trimmed) throw input('query must not be empty.');
  if (trimmed.startsWith('"')) {
    let exact;
    try { exact = JSON.parse(trimmed); } catch { throw input('Exact substring queries must be JSON-quoted strings.'); }
    if (typeof exact !== 'string' || !exact.length || ILL_FORMED.test(exact)) throw input('Exact substring must be nonempty Unicode text.');
    return { exact };
  }
  const words = [...new Set(trimmed.split(/\s+/u))];
  if (words.length > 32) throw input('At most 32 query words are allowed.');
  return { words };
}

function wordOffset(text, word) {
  let offset = text.indexOf(word);
  while (offset !== -1) {
    const end = offset + word.length;
    const before = [...text.slice(Math.max(0, offset - 2), offset)].at(-1) ?? '';
    const after = String.fromCodePoint(text.codePointAt(end) ?? 0);
    if (!WORD.test(before) && !WORD.test(after)) return offset;
    offset = text.indexOf(word, offset + 1);
  }
  return -1;
}

/**
 * Account-owned, offline original-text storage. root must be an absolute account
 * directory supplied by the caller. One account-owning process is the writer;
 * all instances in that process share an async queue keyed by canonical root.
 * Files: root/history.key and root/history/<canonical-thread-UUID>.bin.
 *
 * Every method is async. append returns [{id, bytes, added}] in input order;
 * duplicate text keeps the first role/type. A batch commits atomically or rejects.
 * IDs are SHA-256 of exact UTF-8 text. Unpaired UTF-16 surrogates are rejected.
 * read returns null for an absent ID, otherwise a page with text/nextOffset/done.
 * Offsets and read limits are UTF-16 code units (like String.slice); concatenate
 * pages to reproduce the exact text, including surrogate pairs split by a page.
 * read defaults to 6000, at most 12000 code units. search returns at most 10 records
 * (default 5), one 512-code-unit snippet each. Queries allow 500 code units.
 * Search is case-sensitive: bare
 * whitespace-separated words are ANDed with Unicode word boundaries; a JSON-
 * quoted query is an exact literal substring. No regex or instruction execution.
 * Returned role/type/text/snippets are untrusted data, never system authority.
 * No eviction: 32 MiB unique UTF-8 text, 16K records, 1 KiB per metadata field.
 */
export function createHistoryStore(root, { readOnly = false } = {}) {
  if (typeof root !== 'string' || root.includes('\0') || !isAbsolute(root)) throw input('root must be an absolute account directory.');
  if (typeof readOnly !== 'boolean') throw input('readOnly must be boolean.');
  const home = resolve(root);
  let ownedKey, ownedAccount;
  const noWrite = () => { throw error('READ_ONLY', 'Peer history cannot be modified.'); };

  async function run(threadId, operation) {
    try {
      const empty = () => operation({ records: [], encrypted: undefined, commit: noWrite });
      try { await directory(home, { create: !readOnly, privateMode: false }); }
      catch (cause) { if (readOnly && cause.code === 'ENOENT') return empty(); throw cause; }
      const canonical = await realpath(home);
      const account = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (readOnly) {
        // Match the daemon policy's resolver. On Windows async realpath expands
        // valid DOS short names while sync realpath preserves their spelling.
        // Keep async canonicalization for the existing history AAD format.
        const authorized = realpathSync(home);
        if ((process.platform === 'win32' ? authorized.toLowerCase() !== home.toLowerCase() : authorized !== home)) throw error('PATH', 'Peer storage ancestors must not redirect the authorized account path.');
      }
      if (ownedAccount !== undefined && ownedAccount !== account) throw error('PATH', 'Account directory changed.');
      ownedAccount = account;
      return await enqueue(account, async () => {
        await directory(home, { privateMode: false });
        if ((process.platform === 'win32' ? (await realpath(home)).toLowerCase() : await realpath(home)) !== account) throw error('PATH', 'Account directory changed.');
        const history = join(canonical, 'history'), keyPath = join(canonical, 'history.key');
        try { await directory(history, { create: !readOnly }); }
        catch (cause) { if (readOnly && cause.code === 'ENOENT') return empty(); throw cause; }
        const path = join(history, `${threadId}.bin`);
        // A peer read opens only this chat's file; it neither enumerates other
        // threads nor initializes an absent peer directory/key/archive.
        const encrypted = await regular(path, MAX_FILE);
        if (readOnly && encrypted === undefined) return empty();
        let key = await regular(keyPath, 32);
        if (key === undefined) {
          if (readOnly || ownedKey || (await readdir(history)).length) throw error('KEY', 'Account key is missing; existing history cannot be replaced.');
          const handle = await open(keyPath, 'wx', 0o600);
          try { key = randomBytes(32); await handle.writeFile(key); await handle.sync(); }
          finally { await handle.close(); }
        }
        if (key.length !== 32 || (ownedKey && !ownedKey.equals(key))) throw error('KEY', 'Account key is invalid or changed.');
        ownedKey = key;
        const aad = Buffer.from(JSON.stringify([VERSION, account, threadId]));
        let records = [];
        if (encrypted !== undefined) {
          let plain;
          try {
            if (encrypted.length < 28) throw new Error();
            const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
            decipher.setAAD(aad); decipher.setAuthTag(encrypted.subarray(12, 28));
            plain = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
          } catch { throw error('CRYPTO', 'History authentication/decryption failed; preserve the files for recovery.'); }
          records = decode(plain);
        }
        async function commit(next) {
          if (readOnly) noWrite();
          let temporary, created = false;
          try {
            const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(aad);
            const ciphertext = Buffer.concat([cipher.update(encode(next)), cipher.final()]);
            const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
            temporary = join(history, `.${threadId}-${randomUUID()}.tmp`);
            const handle = await open(temporary, 'wx', 0o600);
            created = true;
            try { await handle.writeFile(sealed); await handle.sync(); }
            finally { await handle.close(); }
            await directory(canonical, { privateMode: false });
            await directory(history);
            if (!(await regular(keyPath, 32))?.equals(key)) throw error('KEY', 'Account key changed before commit.');
            const current = await regular(path, MAX_FILE);
            if (encrypted === undefined ? current !== undefined : !current?.equals(encrypted)) throw error('CONFLICT', 'History changed outside the account queue; retry with the current files.');
            await rename(temporary, path);
          } finally { if (created) await rm(temporary, { force: true }); }
        }
        return operation({ records, encrypted, commit });
      });
    } catch (cause) {
      if (cause.code?.startsWith('ERR_HISTORY_')) throw cause;
      throw error('IO', 'Storage I/O failed; preserve existing files and retry after restoring access.');
    }
  }

  return {
    async append(threadId, records) {
      if (readOnly) noWrite();
      const id = thread(threadId);
      // Copy and validate before waiting for I/O; caller mutation cannot change a queued batch.
      const incoming = incomingRecords(records);
      return run(id, async state => {
        const next = new Map(state.records.map(record => [record.id, record]));
        let total = state.records.reduce((sum, record) => sum + record.bytes, 0), changed = false;
        const result = incoming.map(record => {
          const existing = next.get(record.id);
          if (existing && existing.text !== record.text) throw error('CORRUPT', 'Content hash collision.');
          if (!existing) {
            total += record.bytes;
            if (total > MAX_BYTES || next.size >= MAX_RECORDS) throw error('LIMIT', 'Thread capacity exceeded (32 MiB text or 16384 records); no records were evicted or appended.');
            next.set(record.id, record); changed = true;
          }
          return { id: record.id, bytes: record.bytes, added: !existing };
        });
        if (changed) await state.commit([...next.values()]);
        return result;
      });
    },
    // Internal migration API, never exposed as a broker tool. Snapshot peers
    // before acquiring this account's queue so reciprocal imports cannot deadlock.
    // The final append merges against the latest local state in one transaction.
    async appendFrom(threadId, peers, records) {
      if (readOnly) noWrite();
      const id = thread(threadId), incoming = incomingRecords(records);
      const unique = new Map();
      let bytes = 0;
      const collect = entries => {
        for (const record of entries) {
          const existing = unique.get(record.id);
          if (existing && existing.text !== record.text) throw error('CORRUPT', 'Content hash collision.');
          if (existing) continue;
          bytes += record.bytes;
          if (bytes > MAX_BYTES || unique.size >= MAX_RECORDS) throw error('LIMIT', 'Thread capacity exceeded during continuity import; no records were evicted or appended.');
          unique.set(record.id, record);
        }
      };
      for (const peer of peers) collect(await peer.snapshot(id));
      collect(incoming);
      return this.append(id, [...unique.values()]);
    },
    async snapshot(threadId) {
      return run(thread(threadId), ({ records }) => records.map(record => ({ ...record })));
    },
    async search(threadId, query, opts = {}) {
      const id = thread(threadId), parsed = queryParts(query);
      options(opts, ['limit']);
      const limit = integer(opts.limit === undefined ? 5 : opts.limit, 'limit', 1, 10);
      return run(id, ({ records }) => {
        const results = [];
        for (const record of records) {
          const offsets = parsed.exact === undefined ? parsed.words.map(word => wordOffset(record.text, word)) : [record.text.indexOf(parsed.exact)];
          if (offsets.some(offset => offset < 0)) continue;
          const matchOffset = Math.min(...offsets), offset = Math.max(0, matchOffset - 80);
          results.push({ id: record.id, role: record.role, type: record.type, bytes: record.bytes,
            snippet: record.text.slice(offset, offset + MAX_SNIPPET), offset, matchOffset, untrusted: true });
          if (results.length === limit) break;
        }
        return results;
      });
    },
    async read(threadId, recordId, opts = {}) {
      const id = thread(threadId);
      if (typeof recordId !== 'string' || !HASH.test(recordId)) throw input('id must be a lowercase SHA-256 hex digest.');
      options(opts, ['offset', 'limit']);
      const offset = integer(opts.offset === undefined ? 0 : opts.offset, 'offset', 0, MAX_BYTES);
      const limit = integer(opts.limit === undefined ? 6000 : opts.limit, 'limit', 1, MAX_READ);
      return run(id, ({ records }) => {
        const record = records.find(item => item.id === recordId);
        if (!record) return null;
        if (offset > record.text.length) throw input('offset exceeds the record length.');
        const text = record.text.slice(offset, offset + limit), nextOffset = offset + text.length;
        return { id: record.id, role: record.role, type: record.type, text, bytes: record.bytes,
          offset, nextOffset, totalChars: record.text.length, done: nextOffset === record.text.length, untrusted: true };
      });
    },
    async stats(threadId) {
      const id = thread(threadId);
      return run(id, ({ records, encrypted }) => ({ records: records.length,
        bytes: records.reduce((sum, record) => sum + record.bytes, 0), encryptedBytes: encrypted?.length ?? 0,
        maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS, maxReadChars: MAX_READ, maxSnippetChars: MAX_SNIPPET }));
    },
  };
}
