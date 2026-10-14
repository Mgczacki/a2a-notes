import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopDeliveries } from '../src/slack-desktop-delivery.ts';
import { nativeFunctions, NATIVE_FUNCTIONS, type DesktopPost, type DesktopReaction } from '../src/slack-desktop-native.ts';
import { TransportError } from '../src/transport.ts';
import { DesktopUnavailableError, SlackDesktopHook } from '../src/slack-desktop.ts';
import { slackText } from '../src/slack-format.ts';
import { encode } from '../src/protocol.ts';
import { fakeWorkspace, personService, person, agent, MARIO, ALEX, rid } from './helpers.ts';

const input = (): DesktopPost => {const id=randomUUID(),to=`slack:TEXAMPLE:${ALEX}`;return {team:'TEXAMPLE',owner:MARIO,to,channel:'DTEST',messageId:id,
  text:encode({id,from:`slack:TEXAMPLE:${MARIO}`,to,subject:'Native test',audience:'person',threadId:id,replyTo:null,body:'Test.',files:[],transportFiles:{}}),blocks:'[]'};};
function nativeFixture(mode = 'success') {
  const calls: any[] = []; let restored = false;
  const queue = {q(request: any) {
    calls.push({method:request.method,args:request.args,attempts:request._maxAttempts});
    if (mode === '429') return Promise.reject({status:429,retryAfter:180000,data:{error:'ratelimited',token:'private'}});
    if (mode === 'invalid') return Promise.reject({status:200,data:{error:'invalid_auth',token:'private'}});
    if (mode === 'policy') return Promise.reject({status:200,data:{error:6}});
    if (mode === 'lost') return Promise.reject({status:0,message:'private',args:request.args});
    if (mode === 'already') return Promise.reject({status:200,data:{error:'already_reacted',token:'private'}});
    if (request.method === 'conversations.history') return Promise.resolve({ok:true,token:'private',messages:[
      {user:ALEX,text:'A2A Reply/1 x',ts:'100.0002',client_msg_id:randomUUID(),reactions:[{name:'eyes',users:[MARIO,'private'],extra:'private'}],files:[{url_private:'private'}]},
      {user:ALEX,text:'No timestamp'}]});
    if (request.method === 'users.info') return Promise.resolve({ok:true,user:{id:request.args.user,name:'alex',real_name:'Alex',is_bot:request.args.user!==ALEX,profile:{title:'Engineer',email:'private'}}});
    if (request.method === 'conversations.open') return Promise.resolve({ok:true,channel:{id:'DALEX',is_im:true,user:request.args.users,last_read:'private'}});
    return Promise.resolve({ok:true,channel:request.args.channel,ts:'100.0001',message:{client_msg_id:request.args.client_msg_id},token:'private'});
  }};
  const original = queue.q;
  const api = Object.assign((request: any) => request,{meta:{name:'apiCall'}});
  const store = {dispatch(request: any) {
    const promise = queue.q({method:request.method,args:{...request.args,token:'private'},_maxAttempts:3,_numberOfAttempts:0,
      _xhr:{getResponseHeader:(name:string)=>name==='Retry-After'?'600':name==='x-slack-req-id'?'request-id':null}});
    promise.finally(()=>{restored = queue.q === original;}).catch(()=>{});return promise;
  }};
  const factories: Record<string, Function> = {IlU1:function apiFactory(){},'/+Um':function storeFactory(){},kPEx:function queueFactory(){}};
  const modules: Record<string, any> = {IlU1:{apiCall:api},'/+Um':{oK:()=>store},kPEx:{PS:()=>queue}};
  const req = Object.assign((id:string)=>modules[id],{m:factories});
  const pins = Object.fromEntries(Object.entries(factories).map(([key,value])=>[key,createHash('sha256').update(String(value)).digest('hex')]));
  const context = {crypto:webcrypto,TextEncoder,setTimeout,clearTimeout,AbortController,
    desktopDelegates:{TEXAMPLE:{getCurrentUserId:()=>MARIO}},rspackChunkGantryV2:{},[Symbol.for('a2anotes.desktop.runtime')]:req};
  // The inspected runtime already has this array after boot.
  context.rspackChunkGantryV2 = [];
  const functions = nativeFunctions(pins);
  return {calls,context,factories,functions,restored:()=>restored, invoke:(payload:DesktopPost|DesktopReaction,fn=functions.post)=>runInNewContext(`(${fn})(input)`,{...context,input:payload})};
}

