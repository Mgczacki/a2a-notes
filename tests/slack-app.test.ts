import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {SlackTransport} from '../src/slack.ts';
import {rendererSnapshot, rendererAction, type AppConnection, type AppSnapshot} from '../src/slack-app.ts';
import {NotesService} from '../src/service.ts';
import {Store} from '../src/store.ts';
import {person} from './helpers.ts';
import {DesktopDeliveries} from '../src/slack-desktop-delivery.ts';
import {DesktopUnavailableError} from '../src/slack-desktop.ts';
import {TransportError} from '../src/transport.ts';
import {randomUUID} from 'node:crypto';

function fixture() {
  const s: AppSnapshot = {team:'TEXAMPLE', user:'UMARIO01', channel:'DOTHER01', peers:[{id:'DOTHER01',user:'UALEX01'},{id:'DSELF01',user:'UMARIO01'}],
    people:[{id:'UMARIO01',name:'Mario',realName:'Mario',title:'',active:true},{id:'UALEX01',name:'Alex',realName:'Alex',title:'',active:true}], messages:[], editor:true,draft:''};
  const calls: string[] = [];
  const app: AppConnection = {
    async snapshot() {return structuredClone(s);}, async navigate(id) {calls.push('navigate:'+id); s.channel = s.peers.find(p => p.id === id || p.user === id)?.id;},
    async compose(text) {calls.push('compose'); s.draft = text;},
    async submit() {calls.push('submit'); s.messages.push({channel:s.channel!,user:s.user,text:s.draft,ts:'1791935000.001',reactions:[]}); s.draft='';},
    async react(ts, name) {calls.push('react:'+ts); s.messages.find(m => m.ts === ts)!.reactions.push({name,users:[s.user]});}, async close() {},
  };
  const file = join(mkdtempSync(join(tmpdir(),'app-transport-')), 'account.json');
  const transport = new SlackTransport(file,{teamId:s.team},undefined,{open:async () => app});
  return {s,app,calls,file,transport};
}
const message = {channel:'DOTHER01', user:'UALEX01',text:'A2A #7\nPlease read this.',ts:'1791934900.001',reactions:[]};

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

test('native app receipt survives restart and keeps inline files without another post or navigation', async () => {
  const f=fixture();await f.transport.connect(); const id=randomUUID(),bytes=Buffer.from('Attached text');let checkpoint:any,posts=0;
  const deliveries=new DesktopDeliveries(join(f.file,'..'));
  f.transport.desktopSender={canSend:()=>true,post:async (input,before)=>{
    before();posts++;deliveries.begin(input);deliveries.confirmed(input.messageId,input.channel,'1791935000.010');
    throw new TransportError('Lost response',false);
  }};
  const input={to:'slack:TEXAMPLE:UALEX01',messageId:id,display:{subject:'Read the attachment',body:'Please read.',audience:'person' as const,senderName:'Mario',files:[{name:'text.txt',size:bytes.length}]},
    files:[{id:'file',name:'text.txt',bytes}],wire:(map:Record<string,string>)=>`A2ANotes/1\nID: ${id}\nTransport-File-Slack: file | ${map.file}`,saveCheckpoint:(c:any)=>{checkpoint=structuredClone(c);}};
  await assert.rejects(f.transport.send(input),/Lost response/);
  assert.equal(checkpoint.postStarted,true);assert.equal(checkpoint.uploads.file.phase,'complete');
  assert.match(checkpoint.uploads.file.fileId,/^APP[a-f0-9]{64}$/);
  const restarted=new SlackTransport(f.file,{teamId:f.s.team},undefined,{open:async()=>f.app});
  f.calls.length=0;
  assert.equal((await restarted.findSent(input.to,id))?.ts,'1791935000.010');
  assert.equal(posts,1);assert.deepEqual(f.calls,[]);
  f.s.user='UEVE01';await assert.rejects(restarted.findSent(input.to,id),/differs/);
});

