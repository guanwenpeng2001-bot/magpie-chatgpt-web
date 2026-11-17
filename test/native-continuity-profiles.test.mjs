import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuityProfiles } from '../src/native/continuity-profiles.mjs';
import { nativeClient } from '../src/native/index.mjs';

test('continuity peers come only from this host provider registry and the authenticated selected account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'continuity-peers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = profile => ({ type: 'oauth', profile, accountId: 'fixture@example.test' });
  const path = join(directory, 'plugin-auth.json');
  await writeFile(path, JSON.stringify({ 'chatgpt-web': saved('a'), 'chatgpt-web#b': saved('b'),
    'chatgpt-web#bad': saved('../foreign'), 'another-provider': saved('unrelated'),
    'chatgpt-web#api': { ...saved('not-browser'), type: 'api' } }));
  assert.deepEqual(await continuityProfiles({ directory }, saved('c')), ['a', 'b', 'c']);
  const calls = [];
  const client = nativeClient({ input: { directory }, profileRoot: join(directory, 'profiles'),
    bridge: { async call(command) { calls.push(command); return null; } } });
  assert.deepEqual(await client.models(saved('a')), {});
  assert.equal(calls[0].method, 'nativeRuntime');
  assert.deepEqual(calls[0].continuityPeers, ['a', 'b']);
  await writeFile(path, JSON.stringify({ 'chatgpt-web': saved('a') }));
  assert.deepEqual(await continuityProfiles({ directory }, saved('a')), ['a']);
  await assert.rejects(continuityProfiles({ directory }, saved('../outside')), { code: 'binding' });
  await writeFile(path, '{');
  await assert.rejects(continuityProfiles({ directory }, saved('a')), { code: 'binding' });
  assert.equal(await continuityProfiles(undefined, saved('a')), undefined);
});
