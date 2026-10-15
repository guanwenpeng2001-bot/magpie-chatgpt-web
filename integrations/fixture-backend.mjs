import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { serve } from '../backend/main.mjs';
import { ReadClient } from '../backend/http.mjs';
import { createLoginFlow, launchSignInBrowser } from '../backend/browser.mjs';
import { BackendError } from '../backend/guard.mjs';
import assert from 'node:assert/strict';
import { TurnDriver } from '../backend/turn.mjs';
import { createTurnFixture } from './turn-fixture.mjs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { chromium } from 'playwright-core';

const statePath = process.env.CHATGPT_WEB_FIXTURE_STATE;
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { accessToken: randomUUID(), cookie: randomUUID() };
// Rotation grace lasts until explicit expiry; real-site rotation semantics await live acceptance.
state.acceptedCookies ??= [state.cookie];
const persist = () => { if (statePath) writeFileSync(statePath, JSON.stringify(state)); };
persist();
const record = value => { if (process.env.CHATGPT_WEB_FIXTURE_LOG) appendFileSync(process.env.CHATGPT_WEB_FIXTURE_LOG, JSON.stringify(value) + '\n'); };
const accessToken = state.accessToken;
let cookie = state.cookie;
let expired = false;
const reads = { nodeModels: 0, browserModels: 0, nodeSessions: 0, browserSessions: 0 };
const models = [
  ['gpt-5-5', 'GPT-5.5'], ['gpt-5-6', 'GPT-5.6 Luna'], ['gpt-5-3-mini', 'GPT-5.3 Mini'],
  ['gpt-5-5-mini', 'GPT-5.5 Mini'], ['gpt-5-6-mini', 'GPT-5.6 Luna'], ['gpt-6', 'GPT-6'], ['gpt-6-mini', 'GPT-6'], ['auto', 'Auto'],
].map(([slug, title]) => ({ slug, title, max_tokens: 34834 }));
const fixture = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Local sign-in fixture</title><button aria-label="Open profile menu">Fixture account</button>');
    return;
  }
  const browser = !!request.headers['x-fixture-browser'];
  if (request.url === '/api/auth/session') reads[browser ? 'browserSessions' : 'nodeSessions']++;
  if (request.url === '/backend-api/models') reads[browser ? 'browserModels' : 'nodeModels']++;
  if (expired || !state.acceptedCookies.some(value => request.headers.cookie?.split(';').some(pair => pair.trim() === '__Secure-next-auth.session-token=' + value))) { record({ event: 'rejectedRead', path: request.url, browser, expired }); response.writeHead(401); response.end('{}'); return; }
  if (!browser && request.url === '/backend-api/models') {
    response.writeHead(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' });
    response.end('Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform/');
    return;
  }
  if (request.url === '/api/auth/session') {
    cookie = randomUUID();
    state.cookie = cookie;
    state.acceptedCookies.push(cookie);
    persist();
    response.setHeader('set-cookie', '__Secure-next-auth.session-token=' + cookie + '; Path=/; Secure; HttpOnly; Max-Age=86400');
  }
  record({ event: 'read', path: request.url, browser });
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url === '/api/auth/session'
    ? { accessToken, expires: new Date(Date.now() + 10 * 86400000).toISOString(), user: { email: 'fixture@localhost' } }
    : { models, default_model_slug: 'auto' }));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
let profileRoot;
const routeReads = async route => {
  const url = new URL(route.request().url());
  if (url.origin !== 'https://chatgpt.com' && url.origin !== origin) return route.abort();
  const cookies = await route.request().frame().page().context().cookies('https://chatgpt.com');
  const local = await fetch(origin + url.pathname, { headers: { cookie: cookies.map(value => value.name + '=' + value.value).join('; '), 'x-fixture-browser': 'true' } });
  await route.fulfill({ status: local.status, headers: Object.fromEntries(local.headers), body: await local.text() });
};
const loginFlow = createLoginFlow({
  origin: 'https://chatgpt.com', pollMilliseconds: 10,
  launch: async (profile, signal, options) => {
    profileRoot = dirname(profile);
    const owned = await launchSignInBrowser(profile, signal, { ...options, spawn: (executable, args, settings) => {
      record({ event: 'signinSpawn', args });
      return spawn(executable, args, settings);
    } });
    try {
      const restored = owned.context.pages()[0] ?? await owned.context.newPage();
      await restored.goto('about:blank#restored-fixture');
      assert.ok(owned.context.pages().some(page => page.url() !== 'about:blank'));
      await owned.context.route('**/*', routeReads);
      await owned.context.addCookies([{ name: '__Secure-next-auth.session-token', value: cookie, url: 'https://chatgpt.com', secure: true }]);
      return owned;
    } catch { await owned.close(); throw new BackendError('browserProfile'); }
  },
});
const turnFixture = await createTurnFixture();
const turnRoot = await mkdtemp(join(tmpdir(), 'chatgpt-web-host-turns-'));
const turnDriver = new TurnDriver({ profileRoot: process.env.CHATGPT_WEB_FIXTURE_PROFILE_ROOT ?? turnRoot, origin: turnFixture.origin, launch: async profile => {
  const context = await chromium.launchPersistentContext(join(profileRoot ?? process.env.CHATGPT_WEB_FIXTURE_PROFILE_ROOT ?? turnRoot, profile.split(/[\\/]/).at(-1)), { channel: 'chrome', headless: true, serviceWorkers: 'block' }).catch(error => { record({ event: 'launchFailure', message: error.message });
    throw error; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== turnFixture.origin) return routeReads(route);
    if (!route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace('<main id="messages">', '<input type="file" multiple accept="image/*"><main id="messages">');
    await route.fulfill({ response, body });
  });
  record({ event: 'contextOpened' });
  context.on('close', () => record({ event: 'contextClosed' }));
  context.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/backend-api/f/conversation') {
      const submitted = request.postDataJSON();
      record({ event: 'submit', conversation: submitted.conversation, prompt: submitted.prompt });
    }
  });
  return context;
} });
turnDriver.browser.idleMilliseconds = 10000;
await serve(process.stdin, process.stdout, {
  loginFlow, turnDriver,
  readClient: options => {
    const client = new ReadClient({ ...options, origin, browserRoute: (path, signal) => options.browserRoute(path, signal, new URL('https://chatgpt.com')) });
    const models = client.models.bind(client);
    client.models = async signal => { try { return await models(signal); } catch (error) { record({ event: 'modelsFailure', code: error.code, message: error.message }); throw error; } };
    return client;
  },
  handlers: { expire: () => { expired = true; return true; }, fixtureTurns: () => turnFixture.requests.map(value => ({ conversation: value.conversation })) },
  close: async () => { await turnFixture.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(turnRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
});
