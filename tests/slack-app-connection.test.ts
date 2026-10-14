import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer, type WebSocket} from 'ws';
import {SlackAppConnection} from '../src/slack-app.ts';
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
test('the app connection uses loopback CDP and reads only account and rendered fields',async t=>{
  const f=await fixture(t);let verified=0;const requests:string[]=[];
  const app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{verified++;},fetcher:async(url,options)=>{requests.push(String(url));return fetch(url,options);}});
  t.after(()=>app.close());const s=await app.snapshot();assert.equal(s.user,'UMARIO01');assert.equal(s.messages.length,0);
  assert.equal(verified,2);assert.deepEqual(requests,[`${f.url}/json/list`]);
  assert.ok(f.calls.every(c=>c.method==='Runtime.evaluate'));assert.ok(!JSON.stringify(f.calls).includes('access_token'));
});
test('a changed app account blocks navigation before a page action',async t=>{
  const f=await fixture(t),app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}});t.after(()=>app.close());
  f.setUser('UEVE01');await assert.rejects(app.navigate('DOTHER01'),/account differs/);assert.ok(!f.calls.some(c=>c.method==='Page.navigate'));
});
test('a page from another workspace cannot become the app connection',async t=>{
  const f=await fixture(t);f.setTargetTeam('TOTHER01');await assert.rejects(SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}}),/configured workspace/);assert.equal(f.calls.length,0);
});

test('an account that is loading differs from a confirmed account change',async t=>{
  const f=await fixture(t),app=await SlackAppConnection.open(f.url,'TEXAMPLE',undefined,{verifyEndpoint:async()=>{}});t.after(()=>app.close());
  f.setUser('');await assert.rejects(app.snapshot(),(error:any)=>!error.definite&&error.method==='slack.desktop');
  f.setUser('UEVE01');await assert.rejects(app.snapshot(),(error:any)=>error.definite&&/account differs/.test(error.message));
});
