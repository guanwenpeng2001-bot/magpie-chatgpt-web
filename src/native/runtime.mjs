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

// Exact minified gate in the pinned Windows v6.1.18 bundle, corresponding to
// adapters/chatgpt-web/index.ts:936-937. Only automatic managed Chrome uses the
// existing read-only branch; Launcher/Zero Risk retain their structured handoff.
const compactionGate = 'let oe=(f.modelId!==Ie||c)&&l.localToolsEnabled;';
const sharedCompactionGate = compactionGate.slice(0, -1)
  + '&&!(e.chatgptWeb?.browserHost==="managed-chrome"&&e.chatgptWeb?.browserInteractionMode==="automatic");';
const cliSha256 = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const browserLaunch = 'ff.launch({executablePath:this.config.chromeExecutablePath,headless:!this.config.headed})';
// readChatGptModelAnnouncements, chatgpt-ui/model-picker.ts:125-127. Run in its
// existing DOM evaluation so the checked row and active header are one snapshot.
const modelAnnouncementTail = 'r.push(c.join(" "))}return r})}function fc(e)';
const checkpointRegistry = 'var Kt=new Map,dx=256;';
const checkpointRememberTail = 'while(Kt.size>dx)Kt.delete(Kt.keys().next().value)}function Nh';
const checkpointTouch = 'return Kt.delete(e),Kt.set(e,t),!0}';
const opaqueIdFactory = 'function ci(e){return`${e}_${Ev(24).toString("base64url")}`}';

// Preserve 160 random bits in the existing 32-character token payload without
// mixed case or visually ambiguous i/l/o/u. Authentication remains exact-match;
// never normalize a model-supplied token or revive an earlier turn capability.
export function createNativeTurnToken(randomBytes) {
  const bytes = randomBytes(20);
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let buffer = 0, bits = 0, payload = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      payload += alphabet[(buffer >>> bits) & 31];
    }
  }
  return `turn_${payload}`;
}

