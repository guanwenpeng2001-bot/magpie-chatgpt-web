import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inspect } from 'node:util';
import {
  provision, provisionNativeHarness, connectorNameFor, ProvisionError,
  capturePlatformSession, createRuntimeKeyViaUi,
} from '../src/native/provision.mjs';

// No Playwright browser is launched and no global fetch is used. Even the
// serialized page.evaluate callback executes with an isolated fake fetch.
const PROFILE = '12345678-profile';
const NAME = 'Codex Magpie 12345678';
const KEY_NAME = 'Codex Magpie tunnel 12345678';
const TUNNEL = `tunnel_${'a'.repeat(32)}`;
const OTHER_TUNNEL = `tunnel_${'b'.repeat(32)}`;
const KEY = ['sk', 'proj', 'fixture', 'runtime', 'key', 'x'.repeat(24)].join('-');
const BEARER = 'sess-fixture-dashboard-secret';
const TOKEN = ['chatgpt', 'fixture', 'access', 'token', 'y'.repeat(16)].join('-');
const LOGIN = 'https://api.openai.com/v1/dashboard/onboarding/login';
const KEY_URL = 'https://api.openai.com/dashboard/organizations/org-default/projects/proj-initial/api_keys';
const LEAK = `${KEY} ${BEARER} ${TOKEN}`;

function jsonResponse(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(data) };
}

function browserResponse(url, data, status = 200, method = 'POST') {
  return {
    url: () => url, request: () => ({ method: () => method }),
    ok: () => status >= 200 && status < 300, json: async () => structuredClone(data),
  };
}

class FakeLocator {
  constructor(page, kind, name, parent) { Object.assign(this, { page, kind, name, parent }); }
  getByRole(kind, { name } = {}) { return new FakeLocator(this.page, kind, name, this); }
  getByLabel(name) { return new FakeLocator(this.page, 'label', name, this); }
  getByText(name) { return new FakeLocator(this.page, 'text', name, this); }
  filter({ has }) { this.filterName = has.name; return this; }
  async count() {
    const { server } = this.page;
    if (this.kind === 'row') {
      if (this.filterName === KEY_NAME) return server.keys.filter(key => key.name === KEY_NAME).length;
      return this.filterName === 'Tunnels' && !server.missingTunnelsRow ? 1 : 0;
    }
    if (this.kind === 'dialog') return this.page.phase === 'form' || this.page.phase === 'secret' ? 1 : 0;
    if (this.kind === 'radio') return server.uiMode === 'radio' && ['You', 'Restricted', 'Use'].includes(this.name) ? 1 : 0;
    if (this.kind === 'label') return this.name === 'Project' || (server.uiMode !== 'radio' && ['Owned by', 'Permissions'].includes(this.name)) ? 1 : 0;
    if (this.kind === 'combobox') return 1;
    if (this.kind === 'textbox') return this.name === (server.optionalName ? 'Name (optional)' : 'Name') ? 1 : 0;
    if (this.kind === 'option') return 1;
    if (this.kind === 'menuitem' || this.kind === 'text') return 0;
    if (this.kind === 'button') return ['Create new secret key', 'Create secret key', 'Done'].includes(this.name) ? 1 : 0;
    return 0;
  }
  async isVisible() { return (await this.count()) === 1; }
  async waitFor() { assert.equal(await this.isVisible(), true); }
  async evaluate(fn) { return fn({ tagName: this.page.server.uiMode === 'select' ? 'SELECT' : 'BUTTON' }); }
  async selectOption({ label }) { this.page.recordChoice(label); }
  async check() { assert.equal(await this.count(), 1); this.page.recordChoice(this.name); }
  async fill(value) { assert.equal(await this.count(), 1); this.page.form.name = value; }
  async click() {
    const { page } = this;
    assert.equal(await this.count(), 1);
    if (this.name === 'Create new secret key') { page.phase = 'form'; return; }
    if (this.name === 'Create secret key') {
      page.server.trip('keySubmit');
      assert.deepEqual(page.form, { owner: 'You', name: KEY_NAME, project: 'Default project', permissions: 'Restricted', tunnels: 'Use' });
      page.server.keys.push({ name: page.form.name });
      page.server.created.key++;
      page.phase = 'secret';
      // Wrong methods, origins and projects must never satisfy the interceptor.
      page.emit(browserResponse(KEY_URL, { key: { sensitive_id: 'sk-wrong-method' } }, 200, 'GET'));
      page.emit(browserResponse(KEY_URL.replace('proj-initial', 'proj-other'), { key: { sensitive_id: 'sk-wrong-project' } }));
      page.emit(browserResponse(KEY_URL, { key: { sensitive_id: page.server.keyValue } }, page.server.keyStatus));
      return;
    }
    if (this.name === 'Done') { page.server.trip('closeDialog'); page.phase = 'list'; return; }
    if (this.kind === 'option') page.recordChoice(this.name);
  }
}

