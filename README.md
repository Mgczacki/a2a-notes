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
- `src/slack.ts`: the Slack transport adapter. It uses a Slack user token and OAuth with PKCE.
- `src/mcp.ts` and `src/http.ts`: the MCP server on loopback Streamable HTTP, the review page, and the page API.
- `src/bridge.ts`: a stdio bridge for command-line agents.
- `src/fake-slack.ts`: a fake Slack Web API for tests and sandboxes.

## Install and start

These steps need a Slack app with user token scopes. The Slack app must list `http://localhost:<port>/slack/callback` as a redirect URL.

1. Install the package from this repository: `git clone https://github.com/Mgczacki/a2a-notes.git`, then run `pnpm install`, `pnpm build`, and `npm link` in the folder. The package is not on npm.
2. Write the settings: `a2a-notes init --client-id <Slack client ID> --team-id <Slack team ID> --port 4460`.
3. Start the service: `a2a-notes serve`. The service prints its address.
4. Open the review page: `a2a-notes open`. The link works once, within two minutes.
5. On the review page, select **Connect Slack** and sign in.
6. Make one client token for each client: `a2a-notes token add <name> --role person|reviewer|agent`. The command prints the token once.

To start the service at sign-in on macOS, run `a2a-notes service-file`. It prints a LaunchAgent file and the `launchctl` command. The command does not install the file.

The data folder is `~/.a2a-notes`, or the folder in `A2A_NOTES_DIR`, or `--dir`. It holds `config.json`, `store.json`, `clients.json`, `slack-credentials.json`, `files/`, and `local-secret`. Each file has mode 0600.

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

An outgoing approval stores the note as `queued` before any network write. The worker reads that state after restart. `a2anotes_send` attempts a queued note when its saved deadline permits delivery.

The first Slack 429 sets the next attempt from `Retry-After`. Later 429 responses use capped exponential backoff with jitter. The backoff cap is 300 seconds. `Retry-After` can require a longer wait. Eight failed attempts stop delivery in `permanent_failure`. A local quota wait does not consume that attempt limit.

Each note exposes its `delivery` record. That record includes these fields:

- `nextAttemptAt`: the next permitted attempt time.
- `lastMethod`: the Slack method that failed or required a local wait.
- `lastStatus`: the HTTP status. Zero means the adapter delayed the call locally.
- `lastRetryAfter`: Slack's requested wait, in seconds.
- `lastRequestId`: Slack's request ID, when available.
- `stoppedAt`: the time of the final failure.
- `failureCode`: the final failure code.
- `uncertain`: Slack may have accepted the message.

`next_retry_at` remains an alias for the next attempt time. Existing `sent_at` and `permanent_failure` fields retain their meanings.

The worker checks the current policy before each attempt. It checks the sender address and each approved file hash. Invalid credentials stop delivery. Changed content stops delivery. The service does not ask for another approval of unchanged queued text.

The adapter saves an upload ticket before sending file bytes. It saves `completing` before sharing the file. A retry reuses that Slack file ID. An uncertain share requires `files.info` to confirm the share. The adapter never repeats an uncertain file share.

The adapter saves `postStarted` before `chat.postMessage`. After an uncertain post, it searches for the same message ID. It saves each history cursor, so a 429 or restart resumes the search. It does not post again while delivery remains uncertain. A missing confirmation can therefore end in a final uncertain failure.

Slack cooldowns use the configured Slack client ID and workspace ID for each Web API method. Message posting also reserves one second for each channel. A cooldown for one method does not block other methods.

The service permits one process to own each data folder. Graceful shutdown waits for active requests. Existing queue records retain their saved deadline during upgrade. A legacy interrupted send requires reconciliation because its store has no upload checkpoints.

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

Each transport adapter formats messages for its own service. `src/slack-format.ts` does this for Slack.

