import test from 'node:test';
import assert from 'node:assert/strict';
import { installHarvest } from '../backend/harvest.mjs';
import { wireModels } from '../backend/site-adapter/compatibility.mjs';

test('hidden catalogue IDs replace only the submitted JSON model field', async () => {
  const sent = [];
  globalThis.window = {
    __chatgptHarvestEvent: async payload => sent.push(payload),
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response('', { status: 200 });
    },
    location: new URL('https://chatgpt.com/'),
  };
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.location = new URL('https://chatgpt.com/');
  globalThis.XMLHttpRequest = class {};
  globalThis.XMLHttpRequest.prototype.open = () => {};
  globalThis.XMLHttpRequest.prototype.send = () => {};
  installHarvest();
  for (const [slug, plan] of Object.entries(wireModels)) {
    window.__chatgptHarvest.start('turn', false, slug);
    await window.fetch('/backend-api/conversation', { method: 'POST', body: JSON.stringify({ model: plan.uiModel, messages: [{ role: 'user', content: 'fixture' }] }) });
    assert.equal(sent.filter(item => item.model).at(-1).model, slug);
  }
});
