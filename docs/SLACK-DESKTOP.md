# Receive live messages from Slack Desktop

The optional macOS connector reads incoming events from the installed Slack app.
It uses the Chrome DevTools Protocol, or CDP, through a local debugging port.
It does not need desktop clicks or screenshots.
Slack does not provide this connection as a supported integration API.

## Start the connector

A debugging port gives local processes access to Slack's renderer.
Use this option only on a trusted local computer.
The connector requires the app at `/Applications/Slack.app`.
Keep the existing Slack OAuth connection for channel verification and outgoing delivery.

- Save the endpoint with `a2a-notes desktop enable --url http://127.0.0.1:19322`.
- Restart A2A Notes before you restart Slack.
- Quit Slack normally. Wait until the app closes.
- Start Slack with `open -a /Applications/Slack.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=19322`.
- Use `a2a-notes status` to check `desktop.accountVerified` and `desktop.listening`.

Both status fields must be true for live events to arrive.
Attaching after Slack opens its WebSocket does not prove that socket's destination.
In that case, restart Slack while A2A Notes runs.
The connector also checks the account again every ten seconds.
If an app update removes the required account fields, the connector refuses events.

`a2a-notes desktop probe --url http://127.0.0.1:19322 --seconds 30` checks the connection without delivering notes.
Start the probe before Slack if you need to verify a newly opened WebSocket.
The probe prints status and event counts. It does not print message bodies.

## Read and store events

`SlackDesktopHook` checks that the loopback listener belongs to the installed Slack executable.
It attaches only to pages for the workspace of the connected A2A account.
A fixed renderer query returns the workspace ID and the current account ID.
The query reads the account button in Slack 4.49.89.
It also supports the older `TS` account fields.
The connector does not return cookies or stored credentials.

The connector observes incoming text frames from verified Slack WebSockets.
It keeps only DM messages that start with an explicit A2A prefix.
Ordinary Slack text supplies no agent instruction or approval.

The connector saves each explicit event in `desktop-events.json` before it calls `NotesService.receive`.
The file has mode 0600 in the existing data folder.
The connector checks each new DM channel with `conversations.info` before owner acceptance can occur.
It retries rate limits at the saved time after a restart.
Invalid credentials stop that event's retry.

`NotesService.receive` retains the existing content checks and acceptance rules.
Human replies keep the sender identity and the original audience.
They link to the verified original note and task.
Owner requests still require a native owner post in the verified self-conversation.
Incoming text cannot approve an outgoing action.

Both desktop events and history polling use `slack:<team>:<channel>:<timestamp>` as the event reference.
The existing store therefore identifies the same note when both paths read it.
The connector removes its saved event only after `NotesService.receive` returns.
If the service stops between those writes, it reads the saved event again without creating another note.

## Send approved notes through the app

Use `a2a-notes desktop enable --url http://127.0.0.1:19322 --send` to prefer native posting.
Restart A2A Notes after you change this setting.
The setting stays off unless the user selects it.
`desktop.sendEnabled` shows the selected preference. `desktop.canSend` shows whether the current native function is available.

The existing service approves the note before it calls either adapter.
The sender checks and file uploads continue through the existing Slack adapter.
The native preference replaces the final `chat.postMessage` call.
It sends the same wire text and displayed blocks through Slack's current API function.
The function uses the account already signed in to Slack.
The connector checks that this account matches the A2A Notes account.
It does not return Slack credentials or change the user's composer.

The connector checks hashes of the inspected native code before each call.
An unknown app build cannot use this native function.
If native sending is unavailable before posting, the adapter uses the existing Web API path.
Native credential failures stop the attempt. They do not cause a send through another adapter.

The connector sets one SDK attempt for its own request.
It restores the app's queue method immediately after enqueueing that request.
Ordinary Slack requests retain their current behavior.
A native timeout cancels the request after 15 seconds.
A2A Notes applies Retry-After and its current backoff to later attempts.
The connector saves the native workspace wait in `desktop-limits.json`.

`desktop-deliveries.json` stores each native attempt's message ID and content hash.
The connector writes that record before it calls Slack.
A verified echo must match the sender and channel before it supplies a receipt.
It must also match the message ID and wire content.
The connector saves the receipt before the service records successful delivery.

The note's checkpoint records the selected adapter in `postTransport`.
An uncertain result keeps `postStarted` true.
The service checks native receipts before it queries Slack history.
It never switches adapters and posts again after an uncertain result.
Existing upload checkpoints keep file shares from repeating.
Changed native payloads stop without another post.

Native posting can still receive rate limits.
The desktop client's exact quotas are unknown.
This preference does not remove limits on sender lookup or file operations.
Disable native preference by saving the endpoint without `--send` and restarting A2A Notes.
Disabling it leaves existing uncertain attempts available for reconciliation.

## Recover and disconnect

While the verified native connection remains open, history recovery runs at most once per five minutes.
The configured scan interval still controls how often the timer checks that deadline.
Lost connections restore ordinary history polling.
Manual scans remain available and honor Slack method limits.
Outgoing delivery still uses the current approved queue.
File operations continue through the existing Web API adapter.
The connector does not remove Slack's sending limits.

- Run `a2a-notes desktop disable`.
- Restart A2A Notes to restore ordinary polling.
- Quit Slack and reopen it normally to close the debugging port.

Slack files and login profiles remain unchanged.
Older A2A Notes versions ignore the optional desktop setting and continue polling.

## Sources

- [Electron debugging-port switch](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)
- [CDP WebSocket events](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [Slack method and posting limits](https://docs.slack.dev/apis/web-api/rate-limits/)
