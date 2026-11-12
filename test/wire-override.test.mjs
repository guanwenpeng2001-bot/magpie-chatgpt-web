import test from 'node:test';
import assert from 'node:assert/strict';
import { installHarvest } from '../backend/harvest.mjs';

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
  window.__chatgptHarvest.start('turn', false, 'gpt-5-6-mini');
  await window.fetch('/backend-api/conversation', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-6-instant', messages: [{ role: 'user', content: 'fixture' }] }) });
  assert.equal(sent.find(item => item.model)?.model, 'gpt-5-6-mini');
});
