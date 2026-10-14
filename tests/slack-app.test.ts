import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SlackTransport} from '../src/slack.ts';
import {type AppConnection, type AppSnapshot} from '../src/slack-app.ts';
import {NotesService} from '../src/service.ts';
import {Store} from '../src/store.ts';
import {person, agent, reviewer} from './helpers.ts';
import {DesktopDeliveries} from '../src/slack-desktop-delivery.ts';
import {DesktopUnavailableError} from '../src/slack-desktop.ts';
import {TransportError} from '../src/transport.ts';
import {randomUUID} from 'node:crypto';
import {sha256} from '../src/protocol.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp.ts';

function fixture(options: {waitTimeoutMs?: number} = {}) {
  const s: AppSnapshot = {team:'TEXAMPLE', user:'UMARIO01', channel:'DOTHER01', peers:[{id:'DOTHER01',user:'UALEX01'},{id:'DSELF01',user:'UMARIO01'}],
    people:[{id:'UMARIO01',name:'Mario',realName:'Mario',title:'',active:true},{id:'UALEX01',name:'Alex',realName:'Alex',title:'',active:true}], messages:[]};
  // calls records Slack writes. Conversation selection is internal and is not a Slack window action.
  const calls: string[] = [];
  const app: AppConnection = {
    async snapshot() {return structuredClone(s);},
    async navigate(id) {const peer = s.peers.find(p => p.id === id || p.user === id); if (!peer) throw new TransportError('Slack Desktop: user_not_found',true); s.channel = peer.id;},
    async message() {}, async load() {}, async directory() {return structuredClone(s.people);}, async close() {},
  };
  const file = join(mkdtempSync(join(tmpdir(),'app-transport-')), 'account.json');
  const transport = new SlackTransport(file,{teamId:s.team},undefined,{open:async () => app,...options});
  let sequence = 0;
  const next = () => `1791935000.${String(++sequence).padStart(3,'0')}`;
  transport.desktopSender = {canSend:()=>true, canRead:()=>true,
    post:async (input,before) => {before(); calls.push('post'); const ts=next(); s.messages.push({channel:input.channel,user:s.user,text:input.text,ts,client_msg_id:input.messageId,reactions:[]}); return {channel:input.channel,ts};},
    react:async input => {calls.push('react:'+input.ts); s.messages.find(m => m.ts === input.ts)!.reactions.push({name:input.name,users:[s.user]});},
    notice:async input => {calls.push('notice'); const ts=next(); s.messages.push({channel:input.channel,user:s.user,text:input.text,ts,client_msg_id:input.operationId,reactions:[]}); return {channel:input.channel,ts};}};
  return {s,app,calls,file,transport};
}
const message = {channel:'DOTHER01', user:'UALEX01',text:'A2A #7\nPlease read this.',ts:'1791934900.001',reactions:[]};

async function stoppedNote(t: any, withFile = false) {
  const f = fixture({waitTimeoutMs:5}); await f.transport.connect();
  const service = new NotesService({store:new Store(join(f.file,'..')),transport:f.transport,scanIntervalMs:0,retryIntervalMs:0});
  t.after(() => service.stop());
  const file = withFile ? service.stageFile(person,{name:'plan.txt',text:'Approved attachment',sha256:sha256(Buffer.from('Approved attachment')),request_id:randomUUID()}) : undefined;
  const d = await service.createDraft(person,{to_address:'slack:TEXAMPLE:UALEX01',subject:'Read the plan',body:'Please read the plan.',audience:'person',
    ...(file ? {file_ids:[file.file_id]} : {}),request_id:randomUUID()});
  service.approve(person,{id:d.id,expected_hash:d.hash,decision:'approve'});
  const sender = f.transport.desktopSender!;
  f.transport.desktopSender = {...sender, canSend:()=>false};
  await assert.rejects(service.send(person,{id:d.id,expected_hash:d.hash,request_id:randomUUID()}),/No post was started/);
  f.transport.desktopSender = sender;
  assert.equal(service.store.note(d.id)!.state,'permanent_failure');
  assert.equal(service.store.note(d.id)!.checkpoint?.postStarted,undefined);
  return {...f,service,d,attachment:file};
}

test('an approved pre-post failure retries once after restart with the same note and approval', async t => {
  const f = await stoppedNote(t), request_id = randomUUID();
  const before = structuredClone(f.service.store.note(f.d.id)!);
  const queued = await f.service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id});
  assert.equal(queued.state,'queued'); assert.equal(queued.message_id,f.d.message_id);
  assert.deepEqual(f.service.store.note(f.d.id)!.checkpoint,before.checkpoint);
  assert.deepEqual(f.service.store.note(f.d.id)!.approval,before.approval);
  assert.equal(f.service.store.note(f.d.id)!.delivery!.attempts,1);
  await f.service.stop();
  const transport = new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>f.app});
  await transport.connect(); let posts=0;
  transport.desktopSender={canSend:()=>true,post:async(input,dispatch)=>{dispatch();posts++;assert.equal(input.messageId,f.d.message_id);
    assert.match(input.text,/Please read the plan/);return {channel:input.channel,ts:'1791935000.020'};}};
  const service = new NotesService({store:new Store(join(f.file,'..')),transport,scanIntervalMs:0,retryIntervalMs:0});
  t.after(()=>service.stop());
  await service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id});
  await service.processQueue();
  await service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id});
  await service.processQueue();
  const n=service.store.note(f.d.id)!;
  assert.equal(n.state,'sent'); assert.equal(posts,1); assert.equal(n.delivery!.attempts,2);
  assert.equal(n.hash,before.hash);assert.equal(n.to,before.to);assert.equal(n.from,before.from);assert.equal(n.audience,before.audience);
  assert.deepEqual(n.approval,before.approval);
  assert.equal(service.store.read().audit.filter(a=>a.id===n.id&&a.action==='approve').length,1);
  assert.ok(!f.calls.includes('compose'));assert.ok(!f.calls.includes('submit'));
});