export function appendNativeModelAnnouncement(slider, descriptions, activeHeader) {
  const normalize = text => text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const header = normalize(activeHeader);
  if (!/^(?:Instant|Medium|High|Extra High|Pro|Max|\u5373\u65f6|\u4e2d|\u9ad8)$/i.test(header)) return descriptions;
  // Versioned evidence already belongs to the native parser. In particular, do
  // not manufacture a matching state beside a contradictory version/name/mode.
  if (descriptions.some(text => /^(?:GPT[-\s]?)?\d+(?:\.\d+)?\s+/i.test(normalize(text)))) return descriptions;
  const mode = text => ({ '\u5373\u65f6': 'instant', '\u4e2d': 'medium', '\u9ad8': 'high' }[text] ?? text.toLowerCase());
  for (const description of descriptions) {
    const effort = /^(Instant|Medium|High|Extra High|Pro|Max|\u5373\u65f6|\u4e2d|\u9ad8)(?=\p{P}|$)/iu.exec(normalize(description));
    if (effort && mode(effort[1]) !== mode(header)) return descriptions;
  }
  const menu = slider.closest('[role="menu"]');
  if (!menu) return descriptions;
  // In simple view the real model rows remain attached but inert. Include them,
  // while excluding rows belonging to a nested or unrelated picker.
  const checked = [...menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')]
    .filter(row => row.closest('[role="menu"]') === menu);
  if (checked.length !== 1) return descriptions;
  const row = checked[0];
  const label = normalize(row.textContent ?? '');
  if (row.hasAttribute('aria-labelledby')
    || row.hasAttribute('aria-label') && normalize(row.getAttribute('aria-label')) !== label) return descriptions;
  // A generic Latest/Default row does not prove a version. These are only the
  // exact versioned shared/named rows supported by the pinned native assertion.
  if (!/^(?:(?:GPT[-\s]?)?6(?:\s+(?:Sol|Astra))?|GPT[-\s]?5\.6\s+Sol)$/i.test(label)) return descriptions;
  return [...descriptions, `${label} ${header}`];
}

// Borrow the backend's ordinary signed-in context. The returned Playwright CDP
// Browser owns only this connection; its unmodified close() disconnects it.
// Keep this helper self-contained: the preload embeds it in the pinned bundle.
export async function launchNativeBrowser(chromium, options, endpoint = process.env.MAGPIE_NATIVE_BROWSER_CDP) {
  if (endpoint === undefined || endpoint === '') return chromium.launch(options);
  const match = typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint);
  if (!match || match[0] !== endpoint || Number(match[1]) > 65535) throw new Error('Invalid MAGPIE_NATIVE_BROWSER_CDP loopback endpoint');
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Native browser CDP connection has no default context');
    browser.newContext = async () => context;
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export function compactionPreloadSource(cliPath) {
  // Bun loads the original entry at its original path: helper/dependency resolution
  // is unchanged and the verified download is never modified. Fail closed on drift.
  return `import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const entry = ${JSON.stringify(resolve(cliPath))};
Bun.plugin({ name: 'magpie-shared-compaction-6.1.18', setup(build) {
  build.onLoad({ filter: /[\\\\/]cli\\.js$/ }, async ({ path }) => {
    if (resolve(path) !== entry) return;
    const bytes = await Bun.file(path).arrayBuffer();
    if (createHash('sha256').update(Buffer.from(bytes)).digest('hex') !== ${JSON.stringify(cliSha256)})
      throw new Error('Native shared compaction runtime checksum mismatch');
    const source = new TextDecoder().decode(bytes);
    const before = ${JSON.stringify(compactionGate)};
    if (source.split(before).length !== 2) throw new Error('Native shared compaction gate mismatch');
    const launch = ${JSON.stringify(browserLaunch)};
    if (source.split(launch).length !== 3) throw new Error('Native browser launch compatibility mismatch');
    const announcement = ${JSON.stringify(modelAnnouncementTail)};
    if (source.split(announcement).length !== 2) throw new Error('Native model announcement compatibility mismatch');
    const registry = ${JSON.stringify(checkpointRegistry)};
    const remember = ${JSON.stringify(checkpointRememberTail)};
    const touch = ${JSON.stringify(checkpointTouch)};
    const tokenFactory = ${JSON.stringify(opaqueIdFactory)};
    if (source.split(tokenFactory).length !== 2) throw new Error('Native turn token compatibility mismatch');
    if (source.split(registry).length !== 2 || source.split(remember).length !== 2 || source.split(touch).length !== 2)
      throw new Error('Native checkpoint persistence compatibility mismatch');
    const contents = source.replace(before, ${JSON.stringify(sharedCompactionGate)})
      .replace(registry, 'var magpieCheckpointPersistence=process.env.MAGPIE_NATIVE_CHECKPOINT_HOME?magpieOpenCheckpoints(process.env.MAGPIE_NATIVE_CHECKPOINT_HOME):null;var Kt=magpieCheckpointPersistence?.map??new Map,dx=256;')
      .replace(remember, 'while(Kt.size>dx)Kt.delete(Kt.keys().next().value);magpieCheckpointPersistence?.commit()}function Nh')
      .replace(touch, 'return Kt.delete(e),Kt.set(e,t),magpieCheckpointPersistence?.commit(),!0}')
      .replace(tokenFactory, 'function ci(e){return e==="turn"?createNativeTurnToken(Ev):' + tokenFactory.slice(tokenFactory.indexOf('return') + 6, -1) + '}')
      .replaceAll(launch, 'launchNativeBrowser(ff,{executablePath:this.config.chromeExecutablePath,headless:!this.config.headed})')
      .replace(announcement, ${JSON.stringify('r.push(c.join(" "));r=(' + appendNativeModelAnnouncement.toString() + ')(t,r,c.join(" "))}return r})}function fc(e)')})
      + '\\n' + ${JSON.stringify(launchNativeBrowser.toString())}
      + '\\n' + ${JSON.stringify(createNativeTurnToken.toString())}
      + ${JSON.stringify('\nimport { checkpointStore as magpieOpenCheckpoints } from ' + JSON.stringify(new URL('./checkpoints.mjs', import.meta.url).href) + ';')};
    return { contents, loader: 'js' };
  });
} });
`;
}

async function sharedCompactionCommand(root, runtime) {
  const entry = join(runtime, 'app/cli.js');
  if (hash(await readFile(entry)) !== cliSha256) throw new Error('Native shared compaction runtime checksum mismatch');
  const source = compactionPreloadSource(entry);
  const preload = join(root, `compaction-6.1.18-${hash(source)}.mjs`);
  try { await writeFile(preload, source, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(preload);
  if (!stat.isFile() || stat.isSymbolicLink() || await readFile(preload, 'utf8') !== source)
    throw new Error('Native shared compaction preload mismatch; refusing to overwrite');
  return [join(runtime, 'runtime/bun.exe'), '--preload', preload, entry];
}

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
      const runtimeCommand = releases[0].sha256 === RELEASES[0].sha256
        ? await sharedCompactionCommand(root, runtime)
        : [join(runtime, 'runtime/bun.exe'), join(runtime, 'app/cli.js')];
      return { runtimeCommand, tunnelBinary: join(tunnel, 'tunnel-client.exe') };
    } finally { await rm(lock, { recursive: true, force: true }); }
  })().finally(() => installing.delete(key));
  installing.set(key, pending);
  return pending;
}
