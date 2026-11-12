import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageExtension, readGeneratedImages, IMAGE_MODEL } from '../backend/site-adapter/images.mjs';
import { describeCatalogue } from '../src/models.mjs';

test('image workflow is exposed only when the account catalogue declares image generation', () => {
  assert.equal(describeCatalogue({ models: [{ slug: 'auto', title: 'Auto' }] })[IMAGE_MODEL], undefined);
  const model = describeCatalogue({ models: [{ slug: 'auto', title: 'Auto', enabled_tools: ['image_gen_tool_enabled'] }] })[IMAGE_MODEL];
  assert.ok(model);
  assert.match(model.name, /local image file/);
  assert.equal(model.capabilities.output.text, true);
});

test('generated images are saved from page-owned blobs without trusting remote filenames or formats', async () => {
  const { chromium } = await import('playwright-core');
  const server = createServer((_, res) => res.end('<html><body></body></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'image-output-test-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMWQAAAAASUVORK5CYII=', 'base64');
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const preview = document.createElement('button');
      preview.dataset.testid = 'generated-image-preview';
      const img = new Image(); img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      preview.append(img); document.body.append(preview);
    }, png.toString('base64'));
    const result = await readGeneratedImages(page, { baseline: [], budget: 3000, artifactRoot: root });
    const files = await readdir(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9-]+\.png$/);
    assert.deepEqual(await readFile(join(root, files[0])), png);
    assert.match(result.text, /Open image file/);
    assert.throws(() => imageExtension(Buffer.from('<svg>unsafe</svg>')), { code: 'imageOutput' });
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
