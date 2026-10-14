# A2A Notes

A2A Notes sends messages between people and their agents over Slack direct messages. One service runs for each person on that person's computer. The service stores messages, runs checks, applies approval rules, and scans Slack. Agents use it through an MCP server. The person approves messages on a local review page.

The wire format is `A2ANotes/1`. The agent file format is `a2anotes.request/1`. The name A2A Notes is provisional. It does not claim compatibility with the A2A protocol.

## What the package contains

- `src/protocol.ts`: the `A2ANotes/1` codec and the `a2anotes.request/1` agent file checks.
- `src/body-format.ts`: the body format that writers use, its parser, and the format warnings.
- `src/slack-format.ts`: the Slack blocks and the Slack `text` field.
- `src/checks.ts`: the body check for outgoing drafts and the content check for both directions.
- `src/policy.ts`: approval levels 1, 2, and 3.
- `src/service.ts`: drafts, files, approvals, sends, the inbox, and the Slack scan.
- `src/slack.ts`: the Slack transport adapter. It uses the signed-in Slack Desktop app without Web API calls.
- `src/mcp.ts` and `src/http.ts`: the MCP server on loopback Streamable HTTP, the review page, and the page API.
- `src/bridge.ts`: a stdio bridge for command-line agents.
- `src/fake-slack.ts`: a fake Slack Web API for tests and sandboxes.
- `src/slack-desktop.ts`: a connector for native Slack Desktop events on macOS.

See [Slack Desktop setup](docs/SLACK-DESKTOP.md) for account connection and app requirements.
The connector keeps the existing sender checks and action approval rules.

## Install and start

Slack Desktop must run on macOS with a loopback debugging port.
No registered Slack app or OAuth token is required.

- Install the package with `pnpm install` and `pnpm build`.
- Write settings with `a2a-notes init --team-id <Slack workspace ID> --port 4460`.
- Start the service with `a2a-notes serve`.
- Open the review page with the link from `a2a-notes open`.
- Use Connect Slack Desktop to verify the signed-in app account.

The default app endpoint is `http://127.0.0.1:19322`.
Use `--desktop-url` during init to change it.
See `docs/SLACK-DESKTOP.md` for the app start command.

The data folder defaults to `~/.a2a-notes`.
`A2A_NOTES_DIR` and `--dir` can select another folder.
The account binding lives in `slack-app-account.json` and contains no credentials.
The package ignores old `slack-credentials.json` files and preserves them for rollback.

## Connect an agent

A command-line agent starts the stdio bridge as an MCP server:

```json
{ "mcpServers": { "a2a-notes": { "command": "a2a-notes", "args": ["bridge"], "env": { "A2A_NOTES_TOKEN": "<agent token>" } } } }
```

A client that supports Streamable HTTP connects to `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <token>`. The service refuses a request without a token, a request with a Host header that is not loopback, and a browser request from another origin.

## Approve inside a coding client

Use `a2anotes_request_approval` to review a note inside an interactive MCP client.
This flow works over Streamable HTTP and the stdio bridge.
Taskboard and the browser review page are not required for this decision.
The local service must still run.

Register a trusted client with `a2a-notes token add <name> --role agent --human-approval`.
Use that token in the MCP configuration above.
Existing agent tokens retain their current permissions.
The new permission lets the client relay a human decision through an MCP form.
It does not let the agent call `a2anotes_approve` directly or change policy.

The flow follows these steps:

- The agent creates a draft and receives its ID and hash.
- The agent calls `a2anotes_request_approval` with `id` and `expected_hash`.
- The service asks the client to display a form to the human.
- The form shows the exact note and attached file hashes.
- The human selects approve or reject in that form.
- The service checks the note and current rules again.
- Outgoing approval enters the durable queue. Incoming approval accepts text for reading under its existing audience rules.

Cancel or decline leaves the note undecided.
A response must arrive within five minutes.
Changed content or rules invalidate the open form.
A revoked client permission also prevents approval.
An unchanged approved note does not open another form after retries or restart.

### Retry after an app failure before posting

`a2anotes_retry_send` queues the same note under its current approval.
Only a person or reviewer session can request this retry.
An agent cannot use this tool to send a note.

The retry requires these conditions:

- The recorded failure occurred before posting.
- The failure reports unavailable app controls.
- The content hash still matches the approval.
- The current policy still permits that approval.
- The saved file bytes still match their hashes.
- The connected sender still matches the note.
- The saved native attempt does not show a post start or receipt.
- The note has fewer than eight delivery attempts.