class FakePage extends FakeLocator {
  constructor(server) {
    super(null, 'page');
    this.page = this;
    this.server = server;
    this.waiters = [];
    this.form = {};
    this.closed = false;
  }
  recordChoice(name) {
    const field = { You: 'owner', Restricted: 'permissions', Use: 'tunnels', 'Default project': 'project' }[name];
    assert.ok(field, `Unknown UI choice: ${name}`);
    this.form[field] = name;
  }
  waitForResponse(predicate) {
    return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject }));
  }
  emit(response) {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(response)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(response); }
    }
  }
  async goto(url) {
    this.server.navigation.push(url);
    this.url = url;
    if (url.endsWith('/organization/tunnels')) {
      this.server.trip('platformNavigation');
      this.emit(browserResponse(LOGIN, {}, 200, 'GET'));
      this.emit(browserResponse(LOGIN, this.server.login, this.server.loginStatus));
    } else if (url.endsWith('/organization/api-keys')) {
      this.server.trip('keyNavigation');
      this.phase = 'list';
    } else assert.equal(url, 'https://chatgpt.com');
  }
  async evaluate(fn, args) {
    assert.equal(this.url, 'https://chatgpt.com');
    const execute = runInNewContext(`(${fn.toString()})`, {
      fetch: (path, options) => this.server.chatFetch(path, options), AbortSignal,
    });
    return execute(args);
  }
  async close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(LEAK));
    this.server.trip('pageClose');
  }
}

