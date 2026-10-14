// These hashes identify the inspected Slack module factories. Unknown code cannot send through this adapter.
export const NATIVE_PINS = {
  IlU1: '2c14a39829a9e06c06d131679684961e5910ca47707b1bfe0165c8a2ff8fb00b',
  CBtA: 'abe6bfdf60e35167cc8956a57d79ef78ebe427f5b8589a0d0b30ecaf44d40e22',
  DW51: 'd3ade86f4be3e269455e8c546d73723fef6403d75911ab027227bf41c339df07',
  kPEx: '7f9aa621807970cfa1a5e4b23757ae7eaa7d8cbd8a55924634ada7272588d406',
  GGwr: '906ea288c0722bfefd73cae46da19c760e65948a480c37cfe605f86d8b825670',
  '/+Um': '3ce10bb81300a5ac3df56755cd218e1cede97d5006d35ede1d16c38ea9d24326',
  SIiq: '1d5f9985f5b5355f2cb2fd9faddb164bc3850f1540f14916c1f76da687e5a300',
  thj9: '88dabb73e2ced09583bd9b918a346377f6ebae51eeb15886e6ba5cdaa4d7eec3',
  njQ9: '053e44991ee7783db8998bb0c0c79f04363c3b8e3fd5fb2e12e330c43f3a96cc',
  '4zAA': 'f492dad68d93ea4fe9293cdd3cdaa68cb3902588de14d2abb76801e1cd38fce6',
};
export interface DesktopPost {
  team: string; owner: string; to: string; channel: string; messageId: string; text: string; blocks: string; threadTs?: string;
  // A delivery notice has plain text and uses its operation ID as messageId.
  kind?: 'notice';
}
export interface DesktopRead { team: string; owner: string; method: string; args: Record<string, unknown> }
export interface DesktopReaction { team: string; owner: string; channel: string; ts: string; name: string }
export interface DesktopFile {
  // complete shares nothing. attach adds completed files to the posted note with chat.update.
  team: string; owner: string; operation: 'ticket' | 'complete' | 'attach';
  channel?: string; ts?: string; messageId?: string; text?: string; blocks?: string;
  name?: string; length?: number;
  files?: {id: string; title: string}[];
}
export interface NativeResult { data?: any; ok?: boolean; ready?: boolean; channel?: string; ts?: string; error?: string; definite?: boolean; status?: number; retryAfter?: number; requestId?: string }

