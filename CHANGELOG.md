# Changelog

## 0.7.0

- Read explicit direct human messages with `A2A #task` or `A2A @alias` on the first line.
- Accept native owner messages in the verified Slack self-conversation for the current content hash and policy.
- Keep checks and approval requirements for other senders.
- Read owner replies that earlier versions skipped. Keep the original audience and note link.
- Ignore ordinary Slack text and app posts in this flow. Keep action approval separate.
- Use separate owner cursors to recover skipped replies without duplicating notes after a restart.

## 0.6.1

- Interactive HTTP clients can advertise form support with the legacy empty elicitation capability.

## 0.6.0

- `a2anotes_request_approval` asks the human to decide inside an interactive MCP client.
- The form shows the note and attached file hashes without requiring Taskboard or browser approval.
- Registered clients can relay human decisions while their agent role retains its limits.
- HTTP sessions retain client capabilities and correlate form responses with the requesting client.
- Cancel and missing responses make no decision.
- Changed content or rules invalidate an open confirmation.
- Unchanged approved notes keep one approval after retries and restart.
- Incoming acceptance keeps existing audience and privacy rules.

## 0.5.0

- Outgoing approval writes a durable queue record before delivery starts.
- Slack 429 responses record their method and requested wait.
- Later rate limits use capped exponential backoff with jitter.
- Retry status shows the next attempt and final failure.
- Saved upload progress prevents duplicate file shares after retries and restart.
- Uncertain delivery triggers reconciliation instead of another post.
- History pagination resumes after a 429 or restart.
- Explicit human replies preserve the original audience and verified sender.
- Ordinary Slack text supplies no instruction or action approval.
- The service checks policy versions against stored approvals.
- Existing queue records retain their saved deadline during upgrade.
- A data folder permits one service process.

## 0.4.0 (2026-10-02)

- The Slack adapter shows the body as `rich_text` blocks. Version 0.3.0 put the body in `plain_text` section blocks, and the Slack desktop app showed those blocks as one paragraph without line breaks.
- New body format for writers (`src/body-format.ts`, `docs/WRITING-MESSAGES.md`):
  - title lines (`Title:` or `**Title**`)
  - paragraphs and line breaks
  - bullet, numbered, and nested lists
  - quotes and preformatted text
  - `code`, `**bold**`, `[label](https://...)` and bare https links
- Mentions and Slack markup in the body stay literal text.
- A long part splits between paragraphs, sentences, or list items. The blocks stay inside the Slack limits: 50 blocks, 150 characters in a header, 2,900 characters in a body block.
- The body check returns format warnings with the fix for Markdown that does not render. `a2anotes_create_draft` and `a2anotes_revise_draft` show them in the result text. The review page shows them. A warning does not change who approves a draft.
- The MCP tool descriptions of `a2anotes_create_draft` and `a2anotes_revise_draft`, and the `a2anotes://format/1` resource, give the writing rules and the body format.
- The fake Slack Web API rejects blocks outside the Slack limits with `invalid_blocks`.
- No change to the `A2ANotes/1` wire text, the content hash, the Slack `text` field, or the reading of older messages.

## 0.3.0 (2026-10-01)

- Check commands, file text for checks, rejection comments, and person lookup.

## 0.2.0 (2026-10-01)

- Slack sign-in for clients, sender names, the version in `/healthz`, and a build on install.