Pass the note ID and `expected_hash` with a new `request_id`.
Reuse that request ID when the same tool call loses its response.
The service stores the retry request before it returns the note to the queue.
It retains the message ID and saved progress.
It does not reset the attempt count.
Unknown failures and uncertain delivery cannot use this operation.
Invalid credentials and changed policy cannot use it.

The review page shows **Retry approved note** when the current checks permit retry.
The Slack adapter waits up to 20 seconds for the native sender.
If native sending stays unavailable, the adapter stops before posting.
Message text and tool arguments cannot supply the human decision.

The client must advertise MCP form elicitation.
A client without that support gets `human_confirmation_unsupported` and makes no decision.
Claude Code documents its interactive form support in [its MCP guide](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests).
Codex and other clients must advertise that capability on the connection.
Use a tool timeout of at least 300 seconds when the client permits configuration.

MCP authenticates the client. It cannot prove who pressed a button.
Register only clients that display approval forms to the human.
Do not configure hooks to answer these approval forms automatically.
Treat this token as authority to relay human decisions.
Held incoming text appears in the human form and stays hidden in agent tool results.

Interactive HTTP sessions expire after ten idle minutes.
The server permits at most 128 interactive sessions and 128 open confirmations.
Reconnect after a service restart. Pending forms do not survive restart.
Stored approvals and the delivery queue do survive restart.

## Roles

The token decides the role. No tool argument can change it.

- `agent`: finds people, stages files, creates and revises its own drafts, reads approved messages, and checks status. It cannot approve or send.
- `reviewer`: does what an agent does. It also approves a message when the levels let a review agent approve it, and sends approved drafts.
- `person`: does everything. Only a person changes trusted senders and levels.

## Approval levels

The person sets one level for incoming and one for outgoing messages. The default for both is 2.

- Level 1: the person approves every message.
- Level 2: the review agent approves ordinary messages to or from trusted senders after the checks pass.
- Level 3: the review agent also approves trusted messages that the check is unsure about.

A peer that is not a trusted sender always needs the person. A quarantined or failed message goes to nobody. An outgoing draft with body flags needs the person when the body check is on. An approval records the content hash, the actor, and the policy version. A changed body, file, audience, or level ends the approval.

## Message rules

- Audience `person`: the body is the request. No agent file is allowed. An agent never receives the body.
- Audience `agent` or `both`: one agent file is required. The draft uses the `message_id` from the agent file. The receiver releases the parsed file to an agent only after approval.
- The body is text for a person. It must not be empty. A file cannot replace it. The wire text keeps the body exactly as written.
- [docs/WRITING-MESSAGES.md](docs/WRITING-MESSAGES.md) gives the writing rules, the body format, and what does not render.
- A receiver holds an unknown major version with the code `unsupported_version`. It never parses such text as version 1.
- Text that fails a check stays on the review page with the reason and a copy of at most 4000 bytes. Agents never receive it.
- Ordinary Slack chat stays outside the inbox.

## MCP tools

`a2anotes_identity`, `a2anotes_find_people`, `a2anotes_get_person`, `a2anotes_list_messages`, `a2anotes_get_message`, `a2anotes_stage_file`, `a2anotes_create_draft`, `a2anotes_revise_draft`, `a2anotes_review_message`, `a2anotes_approve`, `a2anotes_send`, `a2anotes_mark_seen`, `a2anotes_set_trusted_sender`, `a2anotes_set_policy`, `a2anotes_connection_status`, and `a2anotes_sync`. A person session also has `a2anotes_review_page_link`.

The resources are `a2anotes://policy`, `a2anotes://format/1`, `a2anotes://health`, and `a2anotes://messages/{id}`.

Each tool returns `structuredContent` and a short text. An error has `isError` set and `structuredContent.error` with `code`, `reason`, and `next`.

## Client metadata

A client can attach `metadata` to a draft in `a2anotes_create_draft` and `a2anotes_revise_draft`. Each key has a client prefix, for example `myclient.task_id`. A value is text of at most 500 characters, a number, `true`, `false`, or `null`. A draft can have at most 20 keys and 4096 bytes of metadata.

- Metadata stays in the sender's store. It never goes over Slack, so a recipient never sees internal task IDs.
- Metadata is not part of the content hash. A metadata change does not end an approval.
- An omitted `metadata` input in `a2anotes_revise_draft` keeps the old metadata.
- An incoming reply has `reply_to_local` when it answers a local outgoing message. The field gives that message's ID, subject, and metadata. The link exists only when the reply comes from the address that received the original. A client can use it to find the task that sent the original. The link does not approve or route anything.

