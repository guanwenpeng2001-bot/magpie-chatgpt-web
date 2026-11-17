import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const profile = /^[A-Za-z0-9_-]{1,64}$/;
const POLICY = 'continuity-policy.json';
const MAX_POLICY_BYTES = 16_384;
const writers = new Map();
const normalized = path => process.platform === 'win32' ? path.toLowerCase() : path;
const fail = () => new Error('Native account continuity authority unavailable; restore the daemon-owned account policy before retrying.');

function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw fail();
  const canonical = realpathSync(path);
  // Reject links in ancestors as well as a linked final component.
  if (normalized(canonical) !== normalized(resolve(path))) throw fail();
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function unchanged(...bound) {
  for (const previous of bound) {
    const current = directory(previous.path);
    if (current.dev !== previous.dev || current.ino !== previous.ino) throw fail();
  }
}

function profiles(value, home) {
  if (!Array.isArray(value) || !value.length || value.length > 128
    || value.some(name => typeof name !== 'string' || !profile.test(name))
    || new Set(value.map(normalized)).size !== value.length
    || !value.some(name => normalized(name) === normalized(basename(home)))) throw fail();
  return [...value].sort();
}

function readPolicy(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
  const valid = item => item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.size <= MAX_POLICY_BYTES
    && (process.platform === 'win32' || (!(item.mode & 0o077) && item.uid === process.getuid()));
  if (!valid(stat)) throw fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!valid(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail();
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size || bytes.length > MAX_POLICY_BYTES) throw fail();
    const body = JSON.parse(bytes.toString('utf8'));
    if (!body || body.version !== 1 || Object.keys(body).some(key => !['version', 'profiles'].includes(key))) throw fail();
    return { bytes, profiles: profiles(body.profiles, dirname(path)) };
  } finally { closeSync(fd); }
}

/** Backend/daemon only: home is the already selected account's owned path.
 * The root and policy filename are derived here, never accepted from a request.
 * Write before launch and before reusing an owner after the host auth list changes.
 * Return exactly the env entry to pass to the native server, never tunnel/MCP.
 */
export async function writeAccountContinuityPolicy(home, names) {
  let authority, owner, path, body;
  try {
    if (typeof home !== 'string' || !isAbsolute(home)) throw fail();
    home = resolve(home);
    const selected = profiles(names, home); // Snapshot before the first await.
    authority = directory(dirname(home));
    body = Buffer.from(JSON.stringify({ version: 1, profiles: selected }) + '\n');
  } catch { throw fail(); }
  const key = normalized(home), previous = writers.get(key) ?? Promise.resolve();
  const work = previous.then(async () => {
    let temporary, created = false;
    try {
      unchanged(authority);
      await mkdir(home, { recursive: false, mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
      owner = directory(home);
      if (normalized(dirname(owner.path)) !== normalized(authority.path)) throw fail();
      path = join(owner.path, POLICY);
      unchanged(authority, owner);
      const before = readPolicy(path);
      if (before?.bytes.equals(body)) return { MAGPIE_NATIVE_CONTINUITY_POLICY: path };
      temporary = join(owner.path, `.continuity-policy-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try { await handle.writeFile(body); await handle.sync(); }
      finally { await handle.close(); }
      unchanged(authority, owner);
      const current = readPolicy(path);
      if (before ? !current?.bytes.equals(before.bytes) : current !== undefined) throw fail();
      await rename(temporary, path);
      return { MAGPIE_NATIVE_CONTINUITY_POLICY: path };
    } catch { throw fail(); }
    finally { if (created) await rm(temporary, { force: true }); }
  });
  const settled = work.then(() => {}, () => {});
  writers.set(key, settled);
  settled.then(() => { if (writers.get(key) === settled) writers.delete(key); });
  return work;
}

/** A local daemon capability, never request metadata or tool arguments.
 * POLICY enables live reads of home/continuity-policy.json on every peer lookup.
 * Without POLICY, ROOT/PEERS retain the immutable legacy/fixture behavior.
 * The host must construct these env entries and omit all from tunnel/MCP children.
 * Unconfigured means account-only. A configured missing/bad policy fails closed.
 * No directory enumeration, account credentials or client paths are used.
 */
export function accountContinuity(home, env = process.env) {
  const root = env.MAGPIE_NATIVE_CONTINUITY_ROOT, peers = env.MAGPIE_NATIVE_CONTINUITY_PEERS, policy = env.MAGPIE_NATIVE_CONTINUITY_POLICY;
  if (!policy && !root && !peers) return null;
  try {
    if (typeof home !== 'string' || !isAbsolute(home)) throw fail();
    const owner = directory(resolve(home));
    const policyPath = join(owner.path, POLICY);
    if (policy && (typeof policy !== 'string' || !isAbsolute(policy) || normalized(resolve(policy)) !== normalized(policyPath))) throw fail();
    const rootPath = policy ? dirname(owner.path) : root;
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath)
      || policy && root && normalized(resolve(root)) !== normalized(rootPath)) throw fail();
    const authority = directory(resolve(rootPath));
    if (normalized(dirname(owner.path)) !== normalized(authority.path)) throw fail();
    const currentProfiles = policy ? () => {
      const value = readPolicy(policyPath);
      if (!value) throw fail();
      return value.profiles;
    } : (() => {
      if (typeof peers !== 'string' || peers.length > MAX_POLICY_BYTES) throw fail();
      const names = profiles(JSON.parse(peers), owner.path);
      return () => names;
    })();
    currentProfiles();
    return Object.freeze({
      peerHomes() {
        try {
          unchanged(authority, owner);
          return currentProfiles().filter(name => normalized(name) !== normalized(basename(owner.path))).flatMap(name => {
            try { return [directory(join(authority.path, name)).path]; }
            catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
          });
        } catch { throw fail(); }
      },
    });
  } catch { throw fail(); }
}

/** Apply after the existing checkpoint persistence patches in the checksum-
 * pinned 6.1.18 runtime. Keep px's hash check/commit and every source, identity
 * and canonical-rollout check intact. A peer lookup is not authorization from
 * the summary: it can only select an already authenticated durable checkpoint.
 * Self-contained because runtime embeds this function's source in its preload.
 */
export function patchNativeAccountContinuity(source) {
  const edits = [
    ['function yi(e,t){let n=ss(e,t),r=n?Kt.get(n):void 0;if(!n||!r)return;',
      'function yi(e,t){let n=ss(e,t),r;if(!n)return;'],
    ['return s!==null&&px(n,r,s)?{checkpoint:r,summaryIndex:i}:void 0',
      'r=s===null?void 0:magpieCheckpointPersistence?magpieCheckpointPersistence.lookup(n,s):Kt.get(n);return r&&s!==null&&px(n,r,s)?{checkpoint:r,summaryIndex:i}:void 0'],
    ['for(let o of[...Kt.keys()]){let[i,a]=JSON.parse(o);',
      'for(let o of magpieCheckpointPersistence?magpieCheckpointPersistence.scopes(n):[...Kt.keys()]){let[i,a]=JSON.parse(o);'],
  ];
  if (typeof source !== 'string' || !source.includes('var magpieCheckpointPersistence=')) throw new Error('Native account continuity persistence anchor mismatch');
  for (const [index, [before]] of edits.entries()) {
    if (source.split(before).length !== 2) throw new Error('Native account continuity anchor mismatch: ' + index);
  }
  for (const [before, after] of edits) source = source.replace(before, () => after);
  return source;
}