// Arguments travel as CDP values. They never become executable source code.
export function nativeFunctions(pins: Record<string, string> = NATIVE_PINS) {
  const lookup = `
    const key = Symbol.for('a2anotes.desktop.runtime');
    const chunks = globalThis.rspackChunkGantryV2;
    if (!Array.isArray(chunks)) throw new Error('native_interface_changed');
    if (!globalThis[key]) chunks.push([['a2anotes-desktop-bridge-v1'], {}, r => { globalThis[key] = r; }]);
    const req = globalThis[key];
    if (typeof req !== 'function' || !req.m) throw new Error('native_interface_changed');
    const pins = ${JSON.stringify(pins)};
    for (const [id, expected] of Object.entries(pins)) {
      if (typeof req.m[id] !== 'function') throw new Error('native_interface_changed');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(req.m[id])));
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== expected) throw new Error('native_interface_changed');
    }
    const delegate = globalThis.desktopDelegates?.[input.team];
    if (typeof delegate?.getCurrentUserId !== 'function' || delegate.getCurrentUserId() !== input.owner)
      throw new Error('native_account_mismatch');
    const store = req('/+Um').oK(input.team), queue = req('kPEx').PS(input.team), api = req('IlU1').apiCall;
    if (typeof store?.dispatch !== 'function' || typeof queue?.q !== 'function' || api?.meta?.name !== 'apiCall')
      throw new Error('native_interface_changed');
  `;
  const capability = `async function(input) { try { ${lookup} return {ready:true}; } catch { return {ready:false}; } }`;
  const post = `async function(input) {
    'use strict';
    let enqueued = false, request, timer;
    try {
      ${lookup}
      const notice = input.kind === 'notice';
      if (!/^D[A-Z0-9]+$/.test(input.channel) || !/^[a-f0-9-]{36}$/i.test(input.messageId) ||
          typeof input.text !== 'string' || input.text.length > (notice ? 600 : 39000) ||
          !notice && typeof input.blocks !== 'string' || input.threadTs && (notice || !/^\\d+\\.\\d+$/.test(input.threadTs)))
        return {error:'native_invalid_payload', definite:true};
      if (notice) {
        // A notice is fixed service text. It cannot carry a mention, a link, or note content.
        if (!input.text.endsWith('\\nReceipt ID: ' + input.messageId) || /[<>&@]/.test(input.text))
          return {error:'native_invalid_payload', definite:true};
      } else {
        const raw = input.text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
        const marker = raw.indexOf('A2A Notes data: ');
        let wire, blocks;
        try { wire = marker >= 0 ? JSON.parse(raw.slice(marker + 'A2A Notes data: '.length)) : raw; blocks = JSON.parse(input.blocks); }
        catch {return {error:'native_invalid_payload', definite:true};}
        if (typeof wire !== 'string' || !wire.startsWith('A2ANotes/1\\nID: ' + input.messageId + '\\n'))
          return {error:'native_invalid_payload', definite:true};
        if (!Array.isArray(blocks) || blocks.length > 50) return {error:'native_invalid_payload', definite:true};
      }
      const original = queue.q, own = Object.getOwnPropertyDescriptor(queue, 'q');
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 15000);
      let promise;
      try {
        queue.q = function(candidate, expedited) {
          if (candidate.method !== 'chat.postMessage' || candidate.args?.client_msg_id !== input.messageId)
            return original.call(this, candidate, expedited);
          const attempts = Object.getOwnPropertyDescriptor(candidate, '_maxAttempts');
          if (!attempts?.writable || !Number.isInteger(attempts.value) || candidate._numberOfAttempts !== 0)
            throw new Error('native_interface_changed');
          candidate._maxAttempts = 1;
          request = candidate;
          enqueued = true;
          return original.call(this, candidate, expedited);
        };
        promise = store.dispatch(api({method:'chat.postMessage', reason:notice ? 'a2anotes-delivery-notice' : 'a2anotes-approved-note', timeout:15, abortSignal:controller.signal,
          args:{channel:input.channel, text:input.text, ...(notice ? {} : {blocks:input.blocks}), client_msg_id:input.messageId,
            mrkdwn:false, unfurl_links:false, unfurl_media:false, parse:'none',
            ...(input.threadTs ? {thread_ts:input.threadTs, reply_broadcast:true} : {})}}));
      } finally { if (own) Object.defineProperty(queue, 'q', own); else delete queue.q; }
      const result = await promise;
      if (!enqueued || result?.ok !== true || result.channel !== input.channel || !/^\\d+\\.\\d+$/.test(result.ts) ||
          result.message?.client_msg_id && result.message.client_msg_id !== input.messageId)
        return {error:'native_delivery_uncertain', definite:false};
      return {ok:true, channel:result.channel, ts:result.ts};
    } catch (error) {
      if (!enqueued) return {error:error?.message==='native_account_mismatch'?'native_account_mismatch':'native_interface_changed', definite:true};
      const status = Number(error?.status);
      const code = typeof error?.data?.error === 'string' && /^[a-z_]{1,80}$/.test(error.data.error) ? error.data.error :
        [6,7,8].includes(error?.data?.error) ? 'native_posting_denied' : '';
      let retryAfter = Math.ceil(Number(error?.retryAfter || 0) / 1000), requestId;
      try {
        const raw = Number(request?._xhr?.getResponseHeader('Retry-After'));
        if (Number.isFinite(raw) && raw > 0) retryAfter = Math.ceil(raw);
        const id = request?._xhr?.getResponseHeader('x-slack-req-id');
        if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) requestId = id;
      } catch {}
      const definite = status === 429 || status >= 400 && status < 500 ||
        !!code && !['internal_error','fatal_error','_parse_error'].includes(code);
      return {error:code || 'native_delivery_uncertain', definite, ...(status>=100 && status<=599 ? {status} : {}),
        ...(status===429 || code==='ratelimited' ? {retryAfter:Math.max(1, retryAfter || 60)} : {}), ...(requestId ? {requestId} : {})};
    } finally { clearTimeout(timer); }
  }`;
  const react = `async function(input) {
    'use strict';
    let enqueued = false, request, timer;
    try {
      ${lookup}
      if (!/^D[A-Z0-9]+$/.test(input.channel) || !/^\\d+\\.\\d+$/.test(input.ts) || !/^[a-z0-9_+-]{1,64}$/.test(input.name))
        return {error:'native_invalid_payload',definite:true};
      const original = queue.q, own = Object.getOwnPropertyDescriptor(queue,'q');
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(),15000);
      let promise;
      try {
        queue.q = function(candidate, expedited) {
          if (candidate.method !== 'reactions.add' || candidate.args?.channel !== input.channel || candidate.args?.timestamp !== input.ts || candidate.args?.name !== input.name)
            return original.call(this,candidate,expedited);
          const attempts = Object.getOwnPropertyDescriptor(candidate,'_maxAttempts');
          if (!attempts?.writable || !Number.isInteger(attempts.value) || candidate._numberOfAttempts !== 0)
            throw new Error('native_interface_changed');
          candidate._maxAttempts=1; request=candidate; enqueued=true;
          return original.call(this,candidate,expedited);
        };
        promise=store.dispatch(api({method:'reactions.add',reason:'a2anotes-receipt',timeout:15,abortSignal:controller.signal,
          args:{channel:input.channel,timestamp:input.ts,name:input.name}}));
      } finally {if(own)Object.defineProperty(queue,'q',own);else delete queue.q;}
      const result=await promise;
      return enqueued && result?.ok===true ? {ok:true,channel:input.channel,ts:input.ts} : {error:'native_delivery_uncertain',definite:false};
    } catch(error) {
      if(!enqueued)return {error:error?.message==='native_account_mismatch'?'native_account_mismatch':'native_interface_changed',definite:true};
      const status=Number(error?.status);
      const code=typeof error?.data?.error==='string'&&/^[a-z_]{1,80}$/.test(error.data.error)?error.data.error:
        [6,7,8].includes(error?.data?.error)?'native_receipt_denied':'';
      if(code==='already_reacted')return {ok:true,channel:input.channel,ts:input.ts};
      let retryAfter=Math.ceil(Number(error?.retryAfter||0)/1000),requestId;
      try {
        const raw=Number(request?._xhr?.getResponseHeader('Retry-After'));
        if(Number.isFinite(raw)&&raw>0)retryAfter=Math.ceil(raw);
        const id=request?._xhr?.getResponseHeader('x-slack-req-id');
        if(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id))requestId=id;
      }catch{}
      const definite=status===429||status>=400&&status<500||!!code&&!['internal_error','fatal_error','_parse_error'].includes(code);
      return {error:code||'native_delivery_uncertain',definite,...(status>=100&&status<=599?{status}:{}),
        ...(status===429||code==='ratelimited'?{retryAfter:Math.max(1,retryAfter||60)}:{}),...(requestId?{requestId}:{})};
    }finally{clearTimeout(timer);}
  }`;
  // Read calls are limited to these methods and argument shapes. Only copied fields leave the renderer.
  const read = `async function(input) {
    'use strict';
    let timer;
    try {
      ${lookup}
      const D = /^D[A-Z0-9]+$/, U = /^[UW][A-Z0-9]+$/, TS = /^\\d+\\.\\d+$/;
      const a = input.args && typeof input.args === 'object' ? input.args : {}, keys = Object.keys(a);
      const only = (...names) => keys.every(k => names.includes(k));
      const limit = v => Number.isInteger(v) && v >= 1 && v <= 200;
      const ts = v => v === undefined || typeof v === 'string' && TS.test(v);
      let valid = false;
      if (input.method === 'conversations.info') valid = only('channel') && D.test(a.channel);
      if (input.method === 'conversations.open') valid = only('users','return_im') && U.test(a.users) && a.return_im === true;
      if (input.method === 'conversations.history') valid = only('channel','limit','latest','oldest','inclusive') && D.test(a.channel) &&
        limit(a.limit) && ts(a.latest) && ts(a.oldest) && (a.inclusive === undefined || a.inclusive === true);
      if (input.method === 'users.info') valid = only('user') && U.test(a.user);
      if (input.method === 'files.info') valid = only('file') && /^F[A-Z0-9]+$/.test(a.file);
      if (input.method === 'users.list') valid = only('limit','cursor') && limit(a.limit) &&
        (a.cursor === undefined || typeof a.cursor === 'string' && /^[A-Za-z0-9=_%:-]{1,300}$/.test(a.cursor));
      if (!valid) return {error:'native_invalid_payload', definite:true};
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 15000);
      const r = await store.dispatch(api({method:input.method, reason:'a2anotes-read', timeout:15, abortSignal:controller.signal, args:{...a}}));
      if (r?.ok !== true) return {error:'native_delivery_uncertain', definite:false};
      const text = v => typeof v === 'string' ? v.slice(0, 200) : '';
      const person = u => u && U.test(u.id) ? {id:u.id, name:text(u.profile?.display_name || u.real_name || u.name || u.id),
        realName:text(u.real_name || u.profile?.real_name), title:text(u.profile?.title),
        active:!u.deleted && !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT'} : undefined;
      const channel = c => c && D.test(c.id) ? {id:c.id, is_im:c.is_im === true, ...(U.test(c.user) ? {user:c.user} : {})} : undefined;
      const message = m => {
        if (!m || !TS.test(m.ts) || !U.test(m.user) || typeof m.text !== 'string' || m.text.length > 64000) return undefined;
        return {user:m.user, text:m.text, ts:m.ts,
          ...(TS.test(m.thread_ts) ? {thread_ts:m.thread_ts} : {}), ...(typeof m.bot_id === 'string' ? {bot_id:m.bot_id.slice(0,40)} : {}),
          ...(typeof m.app_id === 'string' ? {app_id:m.app_id.slice(0,40)} : {}), ...(typeof m.subtype === 'string' ? {subtype:m.subtype.slice(0,40)} : {}),
          ...(typeof m.client_msg_id === 'string' && /^[a-f0-9-]{36}$/i.test(m.client_msg_id) ? {client_msg_id:m.client_msg_id} : {}),
          reactions:(Array.isArray(m.reactions) ? m.reactions.slice(0,50) : []).map(x => ({name:text(x?.name),
            users:Array.isArray(x?.users) ? x.users.filter(u => typeof u === 'string' && U.test(u)).slice(0,100) : []})),
          files:(Array.isArray(m.files) ? m.files.slice(0,5) : []).filter(f => /^F[A-Z0-9]+$/.test(f?.id) &&
            typeof f?.name === 'string' && Number.isInteger(f?.size) && f.size > 0 && f.size <= 2097152)
            .map(f => ({id:f.id,name:f.name.slice(0,200),size:f.size}))};
      };
      const next = typeof r.response_metadata?.next_cursor === 'string' && r.response_metadata.next_cursor ? r.response_metadata.next_cursor.slice(0,300) : undefined;
      let data;
      if (input.method === 'conversations.info' || input.method === 'conversations.open') data = {channel:channel(r.channel)};
      if (input.method === 'conversations.history') data = {messages:(Array.isArray(r.messages) ? r.messages.slice(0,200) : []).map(message).filter(Boolean)};
      if (input.method === 'users.info') data = {user:person(r.user)};
      if (input.method === 'files.info') {
        const f=r.file;
        data={file:f && f.id===a.file && typeof f.name==='string' && Number.isInteger(f.size) &&
          f.size>=1 && f.size<=2097152 && typeof f.url_private_download==='string' ?
          {id:f.id,name:f.name.slice(0,200),size:f.size,url:f.url_private_download} : undefined};
      }
      if (input.method === 'users.list') data = {members:(Array.isArray(r.members) ? r.members.slice(0,200) : []).map(person).filter(Boolean), ...(next ? {next} : {})};
      return {ok:true, data};
    } catch (error) {
      if (error?.message === 'native_account_mismatch' || error?.message === 'native_interface_changed') return {error:error.message, definite:true};
      const status = Number(error?.status);
      const code = typeof error?.data?.error === 'string' && /^[a-z_]{1,80}$/.test(error.data.error) ? error.data.error : '';
      const retryAfter = Math.ceil(Number(error?.retryAfter || 0) / 1000);
      const definite = status === 429 || status >= 400 && status < 500 || !!code && !['internal_error','fatal_error','_parse_error'].includes(code);
      return {error:code || 'native_delivery_uncertain', definite, ...(status>=100 && status<=599 ? {status} : {}),
        ...(status===429 || code==='ratelimited' ? {retryAfter:Math.max(1, retryAfter || 60)} : {})};
    } finally { clearTimeout(timer); }
  }`;
  const file = `async function(input) {
    'use strict';
    let enqueued = false, request, timer;
    try {
      ${lookup}
      const F = /^F[A-Z0-9]+$/, D = /^D[A-Z0-9]+$/, TS = /^\\d+\\.\\d+$/;
      const validUrl = value => {try {const u=new URL(value);return u.protocol==='https:' && u.hostname==='files.slack.com' &&
        u.pathname.startsWith('/upload/') && !u.username && !u.password && !u.hash;}catch{return false;}};
      const name = value => typeof value==='string' && value.length>=1 && value.length<=200 && !/[/\\\\\\x00-\\x1f]/.test(value);
      let method,args;
      if (input.operation==='ticket') {
        if (!name(input.name) || !Number.isInteger(input.length) || input.length<1 || input.length>2097152)
          return {error:'native_invalid_payload',definite:true};
        method='files.getUploadURLExternal';args={filename:input.name,length:input.length};
      } else if (input.operation==='complete') {
        // Private completion: the file belongs to the account and is not shared to any conversation.
        if (!Array.isArray(input.files) || input.files.length<1 || input.files.length>5 ||
          input.files.some(f=>!F.test(f?.id)||!name(f?.title)) || input.channel!==undefined || input.text!==undefined)
          return {error:'native_invalid_payload',definite:true};
        method='files.completeUploadExternal';args={files:input.files};
      } else if (input.operation==='attach') {
        if (!D.test(input.channel) || !TS.test(input.ts) || !/^[a-f0-9-]{36}$/i.test(input.messageId) || typeof input.text!=='string' ||
          input.text.length>39000 || !input.text.includes('A2A Notes data: ') || typeof input.blocks!=='string' ||
          !Array.isArray(input.files) || input.files.length<1 || input.files.length>5 || input.files.some(f=>!F.test(f?.id)||!name(f?.title)))
          return {error:'native_invalid_payload',definite:true};
        const raw=input.text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
        const marker=raw.indexOf('A2A Notes data: ');
        let wire,blocks;
        try {wire=JSON.parse(raw.slice(marker+'A2A Notes data: '.length));blocks=JSON.parse(input.blocks);}catch{return {error:'native_invalid_payload',definite:true};}
        if (typeof wire!=='string' || !wire.startsWith('A2ANotes/1\\nID: '+input.messageId+'\\n') || !Array.isArray(blocks) || blocks.length>50)
          return {error:'native_invalid_payload',definite:true};
        method='chat.update';args={channel:input.channel,ts:input.ts,text:input.text,blocks:input.blocks,file_ids:input.files.map(f=>f.id)};
      } else return {error:'native_invalid_payload',definite:true};
      const original=queue.q,own=Object.getOwnPropertyDescriptor(queue,'q');
      const controller=new AbortController();timer=setTimeout(()=>controller.abort(),20000);
      let promise;
      try {
        queue.q=function(candidate,expedited){
          if(candidate.method!==method) return original.call(this,candidate,expedited);
          const actual=candidate.args||{};
          if(input.operation==='ticket' && (actual.filename!==input.name || Number(actual.length)!==input.length) ||
             input.operation==='complete' && (JSON.stringify(actual.files)!==JSON.stringify(input.files) ||
               actual.channel_id!==undefined || actual.channels!==undefined || actual.initial_comment!==undefined) ||
             input.operation==='attach' && (actual.channel!==input.channel || actual.ts!==input.ts || actual.text!==input.text ||
               actual.blocks!==input.blocks || JSON.stringify(actual.file_ids)!==JSON.stringify(input.files.map(f=>f.id))))
            throw new Error('native_interface_changed');
          const attempts=Object.getOwnPropertyDescriptor(candidate,'_maxAttempts');
          if(!attempts?.writable||!Number.isInteger(attempts.value)||candidate._numberOfAttempts!==0)
            throw new Error('native_interface_changed');
          candidate._maxAttempts=1;request=candidate;enqueued=true;
          return original.call(this,candidate,expedited);
        };
        promise=store.dispatch(api({method,reason:'a2anotes-file-'+input.operation,timeout:20,abortSignal:controller.signal,args}));
      }finally{if(own)Object.defineProperty(queue,'q',own);else delete queue.q;}
      const result=await promise;
      if(!enqueued||result?.ok!==true)return {error:'native_delivery_uncertain',definite:false};
      if(input.operation==='ticket') {
        if(!F.test(result.file_id)||!validUrl(result.upload_url))return {error:'native_delivery_uncertain',definite:false};
        return {ok:true,fileId:result.file_id,url:result.upload_url};
      }
      if(input.operation==='attach')
        return result.channel===input.channel&&result.ts===input.ts?{ok:true,channel:input.channel,ts:input.ts}:{error:'native_delivery_uncertain',definite:false};
      const ids=(Array.isArray(result.files)?result.files:[]).map(f=>f.id);
      return input.files.every(f=>ids.includes(f.id))?{ok:true}:{error:'native_delivery_uncertain',definite:false};
    }catch(error){
      if(!enqueued)return {error:error?.message==='native_account_mismatch'?'native_account_mismatch':'native_interface_changed',definite:true};
      const status=Number(error?.status),code=typeof error?.data?.error==='string'&&/^[a-z_]{1,80}$/.test(error.data.error)?error.data.error:'';
      const headers=request?._xhr,retryHeader=Number(headers?.getResponseHeader?.('Retry-After'));
      const requestId=headers?.getResponseHeader?.('x-slack-req-id');
      const retryAfter=Number.isFinite(retryHeader)&&retryHeader>0?Math.ceil(retryHeader):Math.ceil(Number(error?.retryAfter||0)/1000);
      const definite=status===429||status>=400&&status<500||!!code&&!['internal_error','fatal_error','_parse_error'].includes(code);
      return {error:code||'native_delivery_uncertain',definite,
        ...(status>=100&&status<=599?{status}:{}),
        ...(status===429||code==='ratelimited'?{retryAfter:Math.max(1,retryAfter||60)}:{}),
        ...(typeof requestId==='string'&&/^[A-Za-z0-9-]{1,100}$/.test(requestId)?{requestId}:{})};
    }finally{clearTimeout(timer);}
  }`;
  return { capability, post, react, read, file };
}
export const NATIVE_FUNCTIONS = nativeFunctions();
