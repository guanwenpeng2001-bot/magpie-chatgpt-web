import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const nativeRoot = () => resolve(homedir(), '.config/magpie/chatgpt-web-native');
export const RELEASES = Object.freeze([
  { name: 'runtime-6.1.18', url: 'https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.18/codex-chatgpt-web-windows-amd64.zip',
    sha256: '813690d379fd2fc91b0c95a54ab94026e9f53c53a5d43c39eeca98947cbf3fea', required: ['runtime/bun.exe', 'app/cli.js'] },
  { name: 'tunnel-0.0.16', url: 'https://github.com/openai/tunnel-client/releases/download/v0.0.16/tunnel-client-v0.0.16-windows-amd64.zip',
    sha256: 'edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6',
    files: { 'tunnel-client.exe': '4226bb74a72388147882881f29f79801b95e285d731a138071812e3aa6766571',
      'cloudflared.exe': 'cd0bc49aec24d0d62a37b6e842dad46000f7b401f6167b4cbace4e170819c9a2',
      'cloudflared-manifest.json': '80003d8a8f38d6a0bd74aabc096e9f99a6e8fad8ed4da699e26a8231fa453aa1' } },
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installing = new Map();

async function extractZip(archive, destination) {
  // No shell interpolation of filesystem paths. Reject traversal before extraction.
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($env:MAGPIE_NATIVE_ARCHIVE)
    try {
      $root = [IO.Path]::GetFullPath($env:MAGPIE_NATIVE_DEST) + [IO.Path]::DirectorySeparatorChar
      foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ZIP entry' }
      }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($env:MAGPIE_NATIVE_ARCHIVE, $env:MAGPIE_NATIVE_DEST)
  `], { windowsHide: true, timeout: 120_000, env: { ...process.env, MAGPIE_NATIVE_ARCHIVE: archive, MAGPIE_NATIVE_DEST: destination } });
}

async function inventory(root, directory = root, result = {}) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native install contains a linked directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('Native install contains a link');
    if (entry.isDirectory()) await inventory(root, path, result);
    else if (entry.isFile()) result[key] = hash(await readFile(path));
    else throw new Error('Native install contains a special file');
  }
  return result;
}

async function verify(directory, release) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native install directory is not owned; refusing to overwrite');
  const manifest = JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
  if (manifest.archiveSha256 !== release.sha256) throw new Error('Native install pin mismatch; refusing to overwrite');
  const actual = await inventory(join(directory, 'payload'));
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) throw new Error('Native install checksum mismatch; refusing to overwrite');
  for (const name of release.required ?? []) if (!actual[name]) throw new Error('Native runtime file missing');
  for (const [name, digest] of Object.entries(release.files ?? {})) if (actual[name] !== digest) throw new Error('Native dependency checksum mismatch');
  return join(directory, 'payload');
}

async function install(root, release, fetchImpl, extract) {
  const target = join(root, release.name);
  try { await lstat(target); return await verify(target, release); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A partial existing installation must also never be overwritten.
  try { await lstat(target); throw new Error('Incomplete native install; refusing to overwrite'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = join(root, `.${release.name}-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const response = await fetchImpl(release.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Native release download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== release.sha256) throw new Error('Native release checksum mismatch');
    const archive = join(stage, 'release.zip');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    await extract(archive, join(stage, 'payload'));
    const files = await inventory(join(stage, 'payload'));
    await writeFile(join(stage, 'install.json'), JSON.stringify({ archiveSha256: release.sha256, files }), { flag: 'wx', mode: 0o600 });
    await verify(stage, release);
    await rm(archive);
    await rename(stage, target);
    return join(target, 'payload');
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export function ensureRuntime({ root = nativeRoot(), fetch: fetchImpl = globalThis.fetch, extract = extractZip, releases = RELEASES } = {}) {
  if (!isAbsolute(root)) throw new Error('Native root must be absolute');
  const key = resolve(root);
  if (installing.has(key)) return installing.get(key);
  const pending = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Exclusive lock protects separate backend processes; an interrupted lock is left for inspection.
    const lock = join(root, '.install-lock');
    await mkdir(lock);
    try {
      const runtime = await install(root, releases[0], fetchImpl, extract);
      const tunnel = await install(root, releases[1], fetchImpl, extract);
      return { runtimeCommand: [join(runtime, 'runtime/bun.exe'), join(runtime, 'app/cli.js')], tunnelBinary: join(tunnel, 'tunnel-client.exe') };
    } finally { await rm(lock, { recursive: true, force: true }); }
  })().finally(() => installing.delete(key));
  installing.set(key, pending);
  return pending;
}