const reaction=():DesktopReaction=>({team:'TEXAMPLE',owner:MARIO,channel:'DTEST',ts:'100.0001',name:'white_check_mark'});
test('native receipt uses only the saved message reference and one SDK attempt',async()=>{
  const f=nativeFixture(),p=reaction(),result=await f.invoke(p,f.functions.react);
  assert.equal(result.ok,true);assert.equal(result.channel,p.channel);assert.equal(result.ts,p.ts);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'reactions.add');assert.equal(f.calls[0].attempts,1);
  assert.equal(f.calls[0].args.timestamp,p.ts);assert.equal(f.calls[0].args.name,p.name);
  assert.ok(f.restored());assert.ok(!JSON.stringify(result).includes('private'));
});
test('native receipt treats an existing own reaction as success',async()=>{
  const f=nativeFixture('already'),result=await f.invoke(reaction(),f.functions.react);
  assert.equal(result.ok,true);assert.equal(f.calls.length,1);assert.ok(f.restored());
});
test('native receipt honors Retry-After without exposing request data',async()=>{
  const f=nativeFixture('429'),result=await f.invoke(reaction(),f.functions.react);
  assert.equal(result.status,429);assert.equal(result.retryAfter,600);assert.equal(result.definite,true);
  assert.equal(result.requestId,'request-id');assert.equal(f.calls[0].attempts,1);assert.ok(!JSON.stringify(result).includes('private'));
});
for(const mode of ['invalid','policy','lost'])test(`native receipt classifies ${mode} without another method`,async()=>{
  const f=nativeFixture(mode),result=await f.invoke(reaction(),f.functions.react);
  assert.equal(result.definite,mode!=='lost');assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'reactions.add');
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('native receipt rejects another account, changed SDK code, and invalid references',async()=>{
  for(const fields of [{owner:ALEX},{channel:'COTHER'},{ts:'invalid'},{name:'<@UOTHER>'}]){
    const f=nativeFixture();const result=await f.invoke({...reaction(),...fields},f.functions.react);
    assert.equal(result.definite,true);assert.equal(f.calls.length,0);
  }
  const f=nativeFixture();f.factories.IlU1=function changedFactory(){};
  assert.equal((await f.invoke(reaction(),f.functions.react)).definite,true);assert.equal(f.calls.length,0);
});

test('native sending keeps exact text, blocks, and message ID and disables SDK retries', async () => {
  const f=nativeFixture(), p=input(); const result=await f.invoke(p);
  assert.equal(result.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].attempts,1);
  assert.equal(f.calls[0].args.client_msg_id,p.messageId);assert.equal(f.calls[0].args.text,p.text);assert.equal(f.calls[0].args.blocks,p.blocks);
  assert.ok(f.restored());assert.ok(!JSON.stringify(result).includes('private'));
});
test('native 429 preserves the full Retry-After header and returns no token or request body', async () => {
  const f=nativeFixture('429'),result=await f.invoke(input());
  assert.equal(result.definite,true);assert.equal(result.status,429);assert.equal(result.retryAfter,600);
  assert.equal(result.requestId,'request-id');assert.equal(f.calls.length,1);assert.ok(f.restored());
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('native sending accepts the current Slack wrapper and rejects another message ID', async()=>{
  const f=nativeFixture(),p=input();p.text=slackText(p.text,{subject:'Check & confirm',body:'Please check.',audience:'person',senderName:'Mario',files:[]});
  assert.equal((await f.invoke(p)).ok,true);assert.equal(f.calls[0].args.text,p.text);
  const invalid=nativeFixture();assert.equal((await invalid.invoke({...p,messageId:randomUUID()})).definite,true);assert.equal(invalid.calls.length,0);
});
test('native invalid credentials stop and a lost response remains uncertain', async () => {
  const invalid=await nativeFixture('invalid').invoke(input());assert.equal(invalid.error,'invalid_auth');assert.equal(invalid.definite,true);
  const policy=await nativeFixture('policy').invoke(input());assert.equal(policy.error,'native_posting_denied');assert.equal(policy.definite,true);
  const lost=await nativeFixture('lost').invoke(input());assert.equal(lost.definite,false);assert.ok(!JSON.stringify(lost).includes('private'));
});
test('another account and changed native module code cannot send', async () => {
  const f=nativeFixture();await f.invoke({...input(),owner:ALEX});assert.equal(f.calls.length,0);
  f.factories.IlU1=function changedFactory(){};const result=await f.invoke(input());assert.equal(result.definite,true);assert.equal(f.calls.length,0);
  const real=await nativeFixture().invoke(input(),NATIVE_FUNCTIONS.post);assert.equal(real.definite,true);
});
test('saved native attempts prevent another post after restart and reject changed content', () => {
  const dir=mkdtempSync(join(tmpdir(),'desktop-send-record-')), p=input();const first=new DesktopDeliveries(dir);
  first.begin(p);const restarted=new DesktopDeliveries(dir);
  assert.throws(()=>restarted.begin(p),e=>e instanceof TransportError&&!e.definite);
  assert.throws(()=>restarted.begin({...p,text:p.text+' changed'}),/content changed/);
  assert.ok(!readFileSync(join(dir,'desktop-deliveries.json'),'utf8').includes(p.text));
  restarted.failed(p.messageId,true);assert.equal(restarted.begin(p),null);
  restarted.confirmed(p.messageId,p.channel,'100.0001');assert.deepEqual(new DesktopDeliveries(dir).begin(p),{channel:p.channel,ts:'100.0001'});
});
test('native receipts require the original sender, channel, ID, and content', () => {
  const dir=mkdtempSync(join(tmpdir(),'desktop-send-echo-')),p=input(),store=new DesktopDeliveries(dir);store.begin(p);
  const event={user:MARIO,channel:p.channel,ts:'100.0001',text:p.text,client_msg_id:p.messageId};
  store.echo(p.team,p.owner,{...event,user:ALEX});store.echo(p.team,p.owner,{...event,text:'ordinary text'});store.echo(p.team,p.owner,{...event,channel:'DOTHER'});
  assert.equal(store.receipt(p.team,p.owner,p.to,p.messageId),null);
  store.echo(p.team,p.owner,event);assert.equal(new DesktopDeliveries(dir).receipt(p.team,p.owner,p.to,p.messageId)?.ts,event.ts);
  assert.equal(store.receipt(p.team,ALEX,p.to,p.messageId),null);
  assert.throws(()=>store.confirmed(p.messageId,p.channel,'101.0001'),/two timestamps/);
  assert.throws(()=>new DesktopDeliveries(dir).receipt(p.team,p.owner,p.to,p.messageId),/two timestamps/);
});

test('the approved service uses native sending and keeps file shares across an uncertain restart', async t => {
  const fake=await fakeWorkspace();let owner=personService(fake,MARIO);t.after(async()=>{await owner.service.stop();await fake.close();});
  let calls=0;
  const native = {canSend:()=>true,post:async (payload:DesktopPost,before:()=>void)=>{
    before();calls++;const ts=fake.inject(MARIO,ALEX,payload.text);
    const channel=[...fake.channels.values()].find(c=>c.id===payload.channel)!;const msg=channel.messages.find(m=>m.ts===ts)!;msg.client_msg_id=payload.messageId;
    throw new TransportError('Native response lost.',false,0,'chat.postMessage');
  }};
  owner.transport.desktopSender=native;
  const support=owner.service.stageFile(agent,{kind:'support',name:'report.txt',text:'Approved file.',sha256:createHash('sha256').update('Approved file.').digest('hex'),request_id:rid()});
  const draft=await owner.service.createDraft(agent,{to_address:`slack:TEXAMPLE:${ALEX}`,subject:'Check',body:'Please check this note.',audience:'person',file_ids:[support.file_id],request_id:rid()});
  await assert.rejects(owner.service.send(agent,{id:draft.id,expected_hash:draft.hash,request_id:rid()}));assert.equal(calls,0);
  owner.service.approve(person,{id:draft.id,expected_hash:draft.hash,decision:'approve'});
  await assert.rejects(owner.service.send(person,{id:draft.id,expected_hash:draft.hash,request_id:rid()}));
  assert.equal(calls,1);assert.equal(fake.calls.get('chat.postMessage')||0,0);assert.equal(fake.calls.get('files.completeUploadExternal'),1);
  await owner.service.stop();owner=personService(fake,MARIO,owner.dir);owner.transport.desktopSender=native;
  owner.service.store.update(draft.id,n=>{n.delivery!.nextAttemptAt=new Date(0).toISOString();});await owner.service.processQueue();
  assert.equal(owner.service.get(person,draft.id).state,'sent');assert.equal(calls,1);assert.equal(fake.calls.get('files.completeUploadExternal'),1);
});
test('native 429 remains queued with its approval and never switches to the Web API', async t => {
  const fake=await fakeWorkspace(),owner=personService(fake,MARIO);t.after(async()=>{await owner.service.stop();await fake.close();});let calls=0;
  owner.transport.desktopSender={canSend:()=>true,post:async (_p,before)=>{before();calls++;throw new TransportError('Native rate limit.',true,120,'chat.postMessage',429);}};
  const d=await owner.service.createDraft(agent,{to_address:`slack:TEXAMPLE:${ALEX}`,subject:'Check',body:'Please check this note.',audience:'person',request_id:rid()});
  owner.service.approve(person,{id:d.id,expected_hash:d.hash,decision:'approve'});await owner.service.send(person,{id:d.id,expected_hash:d.hash,request_id:rid()});
  const stored=owner.service.store.note(d.id)!;assert.equal(stored.state,'queued');assert.ok(stored.approval);assert.equal(stored.checkpoint!.postStarted,false);
  assert.ok(Date.parse(stored.delivery!.nextAttemptAt!)>=Date.now()+115000);assert.equal(calls,1);assert.equal(fake.calls.get('chat.postMessage')||0,0);
  await assert.rejects(owner.service.reviseDraft(agent,{id:d.id,expected_hash:d.hash,body:'A changed note.'}));
  owner.service.store.update(d.id,n=>{n.body='A changed note.';n.delivery!.nextAttemptAt=new Date(0).toISOString();});
  await owner.service.processQueue();assert.equal(calls,1);
});
test('native unavailability before posting permits the existing Web API path', async t => {
  const fake=await fakeWorkspace(),owner=personService(fake,MARIO);t.after(async()=>{await owner.service.stop();await fake.close();});
  owner.transport.desktopSender={canSend:()=>true,post:async()=>{throw new DesktopUnavailableError();}};
  const d=await owner.service.createDraft(agent,{to_address:`slack:TEXAMPLE:${ALEX}`,subject:'Check',body:'Please check this note.',audience:'person',request_id:rid()});
  owner.service.approve(person,{id:d.id,expected_hash:d.hash,decision:'approve'});await owner.service.send(person,{id:d.id,expected_hash:d.hash,request_id:rid()});
  assert.equal(owner.service.get(person,d.id).state,'sent');assert.equal(fake.calls.get('chat.postMessage'),1);
});

async function wait(check:()=>boolean) {
  const end=Date.now()+5000;while(!check()){if(Date.now()>end)assert.fail('Native fixture timed out.');await new Promise(r=>setTimeout(r,20));}
}
async function nativeCDP(t:any,onPost:(p:DesktopPost,client:WebSocket)=>Promise<any>,onReact?:(p:DesktopReaction)=>Promise<any>) {
  let port=0;const clients=new Set<WebSocket>(),posts:DesktopPost[]=[],reactions:DesktopReaction[]=[];
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{id:'native-page',type:'page',url:'https://app.slack.com/client/TEXAMPLE/DTEST',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/native-page`}]));});
  const ws=new WebSocketServer({server});ws.on('connection',client=>{
    clients.add(client);client.on('close',()=>clients.delete(client));
    client.on('message',async raw=>{
      const m=JSON.parse(String(raw));
      if(m.method==='Network.enable')client.send(JSON.stringify({method:'Network.webSocketCreated',params:{requestId:'slack-socket',url:'wss://wss-primary.slack.com/connection'}}));
      if(m.method==='Runtime.evaluate')client.send(JSON.stringify({id:m.id,result:{result:m.params.expression==='globalThis'?{objectId:'global-object'}:{value:{team:'TEXAMPLE',user:MARIO}}}}));
      if(m.method==='Runtime.callFunctionOn') {
        let value;
        if(m.params.functionDeclaration===NATIVE_FUNCTIONS.capability)value={ready:true};
        else if(m.params.functionDeclaration===NATIVE_FUNCTIONS.react){assert.ok(onReact);const p=m.params.arguments[0].value;reactions.push(p);value=await onReact(p);}
        else {assert.equal(m.params.functionDeclaration,NATIVE_FUNCTIONS.post);const p=m.params.arguments[0].value;posts.push(p);value=await onPost(p,client);}
        if(value&&client.readyState===1)client.send(JSON.stringify({id:m.id,result:{result:{value}}}));
      }
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as any).port;
  t.after(async()=>{for(const c of clients)c.terminate();await new Promise<void>(r=>ws.close(()=>server.close(()=>r())));});
  return {url:`http://127.0.0.1:${port}`,posts,reactions,clients};
}

test('native reaction limits survive restart and do not block message posting',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-reaction-429-'));
  const remote=await nativeCDP(t,async p=>({ok:true,channel:p.channel,ts:'100.0002'}),async()=>({error:'ratelimited',definite:true,status:429,retryAfter:60}));
  let owner=MARIO;
  const options={dir,config:{url:remote.url,send:true},identity:()=>({transport:'slack',address:`slack:TEXAMPLE:${owner}`,name:'Mario',scopes:[],missingScopes:[],optionalMissing:[]}),
    verifyEndpoint:async()=>{},verifyChannel:async()=>false,receive:async()=>{}};
  let hook=new SlackDesktopHook(options);t.after(()=>hook.close());hook.start();await wait(()=>hook.canSend());
  await assert.rejects(hook.react(reaction()),e=>e instanceof TransportError&&e.method==='reactions.add'&&e.status===429&&e.retryAfter===60);
  assert.equal(remote.reactions.length,1);
  assert.equal((await hook.post(input(),()=>{})).ts,'100.0002');assert.equal(remote.posts.length,1);
  await hook.close();hook=new SlackDesktopHook(options);hook.start();await wait(()=>hook.canSend());
  await assert.rejects(hook.react(reaction()),e=>e instanceof TransportError&&e.method==='reactions.add'&&e.status===0&&e.retryAfter>0);
  assert.equal(remote.reactions.length,1);
  owner=ALEX;await assert.rejects(hook.react(reaction()),/account is invalid/);assert.equal(remote.reactions.length,1);
});

test('a cleared renderer context reconnects and verifies native capability before another post',async t=>{
  const remote=await nativeCDP(t,async p=>({ok:true,channel:p.channel,ts:'100.0002'}));
  let verified=0;
  const hook=new SlackDesktopHook({dir:mkdtempSync(join(tmpdir(),'native-context-')),config:{url:remote.url,send:true},
    identity:()=>({transport:'slack',address:`slack:TEXAMPLE:${MARIO}`,name:'Mario',scopes:[],missingScopes:[],optionalMissing:[]}),
    verifyEndpoint:async()=>{verified++;},verifyChannel:async()=>false,receive:async()=>{}});
  t.after(()=>hook.close());hook.start();await wait(()=>hook.canSend());
  const old=[...remote.clients][0];old.send(JSON.stringify({method:'Runtime.executionContextsCleared'}));
  await wait(()=>!hook.canSend());await wait(()=>hook.canSend());assert.ok(verified>=3);
  assert.equal((await hook.post(input(),()=>{})).ts,'100.0002');assert.equal(remote.posts.length,1);
});

test('the CDP send records 429 and its workspace wait across restart before another native call', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-cdp-429-'));let mode='429';
  const remote=await nativeCDP(t,async p=>mode==='429'?{error:'ratelimited',definite:true,status:429,retryAfter:60}:{ok:true,channel:p.channel,ts:'100.0001'});
  const options={config:{url:remote.url,send:true},dir,identity:()=>({transport:'slack',address:`slack:TEXAMPLE:${MARIO}`,name:'Mario',scopes:[],missingScopes:[],optionalMissing:[]}),
    verifyEndpoint:async()=>{},verifyChannel:async()=>false,receive:async()=>{}};
  let hook=new SlackDesktopHook(options);t.after(()=>hook.close());hook.start();await wait(()=>hook.canSend());const p=input();
  await assert.rejects(hook.post(p,()=>{throw new Error('Approval changed.');}),/Approval changed/);assert.equal(remote.posts.length,0);
  await assert.rejects(hook.post({...p,to:`slack:TEXAMPLE:${MARIO}`},()=>{}),/does not match/);assert.equal(remote.posts.length,0);
  await assert.rejects(hook.post(p,()=>{}),e=>e instanceof TransportError&&e.status===429&&e.retryAfter===60);assert.equal(remote.posts.length,1);
  await hook.close();hook=new SlackDesktopHook(options);hook.start();await wait(()=>hook.canSend());
  await assert.rejects(hook.post(p,()=>{}),e=>e instanceof TransportError&&e.status===0&&e.retryAfter>0);assert.equal(remote.posts.length,1);
  await hook.close();writeFileSync(join(dir,'desktop-limits.json'),'{}');mode='success';hook=new SlackDesktopHook(options);hook.start();await wait(()=>hook.canSend());
  assert.equal((await hook.post(p,()=>{})).ts,'100.0001');assert.equal(remote.posts.length,2);
  assert.equal((await hook.post(p,()=>{})).ts,'100.0001');assert.equal(remote.posts.length,2);
});

test('a native echo confirms an uncertain CDP send after restart without another post or history call', async t=>{
  const fake=await fakeWorkspace();let owner=personService(fake,MARIO);
  const remote=await nativeCDP(t,async(p,client)=>{
    const ts=fake.inject(MARIO,ALEX,p.text);const channel=[...fake.channels.values()].find(c=>c.id===p.channel)!;channel.messages.find(m=>m.ts===ts)!.client_msg_id=p.messageId;
    await new Promise<void>(r=>client.send(JSON.stringify({method:'Network.webSocketFrameReceived',params:{requestId:'slack-socket',response:{opcode:1,payloadData:JSON.stringify({type:'message',channel:p.channel,user:MARIO,text:p.text,ts,client_msg_id:p.messageId})}}}),()=>r()));
    client.close();return null;
  });
  let hook=new SlackDesktopHook({config:{url:remote.url,send:true},dir:owner.dir,identity:()=>owner.transport.identity(),verifyEndpoint:async()=>{},
    verifyChannel:c=>owner.transport.verifyDesktopChannel(c),receive:m=>owner.service.receive(m)});
  t.after(async()=>{await hook.close();await owner.service.stop();await fake.close();});hook.start();await wait(()=>hook.canSend());owner.transport.desktopSender=hook;
  const d=await owner.service.createDraft(agent,{to_address:`slack:TEXAMPLE:${ALEX}`,subject:'Check',body:'Please check this note.',audience:'person',request_id:rid()});
  owner.service.approve(person,{id:d.id,expected_hash:d.hash,decision:'approve'});await assert.rejects(owner.service.send(person,{id:d.id,expected_hash:d.hash,request_id:rid()}));
  await hook.close();await owner.service.stop();owner=personService(fake,MARIO,owner.dir);
  owner.service.store.update(d.id,n=>{n.delivery!.nextAttemptAt=new Date(0).toISOString();});await owner.service.processQueue();
  assert.equal(owner.service.get(person,d.id).state,'sent');assert.equal(remote.posts.length,1);assert.equal(fake.calls.get('chat.postMessage')||0,0);
  assert.equal(fake.calls.get('conversations.history')||0,0);assert.equal(owner.service.list(person,{direction:'incoming'}).messages.length,0);
});

const read=(method:string,args:Record<string,unknown>)=>({team:'TEXAMPLE',owner:MARIO,method,args});
test('native reads copy only known record fields and use no window controls',async()=>{
  const f=nativeFixture();
  const call=async(method:string,args:Record<string,unknown>)=>JSON.parse(JSON.stringify(await f.invoke(read(method,args) as any,f.functions.read)));
  const history=await call('conversations.history',{channel:'DTEST',limit:50});
  assert.equal(history.ok,true);assert.equal(history.data.messages.length,1);
  assert.deepEqual(history.data.messages[0].reactions,[{name:'eyes',users:[MARIO]}]);
  assert.ok(!JSON.stringify(history).includes('private'));
  const member=await call('users.info',{user:ALEX});
  assert.deepEqual(member.data.user,{id:ALEX,name:'Alex',realName:'Alex',title:'Engineer',active:true});
  assert.equal((await call('users.info',{user:'UBOT'})).data.user.active,false);
  const open=await call('conversations.open',{users:ALEX,return_im:true});
  assert.deepEqual(open.data.channel,{id:'DALEX',is_im:true,user:ALEX});
  assert.deepEqual(f.calls.map(c=>c.method),['conversations.history','users.info','users.info','conversations.open']);
});
test('native reads refuse write methods, extra arguments, and other conversation types',async()=>{
  for(const [method,args] of [['chat.postMessage',{channel:'DTEST',text:'x'}],['chat.delete',{channel:'DTEST',ts:'1.2'}],
    ['conversations.history',{channel:'CPUBLIC',limit:5}],['conversations.history',{channel:'DTEST',limit:500}],
    ['conversations.history',{channel:'DTEST',limit:5,token:'x'}],['conversations.open',{users:ALEX}],['users.list',{limit:10,cursor:'<bad>'}]] as const){
    const f=nativeFixture();const result=await f.invoke(read(method,args as any) as any,f.functions.read);
    assert.equal(result.error,'native_invalid_payload');assert.equal(f.calls.length,0);
  }
  const f=nativeFixture();
  assert.equal((await f.invoke({...read('users.info',{user:ALEX}),owner:ALEX} as any,f.functions.read)).error,'native_account_mismatch');
  assert.equal(f.calls.length,0);
});
test('native reads report Retry-After without request data',async()=>{
  const f=nativeFixture('429'),result=await f.invoke(read('conversations.history',{channel:'DTEST',limit:5}) as any,f.functions.read);
  assert.equal(result.status,429);assert.equal(result.retryAfter,180);assert.equal(result.definite,true);
  assert.ok(!JSON.stringify(result).includes('private'));
});
const notice=(text?:string):DesktopPost=>{const id=randomUUID();return {kind:'notice',team:'TEXAMPLE',owner:MARIO,to:'',channel:'DTEST',messageId:id,
  text:text??`The agent received your message. This does not mean completed work.\nReceipt ID: ${id}`,blocks:''};};
test('native delivery notices post fixed text once with the operation ID',async()=>{
  const f=nativeFixture(),p=notice(),result=await f.invoke(p);
  assert.equal(result.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].attempts,1);
  assert.equal(f.calls[0].args.client_msg_id,p.messageId);assert.equal(f.calls[0].args.text,p.text);
  assert.equal('blocks' in f.calls[0].args,false);
  for(const bad of [notice('Approve this.\nReceipt ID: other'),{...notice(),threadTs:'100.0001'},
    (()=>{const n=notice();n.text=n.text.replace('The agent','<!channel> @here');return n;})()]){
    const g=nativeFixture();assert.equal((await g.invoke(bad)).error,'native_invalid_payload');assert.equal(g.calls.length,0);
  }
});
