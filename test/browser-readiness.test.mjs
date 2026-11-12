import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReady } from '../backend/site-adapter/index.mjs';

function pageFixture(states, composers = [1]) {
  let reads = 0;
  return { get reads() { return reads; }, isClosed: () => false,
    evaluate: async () => states[Math.min(reads++, states.length - 1)],
    locator: () => ({ filter() { return this; }, count: async () => composers[Math.min(reads - 1, composers.length - 1)] }),
  };
}

test('visible startup waits for site checks and hydration on the same page', async () => {
  const page = pageFixture([{ kind: 'challenge' }, null, null], [0, 0, 1]);
  await waitForReady(page, { budget: 2000 });
  assert.equal(page.reads, 3);
});

test('persistent verification remains a typed failure and does not submit or reload', async () => {
  const page = pageFixture([{ kind: 'challenge' }]);
  await assert.rejects(waitForReady(page, { budget: 25 }), { code: 'verification' });
});

test('startup cancellation stops waiting promptly', async () => {
  const controller = new AbortController();
  const work = waitForReady(pageFixture([{ kind: 'challenge' }]), { budget: 2000, signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
});

for (const kind of ['sign-in', 'rate-limit']) test(`startup returns ${kind} for existing error handling`, async () => {
  const page = pageFixture([{ kind }]);
  await waitForReady(page, { budget: 2000 });
  assert.equal(page.reads, 1);
});

test('a visible composer is not ready while the account model picker is disabled', async () => {
  const page = pageFixture([null]);
  page.locator = selector => ({ filter() { return this; }, count: async () => 1,
    isEnabled: async () => true,
    getAttribute: async name => name === 'data-disabled' && page.reads < 3 ? '' : null,
  });
  await waitForReady(page, { budget: 2000, requirePicker: true });
  assert.equal(page.reads, 3);
});
