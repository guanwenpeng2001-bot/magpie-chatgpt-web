import { BackendError } from './guard.mjs';

export function browserProfileOf(auth) {
  const profile = auth?.browserProfile ?? auth?.profile;
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new BackendError('browserConfiguration');
  return profile;
}
