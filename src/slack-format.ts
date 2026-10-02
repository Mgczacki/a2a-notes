// How the Slack adapter shows a message to a person and carries the exact A2ANotes/1 text.
// People see the blocks. Slack shows `text` only in notifications and search when a message has blocks, and it
// replaces each newline in that `text` with a space (observed in a real workspace on 2026-09-30). So `text` holds a
// one-line summary and the A2ANotes/1 text as one JSON string: a JSON string has no raw newline, so it survives.
// The body shows as rich_text blocks built from the body format in src/body-format.ts. Version 0.3.0 put the body in
// plain_text section blocks, and the Slack desktop app showed those as one paragraph without line breaks (observed
// on 2026-10-02). A rich_text text element is literal text: Slack does not read mentions or link markup in it.
import { escapeMarkup, unescapeMarkup, type Audience } from './protocol.ts';
import { length, parseBody, parseInline, splitText, type Inline, type ListItem, type Node } from './body-format.ts';
import type { Display } from './transport.ts';

export const DATA_MARKER = 'A2A Notes data: ';
// Slack cuts `text` above 40,000 characters; keep room for the summary line
export const MAX_SLACK_TEXT = 39_000;
// Slack limits: 50 blocks in a message, 150 characters in a header, 3,000 characters in a section text. The body
// keeps each rich_text block under the section limit too, so that every client shows it.
export const MAX_BLOCKS = 50;
export const BLOCK_TEXT_LIMIT = 2900;
// the fixed blocks: header, context, divider, files context, divider, footer context
const FIXED_BLOCKS = 6;

const short = (text: string, limit: number) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
};
const size = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const reader: Record<Audience, string> = { person: 'For you', agent: 'For your agent', both: 'For you and your agent' };
const plain = (text: string) => ({ type: 'plain_text', text, emoji: false });

// The link in the Slack footer that tells a reader what A2A Notes is. Each adapter decides for itself whether it
// shows one. SlackConfig.projectLink changes it, and an empty value hides it.
export const PROJECT_LINK = 'https://github.com/Mgczacki/a2a-notes';

// Only an https URL without Slack link syntax (| < >) can go into the footer link.
export function checkProjectLink(value: unknown): string | undefined {
  if (value === undefined) return PROJECT_LINK;
  if (value === '' || value === null || value === false) return undefined;
  if (typeof value !== 'string' || /[|<>\s]/.test(value)) throw new Error('slack.projectLink must be an https URL, or an empty value to hide the link.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('slack.projectLink must be an https URL, or an empty value to hide the link.');
  return url.href;
}

// ---- the body as rich_text blocks ----

type Rich = Record<string, unknown>;
// One or more rich_text elements that stay in the same block, with their text length.
interface Unit { elements: Rich[]; size: number }

const style = (x: Extract<Inline, { type: 'text' }>) => x.bold || x.code ? { style: { ...(x.bold ? { bold: true } : {}), ...(x.code ? { code: true } : {}) } } : {};
function richInline(items: Inline[]): Rich[] {
  const out: Rich[] = [];
  for (const x of items) {
    if (x.type === 'link') { out.push({ type: 'link', url: x.url, ...(x.label ? { text: x.label } : {}) }); continue; }
    if (!x.text) continue;
    const last = out[out.length - 1];
    // join plain text runs, so a reader of the JSON sees one element for each run
    if (!x.bold && !x.code && last?.type === 'text' && !last.style) last.text += x.text; else out.push({ type: 'text', text: x.text, ...style(x) });
  }
  return out;
}
const sizeOf = (items: Inline[]) => items.reduce((n, x) => n + (x.type === 'link' ? length(x.label || x.url) : length(x.text)), 0);
const section = (elements: Rich[]): Rich => ({ type: 'rich_text_section', elements });

// The pieces of a node that each fit under the limit. A paragraph, a quote or a code block splits between
// sentences or words. A list splits only between items.
function nodeUnits(node: Node, limit: number): Unit[] {
  if (node.kind === 'list') return listUnits(node.items, limit);
  return splitText(node.text, limit).map(text => {
    if (node.kind === 'code') return { elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text }] }], size: length(text) };
    const inline = parseInline(text);
    return { elements: [{ type: node.kind === 'quote' ? 'rich_text_quote' : 'rich_text_section', elements: richInline(inline) }], size: sizeOf(inline) };
  });
}