test('only known native unavailability permits app composer fallback', async () => {
  const f=fixture();await f.transport.connect();
  const input={to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),display:{subject:'Plan',body:'Please read.',audience:'person' as const,senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: test'};
  f.transport.desktopSender={canSend:()=>true,post:async()=>{throw new TransportError('invalid_auth',true);}};
  await assert.rejects(f.transport.send(input),/invalid_auth/);assert.ok(!f.calls.includes('compose'));
  f.transport.desktopSender={canSend:()=>true,post:async()=>{throw new DesktopUnavailableError();}};
  input.wire=()=>`A2ANotes/1\nID: ${input.messageId}`;
  await f.transport.send(input);assert.equal(f.calls.filter(c=>c==='submit').length,1);
});

test('API upload progress cannot become a second attachment through the app adapter', async () => {
  const f=fixture();await f.transport.connect();let native=0;
  f.transport.desktopSender={canSend:()=>true,post:async()=>{native++;throw new Error('No native call is permitted');}};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:randomUUID(),
    display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=>'',
    checkpoint:{channel:'DOTHER01',uploads:{file:{fileId:'FOLD01',url:'https://files.slack.com/old',phase:'complete'}}}}),/earlier Slack adapter/);
  assert.equal(native,0);assert.deepEqual(f.calls,[]);
});

test('recipient lookup uses its verified DM and waits for the account after navigation', async () => {
  const f=fixture();await f.transport.connect();f.s.channel=undefined;let loading=0;
  f.app.navigate=async id=>{assert.equal(id,'DOTHER01');f.calls.push('navigate:'+id);f.s.channel=id;loading=2;};
  f.app.snapshot=async()=>{if(loading-->0)throw new TransportError('The Slack app account is still loading.',false,1,'slack.desktop');return structuredClone(f.s);};
  const recipient=await f.transport.checkRecipient('slack:TEXAMPLE:UALEX01');
  assert.equal(recipient.name,'Alex');assert.deepEqual(f.calls,['navigate:DOTHER01']);
  await assert.rejects(f.transport.checkRecipient('slack:TEXAMPLE:UNEW01'),/verify its recipient/);
});