test('retry requests serialize while saved native attempts are checked', async t => {
  const f = await stoppedNote(t), verify = f.transport.verifyRetry.bind(f.transport);
  let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
  f.transport.verifyRetry=async(...args)=>{await gate;await verify(...args);};
  const input={id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()};
  const first=f.service.retrySend(person,input);
  await assert.rejects(f.service.retrySend(person,input),(e:any)=>e.code==='send_in_progress');
  release();await first;
  await f.service.retrySend(person,input);
  assert.equal(f.service.store.read().audit.filter(a=>a.id===f.d.id&&a.action==='send_retry_queued').length,1);
});

test('a lost response after an approved retry recovers its receipt after restart without another post',async t=>{
  const f=await stoppedNote(t);let posts=0;
  const deliveries=new DesktopDeliveries(join(f.file,'..'));
  f.transport.desktopSender={canSend:()=>true,post:async(input,before)=>{
    before();posts++;deliveries.begin(input);deliveries.confirmed(input.messageId,input.channel,'1791935000.023');
    throw new TransportError('Lost native response',false);
  }};
  const input={id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()};
  await f.service.retrySend(person,input);await f.service.processQueue();
  assert.equal(f.service.store.note(f.d.id)!.state,'delivery_uncertain');
  await assert.rejects(f.service.retrySend(person,{...input,request_id:randomUUID()}),(e:any)=>e.code==='retry_not_permitted');
  await f.service.stop();
  const transport=new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>f.app});await transport.connect();
  const service=new NotesService({store:new Store(join(f.file,'..')),transport,now:()=>Date.now()+100_000,scanIntervalMs:0,retryIntervalMs:0});
  t.after(()=>service.stop());await service.processQueue();
  const n=service.store.note(f.d.id)!;
  assert.equal(n.state,'sent');assert.equal(n.transport!.ts,'1791935000.023');assert.equal(posts,1);
  assert.deepEqual(n.transport!.files,{});
  assert.ok(!f.calls.includes('submit'));
});

for (const change of ['agent','hash','content','policy','credentials','started','uncertain','exhausted','invalid_auth','file_progress'] as const) {
  test(`pre-post retry refuses ${change}`,async t=>{
    const f=await stoppedNote(t);
    if(change==='content')f.service.store.update(f.d.id,n=>{n.body='Changed content';});
    if(change==='policy')f.service.store.change(d=>{d.policy.version++;});
    if(change==='credentials')f.transport.identity=()=>null;
    if(change==='started')f.service.store.update(f.d.id,n=>{n.checkpoint!.postStarted=true;});
    if(change==='uncertain')f.service.store.update(f.d.id,n=>{n.delivery!.uncertain=true;});
    if(change==='exhausted')f.service.store.update(f.d.id,n=>{n.delivery!.attempts=8;});
    if(change==='invalid_auth')f.service.store.update(f.d.id,n=>{n.error='Slack Desktop: invalid_auth';n.delivery!.failureCode='transport_error';});
    if(change==='file_progress')f.service.store.update(f.d.id,n=>{n.checkpoint!.uploads.old={fileId:'FOLD01',url:'slack-app:inline',phase:'complete'};});
    await assert.rejects(f.service.retrySend(change==='agent'?agent:person,{id:f.d.id,expected_hash:change==='hash'?'old':f.d.hash,request_id:randomUUID()}));
    assert.equal(f.service.store.note(f.d.id)!.state,'permanent_failure');
    assert.ok(!f.calls.includes('submit'));
  });
}

test('retry reads file bytes and checks policy again after the transport check',async t=>{
  const f=await stoppedNote(t,true);
  const path=f.service.store.filePath(f.attachment!.file_id);
  writeFileSync(path,'Altered attachment');
  await assert.rejects(f.service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()}));
  writeFileSync(path,'Approved attachment');
  const verify=f.transport.verifyRetry.bind(f.transport);
  f.transport.verifyRetry=async(...args)=>{await verify(...args);f.service.store.change(d=>{d.policy.version++;});};
  await assert.rejects(f.service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()}),(e:any)=>e.code==='approval_invalid');
  assert.equal(f.service.store.note(f.d.id)!.state,'permanent_failure');
});

