import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const checker = await import('../scripts/check-package.mjs').catch(() => ({}));

async function fixture(t) {
  assert.equal(typeof checker.checkPackage, 'function', 'package integrity gate must exist');
  const root = await mkdtemp(join(tmpdir(), 'package-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const save = async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  };
  await save();
  return { root, pkg, lock, save };
}

test('package gate accepts a consistent package', async t => {
  const { root } = await fixture(t);
  assert.deepEqual((await checker.checkPackage(root)).errors, []);
});

for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
  test(`package gate rejects ${script}`, async t => {
    const { root, pkg, save } = await fixture(t);
    pkg.scripts = { [script]: 'node unwanted.mjs' };
    await save();
    assert.ok((await checker.checkPackage(root)).errors.includes('Install lifecycle scripts are forbidden.'));
  });
}

for (const icon of [undefined, 'file:///icon.svg', 'data:image/svg+xml,' + 'x'.repeat(3 << 19)]) {
  test(`package gate rejects ${icon === undefined ? 'missing' : icon.startsWith('file') ? 'invalid' : 'oversized'} icon`, async t => {
    const { root, pkg, save } = await fixture(t);
    pkg.magpie.icon = icon;
    await save();
    assert.ok((await checker.checkPackage(root)).errors.includes('Icon must match the host scheme and size gate.'));
  });
}

for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`package gate rejects an added ${field} entry`, async t => {
    const { root, pkg, save } = await fixture(t);
    pkg[field] = { ...pkg[field], unwanted: '1.0.0' };
    await save();
    assert.ok((await checker.checkPackage(root)).errors.includes('Only playwright-core ~1.62.0 is allowed as a dependency.'));
  });
}

test('package gate rejects a dependency range change', async t => {
  const { root, pkg, save } = await fixture(t);
  pkg.dependencies['playwright-core'] = '*';
  await save();
  assert.ok((await checker.checkPackage(root)).errors.includes('Only playwright-core ~1.62.0 is allowed as a dependency.'));
});

for (const mutation of ['missing', 'mismatch', 'integrity', 'extra', 'install']) {
  test(`package gate rejects ${mutation} lockfile`, async t => {
    const { root, lock, save } = await fixture(t);
    if (mutation === 'mismatch') lock.packages[''].dependencies['playwright-core'] = '*';
    if (mutation === 'integrity') delete lock.packages['node_modules/playwright-core'].integrity;
    if (mutation === 'extra') lock.packages['node_modules/unwanted'] = { version: '1.0.0' };
    if (mutation === 'install') lock.packages['node_modules/playwright-core'].hasInstallScript = true;
    await save();
    if (mutation === 'missing') await rm(join(root, 'package-lock.json'));
    assert.ok((await checker.checkPackage(root)).errors.includes('Lockfile must consistently pin the sole dependency with registry integrity.'));
  });
}

test('package gate rejects a changed host manifest', async t => {
  const { root, pkg, save } = await fixture(t);
  pkg.magpie.maxConcurrency = 2;
  await save();
  assert.ok((await checker.checkPackage(root)).errors.includes('Manifest entry, module type and concurrency must match the provider contract.'));
});

test('credential scan includes ignored and binary files without printing values', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, '.gitignore'), 'ignored/');
  const credential = ['eyJ' + 'a'.repeat(30), 'b'.repeat(32), 'c'.repeat(32)].join('.');
  await writeFile(join(root, 'ignored', 'capture.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(credential)]));
  const result = await checker.checkPackage(root);
  assert.ok(result.errors.includes('Credential-shaped value detected: ignored/capture.bin'));
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test('credential storage is forbidden even when empty', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'plugin-auth.json'), '{}');
  assert.ok((await checker.checkPackage(root)).errors.includes('Credential storage is forbidden: plugin-auth.json'));
});
