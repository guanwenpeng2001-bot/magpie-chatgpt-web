import { writeFile } from 'node:fs/promises';
import { TurnDriver } from '../backend/turn.mjs';
import { launchSignInBrowser } from '../backend/browser.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { observeAnswer } from './observe-answer.mjs';

if (!process.argv.includes('--authorized-single-turn') || !process.env.CHATGPT_WEB_SMOKE_PROFILE || !process.env.CHATGPT_WEB_SMOKE_OUTPUT) throw new Error('Explicit single-turn authorization, profile and evidence path required');
const facts = { started: new Date().toISOString(), slug: 'gpt-6', submits: 0, navigations: 0, requests: 0, terminal: false, verified: false };
const save = () => writeFile(process.env.CHATGPT_WEB_SMOKE_OUTPUT, JSON.stringify(facts, null, 2));
await save();
const driver = new TurnDriver({ profile: process.env.CHATGPT_WEB_SMOKE_PROFILE, timeout: 60000, launch: async profile => {
  const owned = await launchSignInBrowser(profile, new AbortController().signal);
  const context = owned.context;
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== 'chatgpt.com') return route.abort();
    facts.requests++;
    if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) facts.navigations++;
    if (request.method() === 'POST' && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) {
      if (facts.submits >= 1) return route.abort();
      facts.submits++;
    }
    return route.continue();
  });
  context.close = owned.close;
  return context;
} });
try {
  const command = { ...prepare({ model: 'gpt-6', messages: [{ role: 'user', content: 'Write four short sentences about a fictional blue kite. This is a synthetic test.' }] }), auth: { profile: 'smoke' } };
  Object.assign(facts, await observeAnswer(driver, command, new AccountGuard(), 'smoke', AbortSignal.timeout(100000)));
} finally {
  await driver.close();
  facts.finished = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ submits: facts.submits, verified: facts.verified, terminal: facts.terminal, deltas: facts.deltas?.length, failure: facts.failure }));
}
