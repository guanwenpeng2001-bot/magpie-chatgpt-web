import { spawn } from 'node:child_process';
import { writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { BackendError } from '../backend/guard.mjs';

export async function verifyLiveOnce({ installed, home, sandbox, bun, liveHome, env }) {
  const cookieFile = process.env.CHATGPT_WEB_LIVE_COOKIE_FILE;
  if (!cookieFile) throw new Error('CHATGPT_WEB_LIVE_COOKIE_FILE must name the explicitly authorized session source');
  const turnOnly = process.env.CHATGPT_WEB_LIVE_TURN_ONLY === '1';
  const root = join(sandbox, 'isolated-live-profile');
  const ledgerPath = join(sandbox, 'live-ledger.json');
  const factsPath = join(sandbox, 'live-facts.json');
  const facts = { attempt: turnOnly ? '4-turn-only' : 3, sessionRoute: 'unknown', catalogueRoute: 'unknown', turn: null };
  const stderrChunks = [];
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
const ledger = { conversationSubmits:0, deliberate:[], posts:[], browserRequests:0, browserByKind:{}, blockedOffOrigin:0, statuses:[] };
const save = () => writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(ledger));
const note = line => process.stderr.write(JSON.stringify(line)+'\\n');
save();
const DELIBERATE_CAP = 6;
class ShareExhausted extends Error {
 constructor(){ super('Local live-attempt share of deliberate requests exhausted; refusing to spend further. This is a harness budget refusal, not an account rate limit.'); this.name='ShareExhausted'; }
}
const reserve = (route,path) => {
 if (ledger.deliberate.length >= DELIBERATE_CAP) {
  note({event:'shareExhausted',route,path,deliberate:ledger.deliberate.length,cap:DELIBERATE_CAP});
  save();
  throw new ShareExhausted();
 }
 ledger.deliberate.push({route,path});
 note({event:'reserve',route,path,deliberate:ledger.deliberate.length});
 save();
};
const originalGet = https.get;
https.get = function(url, options, callback) {
 if (new URL(url).origin !== 'https://chatgpt.com') throw new BackendError('protocol');
 reserve('node',new URL(url).pathname);
 return originalGet.call(this,url,options,response => {
  ledger.statuses.push({route:'node',path:new URL(url).pathname,status:response.statusCode,mitigated:response.headers['cf-mitigated']==='challenge'});
  note({event:'status',route:'node',path:new URL(url).pathname,status:response.statusCode,mitigated:response.headers['cf-mitigated']==='challenge'});
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
  if(request.method()==='POST') {
   request.response().then(response => {
    ledger.posts.push({path:url.pathname,status:response.status(),headerNames:Object.keys(response.headers())});
    note({event:'post',path:url.pathname,status:response.status()});
    save();
   }).catch(()=>{});
  }
  if(request.method()==='POST' && /^\\/backend-api\\/(?:f\\/)?conversation$/.test(url.pathname)) {
   if(ledger.conversationSubmits>=2 || ledger.deliberate.length>=DELIBERATE_CAP) {
    note({event:'submitRefused',submits:ledger.conversationSubmits,deliberate:ledger.deliberate.length});
    save();
    return route.abort();
   }
   reserve('browser',url.pathname);ledger.conversationSubmits++;
   note({event:'conversationSubmit',count:ledger.conversationSubmits});
  }
  ledger.browserRequests++;
  const kind=request.resourceType();ledger.browserByKind[kind]=(ledger.browserByKind[kind]??0)+1;
  save();
  return route.continue();
 });
 context.on('response',response => {
  const url=new URL(response.url());
  if(url.origin==='https://chatgpt.com' && ['/api/auth/session','/backend-api/models','/backend-api/f/conversation','/backend-api/conversation'].includes(url.pathname)) {
   ledger.statuses.push({route:'browser',path:url.pathname,status:response.status()});
   note({event:'status',route:'browser',path:url.pathname,status:response.status()});
  }
  save();
 });
 await context.addCookies(cookies.map(cookie => ({...cookie,url:'https://chatgpt.com',secure:true,httpOnly:true,expires:Math.floor(Date.now()/1000)+3600})));
 context.close=owned.close;
 return context;
}});
const TURN_ONLY = ${turnOnly};
const loginFlow = TURN_ONLY ? async (account,signal) => ({state:'signed-in',credential:sessionCredential({accessToken:'seeded-credential-not-used-by-browser-turns',expires:new Date(Date.now()+7*86400000).toISOString(),user:{}},refresh,account)}) : async (account,signal) => {
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
    const pluginErrorPath = join(sandbox, 'live-plugin-error.log');
    await writeFile(wrapper, `import { _internal } from ${imports('src/index.mjs')};
import { Bridge } from ${imports('src/bridge.mjs')};
import { appendFileSync } from 'node:fs';
const errorLog = ${JSON.stringify(pluginErrorPath)};
const record = entry => { try { appendFileSync(errorLog, JSON.stringify(entry)+'\\n'); } catch {} };
const bridge = new Bridge({backend:${JSON.stringify(backend)}});
const originalOpen = bridge.open.bind(bridge);
bridge.open = async (command, signal) => {
 const startedAt = Date.now();
 try {
  const upstream = await originalOpen(command, signal);
  return (async function*(){
   try { yield* upstream; }
   catch (error) {
    record({stage:'open-stream',method:command?.method,elapsedMilliseconds:Date.now()-startedAt,name:error?.name,message:String(error?.message??error),signalAborted:!!signal?.aborted,abortReason:String(signal?.reason??''),stack:String(error?.stack??'').slice(0,2000)});
    throw error;
   }
  })();
 } catch (error) {
  record({stage:'open',method:command?.method,elapsedMilliseconds:Date.now()-startedAt,name:error?.name,message:String(error?.message??error),signalAborted:!!signal?.aborted,abortReason:String(signal?.reason??''),stack:String(error?.stack??'').slice(0,2000)});
  throw error;
 }
};
const hooks = _internal.createHooks({bridge,profileRoot:${JSON.stringify(root)},pollMilliseconds:1000});
const originalLoader = hooks.auth.loader;
hooks.auth.loader = getAuth => {
 const loaded = originalLoader(getAuth);
 if (loaded?.fetch) {
  const originalFetch = loaded.fetch.bind(loaded);
  loaded.fetch = async (input, init = {}) => {
   const startedAt = Date.now();
   const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
   const response = await originalFetch(input, init);
   if (response.status !== 200 || signal?.aborted) {
    record({stage:'fetch-response',status:response.status,elapsedMilliseconds:Date.now()-startedAt,signalAborted:!!signal?.aborted,abortReason:String(signal?.reason??'')});
   }
   if (response.status !== 200) {
    try {
     const parsed = JSON.parse(await response.clone().text());
     if (parsed?.error?.message) record({stage:'error-envelope',status:response.status,error:parsed.error});
    } catch {}
   }
   return response;
  };
 }
 return loaded;
};
export default {id:'chatgpt-web',server:async()=>hooks};
`);
    const hostCopy = join(sandbox, 'live-host.mjs');
    await copyFile(join(liveHome, '.cache/magpie/plugin-host/host-6e85b6c721c8.js'), hostCopy);
    host = spawn(bun, ['run', hostCopy], { cwd: sandbox, env, stdio: ['pipe', 'pipe', 'pipe'] });
    host.stderr.on('data', chunk => stderrChunks.push(chunk));
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
    const readLedger = async () => JSON.parse(await readFile(ledgerPath, 'utf8'));
    const saveFacts = () => writeFile(factsPath, JSON.stringify(facts, null, 2));
    const routeOf = (led, path) => {
      const attempts = led.deliberate.filter(item => item.path === path).map(item => item.route);
      const statuses = led.statuses.filter(item => item.path === path);
      if (statuses.some(item => item.route === 'node' && item.status === 200) && !attempts.includes('browser-read-attempt')) return 'node';
      if (attempts.includes('browser-read-attempt') || statuses.some(item => item.route === 'browser')) return 'browser';
      return 'unknown';
    };
    const authorization = await rpc('authorize', { provider: 'chatgpt-web', method: 0 });
    console.log(turnOnly ? 'turn-only attempt: no-network seeded credential exchange; no sign-in, no session read, no catalogue read' : 'existing session exchange started; no interactive sign-in or retained profile');
    const login = await rpc('callback', { session: authorization.session });
    if (!login.ok) throw new Error('Seeded credential exchange failed; no live turn submitted');
    if (!turnOnly) {
      facts.sessionRoute = routeOf(await readLedger(), '/api/auth/session');
      await saveFacts();
      const providers = await rpc('providers', {});
      const provider = providers.find(value => value.id === 'chatgpt-web');
      facts.catalogueRoute = routeOf(await readLedger(), '/backend-api/models');
      facts.models = provider?.models?.length ?? 0;
      facts.fellBack = provider?.fellBack ?? null;
      await saveFacts();
      console.log(JSON.stringify({ liveCatalogue: !provider?.fellBack, models: provider?.models?.length ?? 0, catalogueRoute: facts.catalogueRoute, sessionRoute: facts.sessionRoute }));
      if (!provider || provider.fellBack || !provider.models.length) throw new Error('Live catalogue failed; no turn submitted');
    } else {
      facts.sessionRoute = 'not-exercised';
      facts.catalogueRoute = 'not-exercised';
      await saveFacts();
      console.log('turn-only attempt: reads skipped by authorization; model auto served from the declared baseline');
    }
    const prompt = 'Write six short numbered paragraphs about an imaginary garden in the clouds. Use only invented scenery, no tools, links or personal information.';
    const tries = [];
    let retryUsed = false;
    for (let index = 0; index < 2; index++) {
      const arrivals = [];
      const sizes = [];
      const rawChunks = [];
      let status = null;
      let headFrame = null;
      let success = false;
      let sse = '';
      const started = Date.now();
      const startedWall = new Date(started).toISOString();
      console.log(index === 0 ? 'submitting one temporary conversation turn' : 'the conversation POST was challenged; performing the one authorized retry of the submit alone');
      let fetchError = null;
      try {
        await rpc('fetch', { provider: 'chatgpt-web', model: 'auto', npm: '@ai-sdk/anthropic', url: 'https://chatgpt-web.invalid/v1/messages', session: 'live-consented', body: Buffer.from(JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: prompt }] })).toString('base64') }, frame => {
        if (frame.event === 'head') { status = frame.status; headFrame = frame; }
        if (frame.event !== 'chunk') return;
        const text = Buffer.from(frame.data, 'base64').toString();
        rawChunks.push(text);
        sse += text;
        let end;
        while ((end = sse.indexOf('\n\n')) >= 0) {
          const block = sse.slice(0, end); sse = sse.slice(end + 2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) {
            let value;
            try { value = JSON.parse(line.slice(6)); } catch { continue; }
            if (value.type === 'content_block_delta') {
              arrivals.push(Date.now() - started); sizes.push(value.delta.text.length);
              console.log(JSON.stringify({ try: index + 1, delta: arrivals.length, milliseconds: arrivals.at(-1), characters: sizes.at(-1) }));
            }
            if (value.type === 'message_stop') success = true;
            if (value.type === 'error') console.log('live stream returned a typed error');
          }
        }
        });
      } catch (error) { fetchError = String(error?.message ?? error); }
      let errorEnvelope = null;
      let upstreamBodyDigest = null;
      if (status !== 200) {
        const raw = rawChunks.join('');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (parsed && typeof parsed.error === 'object' && parsed.error !== null && typeof parsed.error.status === 'number' && typeof parsed.error.message === 'string') errorEnvelope = parsed.error;
        else upstreamBodyDigest = { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') };
      }
      const typedCode = errorEnvelope ? BackendError.fromEnvelope(errorEnvelope).code : null;
      const temporaryState = success ? 'confirmed'
        : typedCode === 'temporary' ? 'unconfirmed'
        : typedCode ? `not-reached (${typedCode})`
        : 'unknown';
      tries.push({ startedAt: startedWall, elapsedMilliseconds: Date.now() - started, status, completed: success, deltas: sizes.length, arrivalMilliseconds: arrivals, sizes, errorEnvelope, typedCode, upstreamBodyDigest, fetchError, temporaryState, headFrame });
      if (success) break;
      if (index === 0 && typedCode === 'verification') { retryUsed = true; continue; }
      break;
    }
    let pluginErrors = null;
    try { pluginErrors = (await readFile(pluginErrorPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
    const ledNow = await readLedger();
    const last = tries.at(-1);
    facts.turn = { tries, retryUsed, completed: last.completed, pluginErrors, conversationSubmits: ledNow.conversationSubmits, deliberate: ledNow.deliberate.length };
    await saveFacts();
    console.log(JSON.stringify({ status: last.status, completed: last.completed, deltas: last.deltas, sizes: last.sizes, arrivalMilliseconds: last.arrivalMilliseconds, typedCode: last.typedCode, typedMessage: last.errorEnvelope?.message ?? null, temporaryState: last.temporaryState, retryUsed, fetchError: last.fetchError }));
    if (!last.completed) throw new Error('One live turn failed; the authorized budget for this attempt is spent');
  } finally {
    if (host) { const exit = once(host, 'exit'); host.stdin.end(); await exit; }
    await writeFile(factsPath, JSON.stringify(facts, null, 2)).catch(() => {});
    await writeFile(join(sandbox, 'live-backend-stderr.log'), Buffer.concat(stderrChunks)).catch(() => {});
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      const browserReads = ledger.deliberate.filter(item => item.route === 'browser-read-attempt').length;
      console.log(JSON.stringify({ liveLedger: ledger, ancillaryBrowserRequests: ledger.browserRequests - browserReads - ledger.conversationSubmits }));
    } catch { console.log('live ledger unavailable; request counts cannot be established'); }
  }
}