class FakeServer {
  constructor() {
    this.login = { user: {
      session: { sensitive_id: BEARER },
      orgs: { data: [
        { id: 'org-other', projects: { data: [{ id: 'proj-other', is_initial: true }] } },
        { id: 'org-default', is_default: true, projects: { data: [
          { id: 'proj-other' }, { id: 'proj-initial', name: 'Default project', is_initial: true },
        ] } },
      ] },
    } };
    this.loginStatus = 200;
    this.keyStatus = 200;
    this.keyValue = KEY;
    this.uiMode = 'radio';
    this.tunnels = [];
    this.keys = [];
    this.connectors = [];
    this.link = null;
    this.created = { tunnel: 0, key: 0, connector: 0, link: 0, permission: 0 };
    this.calls = [];
    this.navigation = [];
    this.visibility = [true];
    this.clock = 0;
    this.sleeps = [];
    this.secrets = [];
    this.hooks = [];
    this.accountId = 'account-one';
  }
  trip(point) {
    if (this.failAt !== point) return;
    this.failAt = undefined;
    throw new Error(LEAK);
  }
  async platformFetch(url, options) {
    assert.equal(options.headers.Authorization, `Bearer ${BEARER}`);
    assert.equal(options.headers['openai-organization'], 'org-default');
    assert.equal(options.redirect, 'error');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.openai.com');
    assert.ok(!parsed.pathname.endsWith('/api_keys'), 'API key creation must use UI');
    this.calls.push({ surface: 'platform', path: parsed.pathname, method: options.method });
    if (this.permissionStatus) return jsonResponse({ error: { code: 'tunnel_management_permission_required', message: LEAK } }, this.permissionStatus);
    if (parsed.pathname.endsWith('/principals')) {
      this.trip('principals');
      return jsonResponse({ organizations: [{ id: 'org-default' }], workspaces: this.workspaces ?? [{ id: 'workspace-one' }] });
    }
    assert.equal(parsed.pathname, '/v1/tunnels');
    if (options.method === 'GET') {
      this.trip('tunnelList');
      assert.equal(parsed.searchParams.get('organization_id'), 'org-default');
      return jsonResponse({ tunnels: this.tunnels });
    }
    this.trip('tunnelCreate');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      name: NAME, description: 'Magpie ChatGPT Web native tools',
      organization_ids: ['org-default'], workspace_ids: ['workspace-one'],
    });
    const tunnel = { id: this.tunnelId ?? TUNNEL, name: body.name };
    this.tunnels.push(tunnel);
    this.created.tunnel++;
    this.trip('tunnelCreated');
    return jsonResponse(tunnel);
  }
  async chatFetch(path, options) {
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    this.calls.push({ surface: 'chat', path, method: options.method });
    if (path === '/api/auth/session') {
      this.trip('chatSession');
      return jsonResponse({ accessToken: TOKEN, account: { id: this.accountId } });
    }
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], this.accountId);
    assert.equal(options.headers['OAI-Product-Sku'], 'CONNECTOR_SETTING');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    if (path.endsWith('/mcp/tunnels')) {
      this.trip('visibility');
      assert.ok(this.hooks.length > 0);
      const visible = this.visibility.length > 1 ? this.visibility.shift() : this.visibility[0];
      return jsonResponse({ tunnels: visible ? [{ id: TUNNEL }] : [] });
    }
    if (path.startsWith('/backend-api/aip/connectors?')) {
      this.trip('connectorList');
      if (this.listUnavailable) return jsonResponse({ message: LEAK }, 404);
      if (this.listStatus) return jsonResponse({ message: LEAK }, this.listStatus);
      if (this.pagedList && !new URL(path, 'https://chatgpt.com').searchParams.has('cursor')) {
        return jsonResponse({ connectors: [], next_cursor: 'page-two', has_more: true });
      }
      return jsonResponse({ connectors: this.connectors });
    }
    if (path.endsWith('/connectors/mcp')) {
      this.trip('connectorCreate');
      assert.deepEqual(body, {
        name: NAME, description: 'Codex tools via Magpie', tunnel_id: TUNNEL,
        logo_url: null, auth_request: { supported_auth: [{ type: 'NONE' }] },
      });
      const connector = { id: 'connector-one', name: NAME, tunnel_id: TUNNEL, actions: [{ name: 'tools' }] };
      this.connectors.push(connector);
      this.created.connector++;
      this.trip('connectorCreated');
      return jsonResponse({ connector });
    }
    if (path.endsWith('/links/noauth')) {
      this.trip('linkCreate');
      assert.deepEqual(body, { connector_id: 'connector-one', name: NAME, action_names: [] });
      this.link = { id: 'link-one', name: NAME, connector_id: 'connector-one', auth_status: 'ACTIVE' };
      this.created.link++;
      this.trip('linkCreated');
      return jsonResponse(this.link);
    }
    if (path.endsWith('/links/link-one')) {
      this.trip('permission');
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(body, { apps_privacy_control: 'full_access' });
      this.link.apps_privacy_control = 'full_access';
      this.created.permission++;
      this.trip('permissionSet');
      return jsonResponse(null, 204);
    }
    if (path.endsWith('/connector-one/link')) {
      this.trip('linkLookup');
      if (this.created.permission) this.trip('verifyLink');
      return jsonResponse(this.link, this.link ? 200 : 404);
    }
    if (path.endsWith('/connector-one?include_actions=true')) {
      this.trip('verifyConnector');
      const connector = this.connectors.find(item => item.id === 'connector-one');
      return jsonResponse({ connector: { ...connector, ...this.verifyOverride } });
    }
    assert.fail(`Unexpected fake route ${options.method} ${path}`);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-provision-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = new FakeServer();
  const pages = [];
  const stateFile = join(directory, 'state.json');
  const options = {
    context: { newPage: async () => { const page = new FakePage(server); pages.push(page); return page; } },
    profileId: PROFILE, stateFile,
    fetchImpl: server.platformFetch.bind(server),
    saveSecret: async bytes => { server.trip('saveSecret'); assert.ok(Buffer.isBuffer(bytes)); server.secrets.push(bytes.toString()); },
    ensureTunnelRunning: async value => { server.trip('ensureTunnelRunning'); server.hooks.push(value); },
    now: () => server.clock,
    sleep: async ms => { server.sleeps.push(ms); server.clock += ms; },
  };
  return { server, pages, options, state: async () => JSON.parse(await readFile(stateFile, 'utf8')) };
}