for (const state of ['started','receipt','identity'] as const) {
  test(`retry refuses a saved native ${state} record`,async t=>{
    const f=await stoppedNote(t), deliveries=new DesktopDeliveries(join(f.file,'..'));
    const input={team:f.s.team,owner:state==='identity'?'UEVE01':f.s.user,to:f.d.to,channel:'DOTHER01',messageId:f.d.message_id,
      text:'Saved content',blocks:'[]'};
    deliveries.begin(input);
    if(state==='receipt')deliveries.confirmed(input.messageId,input.channel,'1791935000.021');
    if(state==='identity')deliveries.failed(input.messageId,true);
    await assert.rejects(f.service.retrySend(person,{id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()}),/saved native attempt/);
    assert.equal(f.service.store.note(f.d.id)!.state,'permanent_failure');
  });
}

test('a reviewer can retry under a current human approval but request IDs cannot name another operation',async t=>{
  const f=await stoppedNote(t),request_id=randomUUID();
  f.service.store.change(d=>{d.requests[request_id]={tool:'send',id:f.d.id,at:new Date().toISOString()};});
  await assert.rejects(f.service.retrySend(reviewer,{id:f.d.id,expected_hash:f.d.hash,request_id}),(e:any)=>e.code==='request_conflict');
  assert.equal((await f.service.retrySend(reviewer,{id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()})).state,'queued');
});

test('a send waits for native readiness and keeps the Slack window conversation',async()=>{
  const f=fixture();await f.transport.connect();f.s.channel='DSELF01';let polls=0,posts=0;
  f.transport.desktopSender={canSend:()=>++polls>=3,post:async(input,before)=>{before();posts++;return {channel:input.channel,ts:'1791935000.022'};}};
  await f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),files:[],wire:()=> 'A2ANotes/1',display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]}});
  assert.equal(posts,1);assert.deepEqual(f.calls,[]);
});

test('a selected native sender that stays unavailable stops before composing or posting',async()=>{
  const f=fixture({waitTimeoutMs:5});await f.transport.connect();let checkpoint:any;
  f.transport.desktopSender={canSend:()=>false,post:async()=>{throw new Error('Must not post');}};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),files:[],wire:()=> 'A2ANotes/1',display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]},
    saveCheckpoint:c=>{checkpoint=structuredClone(c);}}),(e:any)=>e.failureCode==='app_control_unavailable');
  assert.equal(checkpoint.postStarted,undefined);assert.deepEqual(f.calls,[]);
});

test('native readiness lost after the wait cannot select composer posting',async()=>{
  const f=fixture();await f.transport.connect();let checks=0;
  f.transport.desktopSender={canSend:()=>++checks===1,post:async()=>{throw new Error('Must not post');}};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),files:[],wire:()=> 'A2ANotes/1',display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]}}),
    (e:any)=>e.failureCode==='app_control_unavailable');
  assert.deepEqual(f.calls,[]);
});

test('the MCP retry tool preserves approval and enforces the caller role',async t=>{
  const f=await stoppedNote(t);
  const input={id:f.d.id,expected_hash:f.d.hash,request_id:randomUUID()};
  for(const session of [agent,reviewer]){
    const server=createMcpServer(f.service,session),client=new Client({name:'retry-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    try{
      const result=await client.callTool({name:'a2anotes_retry_send',arguments:input});
      if(session===agent){assert.equal(result.isError,true);assert.equal((result.structuredContent as any).error.code,'forbidden');}
      else {assert.equal(result.isError,undefined);assert.equal((result.structuredContent as any).state,'queued');}
    }finally{await client.close();await server.close();}
  }
  assert.equal(f.service.store.read().audit.filter(a=>a.id===f.d.id&&a.action==='approve').length,1);
});

test('native app posting queues a 429 under the same approval without using composer controls', async () => {
  const f=fixture(); await f.transport.connect(); let now=Date.now(), posts=0;
  const service=new NotesService({store:new Store(join(f.file,'..')),transport:f.transport,now:()=>now,random:()=>0.5,scanIntervalMs:0,retryIntervalMs:0});
  f.transport.desktopSender={canSend:()=>true,post:async (input,before)=>{
    before(); posts++;
    if(posts===1) throw new TransportError('Slack Desktop: ratelimited',true,10,'chat.postMessage',429);
    return {channel:input.channel,ts:'1791935000.009'};
  }};
  try {
    const draft=await service.createDraft(person,{to_address:'slack:TEXAMPLE:UALEX01',subject:'Read the plan',body:'Please read the plan.',audience:'person',request_id:randomUUID()});
    service.approve(person,{id:draft.id,expected_hash:draft.hash,decision:'approve'});
    const approved=service.store.note(draft.id)!.approval;
    await service.send(person,{id:draft.id,expected_hash:draft.hash,request_id:randomUUID()});
    const queued=service.store.note(draft.id)!;
    assert.equal(queued.state,'queued'); assert.equal(queued.checkpoint?.postStarted,false);
    assert.ok(Date.parse(queued.delivery!.nextAttemptAt!)>=now+10_000);
    assert.deepEqual(queued.approval,approved);
    now=Date.parse(queued.delivery!.nextAttemptAt!)+1;await service.processQueue();
    assert.equal(service.store.note(draft.id)!.state,'sent');assert.equal(posts,2);
    assert.deepEqual(service.store.note(draft.id)!.approval,approved);
    assert.ok(!f.calls.includes('compose'));assert.ok(!f.calls.includes('submit'));
  } finally {await service.stop();}
});

test('native app receipt survives restart without another post or navigation', async () => {
  const f=fixture();await f.transport.connect(); const id=randomUUID();let checkpoint:any,posts=0;
  const deliveries=new DesktopDeliveries(join(f.file,'..'));
  f.transport.desktopSender={canSend:()=>true,post:async (input,before)=>{
    before();posts++;deliveries.begin(input);deliveries.confirmed(input.messageId,input.channel,'1791935000.010');
    throw new TransportError('Lost response',false);
  }};
  const input={to:'slack:TEXAMPLE:UALEX01',messageId:id,display:{subject:'Read the note',body:'Please read.',audience:'person' as const,senderName:'Mario',files:[]},
    files:[],wire:()=>`A2ANotes/1\nID: ${id}\nBody: Please read.`,saveCheckpoint:(c:any)=>{checkpoint=structuredClone(c);}};
  await assert.rejects(f.transport.send(input),/Lost response/);
  assert.equal(checkpoint.postStarted,true);assert.deepEqual(checkpoint.uploads,{});
  const restarted=new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>f.app});
  f.calls.length=0;
  assert.equal((await restarted.findSent(input.to,id))?.ts,'1791935000.010');
  assert.equal(posts,1);assert.deepEqual(f.calls,[]);
  f.s.user='UEVE01';await assert.rejects(restarted.findSent(input.to,id),/differs/);
});

