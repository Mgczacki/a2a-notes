// The body format that people and agents write, and the parser that each adapter uses to show a body.
// The wire text keeps the body exactly as written. Only the display reads these rules (docs/WRITING-MESSAGES.md):
// - a line that is only a title followed by a colon, or only a title in double asterisks, starts a titled part
// - a blank line separates paragraphs; a single line break inside a paragraph stays a line break
// - a line that starts with -, * or • is a bullet item; a line that starts with a number and . or ) is a numbered item
// - an item indented with two or more spaces more than the item above it is a nested item
// - a line that starts with > is a quote; a block between two ``` lines is preformatted text
// - inside a line: `code`, **bold**, [label](https://...) and a bare https URL; nothing else is read as markup
// Mentions and Slack link markup (@channel, <!here>, <@U123>, <#C123>, <https://x|y>) are never interpreted: an
// adapter shows them as the literal characters.

export type Inline =
  | { type: 'text'; text: string; bold?: true; code?: true }
  | { type: 'link'; url: string; label?: string };
export interface ListItem { level: number; ordered: boolean; number: number; text: string }
export type Node =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string };
export interface Part { title?: string; nodes: Node[] }

const ITEM = /^( *)([-*•]|(\d{1,4})[.)])[ \t]+(\S.*)$/;
const FENCE = /^ {0,3}```/;
const QUOTE = /^ {0,3}> ?(.*)$/;
export const MAX_TITLE = 80;

// A title line: "Title:" alone on its line, or "**Title**" (an optional colon after it). A line with a URL is not a title.
export function titleOf(line: string): string | undefined {
  const t = line.trim();
  const bold = /^\*\*([^*]+)\*\*:?$/.exec(t);
  const text = bold ? bold[1].trim() : /^([^:]+):$/.exec(t)?.[1].trim();
  if (!text || Array.from(text).length > MAX_TITLE || text.includes('://') || ITEM.test(text) || /^[>#|]/.test(text)) return undefined;
  return text;
}

// Splits a body into titled parts of paragraphs, lists, quotes and preformatted blocks.
export function parseBody(body: string): Part[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const parts: Part[] = [{ nodes: [] }];
  let open: Node | undefined;
  // the indent of each open list level, to find the level of the next item
  let indents: number[] = [];
  const add = (node: Node) => { parts[parts.length - 1].nodes.push(node); open = node; };
  const close = () => { open = undefined; indents = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      if (code.length) add({ kind: 'code', text: code.join('\n') });
      close();
      continue;
    }
    if (!line.trim()) { close(); continue; }
    const title = open?.kind === 'paragraph' || open?.kind === 'quote' ? undefined : titleOf(line);
    if (title !== undefined) { parts.push({ title, nodes: [] }); close(); continue; }
    const item = ITEM.exec(line);
    if (item) {
      const indent = item[1].length;
      if (open?.kind !== 'list') { close(); add({ kind: 'list', items: [] }); indents = [indent]; }
      while (indents.length > 1 && indent < indents[indents.length - 1]) indents.pop();
      if (indent > indents[indents.length - 1] + 1 && indents.length < 6) indents.push(indent);
      (open as Extract<Node, { kind: 'list' }>).items.push({ level: indents.length - 1, ordered: !!item[3], number: item[3] ? Number(item[3]) : 0, text: item[4].trim() });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      if (open?.kind === 'quote') open.text += `\n${quote[1]}`; else { close(); add({ kind: 'quote', text: quote[1] }); }
      continue;
    }
    // an indented line under a list item continues that item
    if (open?.kind === 'list' && /^\s/.test(line)) { open.items[open.items.length - 1].text += `\n${line.trim()}`; continue; }
    if (open?.kind === 'paragraph') open.text += `\n${line.trimEnd()}`;
    else { close(); add({ kind: 'paragraph', text: line.trimEnd() }); }
  }
  return parts.filter(p => p.title !== undefined || p.nodes.length);
}

// Only an https URL without user name, password, white space or Slack link characters becomes a link.
export function safeLink(value: string): string | undefined {
  if (!/^https:\/\/[^\s<>|"`]+$/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') ? value : undefined;
  } catch { return undefined; }
}

