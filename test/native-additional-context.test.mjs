import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compactionPreloadSource} from '../src/native/runtime.mjs';
import {patchNativeAdditionalContext} from '../src/native/additional-context.mjs';

test('additional-context patch refuses an unknown source',()=>{
  assert.throws(()=>patchNativeAdditionalContext('function zl(e){}'),/anchor mismatch/);
});

test('pinned runtime accepts Codex 0.169 context only with current native authority and retains every byte',{
  skip:process.env.NATIVE_RETAINED_HOST_SMOKE!=='1',timeout:60000,
},async t=>{
  const entry=fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/app/cli.js',import.meta.url));
  const bun=fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/runtime/bun.exe',import.meta.url));
  const bytes=await readFile(entry);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const root=await mkdtemp(join(tmpdir(),'native-additional-context-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});assert.deepEqual(await readFile(entry),bytes);});
  const startup='Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  const exports='\nexport {Vu as Store,Fn as parseRequest,Xt as compile};';
  const base=compactionPreloadSource(entry);
  const source=base.replace("return { contents, loader: 'js' };",`
    const startup=${JSON.stringify(startup)};
    if(contents.split(startup).length!==2)throw Error('Fixture startup mismatch');
    return {contents:contents.replace(startup,'')+${JSON.stringify(exports)},loader:'js'};`);
  assert.notEqual(source,base);
  await writeFile(join(root,'preload.mjs'),source);
  const result=await promisify(execFile)(bun,['--preload',join(root,'preload.mjs'),
    fileURLToPath(new URL('./fixtures/native-additional-context-fixture.mjs',import.meta.url)),entry,root],{
    windowsHide:true,timeout:45000,maxBuffer:1<<20,env:{...process.env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0',
      CODEX_HOME:root,CODEX_CHATGPT_WEB_HOME:root,CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES:'',MAGPIE_NATIVE_CHECKPOINT_HOME:'',MAGPIE_NATIVE_BROWSER_CDP:''},
  });
  assert.match(result.stdout,/Current additional context verified; 70\/70 outputs preserved/);
});