async function rejectsSafely(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof ProvisionError);
    if (code) assert.equal(error.code, code);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    assert.match(error.message, /[a-zA-Z]/);
    for (const secret of [KEY, BEARER, TOKEN]) assert.ok(!inspect(error, { depth: 10 }).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('name uses exactly the first eight profile characters', () => {
  assert.equal(connectorNameFor(PROFILE), NAME);
  assert.equal(connectorNameFor('short'), 'Codex Magpie short');
  assert.equal(provision, provisionNativeHarness);
  assert.throws(() => connectorNameFor(''), { code: 'verify' });
});

test('fresh run uses the captured session, exact bodies, UI key and same-origin ChatGPT fetch', async t => {
  const { options, state, server, pages } = await fixture(t);
  assert.deepEqual(await provision(options), { tunnelId: TUNNEL, runtimeKey: KEY, connectorId: 'connector-one', linkId: 'link-one' });
  assert.deepEqual(server.created, { tunnel: 1, key: 1, connector: 1, link: 1, permission: 1 });
  assert.deepEqual(server.secrets, [KEY]);
  assert.deepEqual(server.hooks, [{ tunnelId: TUNNEL, runtimeKey: KEY }]);
  const checkpoint = await state();
  assert.equal(checkpoint.verified, true);
  assert.equal(checkpoint.secretSaved, true);
  assert.equal(checkpoint.workspaceId, 'workspace-one');
  assert.equal(checkpoint.accountId, 'account-one');
  assert.ok(!JSON.stringify(checkpoint).includes(BEARER));
  assert.ok(!JSON.stringify(checkpoint).includes(TOKEN));
  if (process.platform !== 'win32') assert.equal((await stat(options.stateFile)).mode & 0o777, 0o600);
  assert.ok(pages.every(page => page.closed));
});

test('completed checkpoint is verified again and causes no repeated resource writes', async t => {
  const { options, server } = await fixture(t);
  const first = await provision(options);
  const creates = { ...server.created };
  assert.deepEqual(await provision(options), first);
  assert.deepEqual(server.created, creates);
  assert.equal(server.secrets.length, 1);
  assert.equal(server.hooks.length, 2, 'tunnel process must be ensured on every run');
  assert.equal(server.navigation.filter(url => url.endsWith('/api-keys')).length, 1);
});

const interruptions = [
  ['principals', 'organizationId'], ['tunnelList', 'workspaceId'],
  ['keyNavigation', 'tunnelId'], ['saveSecret', 'runtimeKey'],
  ['closeDialog', 'secretSaved'], ['chatSession', 'secretSaved'],
  ['ensureTunnelRunning', 'accountId'], ['connectorList', 'accountId'],
  ['linkLookup', 'connectorId'], ['permission', 'linkId'],
  ['verifyConnector', 'permissionGranted'], ['verifyLink', 'permissionGranted'],
];
for (const [point, savedField] of interruptions) {
  test(`resume after ${savedField} checkpoint (${point}) creates each resource once`, async t => {
    const { options, server, state, pages } = await fixture(t);
    server.failAt = point;
    await rejectsSafely(() => provision(options));
    assert.ok((await state())[savedField]);
    assert.ok(pages.every(page => page.closed));
    await provision(options);
    assert.deepEqual(server.created, { tunnel: 1, key: 1, connector: 1, link: 1, permission: 1 });
    assert.deepEqual(server.secrets, [KEY]);
    assert.equal((await state()).verified, true);
  });
}

for (const point of ['tunnelCreated', 'connectorCreated', 'linkCreated', 'permissionSet']) {
  test(`remote success before an interrupted response (${point}) is reused on retry`, async t => {
    const { options, server } = await fixture(t);
    server.failAt = point;
    await rejectsSafely(() => provision(options));
    await provision(options);
    assert.deepEqual(server.created, { tunnel: 1, key: 1, connector: 1, link: 1, permission: 1 });
  });
}

test('existing exact tunnel, connector on a later page, and active full-access link are reused', async t => {
  const { options, server } = await fixture(t);
  server.tunnels = [{ id: OTHER_TUNNEL, name: `${NAME} other` }, { id: TUNNEL, name: NAME }];
  server.connectors = [
    { id: 'connector-other', name: `${NAME} other`, tunnel_id: OTHER_TUNNEL },
    { id: 'connector-one', name: NAME, tunnel_id: TUNNEL, actions: [{ name: 'tools' }] },
  ];
  server.link = { id: 'link-one', name: NAME, connector_id: 'connector-one', auth_status: 'ACTIVE', apps_privacy_control: 'full_access' };
  server.pagedList = true;
  await provision(options);
  assert.deepEqual(server.created, { tunnel: 0, key: 1, connector: 0, link: 0, permission: 0 });
  assert.ok(server.calls.some(call => call.path.includes('cursor=page-two')));
});

test('list 404 falls back to checkpoint; subsequent run does not create a connector', async t => {
  const { options, server } = await fixture(t);
  server.listUnavailable = true;
  await provision(options);
  await provision(options);
  assert.equal(server.created.connector, 1);
});

test('a failed connector listing other than 404 does not permit blind creation', async t => {
  const { options, server } = await fixture(t);
  server.listStatus = 500;
  await rejectsSafely(() => provision(options), 'connectorCreate');
  assert.equal(server.created.connector, 0);
});

test('lost connector response with unavailable listing never duplicates; later listing recovers it', async t => {
  const { options, server, state } = await fixture(t);
  server.listUnavailable = true;
  server.failAt = 'connectorCreated';
  await rejectsSafely(() => provision(options), 'connectorCreate');
  assert.equal((await state()).connectorCreatePending, true);
  await rejectsSafely(() => provision(options), 'connectorCreate');
  assert.equal(server.created.connector, 1);
  server.listUnavailable = false;
  await provision(options);
  assert.equal(server.created.connector, 1);
  assert.equal((await state()).connectorCreatePending, undefined);
});

for (const status of [403, 400]) {
  test(`tunnel permission error ${status} is structured and does not leak response body`, async t => {
    const { options, server } = await fixture(t);
    server.permissionStatus = status;
    await rejectsSafely(() => provision(options), 'tunnelPermission');
    assert.equal(server.created.tunnel, 0);
  });
}

test('tunnel polling waits until visible and starts only after the caller hook', async t => {
  const { options, server } = await fixture(t);
  server.visibility = [false, false, true];
  await provision(options);
  assert.deepEqual(server.sleeps, [1000, 1000]);
});

test('tunnel polling ends at two minutes without real sleeps or connector creation', async t => {
  const { options, server } = await fixture(t);
  server.visibility = [false];
  await rejectsSafely(() => provision(options), 'connectorTunnelMissing');
  assert.equal(server.clock, 120_000);
  assert.equal(server.sleeps.length, 120);
  assert.equal(server.created.connector, 0);
});

for (const mode of ['radio', 'select', 'dropdown']) {
  test(`key UI helper supports ${mode} controls and checkpoints before closing`, async () => {
    const server = new FakeServer();
    server.uiMode = mode;
    server.optionalName = true;
    const page = new FakePage(server);
    let saved = false;
    const key = await createRuntimeKeyViaUi(page, {
      organizationId: 'org-default', projectId: 'proj-initial', name: KEY_NAME,
      onKey: async value => { assert.equal(value, KEY); assert.equal(page.phase, 'secret'); saved = true; },
    });
    assert.equal(key, KEY);
    assert.equal(saved, true);
    assert.equal(page.phase, 'list');
  });
}

test('existing exact key without checkpoint is never silently duplicated', async t => {
  const { options, server } = await fixture(t);
  server.keys = [{ name: KEY_NAME }];
  await rejectsSafely(() => provision(options), 'keyUi');
  assert.equal(server.created.key, 0);
});

test('similar key names do not block creation', async t => {
  const { options, server } = await fixture(t);
  server.keys = [{ name: `${KEY_NAME} other` }];
  await provision(options);
  assert.equal(server.created.key, 1);
});

test('missing Tunnels permission row fails before submitting a broad-permission key', async t => {
  const { options, server } = await fixture(t);
  server.missingTunnelsRow = true;
  await rejectsSafely(() => provision(options), 'keyUi');
  assert.equal(server.created.key, 0);
});

test('invalid key response never reaches saveSecret or checkpoint', async t => {
  const { options, server, state } = await fixture(t);
  server.keyValue = 'invalid';
  await rejectsSafely(() => provision(options), 'keyUi');
  assert.equal((await state()).runtimeKey, undefined);
  assert.deepEqual(server.secrets, []);
});

test('platform session selects default org and initial project, ignoring unrelated response', async () => {
  const server = new FakeServer();
  assert.deepEqual(await capturePlatformSession(new FakePage(server)), {
    bearer: BEARER, organizationId: 'org-default', projectId: 'proj-initial', projectName: 'Default project',
  });
});

test('missing dashboard session is a bilingual platformSignin error', async t => {
  const { options, server } = await fixture(t);
  server.login.user.session = null;
  await rejectsSafely(() => provision(options), 'platformSignin');
  assert.equal(server.calls.length, 0);
});

test('missing eligible workspace is a permission error', async t => {
  const { options, server } = await fixture(t);
  server.workspaces = [];
  await rejectsSafely(() => provision(options), 'tunnelPermission');
});

test('invalid created tunnel ID fails before key creation', async t => {
  const { options, server } = await fixture(t);
  server.tunnelId = 'tunnel-invalid';
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.created.key, 0);
});