## Sending and delivery

Outgoing approval stores the note as `queued` before the app acts.
The worker checks the saved approval and content hash before each attempt.
The adapter verifies the workspace and account before each app operation.
It reads Slack records through the app's own API client in the background.
It never changes the open conversation, types in the composer, or clicks a Slack control.
It confirms the recipient with `conversations.open` and `users.info`.

The adapter saves `postStarted` before it posts text through `chat.postMessage`.
A note with files is posted the same way. The adapter then attaches the privately completed files with `chat.update`.
Slack must show the matching message ID and files before delivery becomes `sent`.
A later attempt only attaches the files to the posted note.
After an uncertain post, the adapter searches recent conversation records for that message ID.
It never repeats an uncertain post.

The service retains its retry deadlines and attempt limit.
The adapter handles Slack method limits and HTTP errors from the signed file upload URL.
Existing queue records remain readable.
Agent request data travels inline in the original message, with a 26,000-byte limit.
The signed-in app grants each supporting file an upload URL.
The adapter sends only the checked bytes to that Slack URL, without a cookie or token.
It completes the file privately, posts the formatted note, and then attaches the file to that note.
Slack shows the file as an attachment, with a 2 MiB adapter limit per file.
The adapter checks the original sender and message reference before it returns file bytes through the app.
It reads attachment metadata with `files.info` before download.
The protocol still checks each attachment hash.
A complete app message must fit within 39,000 bytes.
Draft creation, revision, and approval check these limits before posting.
Older API file references cannot be downloaded through this connector.
Old files remain in the local store.

One service process owns each data folder.
Graceful shutdown waits for active requests.

## Direct human messages in Slack

Write the destination on the first line. Write the message on the next line.

```text
A2A #430
Please check the current status.
```

Taskboard supports these destinations:

- `#430` selects local task number 430.
- `@controller` selects the local controller.
- `@research` selects an alias that the user registered in Settings, under Integrations.

Use `A2A @controller` or `A2A @research` as the first line for those destinations.
The service stores `source: human_message` and `direct_target` from that explicit first line.
It sets the audience to `agent`. It stores human text without a generated agent file.
The destination is part of the content hash. Ordinary Slack text and mentions stay outside this flow.

Your native messages in your Slack self-conversation need no acceptance card.
Slack must identify you as the signed-in member. The conversation must be your self-conversation.
App posts and bot posts cannot use this rule.
Message checks and current policy still apply. Quarantine and policy failures stop acceptance.
The service records acceptance for the exact hash and current policy.
Taskboard resolves the destination against active local tasks and saves it before delivery.
An alias change cannot move that saved message to another task.
An unknown target goes to triage. It does not start another task.

Other senders keep the current acceptance rules.
Their destination text requests a target. The owner must choose or approve that local target.
A message never approves a draft or an action that needs separate approval.
These direct messages contain text only. This feature does not import native Slack attachments.

## Explicit human replies in Slack

The Slack footer displays the exact first line for a reply. A person can submit that line in the direct message conversation or its thread.

```text
A2A Reply/1 8a5f74c0-5c03-4d97-b4e6-3e72842cfa11
Yes, Friday works.
```

The UUID identifies the original note. The receiver verifies these facts before linking the reply:

- Slack identifies the sender as the original recipient.
- The original note has confirmed delivery.
- The reply arrives in the original direct message conversation.
- Any thread reference matches the original Slack thread.

The stored reply has `source: human_reply`. It retains the original audience. It contains human text and no generated agent request. It receives the usual incoming content check and approval requirements.
A verified native reply from your account in your self-conversation needs no acceptance card.
This rule keeps the original audience and verified originating task.
The `allowSelf` setting still controls outgoing self-sends. It does not stop native owner replies. Ordinary Slack text stays outside the inbox. A reply never approves actions.

`reply_to_local` exposes only the verified original note and its local metadata. Clients can use that metadata to find the originating task. Reply text cannot supply a task ID.

The scan reads at most 40 tracked threads each time. A saved cursor keeps a reply from arriving twice. Missing tasks require client triage. Stopped tasks use their client's existing inbox delivery rules.


## Slack display

The app connector composes a readable subject and body.
The footer gives the explicit reply marker and acknowledgement meaning.
The final line contains the exact protocol text as a JSON string.
JSON escapes preserve machine content without active mention text.
The app connector does not create Web API blocks.
Older messages with blocks remain readable through their saved data marker.

