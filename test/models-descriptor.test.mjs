import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describeCatalogue } from '../src/models.mjs';
import { _internal } from '../src/index.mjs';
import { resolveChatGptWebContextLimit } from '../src/usage/context.mjs';

test('unknown slugs remain available and capabilities require explicit evidence', () => {
  const catalogue = { models: [
    { slug: 'unknown', title: 'Unknown' },
    { slug: 'verified', title: 'Verified' },
    { slug: 'attachments', title: 'Attachments', product_features: { attachments: { image_mime_types: ['image/png', 'text/plain'] } } },
  ] };
  const models = describeCatalogue(catalogue, { verified: { imageOk: true, name: 'Verified images' } });
  assert.equal(models.unknown.capabilities.input.image, false);
  assert.equal(models.verified.capabilities.input.image, true);
  assert.equal(models.verified.capabilities.attachment, true);
  assert.equal(models.attachments.capabilities.input.image, true);
  assert.equal(models.attachments.capabilities.attachment, true);
  assert.equal(models.verified.name, 'Verified images');
  for (const [slug, model] of Object.entries(models)) {
    assert.equal(model.prefer_websockets, false);
    assert.equal(model.capabilities.toolcall, false);
    assert.equal(model.capabilities.reasoning, false);
    assert.equal(model.capabilities.temperature, false);
    assert.equal(model.limit.context, resolveChatGptWebContextLimit(slug).limit);
    for (const key of ['free', 'rate', 'decides', 'searches']) assert.equal(Object.hasOwn(model, key), false);
  }
});

test('published source has no placeholder domain and declares emulated wire honestly', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.5.4');
  async function inspect(url) {
    const entries = await readdir(url, { withFileTypes: true });
    for (const entry of entries) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) await inspect(path);
      else assert.equal((await readFile(path, 'utf8')).includes('.invalid'), false, path.pathname);
    }
  }
  await inspect(new URL('../src/', import.meta.url));
  await inspect(new URL('../backend/', import.meta.url));
  for (const name of ['integrations/fixture-backend.mjs', 'integrations/turn-fixture.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES', 'package.json'])
    assert.equal((await readFile(new URL('../' + name, import.meta.url), 'utf8')).includes('.invalid'), false, name);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /emulat/i);
  const config = {};
  await _internal.createHooks({ bridge: {}, profileRoot: '.' }).config(config);
  assert.equal(config.provider['chatgpt-web'].npm, '@ai-sdk/anthropic');
  for (const model of Object.values(config.provider['chatgpt-web'].models)) assert.equal(model.prefer_websockets, false);
});
