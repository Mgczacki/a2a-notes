// The local review page for the person. The script builds every element with textContent, so message text never
// becomes markup. Actions send the exact hash that the page showed.
export function reviewPage(signedIn: boolean) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A2A Notes review</title>
<style>
:root { color-scheme: light; --ink:#21302c; --muted:#61716b; --line:#d9e3de; --paper:#f5f8f4; --card:#fff; --green:#0d684f; --green-pale:#e4f3eb; --amber:#8a5515; --amber-pale:#fff1d9; --blue:#235d80; --blue-pale:#e7f1f8; --red:#9b2c2c; --red-pale:#fde8e8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --ink:#e3ece8; --muted:#a4b4ad; --line:#34453f; --paper:#121a17; --card:#1a2420; --green:#4fbf94; --green-pale:#173a2e; --amber:#e3b36b; --amber-pale:#3a2e19; --blue:#8cc2e6; --blue-pale:#17303f; --red:#f09a9a; --red-pale:#3d1c1c; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.48 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
header { padding:22px 16px; background:#163d34; color:#fff; }
header .wrap, main { max-width:1100px; margin:auto; }
header p { margin:4px 0 0; color:#c9ddd3; }
h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; overflow-wrap:anywhere; }
main { padding:20px 16px 50px; display:grid; gap:18px; }
.panel { padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--card); min-width:0; }
.row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.status { display:inline-block; padding:3px 9px; border-radius:99px; font-size:12px; font-weight:700; }
.ok { background:var(--green-pale); color:var(--green); } .wait { background:var(--amber-pale); color:var(--amber); } .info { background:var(--blue-pale); color:var(--blue); } .bad { background:var(--red-pale); color:var(--red); }
.card { padding:14px; border:1px solid var(--line); border-radius:10px; background:var(--card); display:grid; gap:9px; overflow-wrap:anywhere; }
.meta { display:grid; grid-template-columns:110px 1fr; gap:4px 10px; font-size:13px; margin:0; } .meta dt { color:var(--muted); } .meta dd { margin:0; overflow-wrap:anywhere; }
.body { white-space:pre-wrap; padding:10px 12px; border-left:3px solid #9dc5b1; background:var(--paper); border-radius:4px; overflow-wrap:anywhere; }
.flags { margin:0; padding-left:18px; color:var(--amber); font-size:13px; }
.small { font-size:12px; color:var(--muted); }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; background:var(--paper); padding:8px; border-radius:6px; margin:6px 0 0; }
button, select { padding:7px 11px; border:1px solid #9aaca3; border-radius:7px; background:var(--card); color:var(--ink); font:inherit; font-weight:600; cursor:pointer; }
button.primary { background:var(--green); color:#fff; border-color:var(--green); }
button:disabled { opacity:.55; cursor:default; }
button:focus-visible, select:focus-visible { outline:3px solid #72a8d3; outline-offset:2px; }
#messages { display:grid; gap:10px; } #messages > *, .card > *, .meta > *, .panel > * { min-width:0; } #error { color:var(--red); min-height:1em; }
@media (max-width:600px) { .meta { grid-template-columns:1fr; } }
</style></head>
<body>
<header><div class="wrap"><h1>A2A Notes</h1><p id="who">Review messages before they reach an agent or leave this computer.</p></div></header>
<main>
${signedIn ? `
<section class="panel"><h2>Connection</h2><div class="row" id="connection"></div></section>
<section class="panel"><h2>Levels</h2><div class="row" id="levels"></div><p class="small">Level 1: you approve every message. Level 2: your review agent approves ordinary messages to or from trusted senders. Level 3: it also approves trusted messages that the check is unsure about.</p></section>
<section class="panel"><div class="row"><h2 style="margin:0">Messages</h2><button id="sync">Check Slack now</button></div><p id="error" role="alert"></p><div id="messages"></div></section>
<section class="panel"><h2>Recent actions</h2><div id="audit" class="small"></div></section>
<script>
const $ = s => document.querySelector(s);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'onclick') e.onclick = v; else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-a2a-page': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.reason + (data.error.next ? ' ' + data.error.next : '') : 'Request failed');
  return data;
}
const act = fn => async () => { $('#error').textContent = ''; try { await fn(); await load(); } catch (e) { $('#error').textContent = e.message; } };
const stateClass = s => ({ sent: 'ok', approved: 'ok', held: 'wait', draft: 'wait', sending: 'info', delivery_uncertain: 'bad', failed: 'bad', quarantined: 'bad', rejected: 'bad' })[s] || 'info';
function card(m, trusted) {
  const peer = m.direction === 'in' ? m.from : m.to;
  const actions = el('div', { class: 'row' });
  if (m.allowed_actions.includes('approve')) actions.append(el('button', { class: 'primary', onclick: act(() => api('/api/messages/' + m.id + '/decide', { hash: m.hash, decision: 'approve' })) }, 'Approve this version'));
  if (m.allowed_actions.includes('reject')) actions.append(el('button', { onclick: act(() => api('/api/messages/' + m.id + '/decide', { hash: m.hash, decision: 'reject' })) }, 'Reject'));
  if (m.allowed_actions.includes('send')) actions.append(el('button', { class: 'primary', onclick: act(() => api('/api/messages/' + m.id + '/send', { hash: m.hash })) }, m.state === 'delivery_uncertain' ? 'Check and send' : 'Send'));
  if (!m.failure && peer) actions.append(el('button', { onclick: act(() => api('/api/trusted', { address: peer, name: m.peer_name || peer, trusted: !trusted })) }, trusted ? 'Stop trusting sender' : 'Trust sender'));
  return el('article', { class: 'card', 'data-id': m.id },
    el('div', { class: 'row' }, el('h3', {}, m.subject), el('span', { class: 'status ' + stateClass(m.state) }, m.state.replace('_', ' ')), el('span', { class: 'status info' }, 'for ' + m.audience), m.legacy ? el('span', { class: 'status info' }, 'old Taskboard format') : null),
    el('dl', { class: 'meta' },
      el('dt', {}, m.direction === 'in' ? 'From' : 'To'), el('dd', {}, (m.peer_name ? m.peer_name + ' · ' : '') + peer + (trusted ? ' (trusted)' : ' (not trusted)')),
      el('dt', {}, 'Check'), el('dd', {}, m.review ? m.review.verdict + ': ' + m.review.reason : 'not checked'),
      el('dt', {}, 'Approver'), el('dd', {}, m.approver === 'nobody' ? 'nobody: the checks hold this message' : m.approver === 'reviewer' ? 'your review agent or you' : 'you'),
      m.approval ? [el('dt', {}, 'Approved by'), el('dd', {}, m.approval.actor + ' (' + m.approval.by + ') at ' + m.approval.at + (m.approval.current ? '' : ' for an older version'))] : null,
      el('dt', {}, 'Hash'), el('dd', { class: 'small' }, m.hash || 'none')),
    m.body ? el('div', { class: 'body' }, m.body) : null,
    m.body_check && m.body_check.flags.length ? el('ul', { class: 'flags' }, m.body_check.flags.map(f => el('li', {}, f.reason + (f.text && f.code !== 'ask_changed' ? ' Text: “' + f.text + '”' : '')))) : null,
    m.body_check && m.body_check.instruction === 'unavailable' && m.direction === 'out' ? el('p', { class: 'small' }, 'No instruction was given, so the check cannot say that the ask matches it.') : null,
    m.agent_file ? el('p', { class: 'small' }, 'Agent file: ' + m.agent_file.name + ' · ' + m.agent_file.size + ' bytes · SHA-256 ' + m.agent_file.sha256) : null,
    m.agent_file && m.agent_file.data ? el('details', {}, el('summary', {}, 'Show the agent file'), el('pre', {}, JSON.stringify(m.agent_file.data, null, 2))) : null,
    m.files.length ? el('p', { class: 'small' }, 'Files: ' + m.files.map(f => f.name + ' (' + f.size + ' bytes)').join(', ')) : null,
    m.failure ? el('div', {}, el('p', { class: 'status bad' }, m.failure.code), el('p', {}, m.failure.reason), m.failure.raw ? el('details', {}, el('summary', {}, 'Show the received text'), el('pre', {}, m.failure.raw)) : null) : null,
    m.error ? el('p', { class: 'small' }, m.error) : null,
    actions);
}
async function load() {
  const s = await api('/api/state');
  const trusted = new Set(s.policy.trusted.map(t => t.address));
  $('#who').textContent = s.identity.address ? 'Signed in as ' + s.identity.name + ' (' + s.identity.address + ')' : 'Slack is not connected.';
  const c = s.status;
  $('#connection').replaceChildren(...[
    el('span', { class: 'status ' + (c.signed_in ? 'ok' : 'wait') }, c.signed_in ? 'connected' : 'not connected'),
    el('span', { class: 'small' }, 'Last scan: ' + (c.last_scan_at || 'never') + (c.stale ? ' (the inbox may be out of date)' : '')),
    c.last_error ? el('span', { class: 'status bad' }, c.last_error) : null,
    c.missing_scopes.length ? el('span', { class: 'status bad' }, 'Missing Slack scopes: ' + c.missing_scopes.join(', ')) : null,
    c.signed_in ? el('button', { onclick: act(() => api('/api/slack/disconnect', {})) }, 'Disconnect Slack') : el('button', { class: 'primary', onclick: act(async () => { location.href = (await api('/api/slack/connect', {})).url; }) }, 'Connect Slack')].filter(Boolean));
  const level = (name, value) => el('label', {}, name + ' ', el('select', { 'aria-label': name, onchange: undefined }, [1, 2, 3].map(n => el('option', { value: n, selected: n === value }, 'Level ' + n))));
  const inLevel = level('Incoming', s.policy.incoming), outLevel = level('Outgoing', s.policy.outgoing);
  inLevel.querySelector('select').onchange = act(() => api('/api/policy', { incoming: Number(inLevel.querySelector('select').value) }));
  outLevel.querySelector('select').onchange = act(() => api('/api/policy', { outgoing: Number(outLevel.querySelector('select').value) }));
  const bodyCheck = el('label', {}, el('input', { type: 'checkbox', checked: s.policy.checkBody }), ' Check outgoing bodies for internal terms and a changed ask');
  bodyCheck.querySelector('input').onchange = act(() => api('/api/policy', { checkBody: bodyCheck.querySelector('input').checked }));
  $('#levels').replaceChildren(inLevel, outLevel, bodyCheck, el('span', { class: 'small' }, 'Policy version ' + s.policy.version));
  const order = m => m.allowed_actions.includes('approve') || m.allowed_actions.includes('send') || m.state === 'failed' || m.state === 'delivery_uncertain' ? 0 : 1;
  const list = [...s.messages].sort((a, b) => order(a) - order(b));
  $('#messages').replaceChildren(...(list.length ? list.map(m => card(m, trusted.has(m.direction === 'in' ? m.from : m.to))) : [el('p', { class: 'small' }, 'No messages yet.')]));
  $('#audit').replaceChildren(...s.audit.map(a => el('div', {}, a.at + ' · ' + a.actor + ' · ' + a.action + (a.detail ? ' · ' + a.detail : ''))));
}
$('#sync').onclick = act(() => api('/api/sync', {}));
load().catch(e => { $('#error').textContent = e.message; });
setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 15000);
</script>` : `<section class="panel"><h2>Sign in</h2><p>Run <code>a2a-notes open</code> in a terminal. It prints a link that works once, for two minutes.</p></section>`}
</main></body></html>`;
}