- People read the blocks: the subject as a header, a line of small text with the reader and the sender, the body, the agent file and other files, and a small footer about replies with a **Get A2A Notes** link. The link goes to `slack.projectLink` in `config.json` (default: this repository). An empty value hides the link.
- The body shows as `rich_text` blocks: a bold title for each titled part, paragraphs, line breaks, lists, quotes, preformatted text, and https links. `src/body-format.ts` reads the body format. A text element in a `rich_text` block is literal text, so no mention or Slack markup in the body becomes active. Version 0.3.0 put the body in a `plain_text` section, and the Slack desktop app showed it as one paragraph without line breaks (observed on 2026-10-02).
- Each body block holds at most 2,900 characters. A message has at most 50 blocks. A long part splits between paragraphs, sentences, or list items, never inside a word, a link, or code.
- The `text` field holds a one-line summary for notifications, then `A2A Notes data: ` and the exact `A2ANotes/1` text as one JSON string. Slack shows `text` only in notifications and search when a message has blocks.
- Slack replaces each newline in `text` with a space when a message has blocks. This was observed in a live test on 2026-09-30. A JSON string has no raw newline, so the exact text survives. The receiver parses the JSON string, then the `A2ANotes/1` text.
- Text without the data marker goes to the decoder as it is, so an `A2ANotes/1` post without blocks still arrives.

A post with a user token through a Slack app has `bot_id` and `app_id` set. The scan accepts it and takes the sender from the event `user`.

## Scanning and restart

The service scans direct messages every 60 seconds by default. Each scan reads at most 40 conversations, oldest cursor first. With more than 40 conversations, a new message can wait more than one scan. The first scan of a conversation reads the last 14 days (`slack.firstScanDays`). The service reads history in time windows and cuts a window with more than 2000 messages in half. It saves a cursor after it stores and checks each message and after each window. A conversation that Slack lists but the token cannot read (`channel_not_found`, `not_in_channel`, `access_denied`) gets a cursor at the scan time and no error. A failed download stops that conversation without a cursor change, so the next scan reads the message again. A Slack rate limit delays the next scan and shows in `a2anotes_connection_status`.

## Checks

Every message gets the fixed rules in `src/checks.ts`. Two settings in `config.json` add commands, for example a model with no tools:

- `reviewCommand`: the content check for both directions. The command reads the subject, the body, and the text of each file as JSON on stdin. It writes `{"verdict": "...", "reason": "..."}`. It can raise the rule verdict but never lower it. A failure gives the verdict `uncertain`.
- `bodyCheckCommand`: an extra check of outgoing bodies. The command reads the subject, the body, the audience, the instruction, and the list of sentences. It writes `{"flags": [{"text": "<an exact sentence>", "reason": "..."}]}`. A failure adds a flag, so the person must approve the draft.

The body check also returns format warnings in `body_check.warnings`: Markdown headings, tables, images, HTML, nested formatting, `http://` links, Slack markup, mentions, and a body longer than 1,500 characters. Each warning gives the fix. A warning does not change who approves the draft. `a2anotes_create_draft` and `a2anotes_revise_draft` list the warnings in their result text.

The checks read UTF-8 text files, PDF files through `pdftotext`, and DOCX files through `unzip`. When a command does not finish within 1.5 seconds, the draft call returns, and the check finishes in the background. Until then, the draft has no verdict, and nobody can approve it.

A rejection with `review_context` keeps that text as `rejected.comment`, so the client that wrote the draft can show it to its writer.

## People

`a2anotes_get_person` gives the name, the title, and the address of the profile picture of a workspace member. A client downloads the picture itself. The Slack picture addresses need no token.

## Clients

Any MCP client can use this service: a command-line agent through `a2a-notes bridge`, or an application with its own interface through the HTTP endpoint. A client keeps its own data in `metadata`, and it reads all message and approval state from the service.

## Tests

`pnpm test` runs the tests against the fake Slack Web API. No test needs a live Slack account.

## Open items

- The package has no registered Slack app of its own. `a2a-notes init` takes the client ID and team of the Slack app that you use.
- The fixed body rules flag detail names from the agent file, code names, internal task numbers, local paths, secrets, sender notes, and an ask that differs from the `instruction` input.
- The first release supports one Slack workspace. It does not send between workspaces.
