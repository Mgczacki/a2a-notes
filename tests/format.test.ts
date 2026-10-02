// The body format (src/body-format.ts) and the Slack rich_text blocks (src/slack-format.ts).
// Each test shows the blocks JSON that Slack receives, so a reader can see the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWarnings, parseBody, parseInline, splitText } from '../src/body-format.ts';
import { bodyBlocks, slackBlocks, BLOCK_TEXT_LIMIT, MAX_BLOCKS } from '../src/slack-format.ts';
import { checkOutgoingBody } from '../src/checks.ts';

const text = (t: string, style?: Record<string, boolean>) => ({ type: 'text', text: t, ...(style ? { style } : {}) });
const bold = (t: string) => text(t, { bold: true });
const sectionOf = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });
const rich = (...elements: unknown[]) => ({ type: 'rich_text', elements });
const list = (style: 'bullet' | 'ordered', indent: number, items: unknown[][], offset?: number) =>
  ({ type: 'rich_text_list', style, indent, ...(offset ? { offset } : {}), elements: items.map(i => sectionOf(...i)) });
// the text that a block shows, for size checks
const shown = (value: unknown): string => Array.isArray(value) ? value.map(shown).join('') :
  value && typeof value === 'object' ? ((value as any).type === 'link' ? (value as any).text ?? (value as any).url : (value as any).text !== undefined && typeof (value as any).text === 'string' ? (value as any).text : shown((value as any).elements ?? [])) : '';

test('titles, paragraphs, line breaks and a list become one rich_text block for each titled part', () => {
  const body = 'Hi Alex,\nthe report is ready.\n\nWhy you are getting this:\nYou own the release.\n\nSecond paragraph.\n\n**Links**\n- https://example.test/a\n- the plan: https://example.test/b.';
  assert.deepEqual(bodyBlocks(body), [
    rich(sectionOf(text('Hi Alex,\nthe report is ready.'))),
    rich(sectionOf(bold('Why you are getting this'), text('\nYou own the release.\n\nSecond paragraph.'))),
    rich(sectionOf(bold('Links')), list('bullet', 0, [
      [{ type: 'link', url: 'https://example.test/a' }],
      [text('the plan: '), { type: 'link', url: 'https://example.test/b' }, text('.')],
    ])),
  ]);
});

test('the message that showed as one paragraph in Slack keeps its line breaks and its links', () => {
  // the body that a Taskboard task wrote on 2026-10-02, shortened; title lines without a colon stay plain lines
  const body = 'Why you are getting this\nMario asked me to send you this change.\n\nWhat we need from you\nPlease review this.\n\nLinks\n- https://github.com/example/frontend/pull/2739 https://github.com/example/backend/pull/833';
  assert.deepEqual(bodyBlocks(body), [rich(
    sectionOf(text('Why you are getting this\nMario asked me to send you this change.\n\nWhat we need from you\nPlease review this.\n\nLinks')),
    list('bullet', 0, [[{ type: 'link', url: 'https://github.com/example/frontend/pull/2739' }, text(' '), { type: 'link', url: 'https://github.com/example/backend/pull/833' }]]),
  )]);
});

test('nested and numbered lists keep their levels and their numbers', () => {
  const body = 'Steps:\n1. Build\n2. Test\n  - unit tests\n  - the Slack check\n    * one level deeper\n3. Release\n\n5) Five\n6) Six';
  assert.deepEqual(bodyBlocks(body), [rich(
    sectionOf(bold('Steps')),
    list('ordered', 0, [[text('Build')], [text('Test')]]),
    list('bullet', 1, [[text('unit tests')], [text('the Slack check')]]),
    list('bullet', 2, [[text('one level deeper')]]),
    // the numbering continues after the nested list
    list('ordered', 0, [[text('Release')]], 2),
    list('ordered', 0, [[text('Five')], [text('Six')]], 4),
  )]);
  // an indented line under an item continues the item
  assert.deepEqual(parseBody('- first\n  more text\n- second')[0].nodes, [{ kind: 'list', items: [
    { level: 0, ordered: false, number: 0, text: 'first\nmore text' }, { level: 0, ordered: false, number: 0, text: 'second' }] }]);
});

test('links: a bare https URL, a labeled link, and nothing else becomes a link', () => {
  assert.deepEqual(parseInline('See https://example.test/a?b=1&c=2, then [the plan](https://example.test/plan).'), [
    { type: 'text', text: 'See ' }, { type: 'link', url: 'https://example.test/a?b=1&c=2' }, { type: 'text', text: ', then ' },
    { type: 'link', url: 'https://example.test/plan', label: 'the plan' }, { type: 'text', text: '.' }]);
  // a URL in brackets keeps its closing bracket outside the link
  assert.deepEqual(parseInline('(https://example.test/x)'), [{ type: 'text', text: '(' }, { type: 'link', url: 'https://example.test/x' }, { type: 'text', text: ')' }]);
  for (const inert of ['http://example.test/a', '<https://example.test|click>', '[x](http://example.test)', '[x](javascript:alert(1))', 'https://user:pw@example.test/a', 'https://localhost/a', 'ftp://example.test'])
    assert.ok(parseInline(inert).every(x => x.type === 'text'), inert);
});