test('native unavailability or a disabled sender stops before posting without window controls', async () => {
  const f=fixture();await f.transport.connect();
  const input={to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),display:{subject:'Plan',body:'Please read.',audience:'person' as const,senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: test'};
  f.transport.desktopSender={canSend:()=>true,post:async()=>{throw new TransportError('invalid_auth',true);}};
  await assert.rejects(f.transport.send(input),/invalid_auth/);
  let checkpoint:any;
  f.transport.desktopSender={canSend:()=>true,post:async()=>{throw new DesktopUnavailableError();}};
  await assert.rejects(f.transport.send({...input,saveCheckpoint:c=>{checkpoint=structuredClone(c);}}),(e:any)=>e.failureCode==='app_control_unavailable'&&e.definite);
  assert.equal(checkpoint.postStarted,undefined);assert.equal(checkpoint.channel,'DOTHER01');
  f.transport.desktopSender={canSend:()=>true,status:()=>({sendEnabled:false} as any),post:async()=>{throw new Error('Must not post');}};
  await assert.rejects(f.transport.send(input),/sending is turned off/);
  f.transport.desktopSender=undefined;
  await assert.rejects(f.transport.send(input),/sending is turned off/);
  assert.deepEqual(f.calls,[]);
});

test('a lost read before posting returns the note to the queue',async t=>{
  const f=fixture();await f.transport.connect();
  const service=new NotesService({store:new Store(join(f.file,'..')),transport:f.transport,scanIntervalMs:0,retryIntervalMs:0});
  t.after(()=>service.stop());
  const draft=await service.createDraft(person,{to_address:'slack:TEXAMPLE:UALEX01',subject:'Read the plan',body:'Please read the plan.',audience:'person',request_id:randomUUID()});
  service.approve(person,{id:draft.id,expected_hash:draft.hash,decision:'approve'});
  const navigate=f.app.navigate;
  f.app.navigate=async()=>{throw new TransportError('Slack did not return the conversation records.',false,0,'conversations.history');};
  await assert.rejects(service.send(person,{id:draft.id,expected_hash:draft.hash,request_id:randomUUID()}));
  assert.equal(service.store.note(draft.id)!.state,'queued');assert.equal(service.store.note(draft.id)!.delivery!.uncertain,false);
  f.app.navigate=navigate;
});

test('API upload progress cannot become a second attachment through the app adapter', async () => {
  const f=fixture();await f.transport.connect();let native=0;
  f.transport.desktopSender={canSend:()=>true,post:async()=>{native++;throw new Error('No native call is permitted');}};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),
    display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=>'',
    checkpoint:{channel:'DOTHER01',uploads:{file:{fileId:'FOLD01',url:'https://files.slack.com/old',phase:'complete'}}}}),/reconciliation/);
  assert.equal(native,0);assert.deepEqual(f.calls,[]);
});

test('recipient lookup selects its verified DM and waits for the account', async () => {
  const f=fixture();await f.transport.connect();f.s.channel=undefined;let loading=0;
  const navigate=f.app.navigate;
  f.app.navigate=async id=>{f.calls.push('select:'+id);await navigate(id);loading=2;};
  f.app.snapshot=async()=>{if(loading-->0)throw new TransportError('The Slack app account is still loading.',false,1,'slack.desktop');return structuredClone(f.s);};
  const recipient=await f.transport.checkRecipient('slack:TEXAMPLE:UALEX01');
  assert.equal(recipient.name,'Alex');assert.deepEqual(f.calls,['select:UALEX01']);
  await assert.rejects(f.transport.checkRecipient('slack:TEXAMPLE:UNEW01'),/user_not_found/);
});

