import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer, type WebSocket} from 'ws';
import {SlackAppConnection, BackgroundConnection, type BackgroundCache} from '../src/slack-app.ts';
import {TransportError} from '../src/transport.ts';
import {DESKTOP_IDENTITY} from '../src/slack-desktop.ts';
import {runInNewContext} from 'node:vm';

async function fixture(t:any) {
  let port=0, user='UMARIO01', targetTeam='TEXAMPLE'; const calls:any[]=[], sockets=new Set<WebSocket>();
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{type:'page',url:`https://app.slack.com/client/${targetTeam}/DSELF01`,webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/slack`} ]));});
  const ws=new WebSocketServer({server});
  ws.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('message',raw=>{
    const m=JSON.parse(raw.toString());calls.push(m);
    const value=m.method==='Runtime.evaluate' ? m.params.expression===DESKTOP_IDENTITY ? {team:'TEXAMPLE',user}
      : runInNewContext(m.params.expression,{location:{pathname:'/client/TEXAMPLE/DSELF01'},document:{querySelector:()=>null,querySelectorAll:()=>[]}}) : {};
    socket.send(JSON.stringify({id:m.id,result:m.method==='Runtime.evaluate'?{result:{value}}:value}));
  });});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as any).port;
  t.after(async()=>{for(const s of sockets)s.terminate();await new Promise<void>(r=>ws.close(()=>server.close(()=>r())));});
  return {url:`http://127.0.0.1:${port}`,calls,setUser:(next:string)=>{user=next;},setTargetTeam:(team:string)=>{targetTeam=team;}};
}
test('the app connection uses loopback CDP and reads only the account IDs',async t=>{
  const f=await fixture(t);let verified=0;const requests:string[]=[];
  const app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{verified++;},fetcher:async(url,options)=>{requests.push(String(url));return fetch(url,options);}});
  t.after(()=>app.close());assert.deepEqual(await app.identity(),{team:'TEXAMPLE',user:'UMARIO01'});
  assert.equal(verified,2);assert.deepEqual(requests,[`${f.url}/json/list`]);
  assert.ok(f.calls.every(c=>c.method==='Runtime.evaluate'&&c.params.expression===DESKTOP_IDENTITY));
});
test('a changed app account stops the identity check',async t=>{
  const f=await fixture(t),app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}});t.after(()=>app.close());
  f.setUser('UEVE01');await assert.rejects(app.identity(),/account differs/);
  assert.ok(!f.calls.some(c=>/^(Page|Input)\./.test(c.method)));
});
test('a page from another workspace cannot become the app connection',async t=>{
  const f=await fixture(t);f.setTargetTeam('TOTHER01');await assert.rejects(SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}}),/configured workspace/);assert.equal(f.calls.length,0);
});

test('an account that is loading differs from a confirmed account change',async t=>{
  const f=await fixture(t),app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}});t.after(()=>app.close());
  f.setUser('');await assert.rejects(app.identity(),(error:any)=>!error.definite&&error.method==='slack.desktop');
  f.setUser('UEVE01');await assert.rejects(app.identity(),(error:any)=>error.definite&&/account differs/.test(error.message));
});

function background(options:{fail?:Record<string,TransportError>}={}) {
  const reads:{method:string;args:any}[]=[];let now=1000;
  const cache:BackgroundCache={peers:new Map(),people:new Map()};
  const profile=(id:string)=>({id,name:'Member '+id,realName:'Member '+id,title:'',active:true});
  const read=async(method:string,args:any)=>{
    reads.push({method,args});
    if(options.fail?.[method])throw options.fail[method];
    if(method==='users.info')return {user:profile(args.user)};
    if(method==='conversations.open')return {channel:{id:'D'+args.users.slice(1),is_im:true,user:args.users}};
    if(method==='conversations.info')return {channel:{id:args.channel,is_im:true,user:'U'+args.channel.slice(1)}};
    if(method==='conversations.history')return {messages:[{user:'UALEX01',text:'A2A #7',ts:args.latest||'1791934900.001',reactions:[]}]};
    if(method==='users.list')return args.cursor?{members:[profile('UBEA01')]}:{members:[profile('UALEX01')],next:'page2'};
    throw new Error('Unexpected '+method);
  };
  let closed=0;
  const app=new BackgroundConnection({identity:async()=>({team:'TEXAMPLE',user:'UMARIO01'}),close:async()=>{closed++;}},read,cache,()=>now);
  return {app,reads,cache,advance:(ms:number)=>{now+=ms;},closed:()=>closed};
}
test('background selection reads Slack records and caches conversations and profiles',async()=>{
  const f=background();
  await f.app.navigate('UALEX01');
  let s=await f.app.snapshot();
  assert.equal(s.channel,'DALEX01');assert.deepEqual(s.peers,[{id:'DALEX01',user:'UALEX01'}]);
  assert.equal(s.messages[0].channel,'DALEX01');assert.ok(s.people.some(p=>p.id==='UALEX01'));
  f.reads.length=0;await f.app.navigate('DALEX01');
  assert.deepEqual(f.reads.map(r=>r.method),['conversations.history']);
  f.advance(11*60_000);f.reads.length=0;s=await f.app.snapshot();
  assert.deepEqual(f.reads.map(r=>r.method),['users.info']);
});
test('background exact-message reads use one inclusive timestamp',async()=>{
  const f=background();await f.app.message('DALEX01','1791934900.005');
  assert.deepEqual(f.reads.at(-1),{method:'conversations.history',args:{channel:'DALEX01',limit:1,latest:'1791934900.005',oldest:'1791934900.005',inclusive:true}});
  assert.ok((await f.app.snapshot()).messages.some(m=>m.ts==='1791934900.005'));
  await assert.rejects(f.app.message('DALEX01','bad'),/timestamp/);
});
test('background load skips a removed conversation but stops for rate limits',async()=>{
  const removed=background({fail:{'conversations.info':new TransportError('Slack Desktop: channel_not_found',true,0,'conversations.info')}});
  await removed.app.load(['DGONE01','UALEX01']);
  assert.ok((await removed.app.snapshot()).messages.some(m=>m.channel==='DALEX01'));
  const limited=background({fail:{'conversations.history':new TransportError('Slack Desktop: ratelimited',true,30,'conversations.history',429)}});
  await assert.rejects(limited.app.load(['UALEX01']),(e:any)=>e.status===429);
});
test('the background directory pages users.list and caches the result',async()=>{
  const f=background();
  assert.deepEqual((await f.app.directory()).map(p=>p.id),['UALEX01','UBEA01']);
  f.reads.length=0;await f.app.directory();assert.equal(f.reads.length,0);
  await f.app.close();assert.equal(f.closed(),1);
});
