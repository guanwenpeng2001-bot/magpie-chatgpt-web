import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const PLATFORM = 'https://platform.openai.com';
const API = 'https://api.openai.com';
const CHATGPT = 'https://chatgpt.com';
const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
const messages = Object.freeze({
  platformSignin: '请登录 OpenAI 平台并选择默认组织。 / Sign in to OpenAI Platform and select the default organization.',
  tunnelPermission: '缺少隧道管理权限，请联系组织管理员。 / Tunnel management permission is required; contact your organization administrator.',
  keyUi: '无法创建或保存运行密钥，请检查平台密钥页面及安全存储。 / Could not create or save the runtime key; check the Platform keys page and secret storage. An existing key without saved credentials must be recovered before retrying.',
  connectorTunnelMissing: '隧道尚未上线，请检查隧道客户端后重试。 / The tunnel is not visible; check the tunnel client and retry.',
  connectorCreate: '无法配置 ChatGPT 连接器，请检查登录状态及连接器设置。 / Could not configure the ChatGPT connector; check sign-in and connector settings.',
  verify: '配置验证失败，请检查账号、状态文件及工具连接。 / Provisioning verification failed; check the account, state file, and tool connection.',
});

// Never attach upstream errors, response bodies, request options, or causes: any
// of them can contain the dashboard bearer, access token, or one-time secret.
export class ProvisionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'verify';
    super(messages[safeCode]);
    this.name = 'ProvisionError';
    this.code = safeCode;
  }
}

export function connectorNameFor(profileId) {
  if (typeof profileId !== 'string' || !profileId.trim()) throw new ProvisionError('verify');
  return `Codex Magpie ${profileId.slice(0, 8)}`;
}

function requireValue(condition, code = 'verify') {
  if (!condition) throw new ProvisionError(code);
}

function entries(value, property) {
  const list = Array.isArray(value) ? value : value?.[property] ?? value?.data;
  requireValue(Array.isArray(list));
  return list;
}

function exactResource(list, name) {
  const matches = list.filter(item => item?.name === name);
  requireValue(matches.length <= 1);
  return matches[0];
}

function idOf(value, code = 'verify') {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), code);
  return value;
}

function matchesPost(response, url) {
  return response.url() === url && response.request().method() === 'POST';
}