test('people search uses the background directory and returns active members only', async () => {
  const f=fixture();await f.transport.connect();
  f.s.people.push({id:'UBOT01',name:'Alex bot',realName:'Alex bot',title:'',active:false});
  const found=await f.transport.findPeople('alex',10);
  assert.deepEqual(found.people.map(p=>p.address),['slack:TEXAMPLE:UALEX01']);
});

test('refresh updates the name without changing the bound sender', async () => {
  const f=fixture();await f.transport.connect();f.s.people[0].name='Mario G';await f.transport.refresh();
  assert.equal(f.transport.identity()?.name,'Mario G');assert.equal(f.transport.identity()?.address,'slack:TEXAMPLE:UMARIO01');
});

test('app connection binds account IDs without reading an OAuth credential file', async () => {
  const f=fixture(); assert.equal(f.transport.identity(),null);
  writeFileSync(join(f.file,'..','slack-credentials.json'), 'not JSON and never read');
  await f.transport.connect(); assert.equal(f.transport.identity()?.address,'slack:TEXAMPLE:UMARIO01');
  assert.deepEqual(JSON.parse(readFileSync(f.file,'utf8')),{team:'TEXAMPLE',user:'UMARIO01',name:'Mario'});
  f.s.user='UEVE01'; await assert.rejects(f.transport.refresh(),/differs/); assert.equal(f.transport.identity()?.available,false);
  assert.deepEqual(f.calls,[]);
});
test('wrong workspace fails before binding or acting', async () => {
  const f=fixture(); f.s.team='TOTHER01'; await assert.rejects(f.transport.connect(),/differs/); assert.equal(f.transport.identity(),null); assert.deepEqual(f.calls,[]);
});
test('ack adds a reaction to the saved timestamp and an existing own reaction needs no click', async () => {
  const f=fixture(); await f.transport.connect(); f.s.messages.push(structuredClone(message));
  await f.transport.acknowledge({channel:message.channel,ts:message.ts});
  await f.transport.acknowledge({channel:message.channel,ts:message.ts});
  assert.equal(f.calls.filter(c => c.startsWith('react:')).length,1);
  assert.equal(f.s.messages[0].reactions[0].name,'white_check_mark');
  await assert.rejects(f.transport.acknowledge({channel:message.channel,ts:'1791934900.002'}),/original message/);
});
test('a reaction from another account does not acknowledge for the recipient', async () => {
  const f=fixture(); await f.transport.connect(); f.s.messages.push({...structuredClone(message),reactions:[{name:'white_check_mark',users:['UALEX01']}]});
  await f.transport.acknowledge({channel:message.channel,ts:message.ts}); assert.equal(f.calls.filter(c => c.startsWith('react:')).length,1);
});
test('native receipt uses the verified original timestamp without window controls',async()=>{
  const f=fixture();await f.transport.connect();f.s.messages.push(structuredClone(message));let calls=0;
  f.transport.desktopSender={canSend:()=>true,canRead:()=>true,post:async()=>{throw new Error('No message post permitted');},react:async(input)=>{
    calls++;assert.equal(input.ts,message.ts);assert.equal(input.channel,message.channel);assert.equal(input.owner,f.s.user);
  }};
  await f.transport.acknowledge({channel:message.channel,ts:message.ts});
  assert.equal(calls,1);assert.deepEqual(f.calls,[]);
  f.transport.desktopSender.react=async()=>{throw new TransportError('rate limited',true,60,'reactions.add',429);};
  await assert.rejects(f.transport.acknowledge({channel:message.channel,ts:message.ts}),(e:any)=>e.method==='reactions.add'&&e.status===429);
  assert.deepEqual(f.calls,[]);
});
test('text send saves its checkpoint before posting and confirms the original message ID', async () => {
  const f=fixture(); await f.transport.connect(); let checkpoint:any;
  const post=f.transport.desktopSender!.post;
  f.transport.desktopSender!.post=async (input,before) => post(input,()=>{before();assert.equal(checkpoint.postStarted,true);});
  const result=await f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123\nBody:\nHi @channel',saveCheckpoint:c=>{checkpoint=structuredClone(c);}});
  assert.equal(result.ts,'1791935000.001'); assert.equal(f.calls.filter(c=>c==='post').length,1);
  assert.ok(!f.s.messages[0].text.includes('@channel'));
  assert.ok(f.s.messages[0].text.includes('Please read.'));
  const {desktopEvent} = await import('../src/slack-desktop.ts');
  assert.ok(desktopEvent({...f.s.messages[0],type:'message'}));
  assert.equal((await f.transport.findSent('slack:TEXAMPLE:UALEX01','123'))?.ts,result.ts);
});
test('oversized attachments fail before posting', async () => {
  const f=fixture(); await f.transport.connect(); const input={to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Text',audience:'person' as const,senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123'};
  await assert.rejects(f.transport.send({...input,files:[{id:'x',name:'x.txt',bytes:Buffer.alloc(2*1024*1024+1)}]}),/2 MiB/);
  assert.deepEqual(f.calls,[]);
});
test('lost post response can be reconciled without another post', async () => {
  const f=fixture(); await f.transport.connect(); const post=f.transport.desktopSender!.post;
  f.transport.desktopSender!.post=async (input,before)=>{await post(input,before); throw new TransportError('Lost response',false);};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Text',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123'}),/Lost response/);
  assert.equal((await f.transport.findSent('slack:TEXAMPLE:UALEX01','123'))?.ts,'1791935000.001'); assert.equal(f.calls.filter(c=>c==='post').length,1);
  await assert.rejects(f.transport.findSent('slack:TEXAMPLE:UALEX01','missing'),/No duplicate/);
});
test('delivery notices reconcile by saved operation ID and never become incoming instructions', async () => {
  const f=fixture(); await f.transport.connect(); const ref={channel:'DOTHER01',operation_id:'12345678-1234-1234-1234-123456789abc'};
  await f.transport.notifyDelivery(ref,'unassigned'); await f.transport.notifyDelivery({...ref,reconcile:'true'},'unassigned');
  assert.equal(f.calls.filter(c=>c==='notice').length,1);
  let incoming=0; await f.transport.scan({},async()=>{incoming++;},()=>{}); assert.equal(incoming,0);
  await assert.rejects(f.transport.notifyDelivery({...ref,operation_id:'12345678-1234-1234-1234-123456789def',reconcile:'true'},'unassigned'),/No duplicate/);
});
test('app scan accepts explicit human input only and can load older messages without a cursor skip', async () => {
  const f=fixture(); await f.transport.connect();
  f.s.messages.push({...structuredClone(message),channel:'DSELF01',user:'UMARIO01'}, {...structuredClone(message),ts:'1791934900.002',text:'approve'},
    {...structuredClone(message),ts:'1791934900.003',user:'UMARIO01'}, {...structuredClone(message),ts:'1791934900.004',channel:'DSELF01',app_id:'AAPP',user:'UMARIO01'});
  const store=new Store(join(f.file,'..')), service=new NotesService({store,transport:f.transport,scanIntervalMs:0,retryIntervalMs:0});
  await f.transport.scan({'slack:TEXAMPLE:DSELF01:owner':'1791934999.999'},m=>service.receive(m),()=>{});
  const notes=service.list(person,{direction:'incoming'}).messages; assert.equal(notes.length,1); assert.equal(notes[0].owner_message,true);
  await f.transport.scan({},m=>service.receive(m),()=>{}); assert.equal(service.list(person,{direction:'incoming'}).messages.length,1);
  await service.stop();
});
test('disconnect persists across restart and requires an explicit connection', async () => {
  const f=fixture(); await f.transport.connect(); f.transport.disconnect();
  const next=new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>f.app});
  await next.refresh(); assert.equal(next.identity(),null);
  await next.connect(); assert.equal(next.identity()?.address,'slack:TEXAMPLE:UMARIO01');
});

