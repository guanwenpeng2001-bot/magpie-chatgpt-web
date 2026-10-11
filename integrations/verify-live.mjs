import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readdir, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

export async function verifyLiveOnce({ installed, home, sandbox, bun, liveHome, env }) {
  const target = process.env.CHATGPT_WEB_LIVE_PROFILE;
  if (!target) throw new Error('CHATGPT_WEB_LIVE_PROFILE must name the authorized isolated profile');
  const root = join(home, '.config/magpie/chatgpt-web-profile');
  await mkdir(root, { recursive: true });
  let host;
  try {
    const backend = join(sandbox, 'live-backend.mjs');
    const imports = name => JSON.stringify(pathToFileURL(join(installed, name)).href);
    await writeFile(backend, `import { serve } from ${imports('backend/main.mjs')};
import { createLoginFlow, launchSignInBrowser } from ${imports('backend/browser.mjs')};
import { productionReadClient } from ${imports('backend/http.mjs')};
import { TurnDriver } from ${imports('backend/turn.mjs')};
import { symlink, lstat, writeFile } from 'node:fs/promises';
let loginContext;
const inspectedRead = options => {
 const client = productionReadClient(options);
 client.session = async () => {
  const result = await loginContext.pages().find(page => page.url().startsWith('https://chatgpt.com')).evaluate(async () => {
   const response = await fetch('/api/auth/session', {credentials:'include'});
   let value; try {value=await response.json();} catch {}
   return {status:response.status,value};
  });
  const value=result.value;
  await writeFile(${JSON.stringify(join(sandbox, 'session-diagnostic.json'))},JSON.stringify({status:result.status,accessTokenPresent:typeof value?.accessToken==='string' && !!value.accessToken,expiresType:typeof value?.expires,expiresParseable:Number.isFinite(Date.parse(value?.expires)),keys:Object.keys(value??{})}));
  if(result.status!==200) throw new Error('in-page session exchange rejected');
  return value;
 }; return client;
};
const launch = async (profile, signal) => {
 try { await lstat(profile); } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(${JSON.stringify(target)}, profile, 'junction'); }
 const owned = await launchSignInBrowser(profile, signal ?? new AbortController().signal);
 loginContext = owned.context;
 await owned.context.route('**/*', route => new URL(route.request().url()).hostname === 'chatgpt.com' ? route.continue() : route.abort());
 return owned;
};
const turnDriver = new TurnDriver({profileRoot:${JSON.stringify(root)}, launch:async profile => {const owned = await launch(profile); owned.context.close = owned.close; return owned.context;}});
const loginFlow = createLoginFlow({launch, pollMilliseconds:1000, readClient:inspectedRead});
await serve(process.stdin, process.stdout, {loginFlow, turnDriver, readClient:productionReadClient, timeout:60000});
`);
    const wrapper = join(sandbox, 'live-plugin.mjs');
    await writeFile(wrapper, `import { _internal } from ${imports('src/index.mjs')};
import { Bridge } from ${imports('src/bridge.mjs')};
const bridge = new Bridge({backend:${JSON.stringify(backend)}});
export default {id:'chatgpt-web',server:async()=>_internal.createHooks({bridge,profileRoot:${JSON.stringify(root)},pollMilliseconds:1000})};
`);
    const hostCopy = join(sandbox, 'live-host.mjs');
    await copyFile(join(liveHome, '.cache/magpie/plugin-host/host-4bc476f3c4cb.js'), hostCopy);
    host = spawn(bun, ['run', hostCopy], { cwd: sandbox, env, stdio: ['pipe', 'pipe', 'pipe'] });
    host.stderr.resume();
    const pending = new Map();
    let buffer = '';
    let serial = 0;
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const entry = pending.get(frame.id);
        if (!entry) continue;
        if (frame.event) entry.frame?.(frame);
        else if ('result' in frame || frame.error) { pending.delete(frame.id); frame.error ? entry.reject(new Error('Live host request failed')) : entry.resolve(frame.result); }
      }
    });
    const rpc = (method, params, frame) => new Promise((resolve, reject) => {
      const id = String(++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Live ${method} timed out; no retry allowed`)); }, 65000);
      pending.set(id, { frame, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    await rpc('init', { directory: join(home, '.config/magpie/plugins'), authPath: join(home, '.config/magpie/plugin-auth.json'), plugins: [{ spec: 'live-consented', target: wrapper }] });
    const authorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
    console.log('live existing-profile recognition started; interactive sign-in is not authorized');
    const login = await rpc('callback', { session: authorization.session });
    try { console.log('session diagnostic ' + await readFile(join(sandbox, 'session-diagnostic.json'), 'utf8')); } catch {}
    if (!login.ok) { console.log(JSON.stringify({ liveTurns: 0, result: 'existing profile was not recognized', symptom: login.error })); throw new Error('Existing-session recognition failed; no live turn sent'); }
    console.log('live existing profile recognized; real plugin session expiry conversion accepted');
    const arrivals = [];
    const sizes = [];
    let status;
    let success = false;
    const started = Date.now();
    const prompt = 'Write six short numbered paragraphs about an imaginary garden in the clouds. Use only invented scenery, no tools, links or personal information.';
    console.log('live turn budget: submitting exactly one request, no retries');
    await rpc('fetch', { provider: 'chatgpt-web', model: 'auto', npm: '@ai-sdk/anthropic', url: 'https://chatgpt-web.invalid/v1/messages', session: 'live-consented', body: Buffer.from(JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: prompt }] })).toString('base64') }, frame => {
      if (frame.event === 'head') status = frame.status;
      if (frame.event === 'chunk') {
        const text = Buffer.from(frame.data, 'base64').toString();
        for (const line of text.split('\n')) if (line.startsWith('data: ')) {
          const value = JSON.parse(line.slice(6));
          if (value.type === 'content_block_delta') { arrivals.push(Date.now() - started); sizes.push(value.delta.text.length); }
          if (value.type === 'message_stop') success = true;
          if (value.type === 'error') console.log(JSON.stringify({ liveError: value.error }));
        }
        if (status !== 200) { try { console.log(JSON.stringify({ liveError: JSON.parse(text).error })); } catch {} }
      }
    });
    console.log(JSON.stringify({ liveHostRequests: 1, status, completed: success, deltas: sizes.length, sizes, arrivalMilliseconds: arrivals }));
    if (!success) throw new Error('One live turn failed; no retry made');
  } finally {
    if (host) { const exit = once(host, 'exit'); host.stdin.end(); await exit; }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) throw new Error('Unexpected profile entry; preserve sandbox for inspection');
      await unlink(join(root, entry.name));
    }
  }
}
