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
}
export interface NativeResult { ok?: boolean; ready?: boolean; channel?: string; ts?: string; error?: string; definite?: boolean; status?: number; retryAfter?: number; requestId?: string }

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
      if (!/^D[A-Z0-9]+$/.test(input.channel) || !/^[a-f0-9-]{36}$/i.test(input.messageId) ||
          typeof input.text !== 'string' || input.text.length > 39000 ||
          typeof input.blocks !== 'string' || input.threadTs && !/^\\d+\\.\\d+$/.test(input.threadTs))
        return {error:'native_invalid_payload', definite:true};
      const raw = input.text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
      const marker = raw.indexOf('A2A Notes data: ');
      let wire, blocks;
      try { wire = marker >= 0 ? JSON.parse(raw.slice(marker + 'A2A Notes data: '.length)) : raw; blocks = JSON.parse(input.blocks); }
      catch {return {error:'native_invalid_payload', definite:true};}
      if (typeof wire !== 'string' || !wire.startsWith('A2ANotes/1\\nID: ' + input.messageId + '\\n'))
        return {error:'native_invalid_payload', definite:true};
      if (!Array.isArray(blocks) || blocks.length > 50) return {error:'native_invalid_payload', definite:true};
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
        promise = store.dispatch(api({method:'chat.postMessage', reason:'a2anotes-approved-note', timeout:15, abortSignal:controller.signal,
          args:{channel:input.channel, text:input.text, blocks:input.blocks, client_msg_id:input.messageId,
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
  return { capability, post };
}
export const NATIVE_FUNCTIONS = nativeFunctions();