test('an unavailable app keeps the bound identity and retries without sending', async () => {
  const f=fixture(); await f.transport.connect();
  const next=new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>{throw new Error('App closed');}});
  await assert.rejects(next.refresh(),(error:any)=>error.definite && error.retryAfter===10);
  assert.equal(next.identity()?.address,'slack:TEXAMPLE:UMARIO01'); assert.equal(next.identity()?.available,false);
});

// A fake native sender for file notes. post adds the formatted note, and attachFiles adds the files to it.
function fileSender(f: ReturnType<typeof fixture>, bytes: Buffer, options: {upload?: (n: number) => void; complete?: (n: number) => void;
  post?: (n: number) => void; attach?: (n: number) => void} = {}) {
  const c={tickets:0,completions:0,posts:0,attaches:0,blocks:'',postTs:''};
  f.transport.desktopSender={canSend:()=>true,canRead:()=>true,
    read:async input=>({file:{id:(input.args as any).file,name:'report.md',size:bytes.length,url:'https://files.slack.com/files-pri/test'}}),
    uploadFile:async(_input,saveTicket)=>{const id=`FNEW0${++c.tickets}`;saveTicket(id);options.upload?.(c.tickets);return id;},
    completeFile:async()=>{c.completions++;options.complete?.(c.completions);return {ok:true};},
    post:async(input,before)=>{
      before();c.posts++;c.blocks=input.blocks;const ts=`1791935000.0${50+c.posts}`;c.postTs=ts;
      f.s.messages.push({channel:input.channel,user:f.s.user,text:input.text,ts,client_msg_id:input.messageId,reactions:[]});
      options.post?.(c.posts);return {channel:input.channel,ts};
    },
    attachFiles:async input=>{
      c.attaches++;const m=f.s.messages.find(m=>m.ts===input.ts)!;
      assert.equal(input.text,m.text);
      m.files=input.files!.map(x=>({id:x.id,name:x.title,size:bytes.length}));
      options.attach?.(c.attaches);return {ok:true};
    }};
  return c;
}
const fileInput=(id:string,bytes:Buffer,save?:(value:any)=>void)=>({to:'slack:TEXAMPLE:UALEX01',messageId:id,
  display:{subject:'Report',body:'Please read.',audience:'person' as const,senderName:'Mario',files:[{name:'report.md',size:bytes.length}]},
  files:[{id:'file',name:'report.md',bytes}],wire:(map:Record<string,string>)=>`A2ANotes/1\nID: ${id}\nTransport-File-Slack: file | ${map.file}`,
  ...(save?{saveCheckpoint:save}:{})});
