import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const accessToken = randomUUID();
const cookie = randomUUID();
let expired = false;
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
  if (expired || !request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('{}'); return; }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url === '/api/auth/session'
    ? { accessToken, expires: new Date(Date.now() + 10 * 86400000).toISOString(), user: { email: 'fixture@example.invalid' } }
    : { models, default_model_slug: 'auto' }));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
const loginFlow = createLoginFlow({
  origin: 'https://chatgpt.com', pollMilliseconds: 10,
  readClient: options => new ReadClient({ ...options, origin }),
  launch: async (profile, signal) => {
    const owned = await launchSignInBrowser(profile, signal);
    try {
      const restored = owned.context.pages()[0] ?? await owned.context.newPage();
      await restored.goto('about:blank#restored-fixture');
      assert.ok(owned.context.pages().some(page => page.url() !== 'about:blank'));
      await owned.context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== 'https://chatgpt.com') return route.abort();
        const local = await fetch(origin + '/');
        await route.fulfill({ status: local.status, contentType: 'text/html', body: await local.text() });
      });
      await owned.context.addCookies([{ name: '__Secure-next-auth.session-token', value: cookie, url: 'https://chatgpt.com', secure: true }]);
      return owned;
    } catch { await owned.close(); throw new BackendError('browserProfile'); }
  },
});
const turnFixture = await createTurnFixture();
const turnRoot = await mkdtemp(join(tmpdir(), 'chatgpt-web-host-turns-'));
const turnDriver = new TurnDriver({ profileRoot: turnRoot, origin: turnFixture.origin, launch: async profile => {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === turnFixture.origin ? route.continue() : route.abort());
  return context;
} });
await serve(process.stdin, process.stdout, {
  loginFlow, turnDriver,
  readClient: options => new ReadClient({ ...options, origin }),
  handlers: { expire: () => { expired = true; return true; }, fixtureTurns: () => turnFixture.requests.map(value => ({ conversation: value.conversation })) },
  close: async () => { await turnFixture.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(turnRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
});
