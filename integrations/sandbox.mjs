import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, copyFile, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { verifyTurns } from './verify-turns.mjs';
import { redactLiveArtifact } from './verify-live.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const liveHome = homedir();
const liveFiles = ['plugins.json', 'plugin-providers.json', 'plugin-auth.json', 'plugins/package.json'].map(name => join(liveHome, '.config/magpie', name));
const snapshot = async () => Promise.all(liveFiles.map(async path => {
  try {
    if (path.endsWith('plugin-auth.json')) {
      const metadata = await stat(path);
      return [path, metadata.size + ':' + metadata.mtimeMs];
    }
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
const ledger = { rotationSemantics: 'Fixture accepts current and prior cookies until explicit expiry; real-site semantics unverified; production reconciliation tracked separately in D-34', checks: [], started: new Date().toISOString(), node: process.version, mode: process.argv.includes('--host-only') ? 'host-only' : 'full', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() };
const passed = (name, evidence) => { ledger.checks.push({ name, evidence }); console.log(name); };
env.CHATGPT_WEB_FIXTURE_STATE = join(sandbox, 'fixture-state.json');
env.CHATGPT_WEB_FIXTURE_LOG = join(sandbox, 'fixture-events.jsonl');
env.MAGPIE_HTTPS_PROXY = 'http://127.0.0.1:9';
const fixtureEvents = async () => (await readFile(env.CHATGPT_WEB_FIXTURE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
let host;
try {
  await mkdir(config, { recursive: true });
  await mkdir(join(cache, 'bun/1.4.3'), { recursive: true });
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
  const magpie = join(sandbox, 'magpie.exe');
  const bun = join(cache, 'bun/1.4.3/magpie-bun.exe');
  await copyFile(join(liveHome, 'Downloads/magpie-windows-amd64.exe'), magpie);
  await copyFile(join(liveHome, '.cache/magpie/bun/1.4.3/magpie-bun.exe'), bun);
  ledger.version = command(magpie, ['--version']).trim();
  console.log(ledger.version);
  assert.deepEqual(await snapshot(), before, 'live metadata changed during isolated version check');
  console.log('private HOME and USERPROFILE isolation checked before install');
  const repository = join(sandbox, 'package');
  await mkdir(repository);
  for (const name of ['src', 'backend', 'integrations', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES']) await cp(join(source, name), join(repository, name), { recursive: true });
  command('git', ['init', '-q', repository]);
  command('git', ['add', 'src', 'backend', 'integrations', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES'], repository);
  command('git', ['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.invalid', 'commit', '-qm', 'Create disposable integration snapshot'], repository);
  const spec = `git+${pathToFileURL(repository).href}`;
  const revision = command('git', ['rev-parse', 'HEAD'], repository).trim();
  ledger.refProbe = { command: ['plugin', 'add', spec + '#' + revision] };
  command(magpie, ledger.refProbe.command);
  passed('ref-pinned CLI installation', ledger.refProbe);
  assert.deepEqual(await snapshot(), before, 'live metadata changed during sandbox plugin add');
  console.log('add git+file:// snapshot succeeded');
  const listed = command(magpie, ['plugin', 'list', '--json']);
  assert.match(listed, /chatgpt-web/);
  console.log('provider listed chatgpt-web');
  const installed = join(config, 'plugins/node_modules/magpie-chatgpt-web');
  await stat(join(installed, 'src/index.mjs'));
  await stat(join(installed, 'integrations/fixture-backend.mjs'));
  await stat(join(installed, 'LICENSE'));
  if (process.argv.includes('--live-once')) {
    const { verifyLiveOnce } = await import('./verify-live.mjs');
    await verifyLiveOnce({ installed, home, sandbox, bun, liveHome, env });
    assert.deepEqual(await snapshot(), before, 'live installation metadata changed');
    console.log('live installation metadata unchanged');
    process.exitCode ??= 0;
  } else {
  const bundles = (await readdir(join(cache, 'plugin-host'))).filter(name => /^host-[a-f0-9]{12}\.js$/.test(name));
  assert.equal(bundles.length, 1, 'Cold HOME must contain exactly the host emitted by this binary');
  console.log('emitted host ' + join(cache, 'plugin-host', bundles[0]));
  if (!process.argv.includes('--host-only')) await verifyTurns(join(config, 'plugins/node_modules/playwright-core/index.mjs'));
  const launchProbe = join(sandbox, 'launch-probe.mjs');
  await writeFile(launchProbe, 'import { launchSignInBrowser } from ' + JSON.stringify(pathToFileURL(join(installed, 'backend/browser.mjs')).href) + ';\nconst owned = await launchSignInBrowser(' + JSON.stringify(join(home, 'launch-probe')) + ', new AbortController().signal); console.log("ordinary browser probe connected"); await owned.close();');
  console.log(command('node', [launchProbe]).trim());
  const hostSource = join(cache, 'plugin-host', bundles[0]);
  const hostCopy = join(sandbox, 'host.mjs');
  const hostBytes = await readFile(hostSource);
  const hostSha256 = createHash('sha256').update(hostBytes).digest('hex');
  assert.ok(bundles[0].includes(hostSha256.slice(0, 12)), 'Host content digest must match its filename');
  await copyFile(hostSource, hostCopy);
  assert.deepEqual(await readFile(hostCopy), hostBytes);
  ledger.host = { path: hostSource, sha256: hostSha256 };
  console.log(JSON.stringify(ledger.host));
  const wrapper = join(sandbox, 'fixture-plugin.mjs');
  await writeFile(wrapper, `import { spawn } from 'node:child_process';\nimport { _internal } from ${JSON.stringify(pathToFileURL(join(installed, 'src/index.mjs')).href)};\nimport { Bridge } from ${JSON.stringify(pathToFileURL(join(installed, 'src/bridge.mjs')).href)};\nconst bridge = new Bridge({ backend: ${JSON.stringify(join(installed, 'integrations/fixture-backend.mjs'))}, spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...options.env, CHATGPT_WEB_FIXTURE_STATE: ${JSON.stringify(env.CHATGPT_WEB_FIXTURE_STATE)}, CHATGPT_WEB_FIXTURE_LOG: ${JSON.stringify(env.CHATGPT_WEB_FIXTURE_LOG)}, CHATGPT_WEB_FIXTURE_PROFILE_ROOT: ${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))} } }) });\nexport default { id: 'chatgpt-web', server: async () => _internal.createHooks({ bridge, profileRoot: ${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))}, pollMilliseconds: 20 }) };\n`);
  const startHost = () => {
  host = spawn(bun, ['run', hostCopy], { cwd: sandbox, env, stdio: ['pipe', 'pipe', 'pipe'] });
  host.stderr.on('data', chunk => { ledger.hostDiagnostics = (ledger.hostDiagnostics ?? '') + chunk.toString(); });
  let buffer = '';
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
        if (frame.error) waiting?.reject(new Error('Stock host RPC failed: ' + JSON.stringify(frame.error)));
        else waiting?.resolve(frame.result);
      }
    }
  });
  };
  const pending = new Map();
  const events = [];
  let sequence = 0;
  startHost();
  const rpc = (method, params = {}) => new Promise((resolveReply, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Stock host ${method} timeout`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const authPath = join(config, 'plugin-auth.json');
  await assert.rejects(stat(authPath), { code: 'ENOENT' });
  console.log('cold HOME has no plugin credential store before fixture sign-in');
  const init = await rpc('init', { directory: join(config, 'plugins'), authPath, plugins: [{ spec, target: wrapper }] });
  assert.deepEqual(init.plugins[0].provides, ['chatgpt-web']);
  const coldProviders = await rpc('providers');
  const coldProvider = coldProviders.find(value => value.id === 'chatgpt-web');
  assert.ok(coldProvider);
  assert.equal(coldProvider.models.length, 0);
  passed('cold provider listed with zero models', coldProvider);
  const authorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
  assert.ok(authorization.instructions);
  assert.equal(authorization.url, '');
  assert.equal(authorization.method, 'auto');
  const callback = await rpc('callback', { session: authorization.session });
  assert.equal(callback.ok, true, 'fixture callback: ' + (callback.error ?? 'no diagnostic'));
  const signinSpawn = (await fixtureEvents()).find(event => event.event === 'signinSpawn');
  assert.ok(signinSpawn.args.includes('--proxy-server=' + env.MAGPIE_HTTPS_PROXY));
  passed('fixture sign-in and proxy launch args', signinSpawn);
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
  assert.ok(provider.models.every(model => model.toolcall !== true));
  passed('account-derived catalogue', provider.models.map(model => model.id));
  const fetchTurn = (messages, { cancel = false, conversation = 'host-session', tools, tool_choice, suppliedKey, allowFailure = false } = {}) => new Promise((resolveReply, reject) => {
    const id = String(++sequence);
    const chunks = [];
    const arrivals = [];
    const started = Date.now();
    let aborted = false;
    let status;
    const timer = setTimeout(() => reject(new Error('Stock host turn timeout')), 30000);
    pending.set(id, {
      frame(frame) {
        if (frame.event === 'head') status = frame.status;
        if (frame.event !== 'chunk') return;
        const text = Buffer.from(frame.data, 'base64').toString();
        chunks.push(text);
        if (text.includes('content_block_delta')) {
          arrivals.push(Date.now() - started);

        }
      },
      resolve() { clearTimeout(timer); if (status !== 200 && !allowFailure) reject(new Error('Host turn HTTP ' + status + ': ' + chunks.join(''))); else resolveReply({ status, chunks, arrivals, aborted }); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    if (cancel) void (async () => {
      const initial = (await fixtureEvents()).filter(event => event.event === 'submit').length;
      const deadline = Date.now() + 20000;
      while ((await fixtureEvents()).filter(event => event.event === 'submit').length <= initial) {
        if (Date.now() > deadline) throw new Error('Abort probe saw no submission');
        await delay(10);
      }
      aborted = true;
      host.stdin.write(JSON.stringify({ method: 'abort', params: { id } }) + '\n');
      clearTimeout(timer);
      resolveReply({ chunks, arrivals, aborted });
    })().catch(reject);
    host.stdin.write(JSON.stringify({ id, method: 'fetch', params: { provider: 'chatgpt-web', model: 'auto', npm: '@ai-sdk/anthropic', url: 'https://chatgpt-web.invalid/v1/messages', session: conversation, body: Buffer.from(JSON.stringify({ model: 'auto', stream: true, messages, tools, tool_choice, conversation_id: suppliedKey })).toString('base64') } }) + '\n');
  });
  const messages = [{ role: 'user', content: 'Describe a fictional garden.' }];
  const firstTurn = await fetchTurn(messages);
  assert.equal(firstTurn.arrivals.length, 1);
  const answer = firstTurn.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(frame => frame.type === 'content_block_delta').map(frame => frame.delta.text).join('');
  const secondMessages = [...messages, { role: 'assistant', content: answer }, { role: 'user', content: 'Continue the same garden description.' }];
  const secondTurn = await fetchTurn(secondMessages);
  assert.match(secondTurn.chunks.join(''), /event: message_stop/);
  const thirdTurn = await fetchTurn([...secondMessages, { role: 'assistant', content: answer }, { role: 'user', content: 'Recall the garden from the first turn.' }]);
  assert.match(thirdTurn.chunks.join(''), /event: message_stop/);
  console.log('three fixture-backed conversation turns completed');
  const cancelled = await fetchTurn(messages, { cancel: true, conversation: 'abort-session' });
  assert.equal(cancelled.aborted, true);
  await delay(250);
  assert.match((await fetchTurn(messages, { conversation: 'abort-session' })).chunks.join(''), /event: message_stop/);
  passed('host abort after submit then reuse', { abortedBeforeDelta: cancelled.arrivals.length === 0 });
  console.log(JSON.stringify({ hostTurn: 'stream, continuation, abort, session reuse', deltas: firstTurn.arrivals.length, arrivalMilliseconds: firstTurn.arrivals }));
  const submissions = (await fixtureEvents()).filter(event => event.event === 'submit');
  assert.equal(new Set(submissions.slice(0, 3).map(event => event.conversation)).size, 1);
  assert.doesNotMatch(submissions[1].prompt, /Describe a fictional garden/);
  passed('three-turn host binding reuse', submissions.slice(0, 3));
  const suppliedFirst = await fetchTurn(messages, { suppliedKey: 'explicit-binding', conversation: 'header-first' });
  assert.match(suppliedFirst.chunks.join(''), /message_stop/);
  const suppliedSecond = await fetchTurn(secondMessages, { suppliedKey: 'explicit-binding', conversation: 'header-second' });
  assert.match(suppliedSecond.chunks.join(''), /message_stop/);
  const suppliedSubmissions = (await fixtureEvents()).filter(event => event.event === 'submit').slice(-2);
  assert.equal(suppliedSubmissions[0].conversation, suppliedSubmissions[1].conversation);
  passed('supplied conversation_id overrides distinct host sessions', suppliedSubmissions);
  const overlap = await Promise.all([
    fetchTurn(messages, { conversation: 'overlap', suppliedKey: 'supplied-overlap', allowFailure: true }),
    fetchTurn(messages, { conversation: 'overlap', suppliedKey: 'supplied-overlap', allowFailure: true }),
  ]);
  assert.ok(overlap.every(result => result.status === 200));
  assert.ok(Math.abs(overlap[0].arrivals[0] - overlap[1].arrivals[0]) >= 1000, 'AccountGuard must serialize overlapping requests');
  passed('overlapping turns bounded', overlap.map(result => ({ status: result.status })));
  const unsupportedHost = await fetchTurn([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] }], { allowFailure: true });
  assert.equal(unsupportedHost.status, 400);
  passed('unsupported input rejected by host', { status: unsupportedHost.status });
  const image = Buffer.alloc(10 * 1024 * 1024).toString('base64');
  const imageTurn = await fetchTurn([{ role: 'user', content: [{ type: 'text', text: 'Describe the fixture images.' }, ...Array.from({ length: 4 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }))] }], { conversation: 'max-image' });
  assert.match(imageTurn.chunks.join(''), /message_stop/);
  passed('max legal images cross host and backend', { count: 4, bytesEach: 10 * 1024 * 1024 });
  await delay(11000);
  assert.ok((await fixtureEvents()).some(event => event.event === 'contextClosed'));
  passed('idle context teardown', { idleMilliseconds: 10000 });
  const stopped = once(host, 'exit'); host.stdin.end(); await stopped; host = null;
  startHost();
  await rpc('init', { directory: join(config, 'plugins'), authPath, plugins: [{ spec, target: wrapper }] });
  const restartedProviders = await rpc('providers');
  assert.equal(restartedProviders.find(value => value.id === 'chatgpt-web').models.length, 8, JSON.stringify(restartedProviders));
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), auths);
  passed('host restart persistence', { credentialUnchanged: true });
  auths[callback.account].expires = Date.now() - 1;
  await writeFile(authPath, JSON.stringify(auths));
  await rpc('reload', { provider: 'chatgpt-web' });
  await rpc('providers');
  const renewed = JSON.parse(await readFile(authPath, 'utf8'))[callback.account];
  assert.ok(renewed.expires > Date.now() + 86400000);
  assert.equal(renewed.profile, auth.profile);
  assert.ok(renewed.refresh !== auth.refresh, 'HttpOnly session rotation must reach the stock host credential');
  passed('HTTP-only refresh persisted cookie rotation', { profilePreserved: renewed.profile === auth.profile });
  auths[callback.account] = { ...renewed, refresh: crypto.randomUUID(), expires: Date.now() - 1 };
  await writeFile(authPath, JSON.stringify(auths));
  await rpc('reload', { provider: 'chatgpt-web' });
  const expiredProviders = await rpc('providers');
  assert.equal(expiredProviders.find(value => value.id === 'chatgpt-web').fellBack, true);
  assert.ok(events.some(event => event.event === 'signIn' && event.said === 'expired'));
  console.log('stock host marks expired account and reports model listError');
  const hostExpired = await fetchTurn(messages, { allowFailure: true });
  assert.equal(hostExpired.status, 401);
  passed('host expiry classification', { status: hostExpired.status });
  const hostExit = once(host, 'exit');
  host.stdin.end();
  await hostExit;
  host = null;
  await writeFile(authPath, JSON.stringify({ [callback.account]: renewed }));
  const masked = join(sandbox, 'masked-package');
  await cp(join(installed, 'src'), join(masked, 'src'), { recursive: true });
  await cp(join(installed, 'backend'), join(masked, 'backend'), { recursive: true });
  await writeFile(wrapper, `import { _internal } from ${JSON.stringify(pathToFileURL(join(masked, 'src/index.mjs')).href)};
import { Bridge } from ${JSON.stringify(pathToFileURL(join(masked, 'src/bridge.mjs')).href)};
export default { id: 'chatgpt-web', server: async () => _internal.createHooks({ bridge: new Bridge(), profileRoot: ${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))} }) };`);
  startHost();
  await rpc('init', { directory: join(config, 'plugins'), authPath, plugins: [{ spec, target: wrapper }] });
  const maskedTurn = await fetchTurn(messages, { allowFailure: true });
  assert.equal(maskedTurn.status, 503);
  assert.match(maskedTurn.chunks.join(''), /plugin dependency.*Reinstall.*playwright-core/);
  passed('masked component named at host HTTP surface', { status: maskedTurn.status, body: maskedTurn.chunks.join('') });
  const maskedExit = once(host, 'exit'); host.stdin.end(); await maskedExit; host = null;
  const fixturePackage = join(sandbox, 'migration-fixture');
  await cp(installed, fixturePackage, { recursive: true });
  await cp(join(config, 'plugins/node_modules/playwright-core'), join(fixturePackage, 'node_modules/playwright-core'), { recursive: true });
  const legacyRepository = join(sandbox, 'legacy-package');
  await mkdir(legacyRepository);
  const legacyArchive = join(sandbox, 'legacy.tar');
  command('git', ['archive', '--format=tar', '--output=' + legacyArchive, 'b857499'], source);
  command(join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', legacyArchive, '-C', legacyRepository]);
  command('git', ['init', '-q', legacyRepository]);
  command('git', ['add', '.'], legacyRepository);
  command('git', ['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@localhost', 'commit', '-qm', 'Archive prior release'], legacyRepository);
  const legacyRevision = command('git', ['rev-parse', 'HEAD'], legacyRepository).trim();
  const legacySpec = 'git+' + pathToFileURL(legacyRepository).href + '#' + legacyRevision;
  const migrationWrapper = async () => writeFile(wrapper, `import { spawn } from 'node:child_process';
import { _internal } from ${JSON.stringify(pathToFileURL(join(installed, 'src/index.mjs')).href)};
import { Bridge } from ${JSON.stringify(pathToFileURL(join(fixturePackage, 'src/bridge.mjs')).href)};
const bridge = new Bridge({ backend: ${JSON.stringify(join(fixturePackage, 'integrations/fixture-backend.mjs'))}, spawnProcess: (exe,args,options) => spawn(exe,args,{...options,env:{...options.env,CHATGPT_WEB_FIXTURE_STATE:${JSON.stringify(env.CHATGPT_WEB_FIXTURE_STATE)},CHATGPT_WEB_FIXTURE_LOG:${JSON.stringify(env.CHATGPT_WEB_FIXTURE_LOG)},CHATGPT_WEB_FIXTURE_PROFILE_ROOT:${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))}}}) });
export default {id:'chatgpt-web',server:async()=>_internal.createHooks({bridge,profileRoot:${JSON.stringify(join(home, '.config/magpie/chatgpt-web-profile'))},pollMilliseconds:20})};`);
  const installRevision = async pinnedSpec => {
    command(magpie, ['plugin', 'rm', 'magpie-chatgpt-web']);
    command(magpie, ['plugin', 'add', pinnedSpec]);
    await migrationWrapper();
    startHost();
    await rpc('init', { directory: join(config, 'plugins'), authPath, plugins: [{ spec: pinnedSpec, target: wrapper }] });
  };
  await rm(authPath, { force: true });
  await rm(join(home, '.config/magpie/chatgpt-web-profile'), { recursive: true, force: true });
  await installRevision(legacySpec);
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, '0.1.0');
  const legacyAuthorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
  const legacyLogin = await rpc('callback', { session: legacyAuthorization.session });
  assert.equal(legacyLogin.ok, true);
  let legacyCredentials = await readFile(authPath, 'utf8');
  const profileDirectories = await readdir(join(home, '.config/magpie/chatgpt-web-profile'));
  assert.equal(profileDirectories.length, 1);
  assert.equal((await rpc('providers')).find(value => value.id === 'chatgpt-web').models.length, 2, 'Legacy sign-in catalogue');
  await delay(11000);
  assert.equal((await fixtureEvents()).filter(value => /^context/.test(value.event)).at(-1).event, 'contextClosed');
  const legacyExit = once(host, 'exit'); host.stdin.end(); await legacyExit; host = null;
  ledger.migrationProcesses = command('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*" + sandbox.replaceAll("'", "''") + "*' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]);
  ledger.migrationProfileFiles = await readdir(join(home, '.config/magpie/chatgpt-web-profile', profileDirectories[0]));
  await installRevision(spec + '#' + revision);
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, '0.2.0');
  assert.equal(await readFile(authPath, 'utf8'), legacyCredentials);
  const migrationProviders = await rpc('providers');
  assert.equal(migrationProviders.find(value => value.id === 'chatgpt-web').models.length, 8, JSON.stringify(migrationProviders));
  assert.deepEqual(await readdir(join(home, '.config/magpie/chatgpt-web-profile')), profileDirectories);
  const upgradeCredentials = JSON.parse(legacyCredentials);
  const upgradeAccount = upgradeCredentials[legacyLogin.account];
  upgradeAccount.expires = Date.now() - 1;
  await writeFile(authPath, JSON.stringify(upgradeCredentials));
  await rpc('reload', { provider: 'chatgpt-web' });
  const refreshedProviders = await rpc('providers');
  assert.equal(refreshedProviders.find(value => value.id === 'chatgpt-web').models.length, 8, JSON.stringify(refreshedProviders));
  const refreshedUpgrade = JSON.parse(await readFile(authPath, 'utf8'))[legacyLogin.account];
  assert.ok(refreshedUpgrade.expires > Date.now());
  assert.equal(refreshedUpgrade.profile, upgradeAccount.profile);
  legacyCredentials = await readFile(authPath, 'utf8');
  passed('upgrade retained credential and profile directories', { from: '0.1.0', to: '0.2.0', profileDirectories: profileDirectories.length });
  await delay(11000);
  assert.equal((await fixtureEvents()).filter(value => /^context/.test(value.event)).at(-1).event, 'contextClosed');
  const upgradedExit = once(host, 'exit'); host.stdin.end(); await upgradedExit; host = null;
  await installRevision(legacySpec);
  assert.equal(await readFile(authPath, 'utf8'), legacyCredentials);
  assert.equal((await rpc('providers')).find(value => value.id === 'chatgpt-web').models.length, 2);
  passed('rollback serves same credential', { version: '0.1.0', spec: legacySpec });
  assert.deepEqual(await snapshot(), before, 'live installation metadata changed');
  passed('live installation metadata unchanged', { isolated: true });
  }
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Assertion failed: ${error.message}` : `Sandbox failed: ${error.code ?? error.message}`);
  ledger.failure = error.message;
  ledger.failureStack = error.stack;
  try { ledger.fixtureEvents = await fixtureEvents(); } catch {}
  process.exitCode = 1;
} finally {
  try {
  if (host) { const exit = once(host, 'exit'); host.stdin.end(); await exit.catch(() => {}); }
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
    try {
      if (process.env.CHATGPT_WEB_SANDBOX_ARCHIVE) {
        const archive = resolve(process.env.CHATGPT_WEB_SANDBOX_ARCHIVE);
        const local = relative(source, archive);
        if (!local || (!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep))) throw new Error('Archive must be outside the worktree');
        await mkdir(archive, { recursive: true });
        await writeFile(join(archive, 'sandbox-ledger.json'), JSON.stringify({ ...ledger, finished: new Date().toISOString(), passed: !process.exitCode }, null, 2));
      }
    } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    console.log('sandbox discarded');
  }
}
