import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
globalThis.fetch=()=>{throw Error('Network forbidden');};
const [entry,home]=process.argv.slice(2),native=await import(pathToFileURL(entry).href);
const thread=randomUUID(),turn=randomUUID(),other=randomUUID(),cwd=join(home,'workspace');
const dir=join(home,'sessions','2026','11','14');mkdirSync(dir,{recursive:true});mkdirSync(cwd);
const rollout=join(dir,`rollout-2026-11-14T11-16-41-${thread}.jsonl`);
const context={type:'turn_context',payload:{turn_id:turn,cwd,workspace_roots:[cwd],approval_policy:'never',
  permission_profile:{type:'disabled'},sandbox_policy:{type:'danger-full-access'}}};
const save=()=>writeFileSync(rollout,[{type:'session_meta',payload:{id:thread,source:'vscode'}},context].map(JSON.stringify).join('\n')+'\n');save();
const message=(id,text,kind)=>({type:'message',role:'user',id,content:[{type:'input_text',text}],
  internal_chat_message_metadata_passthrough:{turn_id:turn,content_item_kinds:[kind]}});
const environment=message('msg_'+randomUUID(),`<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`,'environments.environment_context');
const outputs=Array.from({length:70},(_,index)=>({type:'function_call_output',id:'fco_'+randomUUID(),name:'warehouse_'+index,
  namespace:'agent',output:`<external_context source="warehouse_${index}">\nExact data ${index}: ${randomUUID()} with literal \`code\`, newlines and \\slashes.\n</external_context>`,
  internal_chat_message_metadata_passthrough:{turn_id:turn,create_time:1794626203.7+index/1000}}));
const request={model:'gpt-5.6-sol',reasoning:{effort:'max'},input:[environment,...outputs,message('msg_'+randomUUID(),'Recall source records','user.text')],tools:[],
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:thread,turn_id:turn,request_kind:'turn',agent_name:'/root',sandbox_mode:'danger-full-access'})}};
const parsed=body=>{const value=native.parseRequest(body);value._chatgptModelFamily='6';return value;};
const resolve=body=>new native.Store(undefined,Date.now,home,home,[]).resolve(parsed(body));
const snapshot=structuredClone(request);
assert.equal(resolve(request).cwd,cwd);
assert.deepEqual(request,snapshot);
const parsedOutputs=parsed(request).context.messages.filter(item=>item.role==='toolResult');
assert.deepEqual(parsedOutputs.map(item=>[item.toolName,item.toolNamespace,item.content]),outputs.map(item=>[item.name,item.namespace,item.output]));
const realCall=parsed({...request,input:[{type:'function_call',id:'fc_real',call_id:'call_real',name:'read_file',arguments:'{}'},
 {...outputs[0],call_id:'call_real',name:'untrusted_override'}]}).context.messages.find(item=>item.role==='toolResult');
assert.equal(realCall.toolName,'read_file');
for(const mutate of [
  i=>{i.call_id='call_real';},i=>{i.call_id=null;},i=>{delete i.id;},i=>{i.id='msg_unowned';},
  i=>{i.namespace='functions';},i=>{delete i.name;},i=>{i.name='';},i=>{i.output={text:'not observed'};},
  i=>{delete i.internal_chat_message_metadata_passthrough.turn_id;},i=>{i.internal_chat_message_metadata_passthrough.turn_id=other;},
  i=>{i.internal_chat_message_metadata_passthrough.content_item_kinds=['user.text'];},
]){
  const invalid=structuredClone(request);mutate(invalid.input.at(-2));assert.throws(()=>resolve(invalid));
}
const forged=structuredClone(request);forged.input[0].content[0].text=forged.input[0].content[0].text.replaceAll(cwd,home);
assert.throws(()=>resolve(forged),/conflict/);
for(const missing of ['thread_id','turn_id']){
  const invalid=structuredClone(request),metadata=JSON.parse(invalid.client_metadata['x-codex-turn-metadata']);
  delete metadata[missing];invalid.client_metadata['x-codex-turn-metadata']=JSON.stringify(metadata);
  assert.throws(()=>resolve(invalid));
}
const missingMetadata=structuredClone(request);delete missingMetadata.client_metadata;assert.throws(()=>resolve(missingMetadata));
const changedTurn=structuredClone(request);const metadata=JSON.parse(changedTurn.client_metadata['x-codex-turn-metadata']);metadata.turn_id=other;
changedTurn.client_metadata['x-codex-turn-metadata']=JSON.stringify(metadata);assert.throws(()=>resolve(changedTurn));
context.payload.turn_id=other;save();assert.throws(()=>resolve(request));context.payload.turn_id=turn;save();
context.payload.sandbox_policy={type:'read-only',network_access:false};save();assert.throws(()=>resolve(request));
context.payload.sandbox_policy={type:'danger-full-access'};save();
unlinkSync(rollout);assert.throws(()=>resolve(request));save();
const cached=new native.Store(undefined,Date.now,home,home,[]);assert.equal(cached.resolve(parsed(request)).cwd,cwd);
unlinkSync(rollout);assert.throws(()=>cached.resolve(parsed(request)));
const noEnvelope=structuredClone(request);noEnvelope.input.shift();assert.throws(()=>cached.resolve(parsed(noEnvelope)));save();
const compiled=native.compile(parsed(request),{localToolsEnabled:false,solAvailable:true,proAvailable:true,extraHighAvailable:false,experimentalBiggerContext:false},undefined,
 {appName:'Offline additional context',experimentalBiggerContext:false,experimentalSkillAttachments:false,captureLunaCheckpoint:false});
const match=/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/.exec(compiled.text);assert.ok(match);
const envelope=JSON.parse(match[1]),strings=[];
assert.deepEqual(envelope.messages.filter(item=>item.role==='tool_result').map(item=>[item.tool_name,item.tool_namespace]),outputs.map(item=>[item.name,item.namespace]));
const visit=value=>{if(typeof value==='string')strings.push(value);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};visit(envelope);
assert.equal(outputs.filter(item=>strings.filter(text=>text===item.output).length===1).length,70);
assert.deepEqual(request,snapshot);
console.log('Current additional context verified; 70/70 outputs preserved');