## Scanning and restart

The connector receives explicit messages from verified native app events.
It stores each event before message intake.
It verifies direct message membership with `conversations.info`.
Self-conversation requests require the signed-in account as sender.
App recovery reads the 50 latest records of up to 20 direct conversations with `conversations.history`.
These are the self-conversation, conversations of sent notes, and conversations with saved cursors.
The protocol store removes duplicate delivery by the original Slack message reference.
This version does not recover a complete workspace history.
The app must reopen its native connection while the connector listens to supply live events.

## Checks

Every message gets the fixed rules in `src/checks.ts`. Two settings in `config.json` add commands, for example a model with no tools:

- `reviewCommand`: the content check for both directions. The command reads the subject, the body, and the text of each file as JSON on stdin. It writes `{"verdict": "...", "reason": "..."}`. It can raise the rule verdict but never lower it. A failure gives the verdict `uncertain`.
- `bodyCheckCommand`: an extra check of outgoing bodies. The command reads the subject, the body, the audience, the instruction, and the list of sentences. It writes `{"flags": [{"text": "<an exact sentence>", "reason": "..."}]}`. A failure adds a flag, so the person must approve the draft.

The body check also returns format warnings in `body_check.warnings`: Markdown headings, tables, images, HTML, nested formatting, `http://` links, Slack markup, mentions, and a body longer than 1,500 characters. Each warning gives the fix. A warning does not change who approves the draft. `a2anotes_create_draft` and `a2anotes_revise_draft` list the warnings in their result text.

The checks read UTF-8 text files, PDF files through `pdftotext`, and DOCX files through `unzip`. When a command does not finish within 1.5 seconds, the draft call returns, and the check finishes in the background. Until then, the draft has no verdict, and nobody can approve it.

A rejection with `review_context` keeps that text as `rejected.comment`, so the client that wrote the draft can show it to its writer.

## People

People search reads up to 2,000 members with `users.list` and keeps the list for 10 minutes.
It does not search email.
An explicit member address uses `conversations.open`. Slack can then list that direct conversation in the sidebar.
The adapter verifies the active recipient from the app's direct message view.

## Clients

Any MCP client can use this service: a command-line agent through `a2a-notes bridge`, or an application with its own interface through the HTTP endpoint. A client keeps its own data in `metadata`, and it reads all message and approval state from the service.

## Tests

`pnpm test` runs without a live Slack account.
App tests use a local app connection fixture and rendered component fixtures.
Protocol regression tests use `FakeSlackTransport` against a loopback simulator.
That adapter rejects remote API endpoints and never runs in the normal service.

## Open items

- Verify sends and reactions against the installed Slack app before release.
- Add recovery beyond messages available in the app.
- Support workspace directory search through app controls.

## Acknowledge receipt

`a2anotes_ack` takes the incoming note's `id` and `expected_hash`.
It records receipt separately from acceptance and action approval.
A person can acknowledge a held note. Agents can acknowledge only approved content released to them.
`a2anotes_mark_seen` remains a local viewing flag and posts nothing.

Verified native human replies and direct messages queue acknowledgement in the same write that stores the note.
Failed or quarantined input receives no automatic acknowledgement.
The adapter adds ✅ with the app's `reactions.add` call for the saved message.
It reads that message with `conversations.history` first. An existing reaction from the bound account counts as confirmation.
Set `slack.acknowledgementEmoji` to a Slack emoji name to change the reaction. The default is `white_check_mark`.

The note exposes `acknowledgement` with its status and error.
An uncertain response retries the same reaction. An existing reaction counts as confirmation.
Rate limits keep the request pending. Eight failed attempts stop automatic retry.
Permanent errors stop retry immediately. Call `a2anotes_ack` again after correcting a permanent error.

The reaction means received by the endpoint. It does not prove agent notification or completed work.
It never approves a draft or action. Manual Slack reactions are not imported as instructions or approvals.
Transports can implement the optional `acknowledge` operation without Slack parsing in the core.

`a2anotes_report_delivery` lets a person or connector reviewer report agent notification status for an accepted message.
Taskboard reports when no agent is selected or notification is pending.
The Slack adapter posts fixed text without the original body or internal task details.
It posts a further notice if a reported failure resolves.
These notices use durable retries and never enter agent intake.
After an uncertain send or restart, the adapter looks for the saved operation ID before posting again.
Agent delivery remains separate from endpoint acknowledgement and action approval.
