import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BackendError } from '../../backend/guard.mjs';

// Host storage supplies peer identities. Neither browser output nor a model
// request can choose peer accounts or a storage path.
export async function continuityProfiles(input, selected) {
  if (typeof input?.directory !== 'string' || !isAbsolute(input.directory)) return undefined;
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  if (!valid(selected?.profile)) throw new BackendError('binding');
  let all;
  try { all = JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8')); }
  catch { throw new BackendError('binding'); }
  const peers = new Set([selected.profile]);
  for (const [key, auth] of Object.entries(all ?? {})) {
    if (!(key === 'chatgpt-web' || /^chatgpt-web#[A-Za-z0-9_-]+$/.test(key)) || auth?.type !== 'oauth'
        || !valid(auth.profile) || typeof auth.accountId !== 'string' || !auth.accountId.trim()) continue;
    peers.add(auth.profile);
  }
  if (peers.size > 128) throw new BackendError('capacity');
  return [...peers].sort();
}