const INLINE = /`([^`\n]+)`|\[([^\]\n]{1,300})\]\((https:\/\/[^\s()<>|"`]+)\)|(https:\/\/[^\s<>|"`]+)|\*\*([^*\n]+)\*\*/g;

// The spans in a line that are one inline element, so that a split never falls inside a link or code.
export function inlineSpans(text: string) {
  return [...text.matchAll(INLINE)].map(m => ({ start: m.index!, end: m.index! + m[0].length }));
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.type === 'text' && !last.bold && !last.code) last.text += t; else out.push({ type: 'text', text: t });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index!;
    let raw = m[0], tail = '';
    if (m[1] !== undefined) { plain(text.slice(at, start)); out.push({ type: 'text', text: m[1], code: true }); at = start + raw.length; continue; }
    if (m[5] !== undefined) { plain(text.slice(at, start)); out.push({ type: 'text', text: m[5], bold: true }); at = start + raw.length; continue; }
    if (m[3] !== undefined) {
      const url = safeLink(m[3]);
      plain(text.slice(at, start));
      if (url) out.push({ type: 'link', url, label: m[2] }); else plain(raw);
      at = start + raw.length; continue;
    }
    // a bare URL: punctuation at its end belongs to the sentence; a URL inside <...> is Slack markup and stays text
    const trail = /[.,;:!?'")\]]+$/.exec(raw);
    if (trail && !(trail[0].startsWith(')') && raw.includes('('))) { tail = trail[0]; raw = raw.slice(0, -tail.length); }
    const url = text[start - 1] === '<' ? undefined : safeLink(raw);
    plain(text.slice(at, start));
    if (url) out.push({ type: 'link', url }); else plain(raw);
    plain(tail);
    at = start + raw.length + tail.length;
  }
  plain(text.slice(at));
  return out;
}

export const length = (text: string) => Array.from(text).length;

// Splits text into pieces of at most `limit` characters. A piece ends at a line break, then at the end of a
// sentence, then at a space, and never inside a word, a link or code. Only a single word longer than the limit is cut.
export function splitText(text: string, limit: number): string[] {
  const chars = Array.from(text);
  if (chars.length <= limit) return [text];
  const blocked = inlineSpans(text);
  // character offsets of code units: inlineSpans works on string indexes
  const index: number[] = [];
  let unit = 0;
  for (const c of chars) { index.push(unit); unit += c.length; }
  const inside = (u: number) => blocked.some(s => u > s.start && u < s.end);
  const pieces: string[] = [];
  let from = 0;
  while (chars.length - from > limit) {
    let cut = -1;
    for (const rule of [(c: string) => c === '\n', (c: string, prev: string) => c === ' ' && /[.!?]/.test(prev), (c: string) => /\s/.test(c)]) {
      for (let i = from + limit; i > from; i--) if (rule(chars[i], chars[i - 1]) && !inside(index[i])) { cut = i; break; }
      if (cut > from) break;
    }
    if (cut <= from) cut = from + limit;
    pieces.push(chars.slice(from, cut).join('').trimEnd());
    from = cut;
    while (from < chars.length && /\s/.test(chars[from])) from++;
  }
  if (from < chars.length) pieces.push(chars.slice(from).join(''));
  return pieces.filter(Boolean);
}

// ---- warnings for the writer ----

export interface FormatWarning { code: 'heading' | 'table' | 'image' | 'html' | 'slack_markup' | 'mention' | 'nested_format' | 'http_link' | 'long_body'; text: string; start: number; end: number; reason: string }
export const LONG_BODY = 1500;

const lineRules: { code: FormatWarning['code']; pattern: RegExp; reason: string }[] = [
  { code: 'heading', pattern: /^ {0,3}#{1,6}\s+\S/, reason: 'A Markdown heading (#) does not render. Write the title alone on its line with a colon after it, for example "What we found:".' },
  { code: 'table', pattern: /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{3,}:?\s*\|/, reason: 'A table does not render. Write each row as a list item, for example "- Name: value".' },
];
const textRules: { code: FormatWarning['code']; pattern: RegExp; reason: string }[] = [
  { code: 'image', pattern: /!\[[^\]\n]*\]\([^)\n]*\)/g, reason: 'An image does not render. Attach the image as a file, or give its https link.' },
  { code: 'html', pattern: /<\/?(?:b|i|u|s|em|strong|br|p|div|span|a|ul|ol|li|h[1-6]|table|tr|td|code|pre|img)\b[^>\n]*>/gi, reason: 'HTML does not render and shows as text. Use the body format: a title line, - for a list, ** for bold.' },
  { code: 'slack_markup', pattern: /<(?:[@#!][^>\n]*|https?:[^>\n]*)>/g, reason: 'Slack markup shows as plain text and does not mention or link. Write a name in words, and write a link as [label](https://...) or as the bare https URL.' },
  { code: 'mention', pattern: /(?<![\w@])@(?:channel|here|everyone)\b/g, reason: 'A mention shows as plain text and does not notify anyone. Remove it.' },
  { code: 'nested_format', pattern: /\*\*\*[^*\n]+\*\*\*|\*\*_[^_\n]+_\*\*|_\*\*[^*\n]+\*\*_|\*\*`[^`\n]+`\*\*|`\*\*[^*\n]+\*\*`/g, reason: 'Nested formatting does not render. Use one format: **bold** or `code`.' },
  { code: 'http_link', pattern: /(?<![\w/])http:\/\/[^\s<>|"`]+/g, reason: 'Only an https link becomes a link. Use the https address.' },
];

// Markdown and markup that will not render. A warning does not block a draft and does not change who approves it.
export function formatWarnings(body: string): FormatWarning[] {
  const found: FormatWarning[] = [];
  let offset = 0, code = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) code = !code;
    else if (!code) {
      for (const rule of lineRules) if (rule.pattern.test(line)) found.push({ code: rule.code, text: line.trim(), start: offset, end: offset + line.length, reason: rule.reason });
      // the first match of each rule on a line is enough to show the fix
      for (const rule of textRules) for (const m of line.matchAll(rule.pattern)) {
        found.push({ code: rule.code, text: m[0], start: offset + m.index!, end: offset + m.index! + m[0].length, reason: rule.reason });
        break;
      }
    }
    offset += line.length + 1;
  }
  if (length(body) > LONG_BODY) found.push({ code: 'long_body', text: '', start: 0, end: 0,
    reason: `The body has ${length(body)} characters. A person reads a short message with one ask. Keep the body under ${LONG_BODY} characters and move detail to a file or the agent file.` });
  // one heading warning and one table warning are enough for the whole body
  return found.filter((w, i) => (w.code !== 'table' && w.code !== 'heading') || found.findIndex(x => x.code === w.code) === i);
}
