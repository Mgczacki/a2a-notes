// How the Slack adapter shows a message to a person and carries the exact A2ANotes/1 text.
// People see the blocks. Slack shows `text` only in notifications and search when a message has blocks, and it
// replaces each newline in that `text` with a space (observed in a real workspace on 2026-09-30). So `text` holds a
// one-line summary and the A2ANotes/1 text as one JSON string: a JSON string has no raw newline, so it survives.
import { escapeMarkup, unescapeMarkup, type Audience } from './protocol.ts';
import type { Display } from './transport.ts';

export const DATA_MARKER = 'A2A Notes data: ';
// Slack cuts `text` above 40,000 characters; keep room for the summary line
export const MAX_SLACK_TEXT = 39_000;
const SECTION_LIMIT = 2900;

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

export function slackBlocks(d: Display, options: { projectLink?: string } = {}): unknown[] {
  const sender = short(d.senderName, 80) || 'Someone';
  const blocks: unknown[] = [
    { type: 'header', text: plain(short(d.subject, 150)) },
    { type: 'context', elements: [plain(`${reader[d.audience]} · Sent by ${sender} with A2A Notes`)] },
    { type: 'divider' },
  ];
  // plain_text keeps line breaks and never turns text into a mention or a link
  const chars = Array.from(d.body);
  for (let i = 0; i < chars.length && blocks.length < 40; i += SECTION_LIMIT) blocks.push({ type: 'section', text: plain(chars.slice(i, i + SECTION_LIMIT).join('')) });
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
// A2ANotes/1 post without blocks and an old Taskboard message still reach the core decoder.
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