async function fileNote(t:any,f:ReturnType<typeof fixture>,clock:{now:number}){
  const service=new NotesService({store:new Store(join(f.file,'..')),transport:f.transport,now:()=>clock.now,random:()=>0.5,scanIntervalMs:0,retryIntervalMs:0});
  t.after(()=>service.stop());const bytes=Buffer.from('# Report\nText.');
  const staged=service.stageFile(person,{name:'report.md',text:bytes.toString(),sha256:sha256(bytes),request_id:randomUUID()});
  const draft=await service.createDraft(person,{to_address:'slack:TEXAMPLE:UALEX01',subject:'Report',body:'Please read.',audience:'person',file_ids:[staged.file_id],request_id:randomUUID()});
  service.approve(person,{id:draft.id,expected_hash:draft.hash,decision:'approve'});
  return {service,draft,staged,bytes,approval:structuredClone(service.store.note(draft.id)!.approval)};
}

test('a file note posts formatted blocks once, attaches its file, and downloads with its original hash', async () => {
  const f=fixture(); await f.transport.connect(); const bytes=Buffer.from('# Report\n'+('Content.\n'.repeat(4000)));
  const id=randomUUID(),c=fileSender(f,bytes);
  f.app.downloadFile=async()=>bytes;
  const result=await f.transport.send(fileInput(id,bytes));
  assert.equal(c.tickets,1);assert.equal(c.completions,1);assert.equal(c.posts,1);assert.equal(c.attaches,1);
  assert.equal(result.ts,c.postTs);
  assert.deepEqual(JSON.parse(c.blocks).map((b:any)=>b.type).slice(0,3),['header','context','divider']);
  const posted=f.s.messages.find(m=>m.ts===result.ts)!;
  assert.match(posted.text,/A2A Notes data: /);assert.equal(posted.files![0].name,'report.md');
  const received={conversation:'slack:TEXAMPLE:DOTHER01',ref:`slack:TEXAMPLE:DOTHER01:${result.ts}`,channel:'DOTHER01',ts:result.ts,sender:'slack:TEXAMPLE:UMARIO01',text:''};
  assert.deepEqual(await f.transport.download(result.files.file,received,bytes.length),bytes);
  await assert.rejects(f.transport.download(result.files.file,{...received,sender:'slack:TEXAMPLE:UALEX01'},bytes.length),/original attachment/);
  await assert.rejects(f.transport.download(result.files.file,received,2),/bytes do not match/);
  f.app.downloadFile=async()=>Buffer.from('Wrong bytes');
  await assert.rejects(f.transport.download(result.files.file,received,bytes.length),/bytes do not match/);
});

test('a lost binary upload starts a new ticket before the note is posted',async()=>{
  const f=fixture();await f.transport.connect();let saved:any;const id=randomUUID(),bytes=Buffer.from('# Report\nText.');
  const c=fileSender(f,bytes,{upload:n=>{if(n===1)throw new TransportError('Lost upload reply',false);}});
  const input=fileInput(id,bytes,value=>{saved=structuredClone(value);});
  await assert.rejects(f.transport.send(input),/Lost upload reply/);
  assert.equal(saved.postStarted,undefined);assert.equal(saved.uploads.file.phase,'allocated');assert.equal(saved.uploads.file.url,undefined);
  await f.transport.send({...input,checkpoint:saved});
  assert.equal(c.tickets,2);assert.equal(c.posts,1);assert.equal(c.attaches,1);
});

test('a failed private completion uploads again and never shares the earlier file',async()=>{
  const f=fixture();await f.transport.connect();let saved:any;const id=randomUUID(),bytes=Buffer.from('# Report\nText.');
  const c=fileSender(f,bytes,{complete:n=>{if(n===1)throw new TransportError('Lost completion reply',false);}});
  const input=fileInput(id,bytes,value=>{saved=structuredClone(value);});
  await assert.rejects(f.transport.send(input),/Lost completion reply/);
  assert.equal(saved.postStarted,undefined);assert.equal(saved.uploads.file.phase,'allocated');assert.equal(c.posts,0);
  await f.transport.send({...input,checkpoint:saved});
  assert.equal(c.tickets,2);assert.equal(c.posts,1);
  assert.equal(f.s.messages.find(m=>m.ts===c.postTs)!.files![0].id,'FNEW02');
});

test('a lost attach reply attaches again and never posts the note twice',async()=>{
  const f=fixture();await f.transport.connect();let saved:any;const id=randomUUID(),bytes=Buffer.from('# Report\nText.');
  const c=fileSender(f,bytes,{attach:n=>{if(n===1)throw new TransportError('Lost attach reply',false);}});
  const input=fileInput(id,bytes,value=>{saved=structuredClone(value);});
  await assert.rejects(f.transport.send(input),/Lost attach reply/);
  assert.equal(saved.postStarted,true);assert.equal(saved.postedTs,c.postTs);assert.equal(saved.uploads.file.phase,'complete');
  const result=await f.transport.send({...input,checkpoint:saved});
  assert.equal(result.ts,c.postTs);assert.equal(c.posts,1);assert.equal(c.attaches,2);assert.equal(c.tickets,1);
});

