import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PROVIDER } from './config.mjs';
import { browserProfileOf } from '../../backend/browser-profile.mjs';

const profileName = /^[A-Za-z0-9_-]{1,64}$/;
const accountKey = key => key === PROVIDER || /^chatgpt-web#[A-Za-z0-9_-]+$/.test(key ?? '');
const identity = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const trustedIdentity = value => /^[^\s@]+@[^\s@]+$/.test(identity(value));
const snapshot = (key, auth) => ({ key, profile: auth.profile,
  browserProfile: browserProfileOf(auth), accountId: auth.accountId });

// Magpie scopes authorize/callback to the selected saved account. Reusing its
// profile keeps browser verification, native route IDs and tunnel ownership in
// the same place. A new-account scope has no saved row and gets its own profile.
export async function scopedBrowserAccount(input) {
  const key = input?.magpie?.account?.(PROVIDER);
  const directory = input?.directory;
  if (!accountKey(key) || typeof directory !== 'string' || !isAbsolute(directory)) return null;
  let all;
  try { all = JSON.parse(await readFile(join(directory, 'plugin-auth.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read the selected ChatGPT browser account.'); }
  const auth = all?.[key];
  if (!auth) return null;
  if (auth.type !== 'oauth' || !profileName.test(auth.profile ?? '') || !trustedIdentity(auth.accountId)) {
    throw new Error('The selected ChatGPT account has no reusable browser profile.');
  }
  return snapshot(key, auth);
}

export async function verifyBrowserAccount(input, original, credential) {
  if (!original) return;
  const current = await scopedBrowserAccount(input);
  if (!current || current.key !== original.key || current.profile !== original.profile || current.browserProfile !== original.browserProfile
      || identity(current.accountId) !== identity(original.accountId)) {
    throw new Error('The selected ChatGPT account changed during sign-in. Start sign-in again.');
  }
  if (credential?.profile !== original.browserProfile || identity(credential?.accountId) !== identity(original.accountId)) {
    throw new Error('This browser is signed in to a different ChatGPT account. Use the selected account, or add the other account separately.');
  }
}

export async function bindSignedInBrowser(input, original, credential, claimedProfile) {
  if (!trustedIdentity(credential?.accountId)) throw new Error('ChatGPT did not provide a verified account identity. Sign in again.');
  await verifyBrowserAccount(input, original, credential);
  // Preserve the native route even when the user signed in through Add account:
  // the host deduplicates equal account IDs after this callback. Keep the newly
  // verified browser in place rather than copying its cookies to the old one.
  if (credential?.profile !== claimedProfile) throw new Error('The sign-in result belongs to a different browser profile.');
  let target = original;
  if (!target && typeof input?.directory === 'string' && isAbsolute(input.directory) && identity(credential?.accountId)) {
    let all;
    try { all = JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot preserve the existing ChatGPT model route.'); }
    const matches = Object.entries(all ?? {}).filter(([key, auth]) => accountKey(key) && auth?.type === 'oauth'
      && identity(auth.accountId) === identity(credential.accountId));
    if (matches.length > 1) throw new Error('Multiple saved entries match this ChatGPT account. Reconnect the intended saved account.');
    if (matches.length === 1) {
      const [key, auth] = matches[0];
      if (!profileName.test(auth.profile ?? '')) throw new Error('The existing ChatGPT model route has an invalid profile.');
      target = snapshot(key, auth);
    }
  }
  return { binding: target ?? null, credential: !target ? credential
    : { ...credential, accountId: target.accountId, profile: target.profile,
      ...(target.profile !== credential.profile ? { browserProfile: credential.profile } : {}) } };
}
