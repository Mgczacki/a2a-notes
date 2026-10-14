# Changelog

## 0.13.0

- Send supporting Markdown files as visible Slack attachments through the signed-in app adapter.
- Send file bytes to a signed `files.slack.com` upload URL from the adapter host. This is the only direct Slack HTTP request.
- Keep agent request data inline. Check the 26,000-byte inline limit, 2 MiB file limit, and 39,000-byte text limit before approval.
- Save the file ID and upload phase without the URL. Check the posted message ID, file names, sizes, and downloaded hashes.
- Post file notes with the formatted display blocks. Complete files privately, post the note, and attach the files with `chat.update`.
- Start a new ticket after a lost binary upload or failed private completion.
- Save the posted note timestamp. A later attempt only attaches the files and never posts the note again.
- Save each file method's rate limit and request ID.
- Permit `files.info` to read the metadata for a received attachment.

## 0.12.0

- Stop operating the Slack window. The adapter no longer navigates, types in the composer, or clicks controls.
- Read conversations, members, and messages through the app's own API client in the background.
- Permit only `conversations.info`, `conversations.open`, `conversations.history`, `users.info`, and `users.list` for reads.
- Post delivery notices through the native `chat.postMessage` call with the operation ID as the client message ID.
- Stop before posting when native sending is off or unavailable. No composer fallback remains.
- Save the send checkpoint before the first read, so a lost read returns the note to the queue.

## 0.11.3

- Read current Slack Message records from their `msg` field.
- Match receipt and thread controls against the same message records.
- Confirm receipt through the verified app SDK when native sending is selected.
- Give receipt requests one SDK attempt and preserve their method limit across restart.
- Keep receipt confirmation separate from acceptance and action approval.

## 0.11.2

- Queue the same approved note after a verified app failure before posting.
- Preserve the approval and saved file progress during that retry.
- Refuse uncertain delivery or a saved native attempt that could have posted.
- Wait for the selected native sender after navigation.
- Add a retry tool and a retry button to the review page.

## 0.11.1

- Read verified member names from current Slack avatar records.
- Navigate to the verified direct conversation instead of a member profile URL.
- Wait for account loading while still rejecting a confirmed account change.
- Reconnect native posting after Slack clears the renderer context.

## 0.11.0

- Combine the app-only transport with optional native SDK posting.
- Keep app account binding and acknowledgement without OAuth.
- Check the native API code and current account before posting.
- Store native attempts and receipts before returning delivery results.
- Give each native request one SDK attempt and let A2A Notes control retries.
- Keep Retry-After across restart and recover uncertain posts without a duplicate.
- Preserve small inline attachments in the original message.
- Keep app controls as the fallback only before a known native attempt.
- Preserve current human replies and approval rules.

## 0.10.0

- Replace production Slack Web API operations with desktop app operations.
- Bind the account without reading OAuth credentials.
- Verify app views before sending text or acknowledging receipt.
- Confirm outgoing message IDs and existing reactions through app records.
- Remove OAuth tools and callbacks.
- Preserve old data and credentials for rollback.
- Carry small attachments in the original message and verify their sender and hash.
- Fail oversized attachments before posting.
- Keep loopback API fixtures for protocol regression tests only.

## 0.9.0

- Add generic receipt acknowledgement through `a2anotes_ack`.
- Store native intake and pending acknowledgement in one write.
- Post the configured Slack reaction. The default is ✅.
- Retry uncertain reaction responses without creating reply notes.
- Keep acknowledgement separate from acceptance and action approval.
- Show acknowledgement errors and retries on the review page.
- Report agent delivery failures through fixed Slack notices without exposing task details.
- Reconcile uncertain notices before another post.
- Handle check commands that close their input without stopping the service.


## 0.8.1

- Recheck the Slack port owner before each new debugger connection.
- Refuse a replacement target if another process takes the listener while an older socket remains open.

## 0.8.0

- Connect to the installed macOS Slack app through an optional loopback debugging port.
- Verify the port owner and the current account before reading native WebSocket events.
- Save explicit DM events before the existing service checks and reads them.
- Prevent duplicate notes across desktop events, history polling, and restarts.
- Reduce history polling to five-minute recovery scans while the verified native connection remains open.
- Show desktop connection status through the current status command and MCP tool.
- Add desktop setup and probe commands. The probe delivers no notes.
- Keep current content checks and action approval rules. Outgoing sends retain Web API limits and the durable queue.

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
