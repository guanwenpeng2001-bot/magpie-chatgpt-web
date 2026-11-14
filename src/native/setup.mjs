import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativeRoot } from './runtime.mjs';
import { writePrivate, lockAccount } from './daemon.mjs';

export const SETUP_RETRY = 'Choose Resume Native setup (existing account) in Magpie sign-in, or run magpie plugin login chatgpt-web 2, then select this account.';
const stages = Object.freeze({
  install: 'Install could not finish. Check connectivity, the pinned runtime files and local file access.',
  startup: 'The Native runtime could not start. Check local runtime and tunnel availability.',
  invalidState: 'Saved Native state is incomplete or belongs to a different account. It was not changed. Restore trusted account state before retrying.',
  platformSignin: 'OpenAI Platform sign-in did not finish. Complete Platform sign-in when retrying.',
  tunnelPermission: 'Tunnel management permission is required. Check your organization permissions.',
  keyUi: 'Runtime key setup did not finish. Check Platform key settings; keep the existing saved key.',
  connectorTunnelMissing: 'The tunnel was not visible to ChatGPT. Check the tunnel connection.',
  connectorCreate: 'ChatGPT connector setup did not finish. Check connector settings and account access.',
  verify: 'Native setup verification did not finish. Check the existing tunnel and connector.',
  cancelled: 'Native setup was cancelled. Saved setup progress is kept.',
  interrupted: 'Native setup completion is unknown; setup may still be running. Saved progress is kept, and retry will refuse while another setup owns this account.',
});
const active = new Set();
function homeFor(account, root) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(account?.profile ?? '')) throw new Error('Invalid Native setup account');
  return join(resolve(root), 'accounts', account.profile);
}
export function setupResult(state, stage) {
  if (state === 'ready') return { state, message: 'Native setup complete. Select this account’s Native tools model.' };
  if (state === 'busy') return { state, message: 'Native setup is already running or account ownership is unavailable. Wait for the current setup to finish before retrying.' };
  const safe = Object.hasOwn(stages, stage) ? stage : 'verify';
  return { state: state === 'needed' ? 'needed' : 'failed', stage: safe,
    message: `${state === 'needed' ? 'Native setup is not complete.' : stages[safe]} Text sign-in is kept. ${SETUP_RETRY}` };
}
export function cleanSetupResult(value) { return setupResult(value?.state, value?.stage); }

// Shared by setup readiness, startup and status. A present but invalid file is
// never treated as an unprovisioned account: that could recreate remote assets.
export async function readNativeState(account, { root = nativeRoot() } = {}) {
  try {
    const saved = JSON.parse(await readFile(join(homeFor(account, root), 'native.json'), 'utf8'));
    if (saved?.profile !== account.profile || ['tunnelId', 'runtimeKey', 'connectorId', 'linkId']
      .some(key => typeof saved[key] !== 'string' || !saved[key].trim())) throw new Error('Invalid state');
    return saved;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error(stages['invalidState']), { code: 'invalidState' });
  }
}

// Read-only: never installs, starts a runtime, opens a browser, or retries setup.
export async function readSetupStatus(account, { root = nativeRoot() } = {}) {
  const home = homeFor(account, root);
  if (active.has(home)) return setupResult('busy');
  let status;
  try { status = JSON.parse(await readFile(join(home, 'setup-status.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') return setupResult('failed', 'verify'); }
  if (status?.state === 'running') return setupResult('failed', 'interrupted');
  if (status?.state === 'failed') return cleanSetupResult(status);
  try {
    if (await readNativeState(account, { root })) return setupResult('ready');
  } catch { return setupResult('failed', 'invalidState'); }
  return setupResult('needed');
}

// The explicit setup path owns a separate OS lease until the actual operation
// and cleanup settle, even if the RPC caller has already stopped waiting.
export async function runNativeSetup(account, run, { root = nativeRoot(), signal } = {}) {
  signal?.throwIfAborted();
  const home = homeFor(account, root);
  if (active.has(home)) return setupResult('busy');
  active.add(home);
  let lease, stage = 'startup';
  const save = value => writePrivate(join(home, 'setup-status.json'), JSON.stringify(value));
  try {
    try { lease = await lockAccount(join(home, 'setup-owner')); }
    catch { return setupResult('busy'); }
    signal?.throwIfAborted();
    await save({ state: 'running' });
    try {
      const ready = await run(value => { if (Object.hasOwn(stages, value)) stage = value; });
      signal?.throwIfAborted();
      if (!ready) throw new Error('Native setup did not finish');
      await save({ state: 'ready' });
      return setupResult('ready');
    } catch (error) {
      const result = setupResult('failed', signal?.aborted ? 'cancelled' : Object.hasOwn(stages, error?.code) ? error.code : stage);
      await save({ state: result.state, stage: result.stage });
      signal?.throwIfAborted();
      return result;
    }
  } finally {
    if (lease) await new Promise(resolveClose => lease.close(resolveClose));
    active.delete(home);
  }
}
