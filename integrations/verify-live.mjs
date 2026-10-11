import { spawn } from 'node:child_process';
import { writeFile, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

export async function verifyLiveOnce({ installed, home, sandbox, bun, liveHome, env }) {
  const cookieFile = process.env.CHATGPT_WEB_LIVE_COOKIE_FILE;
  if (!cookieFile) throw new Error('CHATGPT_WEB_LIVE_COOKIE_FILE must name the explicitly authorized session source');
  const root = join(sandbox, 'isolated-live-profile');
  const ledgerPath = join(sandbox, 'live-ledger.json');
  let host;
  try {
    const backend = join(sandbox, 'live-backend.mjs');
    const imports = name => JSON.stringify(pathToFileURL(join(installed, name)).href);
    await writeFile(backend, `import { serve } from ${imports('backend/main.mjs')};
import { browserRead, launchSignInBrowser, sessionCredential } from ${imports('backend/browser.mjs')};
import { productionReadClient } from ${imports('backend/http.mjs')};
import { BackendError } from ${imports('backend/guard.mjs')};
import { TurnDriver } from ${imports('backend/turn.mjs')};
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import https from 'node:https';
const ledger = { conversationSubmits:0, deliberate:[], browserRequests:0, browserByKind:{}, blockedOffOrigin:0, statuses:[] };
const save = () => writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(ledger));
save();
const reserve = (route,path) => {
 if (ledger.deliberate.length >= 8) throw new BackendError('cooldown');
 ledger.deliberate.push({route,path});
 save();
};
const originalGet = https.get;
https.get = function(url, options, callback) {
 if (new URL(url).origin !== 'https://chatgpt.com') throw new BackendError('protocol');
 reserve('node',new URL(url).pathname);
 return originalGet.call(this,url,options,response => {
  ledger.statuses.push({route:'node',path:new URL(url).pathname,status:response.statusCode,mitigated:response.headers['cf-mitigated']==='challenge'});
  save();
  callback(response);
 });
};
const source = await readFile(${JSON.stringify(cookieFile)},'utf8');
const jar = source.match(/(?:^|\\s)-b\\s+'([^']+)'/);
if (!jar) throw new BackendError('expired');
const cookies = jar[1].split(';').map(pair => {
 const at=pair.indexOf('='); return {name:pair.slice(0,at).trim(),value:pair.slice(at+1).trim()};
}).filter(cookie => /^__Secure-next-auth\\.session-token(?:\\.\\d+)?$/.test(cookie.name));
if (!cookies.length) throw new BackendError('expired');
const refresh = cookies.map(cookie => cookie.name+'='+cookie.value).join('; ');
const turnDriver = new TurnDriver({profileRoot:${JSON.stringify(root)},launch:async profile => {
 const owned = await launchSignInBrowser(profile,new AbortController().signal);
 const context=owned.context;
 await context.route('**/*',async route => {
  const request=route.request(); const url=new URL(request.url());
  if(url.origin!=='https://chatgpt.com'){ledger.blockedOffOrigin++;save();return route.abort();}
  if(request.method()==='POST' && /^\\/backend-api\\/(?:f\\/)?conversation$/.test(url.pathname)) {
   if(ledger.conversationSubmits>=1 || ledger.deliberate.length>=8) return route.abort();
   reserve('browser',url.pathname);ledger.conversationSubmits++;
  }
  ledger.browserRequests++;
  const kind=request.resourceType();ledger.browserByKind[kind]=(ledger.browserByKind[kind]??0)+1;
  save();
  return route.continue();
 });
 context.on('response',response => {
  const url=new URL(response.url());
  if(url.origin==='https://chatgpt.com' && ['/api/auth/session','/backend-api/models','/backend-api/f/conversation','/backend-api/conversation'].includes(url.pathname)) ledger.statuses.push({route:'browser',path:url.pathname,status:response.status()});
  save();
 });
 await context.addCookies(cookies.map(cookie => ({...cookie,url:'https://chatgpt.com',secure:true,httpOnly:true,expires:Math.floor(Date.now()/1000)+3600})));
 context.close=owned.close;
 return context;
}});
const loginFlow=async (account,signal) => {
 const client=productionReadClient({cookie:refresh,browserRoute:async(path,bounded,origin)=>{
  reserve('browser-read-attempt',path);
  return turnDriver.browser.run(account,async context=>{
   const page=await context.newPage();
   try {await page.goto(origin.href,{waitUntil:'domcontentloaded',timeout:20000});return await browserRead(context,page,path,origin,bounded);}
   finally {await page.close().catch(()=>{});}
  },bounded);
 }});
 const session=await client.session(signal);
 return {state:'signed-in',credential:sessionCredential(session,session.refresh??refresh,account)};
};
await serve(process.stdin,process.stdout,{loginFlow,turnDriver,readClient:options=>productionReadClient({...options,browserRoute:async(...args)=>{
 reserve('browser-read-attempt',args[0]);return options.browserRoute(...args);
}}),close:save,timeout:180000});
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
        if (frame.event) {
          entry.frame?.(frame);
          if (frame.event === 'chunk') host.stdin.write(JSON.stringify({ method: 'credit', params: { id: frame.id, n: Buffer.from(frame.data, 'base64').length + 256 } }) + '\n');
        } else if ('result' in frame || frame.error) {
          pending.delete(frame.id);
          frame.error ? entry.reject(new Error('Live host request failed')) : entry.resolve(frame.result);
        }
      }
    });
    const rpc = (method, params, frame) => new Promise((resolve, reject) => {
      const id = String(++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Live ${method} timed out; no retry allowed`)); }, 190000);
      pending.set(id, { frame, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    await rpc('init', { directory: join(home, '.config/magpie/plugins'), authPath: join(home, '.config/magpie/plugin-auth.json'), plugins: [{ spec: 'live-consented', target: wrapper }] });
    const authorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
    console.log('existing session exchange started; no interactive sign-in or retained profile');
    const login = await rpc('callback', { session: authorization.session });
    if (!login.ok) throw new Error('Seeded session exchange failed; no live turn submitted');
    const providers = await rpc('providers', {});
    const provider = providers.find(value => value.id === 'chatgpt-web');
    console.log(JSON.stringify({ liveCatalogue: !provider?.fellBack, models: provider?.models?.length ?? 0 }));
    if (!provider || provider.fellBack || !provider.models.length) throw new Error('Live catalogue failed; no turn submitted');
    const arrivals = [];
    const sizes = [];
    let status;
    let success = false;
    let sse = '';
    const started = Date.now();
    const prompt = 'Write six short numbered paragraphs about an imaginary garden in the clouds. Use only invented scenery, no tools, links or personal information.';
    console.log('submitting one temporary conversation turn without retries');
    await rpc('fetch', { provider: 'chatgpt-web', model: 'auto', npm: '@ai-sdk/anthropic', url: 'https://chatgpt-web.invalid/v1/messages', session: 'live-consented', body: Buffer.from(JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: prompt }] })).toString('base64') }, frame => {
      if (frame.event === 'head') status = frame.status;
      if (frame.event !== 'chunk') return;
      sse += Buffer.from(frame.data, 'base64').toString();
      let end;
      while ((end = sse.indexOf('\n\n')) >= 0) {
        const block = sse.slice(0, end); sse = sse.slice(end + 2);
        for (const line of block.split('\n')) if (line.startsWith('data: ')) {
          let value;
          try { value = JSON.parse(line.slice(6)); } catch { continue; }
          if (value.type === 'content_block_delta') {
            arrivals.push(Date.now() - started); sizes.push(value.delta.text.length);
            console.log(JSON.stringify({ delta: arrivals.length, milliseconds: arrivals.at(-1), characters: sizes.at(-1) }));
          }
          if (value.type === 'message_stop') success = true;
          if (value.type === 'error') console.log('live stream returned a typed error');
        }
      }
    });
    console.log(JSON.stringify({ status, completed: success, deltas: sizes.length, sizes, arrivalMilliseconds: arrivals }));
    if (!success) throw new Error('One live turn failed; no retry made');
  } finally {
    if (host) { const exit = once(host, 'exit'); host.stdin.end(); await exit; }
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      const browserReads = ledger.deliberate.filter(item => item.route === 'browser-read-attempt').length;
      console.log(JSON.stringify({ liveLedger: ledger, ancillaryBrowserRequests: ledger.browserRequests - browserReads - ledger.conversationSubmits }));
    } catch { console.log('live ledger unavailable; request counts cannot be established'); }
  }
}