test('duplicate exact tunnel names fail safely', async t => {
  const { options, server } = await fixture(t);
  server.tunnels = [{ id: TUNNEL, name: NAME }, { id: OTHER_TUNNEL, name: NAME }];
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.created.tunnel, 0);
});

test('an exact connector name bound to another tunnel is never reused or duplicated', async t => {
  const { options, server } = await fixture(t);
  server.connectors = [{ id: 'connector-one', name: NAME, tunnel_id: OTHER_TUNNEL }];
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.created.connector, 0);
});

for (const override of [{ actions: [] }, { name: 'Wrong name' }, { tunnel_id: OTHER_TUNNEL }]) {
  test(`final verification rejects ${Object.keys(override)[0]} mismatch`, async t => {
    const { options, server, state } = await fixture(t);
    server.verifyOverride = override;
    await rejectsSafely(() => provision(options), 'verify');
    assert.equal((await state()).verified, undefined);
  });
}

test('inactive link fails verification', async t => {
  const { options, server } = await fixture(t);
  server.failAt = 'permission';
  await rejectsSafely(() => provision(options));
  server.link.auth_status = 'PENDING';
  await rejectsSafely(() => provision(options), 'verify');
});

test('checkpoint cannot be reused for a different profile or account', async t => {
  const { options, server } = await fixture(t);
  await provision(options);
  await rejectsSafely(() => provision({ ...options, profileId: 'other-profile' }), 'verify');
  server.accountId = 'account-two';
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.created.connector, 1);
});