function listUnits(items: ListItem[], limit: number): Unit[] {
  // a single item longer than the limit is the only case where an item becomes two items
  const flat = items.flatMap(item => splitText(item.text, limit).map(text => ({ ...item, text })));
  const units: Unit[] = [];
  let unit: Unit = { elements: [], size: 0 };
  // the count of items so far at each level, so that numbering continues after a nested list or a split
  const seen: number[] = [];
  let run: Rich | undefined, runKey = '';
  for (const item of flat) {
    const inline = parseInline(item.text), size = sizeOf(inline);
    if (unit.size && unit.size + size > limit) { units.push(unit); unit = { elements: [], size: 0 }; run = undefined; }
    seen.length = item.level + 1;
    const count = seen[item.level] ?? 0;
    const key = `${item.level}:${item.ordered}`;
    if (!run || runKey !== key) {
      const offset = item.ordered ? Math.max(item.number - 1, count) : 0;
      run = { type: 'rich_text_list', style: item.ordered ? 'ordered' : 'bullet', indent: item.level, ...(offset ? { offset } : {}), elements: [] };
      runKey = key;
      unit.elements.push(run);
    }
    (run.elements as Rich[]).push(section(richInline(inline)));
    seen[item.level] = item.ordered ? Math.max(item.number, count + 1) : count + 1;
    unit.size += size;
  }
  if (unit.elements.length) units.push(unit);
  return units;
}

// The units of one titled part. Paragraphs that follow each other share one rich_text_section with a blank line
// between them. The title is bold text on the first line of the part.
function partUnits(title: string | undefined, nodes: Node[], limit: number): Unit[] {
  const units: Unit[] = [];
  for (const node of nodes) {
    for (const unit of nodeUnits(node, limit)) {
      const last = units[units.length - 1];
      const joinable = node.kind === 'paragraph' && last?.elements.length === 1 && last.elements[0].type === 'rich_text_section';
      if (joinable && last.size + 2 + unit.size <= limit) {
        (last.elements[0].elements as Rich[]).push({ type: 'text', text: '\n\n' }, ...(unit.elements[0].elements as Rich[]));
        last.size += 2 + unit.size;
      } else units.push(unit);
    }
  }
  if (title !== undefined) {
    const heading = [{ type: 'text', text: title, style: { bold: true } }];
    const first = units[0];
    if (first?.elements.length === 1 && first.elements[0].type === 'rich_text_section' && first.size + length(title) + 1 <= limit) {
      first.elements[0].elements = [...heading, { type: 'text', text: '\n' }, ...(first.elements[0].elements as Rich[])];
      first.size += length(title) + 1;
    } else units.unshift({ elements: [section(heading)], size: length(title) });
  }
  // join plain text runs again after the joins above
  for (const unit of units) for (const element of unit.elements) if (element.type === 'rich_text_section') element.elements = merge(element.elements as Rich[]);
  return units;
}
function merge(elements: Rich[]) {
  const out: Rich[] = [];
  for (const e of elements) {
    const last = out[out.length - 1];
    if (e.type === 'text' && !e.style && last?.type === 'text' && !last.style) last.text = `${last.text}${e.text}`; else out.push({ ...e });
  }
  return out;
}

