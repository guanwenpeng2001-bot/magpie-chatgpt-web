import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dependency = '~1.62.0';
const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
const credentialPatterns = [
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /(?:__Secure-)?next-auth\.session-token(?:\.\d+)?\s*=\s*[A-Za-z0-9_%.-]{32,}/i,
  /\b(?:sk-(?:proj-)?|sess-)[A-Za-z0-9_-]{24,}/,
  /\bBearer\s+[A-Za-z0-9_.-]{32,}/i,
  /["'](?:accessToken|refreshToken|sessionKey)["']\s*:\s*["'][A-Za-z0-9_.-]{32,}["']/,
];

export async function checkPackage(root) {
  root = resolve(root);
  const errors = [];
  const checks = [];
  const readJson = async name => {
    try { return JSON.parse(await readFile(join(root, name), 'utf8')); }
    catch { errors.push(`${name} must exist and contain valid JSON.`); return {}; }
  };
  const pkg = await readJson('package.json');
  const icon = pkg.magpie?.icon;
  if (typeof icon !== 'string' || !icon.trim() || icon !== icon.trim() || icon.length > (3 << 19) || !/^(https:\/\/|data:image\/)/i.test(icon)) errors.push('Icon must match the host scheme and size gate.');
  else checks.push('icon scheme and size');
  if (lifecycle.some(name => Object.hasOwn(pkg.scripts ?? {}, name))) errors.push('Install lifecycle scripts are forbidden.');
  else checks.push('zero install lifecycle scripts');
  if (JSON.stringify(pkg.dependencies) !== JSON.stringify({ 'playwright-core': dependency }) || ['devDependencies', 'optionalDependencies', 'peerDependencies'].some(name => Object.keys(pkg[name] ?? {}).length) || (pkg.bundledDependencies?.length ?? pkg.bundleDependencies?.length ?? 0)) errors.push('Only playwright-core ~1.62.0 is allowed as a dependency.');
  else checks.push('dependency allowlist');
  if (pkg.type !== 'module' || pkg.main !== './src/index.mjs' || pkg.exports !== './src/index.mjs' || pkg.magpie?.maxConcurrency !== 1) errors.push('Manifest entry, module type and concurrency must match the provider contract.');
  else checks.push('manifest contract');
  const lock = await readJson('package-lock.json');
  const locked = lock.packages?.['node_modules/playwright-core'];
  if (lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(pkg.dependencies) || !/^1\.62\.\d+$/.test(locked?.version ?? '') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked?.integrity ?? '') || !/^https:\/\/registry\.npmjs\.org\/playwright-core\/-\/playwright-core-1\.62\.\d+\.tgz$/.test(locked?.resolved ?? '') || Object.keys(lock.packages ?? {}).some(name => !['', 'node_modules/playwright-core'].includes(name)) || locked?.hasInstallScript) errors.push('Lockfile must consistently pin the sole dependency with registry integrity.');
  else checks.push('lockfile consistency and integrity metadata');
  let scanned = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if ((await lstat(path)).isSymbolicLink()) { errors.push(`Symbolic links are not scanned: ${name}`); continue; }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) { errors.push(`Unsupported filesystem entry: ${name}`); continue; }
      const body = (await readFile(path)).toString('utf8');
      scanned++;
      if (credentialPatterns.some(pattern => pattern.test(body))) errors.push(`Credential-shaped value detected: ${name}`);
      if (/^(?:plugin-auth\.json(?:\.bak)?|Cookies|Login Data)$/i.test(entry.name)) errors.push(`Credential storage is forbidden: ${name}`);
    }
  }
  await walk(root);
  if (!errors.some(error => /Credential|not scanned|filesystem/.test(error))) checks.push(`credential scan (${scanned} files; only Git metadata excluded)`);
  return { checks, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { checks, errors } = await checkPackage(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
    for (const check of checks) console.log(`PASS ${check}`);
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = errors.length ? 1 : 0;
  } catch { console.error('FAIL Package tree could not be completely inspected.'); process.exitCode = 1; }
}
