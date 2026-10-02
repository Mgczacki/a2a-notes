# Changelog

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
