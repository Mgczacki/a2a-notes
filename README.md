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

The service uploads files before it posts the message. It stores `sending` before the Slack call. A Slack rate limit or an uncertain reply moves the approved draft to `queued`. The stored `next_retry_at` gives the next attempt. The service uses Slack `Retry-After` when Slack sends it. Without that header, the wait starts at 60 seconds and doubles to a maximum of one hour. The service reads queued drafts after a restart. It checks Slack history for the message ID before it posts again. It uses the stored recipient, approved text, and sender name for each retry. It checks the Slack account address against the approved draft. A definite Slack error moves the draft to `permanent_failure`. The person can revise that draft and approve the new version. The review page and message tools show `queued`, `next_retry_at`, `sent`, and `permanent_failure`.

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