test('a chat.update 429 keeps the posted note and attaches after Retry-After under the same approval',async t=>{
  const f=fixture();await f.transport.connect();const clock={now:Date.now()};const n=await fileNote(t,f,clock);
  const c=fileSender(f,n.bytes,{attach:k=>{if(k===1)throw new TransportError('Slack Desktop: ratelimited',true,45,'chat.update',429,'request-id');}});
  await n.service.send(person,{id:n.draft.id,expected_hash:n.draft.hash,request_id:randomUUID()});
  const waiting=n.service.store.note(n.draft.id)!;
  assert.equal(waiting.checkpoint?.postedTs,c.postTs);assert.equal(waiting.delivery!.lastMethod,'chat.update');
  assert.ok(Date.parse(waiting.delivery!.nextAttemptAt!)>=clock.now+45_000);
  clock.now=Date.parse(waiting.delivery!.nextAttemptAt!)+1;await n.service.processQueue();
  const sent=n.service.store.note(n.draft.id)!;
  assert.equal(sent.state,'sent');assert.equal(sent.transport!.ts,c.postTs);
  assert.equal(c.posts,1);assert.equal(c.attaches,2);assert.deepEqual(sent.approval,n.approval);
});

test('a lost post reply finds the note without files and attaches them without another post',async t=>{
  const f=fixture();await f.transport.connect();const clock={now:Date.now()};const n=await fileNote(t,f,clock);
  const c=fileSender(f,n.bytes,{post:k=>{if(k===1)throw new TransportError('Lost post reply',false);}});
  await assert.rejects(n.service.send(person,{id:n.draft.id,expected_hash:n.draft.hash,request_id:randomUUID()}));
  const uncertain=n.service.store.note(n.draft.id)!;
  assert.equal(uncertain.state,'delivery_uncertain');assert.equal(uncertain.checkpoint?.postedTs,undefined);
  clock.now=Date.parse(uncertain.delivery!.nextAttemptAt!)+1;await n.service.processQueue();
  const sent=n.service.store.note(n.draft.id)!;
  assert.equal(sent.state,'sent');assert.equal(sent.transport!.ts,c.postTs);assert.equal(c.posts,1);assert.equal(c.attaches,1);
});

test('a native interface change before private completion can be retried under the same approval',async t=>{
  const f=fixture();await f.transport.connect();const clock={now:Date.now()};const n=await fileNote(t,f,clock);
  const c=fileSender(f,n.bytes,{complete:k=>{if(k===1)throw new DesktopUnavailableError();}});
  await assert.rejects(n.service.send(person,{id:n.draft.id,expected_hash:n.draft.hash,request_id:randomUUID()}),/No post was started/);
  const failed=n.service.store.note(n.draft.id)!;
  assert.equal(failed.state,'permanent_failure');assert.equal(failed.checkpoint?.postStarted,undefined);
  assert.equal(failed.checkpoint?.uploads[n.staged.file_id].phase,'allocated');
  assert.equal((await n.service.retrySend(person,{id:n.draft.id,expected_hash:n.draft.hash,request_id:randomUUID()})).state,'queued');
  await n.service.processQueue();
  assert.equal(n.service.store.note(n.draft.id)!.state,'sent');assert.equal(c.posts,1);assert.equal(c.tickets,2);
  assert.deepEqual(n.service.store.note(n.draft.id)!.approval,n.approval);
});

test('an approved agent note with its JSON file reaches another app account through the protocol core', async () => {
  const f=fixture(); await f.transport.connect();
  const {agent, stageAgentFile, agentRequest, rid} = await import('./helpers.ts');
  const source=new NotesService({store:new Store(join(f.file,'..')),transport:f.transport,scanIntervalMs:0,retryIntervalMs:0});
  const {randomUUID} = await import('node:crypto'); const id=randomUUID();
  const file=stageAgentFile(source,agent,agentRequest(id,'Read the plan'));
  const draft=await source.createDraft(agent,{to_address:'slack:TEXAMPLE:UALEX01',subject:'Read the plan',body:'Hi Alex, please ask your agent to read the plan.',audience:'both',agent_file_id:file.file_id,request_id:rid()});
  source.approve(person,{id:draft.id,expected_hash:draft.hash,decision:'approve'});
  await source.send(person,{id:draft.id,expected_hash:draft.hash,request_id:rid()});
  assert.equal(source.get(person,draft.id).state,'sent');
  f.s.user='UALEX01'; f.s.peers=[{id:'DOTHER01',user:'UMARIO01'}];
  const receiving=new SlackTransport(join(mkdtempSync(join(tmpdir(),'app-recipient-')),'account.json'),{teamId:'TEXAMPLE'},undefined,{open:async()=>f.app});
  await receiving.connect();
  const target=new NotesService({store:new Store(join(mkdtempSync(join(tmpdir(),'app-inbox-')))),transport:receiving,scanIntervalMs:0,retryIntervalMs:0});
  await target.scanNow();
  const note=target.list(person,{direction:'incoming'}).messages[0];
  assert.equal(note.state,'held'); assert.equal(note.audience,'both');
  const detail=target.get(person,note.id); assert.equal(detail.agent_file?.data?.message_id,id);
  assert.equal(target.get(agent,note.id).body,'');
  await source.stop(); await target.stop();
});