/** Capture the dashboard's own login response; never replay its login request. */
// The plugin's Chrome profile is signed in to ChatGPT, not necessarily to
// platform.openai.com. The page stays visible so the user can finish that
// sign-in (usually one click through the shared OpenAI account).
export async function capturePlatformSession(page, { timeoutMs = 30_000, signinTimeoutMs = 10 * 60_000 } = {}) {
  try {
    const responsePromise = page.waitForResponse(
      response => matchesPost(response, `${API}/v1/dashboard/onboarding/login`) && response.ok(),
      { timeout: signinTimeoutMs },
    );
    // Observe both promises immediately: navigation can fail before the waiter
    // rejects, and the waiter can time out while navigation is still pending.
    const [response] = await Promise.all([responsePromise, (async () => {
      await page.goto(`${PLATFORM}/settings/organization/tunnels`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.bringToFront?.().catch?.(() => {});
    })()]);
    requireValue(response.ok(), 'platformSignin');
    const { user } = await response.json();
    const org = user?.orgs?.data?.find(item => item.is_default);
    const project = org?.projects?.data?.find(item => item.is_initial);
    requireValue(typeof user?.session?.sensitive_id === 'string' && user.session.sensitive_id.startsWith('sess-'), 'platformSignin');
    requireValue(/^org-[A-Za-z0-9_-]+$/.test(org?.id) && project?.id, 'platformSignin');
    return {
      bearer: user.session.sensitive_id,
      organizationId: org.id,
      projectId: idOf(project.id, 'platformSignin'),
      projectName: project.name || 'Default project',
    };
  } catch {
    throw new ProvisionError('platformSignin');
  }
}

async function visibleChoice(locators) {
  for (const locator of locators) {
    if (await locator.count() === 1 && await locator.isVisible()) return locator;
  }
  throw new ProvisionError('keyUi');
}

async function choose(scope, page, label, name) {
  const radio = scope.getByRole('radio', { name, exact: true });
  if (await radio.count() === 1 && await radio.isVisible()) {
    await radio.check();
    return;
  }
  const labeled = scope.getByLabel(label, { exact: true });
  const combo = scope.getByRole('combobox', { name: label, exact: true });
  for (const locator of [labeled, combo]) {
    if (await locator.count() !== 1 || !await locator.isVisible()) continue;
    if (await locator.evaluate(element => element.tagName) === 'SELECT') {
      await locator.selectOption({ label: name });
      return;
    }
    await locator.click();
    await (await visibleChoice([
      page.getByRole('option', { name, exact: true }),
      page.getByRole('menuitem', { name, exact: true }),
    ])).click();
    return;
  }
  await (await visibleChoice([
    scope.getByRole('button', { name, exact: true }),
    scope.getByText(name, { exact: true }),
  ])).click();
}

/**
 * UI-only creation: the site's own submission supplies Sentinel. onKey must
 * durably save the one-time secret; it runs before any dialog cleanup.
 * This helper takes only a Page interface and is independently fake-testable.
 */
export async function createRuntimeKeyViaUi(page, {
  organizationId, projectId, projectName = 'Default project', name,
  onKey = async () => {}, timeoutMs = 30_000,
}) {
  try {
    await page.goto(`${PLATFORM}/settings/organization/api-keys`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const create = page.getByRole('button', { name: 'Create new secret key', exact: true });
    await create.waitFor({ state: 'visible', timeout: timeoutMs });
    // A one-time secret cannot be read back. Never silently duplicate an exact
    // existing name when the caller has lost its saved key.
    const existing = page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
    requireValue(await existing.count() === 0, 'keyUi');
    await create.click();
    const dialog = page.getByRole('dialog', { name: 'Create new secret key' });
    await dialog.waitFor({ state: 'visible', timeout: timeoutMs });
    // Measured 2026-11-13: owner and permission groups are Radix radio buttons;
    // Project and each permission row use a span[role=button] select trigger
    // whose listbox renders in a separate popover outside the dialog.
    await dialog.getByRole('radio', { name: 'You', exact: true }).click();
    await dialog.locator('input').first().fill(name);
    await dialog.locator('span[role=button]').filter({ hasText: /Select project/ }).click();
    await page.getByRole('option', { name: projectName, exact: true }).first().click();
    // Create stays disabled until an expiration is chosen; the picker may open
    // by itself right after the project is selected.
    const never = page.getByRole('option', { name: /^(Never|永不过期)$/ }).first();
    if (!await never.isVisible().catch(() => false)) {
      await dialog.locator('span[role=button]').filter({ hasText: /Select an expiration|选择有效期/ }).click();
    }
    await never.click();
    await dialog.getByRole('radio', { name: 'Restricted', exact: true }).click();
    const tunnelsTrigger = await dialog.getByRole('button', { name: 'Tunnels', exact: true })
      .evaluate(element => element.parentElement?.querySelector('span[role=button]')?.id ?? '');
    requireValue(tunnelsTrigger, 'keyUi');
    await page.locator(`[id="${tunnelsTrigger}"]`).click();
    await page.getByRole('listbox').getByRole('option', { name: 'Use', exact: true }).click();
    await page.locator(`[id="${tunnelsTrigger}"]`).click();
    requireValue(/2 selected permissions/.test(await dialog.getByText(/selected permission/).innerText()), 'keyUi');
    const responsePromise = page.waitForResponse(
      response => matchesPost(response, `${API}/dashboard/organizations/${organizationId}/projects/${projectId}/api_keys`),
      { timeout: timeoutMs },
    );
    const [response] = await Promise.all([
      responsePromise,
      dialog.getByRole('button', { name: 'Create secret key', exact: true }).click(),
    ]);
    requireValue(response.ok(), 'keyUi');
    const data = await response.json();
    const key = data?.key?.sensitive_id;
    requireValue(typeof key === 'string' && /^sk-\S+$/.test(key), 'keyUi');
    await onKey(key);
    const resultDialog = page.getByRole('dialog');
    await (await visibleChoice([
      resultDialog.getByRole('button', { name: 'Done', exact: true }),
      resultDialog.getByRole('button', { name: 'Close', exact: true }),
      resultDialog.getByRole('button', { name: 'Close dialog', exact: true }),
    ])).click();
    return key;
  } catch {
    throw new ProvisionError('keyUi');
  }
}

async function loadState(stateFile, profileId, connectorName) {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    requireValue(state?.version === 1 && state.profileId === profileId && state.connectorName === connectorName);
    if (state.tunnelId) requireValue(TUNNEL_ID.test(state.tunnelId));
    if (state.runtimeKey) requireValue(typeof state.runtimeKey === 'string' && /^sk-\S+$/.test(state.runtimeKey));
    if (state.connectorId) idOf(state.connectorId);
    if (state.linkId) idOf(state.linkId);
    requireValue(!state.runtimeKey || state.tunnelId);
    requireValue(!state.connectorId || state.runtimeKey);
    requireValue(!state.linkId || state.connectorId);
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, profileId, connectorName };
    throw new ProvisionError('verify');
  }
}

