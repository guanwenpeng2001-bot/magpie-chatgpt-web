import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, copyFile, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { verifyTurns } from './verify-turns.mjs';
import { redactLiveArtifact } from './verify-live.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const liveHome = homedir();
const liveFiles = ['plugins.json', 'plugin-providers.json', 'plugin-auth.json', 'plugins/package.json'].map(name => join(liveHome, '.config/magpie', name));
const snapshot = async () => Promise.all(liveFiles.map(async path => {
  try {
    const value = await readFile(path);
    const content = path.endsWith('plugin-providers.json') ? JSON.stringify(Object.keys(JSON.parse(value)).sort()) : value;
    return [path, createHash('sha256').update(content).digest('hex')];
  }
  catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
}));
const before = await snapshot();
const sandbox = await mkdtemp(join(tmpdir(), 'chatgpt-web-sandbox-'));
console.log(`sandbox ${sandbox}`);
const home = join(sandbox, 'home');
const config = join(home, '.config/magpie');
const cache = join(home, '.cache/magpie');
const env = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), MAGPIE_ADDR: '127.0.0.1:1', MAGPIE_PLUGIN_MARKET: '', BUN_INSTALL_CACHE_DIR: join(sandbox, 'bun-cache') });
const command = (executable, args, cwd = sandbox) => execFileSync(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' });
let host;
let directBridge;
try {
  await mkdir(config, { recursive: true });
  await mkdir(join(cache, 'bun/1.4.2'), { recursive: true });
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
  const magpie = join(sandbox, 'magpie.exe');
  const bun = join(cache, 'bun/1.4.2/magpie-bun.exe');
  await copyFile(join(liveHome, 'Downloads/magpie-windows-amd64.exe'), magpie);
  await copyFile(join(liveHome, '.cache/magpie/bun/1.4.2/magpie-bun.exe'), bun);
  assert.match(command(magpie, ['--version']), /0\.1\.1198/);
  assert.deepEqual(await snapshot(), before, 'live metadata changed during isolated version check');
  console.log('private HOME and USERPROFILE isolation checked before install');
  const repository = join(sandbox, 'package');
  await mkdir(repository);
  for (const name of ['src', 'backend', 'integrations', 'package.json', 'README.md']) await cp(join(source, name), join(repository, name), { recursive: true });
  command('git', ['init', '-q', repository]);
  command('git', ['add', 'src', 'backend', 'integrations', 'package.json', 'README.md'], repository);
  command('git', ['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.invalid', 'commit', '-qm', 'Create disposable integration snapshot'], repository);
  const spec = `git+${pathToFileURL(repository).href}`;
  command(magpie, ['plugin', 'add', spec]);
  assert.deepEqual(await snapshot(), before, 'live metadata changed during sandbox plugin add');
  console.log('add git+file:// snapshot succeeded');
  const listed = command(magpie, ['plugin', 'list', '--json']);
  assert.match(listed, /chatgpt-web/);
  console.log('provider listed chatgpt-web');
  const installed = join(config, 'plugins/node_modules/magpie-chatgpt-web');
  await stat(join(installed, 'src/index.mjs'));
  await cp(join(repository, 'integrations'), join(installed, 'integrations'), { recursive: true });
  if (process.argv.includes('--live-once')) {
    const { verifyLiveOnce } = await import('./verify-live.mjs');
    await verifyLiveOnce({ installed, home, sandbox, bun, liveHome, env });
    assert.deepEqual(await snapshot(), before, 'live installation metadata changed');
    console.log('live installation metadata unchanged');
    process.exitCode ??= 0;
  } else {
  await verifyTurns(join(config, 'plugins/node_modules/playwright-core/index.mjs'));
  const launchProbe = join(sandbox, 'launch-probe.mjs');
  await writeFile(launchProbe, 'import { launchSignInBrowser } from ' + JSON.stringify(pathToFileURL(join(installed, 'backend/browser.mjs')).href) + ';\nconst owned = await launchSignInBrowser(' + JSON.stringify(join(home, 'launch-probe')) + ', new AbortController().signal); console.log("ordinary browser probe connected"); await owned.close();');
  console.log(command('node', [launchProbe]).trim());
  const hostSource = join(liveHome, '.cache/magpie/plugin-host/host-6e85b6c721c8.js');
  const hostCopy = join(sandbox, 'host.mjs');
  await copyFile(hostSource, hostCopy);
  assert.deepEqual(await readFile(hostCopy), await readFile(hostSource));
  const wrapper = join(sandbox, 'fixture-plugin.mjs');
  await writeFile(wrapper, `import { _internal } from ${JSON.stringify(pathToFileURL(join(installed, 'src/index.mjs')).href)};\nimport { Bridge } from ${JSON.stringify(pathToFileURL(join(installed, 'src/bridge.mjs')).href)};\nconst bridge = new Bridge({ backend: ${JSON.stringify(join(installed, 'integrations/fixture-backend.mjs'))} });\nexport default { id: 'chatgpt-web', server: async () => _internal.createHooks({ bridge, profileRoot: ${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))}, pollMilliseconds: 20 }) };\n`);
  host = spawn(bun, ['run', hostCopy], { cwd: sandbox, env, stdio: ['pipe', 'pipe', 'pipe'] });
  host.stderr.resume();
  const pending = new Map();
  const events = [];
  let buffer = '';
  let sequence = 0;
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (!frame.id) { events.push(frame); continue; }
      if (frame.event === 'chunk' || frame.event === 'head') {
        pending.get(frame.id)?.frame?.(frame);
        if (frame.event === 'chunk') host.stdin.write(JSON.stringify({ method: 'credit', params: { id: frame.id, n: Buffer.from(frame.data, 'base64').length + 256 } }) + '\n');
        continue;
      }
      if ('result' in frame || frame.error) {
        const waiting = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) waiting?.reject(new Error('Stock host RPC failed'));
        else waiting?.resolve(frame.result);
      }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolveReply, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Stock host ${method} timeout`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const authPath = join(config, 'plugin-auth.json');
  const init = await rpc('init', { directory: join(config, 'plugins'), authPath, plugins: [{ spec, target: wrapper }] });
  assert.deepEqual(init.plugins[0].provides, ['chatgpt-web']);
  const authorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
  assert.equal(authorization.url, '');
  assert.equal(authorization.method, 'auto');
  const callback = await rpc('callback', { session: authorization.session });
  assert.equal(callback.ok, true, 'fixture callback: ' + (callback.error ?? 'no diagnostic'));
  console.log('fixture login via ordinary Chrome and IF-8 succeeded');
  const auths = JSON.parse(await readFile(authPath, 'utf8'));
  const auth = auths[callback.account];
  assert.deepEqual(Object.keys(auth).sort(), ['access', 'accountId', 'expires', 'persona', 'profile', 'refresh', 'type'].sort());
  assert.equal(auth.type, 'oauth');
  assert.equal(typeof auth.expires, 'number');
  for (const key of ['refresh', 'access', 'accountId', 'profile', 'persona']) assert.equal(typeof auth[key], 'string');
  console.log('credential persisted: type, refresh, access, expires, accountId, profile, persona (synthetic values withheld)');
  const providers = await rpc('providers');
  const provider = providers.find(value => value.id === 'chatgpt-web');
  assert.equal(provider.fellBack, false);
  assert.equal(provider.models.length, 8);
  assert.equal(provider.models[0].id, 'auto');
  console.log('models listed: 8, auto first, duplicate mini names disambiguated');
  const fetchTurn = (messages, { cancel = false, conversation = 'host-session' } = {}) => new Promise((resolveReply, reject) => {
    const id = String(++sequence);
    const chunks = [];
    const arrivals = [];
    const started = Date.now();
    let aborted = false;
    const timer = setTimeout(() => reject(new Error('Stock host turn timeout')), 30000);
    pending.set(id, {
      frame(frame) {
        if (frame.event === 'head') assert.equal(frame.status, 200);
        if (frame.event !== 'chunk') return;
        const text = Buffer.from(frame.data, 'base64').toString();
        chunks.push(text);
        if (text.includes('content_block_delta')) {
          arrivals.push(Date.now() - started);
          if (cancel && !aborted) { aborted = true; host.stdin.write(JSON.stringify({ method: 'abort', params: { id } }) + '\n'); clearTimeout(timer); resolveReply({ chunks, arrivals, aborted }); }
        }
      },
      resolve() { clearTimeout(timer); resolveReply({ chunks, arrivals, aborted }); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    host.stdin.write(JSON.stringify({ id, method: 'fetch', params: { provider: 'chatgpt-web', model: 'auto', npm: '@ai-sdk/anthropic', url: 'https://chatgpt-web.invalid/v1/messages', session: conversation, body: Buffer.from(JSON.stringify({ model: 'auto', stream: true, messages })).toString('base64') } }) + '\n');
  });
  const messages = [{ role: 'user', content: 'Describe a fictional garden.' }];
  const firstTurn = await fetchTurn(messages);
  assert.equal(firstTurn.arrivals.length, 3);
  assert.ok(firstTurn.arrivals[1] - firstTurn.arrivals[0] > 250);
  const answer = firstTurn.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(frame => frame.type === 'content_block_delta').map(frame => frame.delta.text).join('');
  await fetchTurn([...messages, { role: 'assistant', content: answer }, { role: 'user', content: 'Continue.' }]);
  const cancelled = await fetchTurn(messages, { cancel: true, conversation: 'abort-session' });
  assert.equal(cancelled.aborted, true);
  assert.match((await fetchTurn(messages, { conversation: 'abort-session' })).chunks.join(''), /event: message_stop/);
  console.log(JSON.stringify({ hostTurn: 'stream, continuation, abort, session reuse', deltas: firstTurn.arrivals.length, arrivalMilliseconds: firstTurn.arrivals }));
  auths[callback.account].expires = Date.now() - 1;
  await writeFile(authPath, JSON.stringify(auths));
  await rpc('reload', { provider: 'chatgpt-web' });
  await rpc('providers');
  const renewed = JSON.parse(await readFile(authPath, 'utf8'))[callback.account];
  assert.ok(renewed.expires > Date.now() + 86400000);
  assert.equal(renewed.profile, auth.profile);
  assert.ok(renewed.refresh !== auth.refresh, 'HttpOnly session rotation must reach the stock host credential');
  console.log('challenged Node renewal used browser fallback and persisted HttpOnly rotation through stock host');
  auths[callback.account] = { ...renewed, refresh: crypto.randomUUID(), expires: Date.now() - 1 };
  await writeFile(authPath, JSON.stringify(auths));
  await rpc('reload', { provider: 'chatgpt-web' });
  const expiredProviders = await rpc('providers');
  assert.equal(expiredProviders.find(value => value.id === 'chatgpt-web').fellBack, true);
  assert.ok(events.some(event => event.event === 'signIn' && event.said === 'expired'));
  console.log('stock host marks expired account and reports model listError');
  const hostExit = once(host, 'exit');
  host.stdin.end();
  await hostExit;
  host = null;
  const { Bridge } = await import(pathToFileURL(join(installed, 'src/bridge.mjs')).href);
  const { _internal } = await import(pathToFileURL(join(installed, 'src/index.mjs')).href);
  directBridge = new Bridge({ backend: join(installed, 'integrations/fixture-backend.mjs') });
  const hooks = _internal.createHooks({ bridge: directBridge, profileRoot: join(home, 'unused') });
  await directBridge.call({ method: 'expire' });
  await assert.rejects(hooks.provider.models({}, { auth }), error => error.signIn === 'expired');
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(directBridge.call({ method: 'session', auth }), error => error.signIn === 'expired');
  const rejected = await loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'fixture' }] }) });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('x-magpie-sign-in'), 'expired');
  console.log('expiry throws signIn expired and HTTP 401 x-magpie-sign-in: expired');
  assert.deepEqual(await snapshot(), before, 'live installation metadata changed');
  console.log('live installation metadata unchanged; no real account requests');
  }
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Assertion failed: ${error.message}` : `Sandbox failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  try {
  if (host) { const exit = once(host, 'exit'); host.stdin.end(); await exit.catch(() => {}); }
  await directBridge?.dispose();
  if (process.argv.includes('--live-once')) {
    const archive = process.env.CHATGPT_WEB_LIVE_ARCHIVE;
    if (archive) {
      try {
        const archiveRelative = relative(source, resolve(archive));
        if (!archiveRelative || (archiveRelative !== '..' && !archiveRelative.startsWith('..' + sep) && !isAbsolute(archiveRelative))) throw new Error('Archive must be outside the worktree');
        await mkdir(archive, { recursive: true });
        for (const name of ['live-ledger.json', 'live-facts.json', 'live-plugin-error.log', 'live-backend-stderr.log', 'live-backend-notes.log', 'live-backend.mjs', 'live-plugin.mjs']) {
          try { await writeFile(join(archive, name), redactLiveArtifact(await readFile(join(sandbox, name), 'utf8'))); }
          catch (error) { if (error.code !== 'ENOENT' || ['live-ledger.json', 'live-facts.json'].includes(name)) throw error; }
        }
        console.log(`live attempt artifacts archived before teardown to ${archive}`);
      } catch { throw new Error('Live archive failed; sandbox cleanup will still run'); }
    } else {
      console.log('CHATGPT_WEB_LIVE_ARCHIVE not set; live artifacts not archived');
    }
  }
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log('sandbox discarded');
  }
}