test('completed state is no longer marked verified when a subsequent verification fails', async t => {
  const { options, server, state } = await fixture(t);
  await provision(options);
  server.verifyOverride = { actions: [] };
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal((await state()).verified, undefined);
});

test('changed organization or project is rejected before any Platform resource requests', async t => {
  const { options, server } = await fixture(t);
  await provision(options);
  const callsBefore = server.calls.length;
  server.login.user.orgs.data[1].projects.data[1].id = 'proj-changed';
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.calls.length, callsBefore);
});

test('corrupt checkpoint fails closed without exposing contents or creating resources', async t => {
  const { options, server } = await fixture(t);
  await writeFile(options.stateFile, LEAK);
  await rejectsSafely(() => provision(options), 'verify');
  assert.equal(server.navigation.length, 0);
});

test('cleanup errors cannot replace success or expose secrets', async t => {
  const { options, server, pages } = await fixture(t);
  server.failAt = 'pageClose';
  assert.equal((await provision(options)).runtimeKey, KEY);
  assert.ok(pages.every(page => page.closed));
});

test('even injected ProvisionError messages and causes are rebuilt without secrets', async t => {
  const { options } = await fixture(t);
  options.ensureTunnelRunning = async () => {
    const error = new ProvisionError('connectorTunnelMissing');
    error.message = LEAK;
    error.cause = new Error(LEAK);
    throw error;
  };
  await rejectsSafely(() => provision(options), 'connectorTunnelMissing');
});