test('code, bold, a quote and a preformatted block', () => {
  const body = 'Run `pnpm test` and **stop** on a failure.\n> Quoted line one\n> line two\n```\nconst a = "<b>";\n  indented\n```';
  assert.deepEqual(bodyBlocks(body), [rich(
    sectionOf(text('Run '), text('pnpm test', { code: true }), text(' and '), bold('stop'), text(' on a failure.')),
    { type: 'rich_text_quote', elements: [text('Quoted line one\nline two')] },
    { type: 'rich_text_preformatted', elements: [text('const a = "<b>";\n  indented')] },
  )]);
});

test('mentions, Slack markup, <, >, &, | and emoji stay literal text', () => {
  const body = 'Hi @channel <!here> <!everyone> <@U123ABC> <#C123|general> <https://evil.test|login> a & b < c > d | e 🎉 :tada: *x* _y_ ~z~';
  // one plain text element: no mention, channel, broadcast or link element, and no &amp; escapes
  assert.deepEqual(bodyBlocks(body), [rich(sectionOf(text(body)))]);
  const all = JSON.stringify(slackBlocks({ subject: '<!channel> & co', body, audience: 'person', senderName: '<@U1>', files: [] }));
  assert.ok(!/"type":"(?:user|channel|broadcast|usergroup|emoji)"/.test(all));
  assert.ok(!all.includes('&amp;') && !all.includes('&lt;'));
});

test('an empty body and a one-line body', () => {
  assert.deepEqual(bodyBlocks(''), [rich(sectionOf(text(' ')))]);
  assert.deepEqual(bodyBlocks('Hi Alex, please confirm the date.'), [rich(sectionOf(text('Hi Alex, please confirm the date.')))]);
  assert.deepEqual(bodyBlocks('Only a title:'), [rich(sectionOf(bold('Only a title')))]);
});

test('a long paragraph splits between sentences and never inside a word or a link', () => {
  const sentence = 'The source game is now recorded with the first chat message and https://example.test/very/long/link. ';
  const body = sentence.repeat(80).trim();
  const blocks = bodyBlocks(body);
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.ok(Array.from(shown(b)).length <= BLOCK_TEXT_LIMIT);
  // every piece ends at the end of a sentence, and the words are the same as in the body
  for (const b of blocks) assert.match(shown(b), /\.$/);
  assert.equal(blocks.map(shown).join(' '), body);
  assert.equal(JSON.stringify(blocks).split('"type":"link"').length - 1, 80, 'each link is whole');
  // a single word longer than the limit is the only case that is cut
  assert.deepEqual(splitText('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  assert.deepEqual(splitText('one two three', 8), ['one two', 'three']);
});

test('a long list splits only between items, and the numbers continue', () => {
  const body = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${'item text '.repeat(10)}${i + 1}`).join('\n');
  const blocks = bodyBlocks(body) as any[];
  assert.ok(blocks.length > 1);
  let next = 0;
  for (const b of blocks) {
    assert.ok(Array.from(shown(b)).length <= BLOCK_TEXT_LIMIT);
    const l = b.elements[0];
    assert.equal(l.type, 'rich_text_list');
    assert.equal(l.offset ?? 0, next, 'the first number of each block follows the last block');
    next += l.elements.length;
    assert.match(shown(l.elements[l.elements.length - 1]), new RegExp(` ${next}$`), 'an item is never cut');
  }
  assert.equal(next, 60);
});

test('the blocks stay inside the Slack limits: 50 blocks, 150 characters in a header', () => {
  const many = Array.from({ length: 200 }, (_, i) => `Part ${i}:\nText ${i}.`).join('\n\n');
  const blocks = slackBlocks({ subject: 'S'.repeat(400), body: many, audience: 'both', senderName: 'Mario', files: [{ name: 'a.pdf', size: 10 }], agentFile: { name: 'r.json', size: 5 } }, { projectLink: 'https://example.test' }) as any[];
  assert.ok(blocks.length <= MAX_BLOCKS);
  assert.equal(Array.from(blocks[0].text.text as string).length, 150);
  // the parts share blocks when each part in its own block would be too many
  assert.ok(blocks.filter(b => b.type === 'rich_text').length < 200);
  assert.match(JSON.stringify(blocks), /Part 199/);
  // a body that needs more than the blocks allow ends with a note
  const huge = bodyBlocks(Array.from({ length: 30 }, () => 'word '.repeat(560)).join('\n\n'), 5) as any[];
  assert.equal(huge.length, 5);
  assert.match(JSON.stringify(huge[4]), /too long to show here in full/);
});

test('format warnings name Markdown that does not render and give the fix', () => {
  const body = '# Summary\n| a | b |\n|---|---|\n![chart](https://example.test/c.png)\n<b>bold</b>\n<https://example.test|link>\n@here please\n***very***\nhttp://example.test\n```\n# not a heading in code\n```';
  assert.deepEqual(formatWarnings(body).map(w => w.code), ['heading', 'table', 'image', 'html', 'slack_markup', 'mention', 'nested_format', 'http_link']);
  assert.match(formatWarnings('## Ask')[0].reason, /Write the title alone on its line with a colon/);
  assert.deepEqual(formatWarnings('Why you get this:\nText with **bold**, `code` and https://example.test.\n- item'), []);
  assert.deepEqual(formatWarnings('x'.repeat(1501)).map(w => w.code), ['long_body']);
  // a warning is not a body flag: it does not change who approves the draft
  const check = checkOutgoingBody('# Report\nHi Alex, the report is ready.');
  assert.equal(check.flags.length, 0);
  assert.equal(check.warnings![0].code, 'heading');
});
