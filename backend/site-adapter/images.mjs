import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BackendError } from '../guard.mjs';

export const IMAGE_MODEL = 'chatgpt-image';

export async function initializeImagePage(page, { budget }) {
  const chat = page.getByRole('button', { name: /^(Chat|聊天)$/, exact: true });
  await chat.waitFor({ state: 'visible', timeout: budget });
  if (await chat.getAttribute('aria-pressed') !== 'true') await chat.click({ timeout: budget });
}

export async function selectImageTool(page) {
  const main = page.locator('main').filter({ visible: true }).last();
  await main.getByRole('button', { name: /^(添加文件等内容|Add files and more|Add photos & files)$/i }).click();
  const label = page.getByText(/^(创建图像|Create image)$/i).filter({ visible: true });
  if (await label.count() !== 1) return { ok: false, kind: 'model-not-offered', detail: { slug: IMAGE_MODEL } };
  const disabled = label.locator('xpath=ancestor-or-self::*[@aria-disabled="true"]');
  if (await disabled.count()) return { ok: false, kind: 'model-not-offered', detail: { slug: IMAGE_MODEL } };
  const item = label.locator('xpath=ancestor::*[@data-menu-row-content="true"][1]/..').first();
  if (await item.count() !== 1) return { ok: false, kind: 'model-not-offered', detail: { slug: IMAGE_MODEL } };
  await item.click();
  return { ok: true };
}

export function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new BackendError('imageOutput');
}

export async function readGeneratedImages(page, { baseline, budget, artifactRoot, signal }) {
  try {
    signal?.throwIfAborted();
    await page.waitForFunction(previous => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const busy = [...document.querySelectorAll('button')].some(b => visible(b) && /^(Stop generating|Stop|停止生成|停止)$/i.test(b.getAttribute('aria-label') ?? b.innerText));
      return !busy && [...document.querySelectorAll('[data-testid="generated-image-preview"] img')].some(img => visible(img) && img.complete && img.naturalWidth > 0 && !previous.includes(img.src));
    }, baseline, { timeout: budget });
    signal?.throwIfAborted();
    const images = await page.evaluate(async previous => {
      const candidates = [...document.querySelectorAll('[data-testid="generated-image-preview"] img')].filter(img => img.complete && img.naturalWidth > 0 && !previous.includes(img.src));
      if (!candidates.length || candidates.length > 4) throw new Error('Unexpected image count');
      const results = [];
      for (const img of candidates) {
        if (!img.src.startsWith('blob:') || new URL(img.src.slice(5)).origin !== location.origin) throw new Error('Expected a generated image blob owned by this page');
        const blob = await (await fetch(img.src)).blob();
        if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error('Image exceeds output limit');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
        results.push(btoa(binary));
      }
      return results;
    }, baseline);
    signal?.throwIfAborted();
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const paths = [];
    for (const encoded of images) {
      const bytes = Buffer.from(encoded, 'base64');
      const path = resolve(artifactRoot, `${randomUUID()}.${imageExtension(bytes)}`);
      signal?.throwIfAborted();
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      paths.push(path.replaceAll('\\', '/'));
    }
    return { text: paths.map((path, index) => `![Generated image ${index + 1}](<${path}>)\n\n[Open image file](<${path}>)`).join('\n\n'), route: 'dom' };
  } catch (error) {
    signal?.throwIfAborted();
    throw error instanceof BackendError ? error : new BackendError('imageOutput');
  }
}