test('live avatar fields provide verified names and exclude deleted or automated users', () => {
  const avatar=(id:string,type:string,deleted=false)=>({__reactFiberTest:{type:{displayName:'BaseAvatar'},memoizedProps:{userId:id,memberOrBotName:'Member '+id,userType:type,isDeleted:deleted,access:'private'}}});
  const elements=[avatar('UALEX01','member'),avatar('UMARIO01','member'),avatar('UBOT01','bot'),avatar('UDELETED01','member',true)];
  const result=runInNewContext(`(${rendererSnapshot.toString()})()`,{__name:(f:unknown)=>f,location:{pathname:'/client/TEXAMPLE/DOTHER01'},document:{querySelector:()=>null,querySelectorAll:(q:string)=>q.includes('contenteditable')?[]:elements}});
  assert.equal(result.people.find((p:any)=>p.id==='UALEX01').active,true);
  assert.equal(result.people.find((p:any)=>p.id==='UBOT01').active,false);
  assert.equal(result.people.find((p:any)=>p.id==='UDELETED01').active,false);
  assert.ok(!JSON.stringify(result).includes('private'));
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
test('text send saves its checkpoint before clicking and confirms the original message ID', async () => {
  const f=fixture(); await f.transport.connect(); let checkpoint:any;
  f.app.submit=async () => {assert.equal(checkpoint.postStarted,true); f.calls.push('submit'); f.s.messages.push({channel:f.s.channel!,user:f.s.user,text:f.s.draft,ts:'1791935000.002',reactions:[]});f.s.draft='';};
  const result=await f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Please read.',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123\nBody:\nHi @channel',saveCheckpoint:c=>{checkpoint=structuredClone(c);}});
  assert.equal(result.ts,'1791935000.002'); assert.equal(f.calls.filter(c=>c==='submit').length,1);
  assert.ok(!f.s.messages[0].text.includes('@channel'));
  assert.ok(f.s.messages[0].text.includes('Please read.'));
  const {desktopEvent} = await import('../src/slack-desktop.ts');
  assert.ok(desktopEvent({...f.s.messages[0],type:'message'}));
  assert.equal((await f.transport.findSent('slack:TEXAMPLE:UALEX01','123'))?.ts,result.ts);
});
test('existing drafts and attachments fail before composing or submitting', async () => {
  const f=fixture(); await f.transport.connect(); const input={to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Text',audience:'person' as const,senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123'};
  f.s.draft='Private draft'; await assert.rejects(f.transport.send(input),/contains a draft/);
  await assert.rejects(f.transport.send({...input,files:[{id:'x',name:'x.txt',bytes:Buffer.alloc(40_000)}]}),/exceed the app text limit/);
  assert.ok(!f.calls.includes('compose')); assert.ok(!f.calls.includes('submit')); assert.equal(f.s.draft,'Private draft');
});
test('lost submit response can be reconciled without another post', async () => {
  const f=fixture(); await f.transport.connect(); f.app.submit=async()=>{f.calls.push('submit'); f.s.messages.push({channel:f.s.channel!,user:f.s.user,text:f.s.draft,ts:'1791935000.003',reactions:[]}); throw new Error('Lost response');};
  await assert.rejects(f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Text',audience:'person',senderName:'Mario',files:[]},files:[],wire:()=> 'A2ANotes/1\nID: 123'}),/Lost response/);
  assert.equal((await f.transport.findSent('slack:TEXAMPLE:UALEX01','123'))?.ts,'1791935000.003'); assert.equal(f.calls.filter(c=>c==='submit').length,1);
  await assert.rejects(f.transport.findSent('slack:TEXAMPLE:UALEX01','missing'),/No duplicate/);
});
test('delivery notices reconcile by saved operation ID and never become incoming instructions', async () => {
  const f=fixture(); await f.transport.connect(); const ref={channel:'DOTHER01',operation_id:'12345678-1234-1234-1234-123456789abc'};
  await f.transport.notifyDelivery(ref,'unassigned'); await f.transport.notifyDelivery({...ref,reconcile:'true'},'unassigned');
  assert.equal(f.calls.filter(c=>c==='submit').length,1);
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
test('renderer copies known message and profile fields without exposing unrelated props', () => {
  const element={__reactFiberTest:{memoizedProps:{message:{...message,access:'secret'},channel:{id:'DOTHER01',is_im:true,user:'UALEX01'},user:{id:'UALEX01',name:'Alex',profile:{token:'secret'}}}}};
  const result=runInNewContext(`(${rendererSnapshot.toString()})()`,{__name:(f:unknown)=>f,location:{pathname:'/client/TEXAMPLE/DOTHER01'},document:{querySelector:()=>null,querySelectorAll:(q:string)=>q.includes('contenteditable')?[]:[element]}});
  assert.equal(result.messages.length,1); assert.equal(result.peers[0].user,'UALEX01'); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('submit refuses a changed channel before it clicks a control', () => {
  const result=runInNewContext(`(${rendererAction.toString()})('submit','',undefined,'DOTHER01','approved text')`,{location:{pathname:'/client/TEXAMPLE/DWRONG01'},document:{querySelectorAll:()=>{throw new Error('No control may be read');}}});
  assert.equal(result,false);
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

test('small attachments remain in the original message and verify sender, size, and hash', async () => {
  const f=fixture(); await f.transport.connect(); const bytes=Buffer.from('A small JSON request.');
  const result=await f.transport.send({to:'slack:TEXAMPLE:UALEX01',messageId:'123',display:{subject:'Plan',body:'Text',audience:'person',senderName:'Mario',files:[{name:'request.json',size:bytes.length}]},files:[{id:'file',name:'request.json',bytes}],wire:map=>`A2ANotes/1\nID: 123\nTransport-File-Slack: file | ${map.file}`});
  const received={conversation:'slack:TEXAMPLE:DOTHER01',ref:`slack:TEXAMPLE:DOTHER01:${result.ts}`,channel:'DOTHER01',ts:result.ts,sender:'slack:TEXAMPLE:UMARIO01',text:''};
  assert.deepEqual(await f.transport.download(result.files.file,received,100),bytes);
  await assert.rejects(f.transport.download(result.files.file,{...received,sender:'slack:TEXAMPLE:UALEX01'},100),/original attachment/);
  await assert.rejects(f.transport.download(result.files.file,received,2),/bytes do not match/);
  f.s.messages[0].text=f.s.messages[0].text.replace(bytes.toString('base64'),Buffer.from('Changed bytes').toString('base64'));
  await assert.rejects(f.transport.download(result.files.file,received,100),/bytes do not match/);
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