// Packs units into rich_text blocks: each titled part starts a new block, and a block holds at most `limit`
// characters. When the parts need more than maxBlocks blocks, the parts share blocks. When even that is too many,
// the last block says that the rest is in A2A Notes.
export function bodyBlocks(body: string, maxBlocks = MAX_BLOCKS - FIXED_BLOCKS, limit = BLOCK_TEXT_LIMIT): Rich[] {
  const parts = parseBody(body).map(p => partUnits(p.title, p.nodes, limit));
  const pack = (shared: boolean) => {
    const blocks: Unit[] = [];
    for (const units of parts) units.forEach((unit, i) => {
      const last = blocks[blocks.length - 1];
      if (last && (shared || i > 0) && last.size + unit.size <= limit) { last.elements.push(...unit.elements); last.size += unit.size; }
      else blocks.push({ elements: [...unit.elements], size: unit.size });
    });
    return blocks;
  };
  let blocks = pack(false);
  if (blocks.length > maxBlocks) blocks = pack(true);
  if (blocks.length > maxBlocks) blocks = [...blocks.slice(0, maxBlocks - 1), { elements: [section([{ type: 'text', text: 'The message is too long to show here in full. Open it in A2A Notes to read the rest.', style: { italic: true } }])], size: 0 }];
  // an empty body cannot reach Slack (protocol.checkBody), but a block needs at least one element
  if (!blocks.length) blocks.push({ elements: [section([{ type: 'text', text: ' ' }])], size: 1 });
  return blocks.map(b => ({ type: 'rich_text', elements: b.elements }));
}

export function slackBlocks(d: Display, options: { projectLink?: string } = {}): unknown[] {
  const sender = short(d.senderName, 80) || 'Someone';
  const blocks: unknown[] = [
    { type: 'header', text: plain(short(d.subject, 150)) },
    { type: 'context', elements: [plain(`${reader[d.audience]} · Sent by ${sender} with A2A Notes`)] },
    { type: 'divider' },
  ];
  blocks.push(...bodyBlocks(d.body, MAX_BLOCKS - FIXED_BLOCKS));
  const attached = [
    ...(d.agentFile ? [`Agent request for the reader's agent: ${short(d.agentFile.name, 90)} (${size(d.agentFile.size)})`] : []),
    ...d.files.map(f => `File: ${short(f.name, 90)} (${size(f.size)})`),
  ];
  if (attached.length) blocks.push({ type: 'context', elements: attached.slice(0, 10).map(plain) });
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [plain(d.audience === 'person'
    ? `To reply, send an A2A Notes message to ${sender}.`
    : `Your agent can read this message after you approve it in A2A Notes. To reply, send an A2A Notes message to ${sender}.`),
    // mrkdwn is the only element type that shows a link; the label is fixed text, never message text
    ...(options.projectLink ? [{ type: 'mrkdwn', text: `<${options.projectLink}|Get A2A Notes>` }] : [])] });
  return blocks;
}

// The `text` field: a summary line for notifications, then the exact A2ANotes/1 text as a JSON string.
// The whole field gets markup escapes so that no mention or link becomes active.
export function slackText(wire: string, d: Display) {
  return escapeMarkup(`${short(d.subject, 100)} · from ${short(d.senderName, 60) || 'someone'} with A2A Notes\n${DATA_MARKER}${JSON.stringify(wire)}`);
}

// Reads the A2ANotes text from a Slack message `text`. Text without the data marker is returned as it is, so an
// A2ANotes/1 post without blocks still reaches the core decoder.
export function readSlackText(raw: string): { text: string } | { error: string } {
  const text = unescapeMarkup(raw);
  const marker = `${DATA_MARKER}"`;
  if (!text.includes(marker)) return { text };
  // the subject in the summary line can contain the marker: the data is where the rest of the text is one JSON string
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    try {
      const value = JSON.parse(text.slice(at + DATA_MARKER.length).trimEnd());
      if (typeof value === 'string') return { text: value };
    } catch { /* try the next marker */ }
  }
  return { error: 'The A2A Notes data in this Slack message is not a complete JSON string.' };
}
