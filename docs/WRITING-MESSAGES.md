# Writing A2A Notes messages

This guide is for people and agents that write the body of an A2A Notes message. The body goes to the reader exactly as you write it. The Slack adapter shows it with a small set of format rules. Other adapters can use the same rules from `src/body-format.ts`.

## What to write

The reader has none of your context. The reader did not see your files, your task, or your chat. Write these items, in this order:

- Why the reader gets this message.
- The facts the reader needs to act.
- One ask: the one thing that you want the reader to do.
- A date, if the ask has one.
- Links that the reader needs and can open. Say when access may be limited.

Keep the body under 1,500 characters. The draft check gives a `long_body` warning above that length. Put details in a file or in the agent file.

Do not write these items:

- your next steps or your plan
- task numbers, tool names, local file paths, or names of work folders
- secrets or keys
- other tasks or people that the reader does not need

## Format rules

The display reads only these rules. All other text shows as you wrote it.

| You write | The reader sees |
| --- | --- |
| A line that is only a title with a colon after it, for example `What we found:` | A bold title that starts a new part |
| A line that is only `**What we found**` | A bold title that starts a new part |
| A blank line | A new paragraph |
| A single line break inside a paragraph | A line break |
| A line that starts with `- `, `* ` or `• ` | A bullet item |
| A line that starts with a number and `. ` or `) `, for example `1. ` | A numbered item |
| An item indented two or more spaces more than the item above it | A nested item |
| A line that starts with `> ` | A quote |
| Lines between two lines of three backticks (```) | Preformatted text, shown exactly |
| `` `code` `` inside a line | Code text |
| `**bold**` inside a line | Bold text |
| `[label](https://example.com/page)` | A link with your label |
| A bare `https://` address | A link. A period or bracket at its end stays outside the link. |

A title line must be alone on its line, at the start of a part or after a blank line. It has at most 80 characters and no `://`. A line with a colon inside a paragraph is not a title.

## What does not render

These items show as plain characters. The draft check gives a format warning with the fix for each one:

- A Markdown heading with `#` or `##`. Write `Title:` on its own line.
- A table. Write each row as a list item, for example `- Name: value`.
- An image, `![alt](url)`. Attach the image as a file, or give its https link.
- HTML, for example `<b>` or `<br>`.
- Nested formatting, for example `***text***` or `**_text_**`. Use one format.
- An `http://` link. Only an https link becomes a link.
- Slack markup: `<@U123>`, `<#C123>`, `<!here>` and `<https://example.com|label>`.
- A mention: `@channel`, `@here` or `@everyone`.

A mention never notifies anyone. A2A Notes never turns message text into a mention, a channel link, or a link to an address that is not https. This rule protects the reader from a message that pings a whole channel.

A format warning does not block the draft. It does not change who approves the draft. The fixed body rules still flag a code name in backticks (`code_term`), because a person may not know the name.

## Example of a good body

```
Why you are getting this:
You own the Create page, and this change records where each new game comes from.

What we found:
- A new game now records the game and the version that sent the player.
- The source is now recorded with the first chat message, not when the page loads.

What we need from you:
Please review the two pull requests below by Friday 9 October.

Links:
- [Frontend change](https://github.com/example/frontend/pull/2739)
- [Backend change](https://github.com/example/backend/pull/833)
```

This body has four titled parts, one ask, a date, and one link on each list line.

## Example of a bad body

```
## Context
As discussed in task #167, I updated `referrer_source` in /Users/me/work/app.

| PR | Status |
|----|--------|
| 2739 | open |

My next step is to check the funnel. @channel please look at https://github.com/example/frontend/pull/2739 https://github.com/example/backend/pull/833
```

This body has these problems:

- `## Context` and the table do not render.
- The reader does not know task #167 or the local path. The check flags both.
- "My next step" is the sender's own work. The check flags it.
- `@channel` does not notify anyone.
- The ask "please look at" does not say what the reader must do or by when.
- Two links on one line are hard to read. Put each link on its own list line.

## How Slack shows a message

The Slack adapter (`src/slack-format.ts`) builds these blocks:

- a header with the subject, cut at 150 characters
- a context line with the reader and the sender name
- the body as `rich_text` blocks, one block for each titled part
- a context line with the agent file and the other files
- a footer about replies

A `rich_text` block holds at most 2,900 characters. A longer part splits between paragraphs, between sentences, or between list items. A split never falls inside a word, a link, or code. A numbered list keeps its numbers after a split. A message has at most 50 blocks. When the parts need more blocks, they share blocks. When the body still does not fit, the last block says that the rest is in A2A Notes.

The `text` field of the Slack message is not what the reader sees. It holds a one-line summary for notifications and the exact A2ANotes/1 text for the receiving service.