async function saveState(stateFile, state) {
  // Atomic replace prevents a killed process leaving a truncated checkpoint.
  // This file contains runtimeKey: treat it as a secret, including on Windows
  // where the parent directory's ACL controls access (mode is POSIX-only).
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, stateFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function platformRequest(fetchImpl, session, path, method = 'GET', body) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.bearer}`, 'openai-organization': session.organizationId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (response.status === 403) throw new ProvisionError('tunnelPermission');
  if (response.status === 401) throw new ProvisionError('platformSignin');
  const data = await response.json();
  if (data?.error?.code === 'tunnel_management_permission_required' || data?.code === 'tunnel_management_permission_required') {
    throw new ProvisionError('tunnelPermission');
  }
  requireValue(response.ok);
  return data;
}

// All ChatGPT traffic runs inside its own page, with same-origin cookies. The
// evaluated function is deliberately self-contained for Playwright serialization.
async function chatRequest(page, path, { method = 'GET', body, auth, timeoutMs = 30_000 } = {}) {
  return page.evaluate(async ({ path, method, body, auth, timeoutMs }) => {
    const response = await fetch(path, {
      method, credentials: 'same-origin', redirect: 'error',
      headers: auth ? {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        'OAI-Product-Sku': 'CONNECTOR_SETTING',
        'Content-Type': 'application/json',
      } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }, { path, method, body, auth, timeoutMs });
}

function checked(response, code, allow404 = false) {
  if (allow404 && response.status === 404) return null;
  requireValue(response.status >= 200 && response.status < 300, code);
  return response.data;
}

function connectorFrom(data) { return data && Object.hasOwn(data, 'connector') ? data.connector : data; }
function linkFrom(data) { return data && Object.hasOwn(data, 'link') ? data.link : data; }

/**
 * Provision one profile, serially (the caller must serialize use of stateFile).
 *
 * Required: context (signed-in Playwright BrowserContext), profileId, stateFile,
 * saveSecret(bytes: Buffer), ensureTunnelRunning({ tunnelId, runtimeKey }).
 * Optional: connectorName, fetchImpl (Platform only), sleep, now,
 * tunnelTimeoutMs (0..120000), pollIntervalMs, uiTimeoutMs.
 *
 * Returns { tunnelId, runtimeKey, connectorId, linkId }. runtimeKey is sensitive:
 * do not log this result. The confidential checkpoint contains the key as well
 * as IDs so resuming needs no additional secret-read callback. saveSecret must
 * support repeat writes; a crash between that callback and checkpoint may retry.
 * Neither session bearer nor ChatGPT access token is persisted.
 */
export async function provisionNativeHarness({
  context, profileId, stateFile, connectorName = connectorNameFor(profileId),
  saveSecret, ensureTunnelRunning, fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  tunnelTimeoutMs = 120_000, pollIntervalMs = 1_000, uiTimeoutMs = 30_000,
}) {
  let stage = 'verify';
  const pages = [];
  try {
    requireValue(context && typeof context.newPage === 'function' && typeof stateFile === 'string' && stateFile.length);
    requireValue(typeof saveSecret === 'function' && typeof ensureTunnelRunning === 'function');
    requireValue(typeof connectorName === 'string' && connectorName.trim().length > 0);
    requireValue(Number.isFinite(tunnelTimeoutMs) && tunnelTimeoutMs >= 0 && tunnelTimeoutMs <= 120_000);
    requireValue(Number.isFinite(pollIntervalMs) && pollIntervalMs > 0);
    const state = await loadState(stateFile, profileId, connectorName);
    delete state.verified;
    const persist = () => saveState(stateFile, state);
    stage = 'platformSignin';
    const platform = await context.newPage();
    pages.push(platform);
    const session = await capturePlatformSession(platform, { timeoutMs: uiTimeoutMs });
    requireValue(!state.organizationId || state.organizationId === session.organizationId);
    requireValue(!state.projectId || state.projectId === session.projectId);
    Object.assign(state, { organizationId: session.organizationId, projectId: session.projectId });
    await persist();

    stage = 'verify';
    const principals = await platformRequest(fetchImpl, session, '/v1/tunnels/principals');
    requireValue(principals.organizations?.some(org => org.id === session.organizationId), 'tunnelPermission');
    const workspace = state.workspaceId
      ? principals.workspaces?.find(item => item.id === state.workspaceId)
      : principals.workspaces?.find(item => item.is_default) ?? principals.workspaces?.[0];
    requireValue(workspace?.id, 'tunnelPermission');
    state.workspaceId = idOf(workspace.id, 'tunnelPermission');
    await persist();
    const tunnelName = connectorNameFor(profileId);
    const tunnels = await platformRequest(fetchImpl, session, `/v1/tunnels?organization_id=${encodeURIComponent(session.organizationId)}`);
    let tunnel = exactResource(entries(tunnels, 'tunnels'), tunnelName);
    if (state.tunnelId) requireValue(tunnel?.id === state.tunnelId);
    if (!tunnel) {
      tunnel = await platformRequest(fetchImpl, session, '/v1/tunnels', 'POST', {
        name: tunnelName, description: 'Magpie ChatGPT Web native tools',
        organization_ids: [session.organizationId], workspace_ids: [state.workspaceId],
      });
    }
    requireValue(TUNNEL_ID.test(tunnel?.id));
    state.tunnelId = tunnel.id;
    await persist();

    stage = 'keyUi';
    if (!state.runtimeKey) {
      await createRuntimeKeyViaUi(platform, {
        ...session, name: `Codex Magpie tunnel ${profileId.slice(0, 8)}`, timeoutMs: uiTimeoutMs,
        onKey: async key => {
          state.runtimeKey = key;
          state.secretSaved = false;
          await persist();
          await saveSecret(Buffer.from(key, 'utf8'));
          state.secretSaved = true;
          await persist();
        },
      });
    } else if (!state.secretSaved) {
      await saveSecret(Buffer.from(state.runtimeKey, 'utf8'));
      state.secretSaved = true;
      await persist();
    }

    stage = 'connectorCreate';
    const chat = await context.newPage();
    pages.push(chat);
    await chat.goto(CHATGPT, { waitUntil: 'domcontentloaded', timeout: uiTimeoutMs });
    const account = checked(await chatRequest(chat, '/api/auth/session'), stage);
    requireValue(typeof account?.accessToken === 'string' && account.accessToken.length && account?.account?.id, stage);
    const auth = { accessToken: account.accessToken, accountId: account.account.id };
    requireValue(!state.accountId || state.accountId === auth.accountId);
    state.accountId = auth.accountId;
    await persist();
    const request = (path, options = {}) => chatRequest(chat, path, { ...options, auth });

    stage = 'connectorTunnelMissing';
    await ensureTunnelRunning({ tunnelId: state.tunnelId, runtimeKey: state.runtimeKey });
    const deadline = now() + tunnelTimeoutMs;
    // The attempt cap also bounds injected clocks that fail to advance.
    const attempts = Math.ceil(tunnelTimeoutMs / pollIntervalMs) + 1;
    let visible = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = Math.max(1, deadline - now());
      const result = await request('/backend-api/aip/connectors/mcp/tunnels', { timeoutMs: Math.min(30_000, remaining) });
      const listed = checked(result, stage);
      visible = entries(listed, 'tunnels').some(item => (typeof item === 'string' ? item : item?.id ?? item?.tunnel_id) === state.tunnelId);
      if (visible) break;
      if (now() >= deadline || attempt === attempts - 1) break;
      await sleep(Math.min(pollIntervalMs, deadline - now()));
    }
    requireValue(visible, stage);

    stage = 'connectorCreate';
    let connector;
    if (state.connectorId) {
      connector = connectorFrom(checked(await request(`/backend-api/aip/connectors/${encodeURIComponent(state.connectorId)}?include_actions=true`), stage));
      requireValue(connector?.id === state.connectorId && connector.name === connectorName && connector.tunnel_id === state.tunnelId);
    } else {
      // Follow cursor pages when provided; an unavailable list (404) falls back
      // to the persisted connector ID on subsequent runs.
      let cursor;
      let listingUnavailable = false;
      const seen = new Set();
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const data = checked(await request(`/backend-api/aip/connectors?${query}`), stage, true);
        if (data === null) { listingUnavailable = true; break; }
        const found = exactResource(entries(data, 'connectors').map(connectorFrom), connectorName);
        requireValue(!connector || !found);
        connector ??= found;
        cursor = data.next_cursor;
        requireValue(!data.has_more || cursor, stage);
        if (cursor) { requireValue(!seen.has(cursor), stage); seen.add(cursor); }
      } while (cursor);
      if (connector) requireValue(connector.tunnel_id === state.tunnelId);
      else {
        // A lost creation response cannot be recovered from a 404 list. Do not
        // duplicate an unknown remote result; leave the intent for recovery.
        requireValue(!state.connectorCreatePending || !listingUnavailable, stage);
        state.connectorCreatePending = true;
        await persist();
        connector = connectorFrom(checked(await request('/backend-api/aip/connectors/mcp', {
          method: 'POST', body: {
            name: connectorName, description: 'Codex tools via Magpie', tunnel_id: state.tunnelId,
            logo_url: null, auth_request: { supported_auth: [{ type: 'NONE' }] },
          },
        }), stage));
      }
      state.connectorId = idOf(connector?.id, stage);
      delete state.connectorCreatePending;
      await persist();
    }

    const linkPath = `/backend-api/aip/connectors/${encodeURIComponent(state.connectorId)}/link`;
    let link = linkFrom(checked(await request(linkPath), stage, true));
    if (state.linkId) requireValue(link?.id === state.linkId);
    if (link) {
      requireValue(!link.connector_id || link.connector_id === state.connectorId);
      requireValue(!link.name || link.name === connectorName);
    } else {
      link = linkFrom(checked(await request('/backend-api/aip/connectors/links/noauth', {
        method: 'POST', body: { connector_id: state.connectorId, name: connectorName, action_names: [] },
      }), stage));
    }
    state.linkId = idOf(link?.id, stage);
    await persist();
    if (link.apps_privacy_control !== 'full_access') {
      checked(await request(`/backend-api/aip/connectors/links/${encodeURIComponent(state.linkId)}`, {
        method: 'PATCH', body: { apps_privacy_control: 'full_access' },
      }), stage);
    }
    state.permissionGranted = true;
    await persist();

    stage = 'verify';
    const verified = connectorFrom(checked(await request(`/backend-api/aip/connectors/${encodeURIComponent(state.connectorId)}?include_actions=true`), stage));
    requireValue(verified?.id === state.connectorId && verified.name === connectorName && verified.tunnel_id === state.tunnelId);
    requireValue(Array.isArray(verified.actions) && verified.actions.length > 0);
    const active = linkFrom(checked(await request(linkPath), stage));
    requireValue(active?.id === state.linkId && active.auth_status === 'ACTIVE');
    requireValue(!active.connector_id || active.connector_id === state.connectorId);
    state.verified = true;
    await persist();
    return { tunnelId: state.tunnelId, runtimeKey: state.runtimeKey, connectorId: state.connectorId, linkId: state.linkId };
  } catch (error) {
    // Reconstruct even ProvisionError instances; injected hooks may throw one
    // whose message/cause has been replaced with credential-bearing diagnostics.
    throw new ProvisionError(error instanceof ProvisionError ? error.code : stage);
  } finally {
    await Promise.allSettled(pages.map(page => Promise.resolve().then(() => page.close())));
  }
}

export const provision = provisionNativeHarness;
