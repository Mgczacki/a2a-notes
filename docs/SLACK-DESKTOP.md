# Slack Desktop transport

A2A Notes uses the signed-in Slack Desktop app through a local debugging connection.
It calls the app's own API client inside the app.
For a file upload, the adapter host sends bytes to a signed URL from that client.
That binary upload is the only direct Slack HTTP request from A2A Notes.
It does not read cookies or OAuth credentials.
It never changes the open conversation, types in the composer, or clicks a Slack control.
Slack does not document this app connection as a supported integration.

## Start the app connection

The debugging port gives local processes access to the app.
Restrict it to loopback on a trusted computer.

- Quit Slack normally.
- Start it with `open -a /Applications/Slack.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=19322`.
- Write settings with `a2a-notes init --team-id <workspace ID> --desktop-url http://127.0.0.1:19322`.
- Start A2A Notes with `a2a-notes serve`.
- Use Connect Slack Desktop on the review page.

The account binding contains workspace and member IDs.
It contains no token.
Each app operation checks that binding.
Disconnect the connector before binding another account.
Disconnect does not sign out the Slack app.

## Read messages

The connector verifies the debugging port owner before it connects.
It observes events from native Slack sockets for the bound workspace and account.
A socket that opened before A2A Notes started has no network events.
For those sockets, the connector adds one listener inside the app page through `Runtime.queryObjects`.
The listener forwards only message frames that can hold A2A Notes input.
Page code can call that listener binding, so the connector reads each forwarded message back with `conversations.history` or `conversations.replies`.
The sender, conversation, thread, and text must match the Slack record before intake.
Slack needs no restart after A2A Notes restarts.

Slack must start with its debugging port. A Slack update, a reboot, or a manual restart starts it without the port.
Use `a2a-notes desktop restart-slack`, the review page button, or the person-only MCP tool `a2anotes_restart_slack` to restart it with the port.
This restart supports macOS only. Slack keeps unsent drafts.
Each pending event enters `desktop-events.json` before intake.
The adapter checks the direct message conversation with `conversations.info`.
Ordinary text supplies no instruction or approval.
Recovery reads the 50 latest records of up to 20 direct conversations with `conversations.history`.
Recovery does not provide a complete history export.
The app client permits these read methods:

- `conversations.info`
- `conversations.open`
- `conversations.history`
- `conversations.replies`
- `users.info`
- `users.list`
- `files.info`

## Send and acknowledge

The adapter finds the recipient's direct conversation with `conversations.open`.
It checks the recipient profile with `users.info`.
It posts approved text with the app's `chat.postMessage` call.
It requires a matching channel and timestamp before recording delivery.
An uncertain post gets no second send.

Acknowledgement uses the app's verified `reactions.add` call.
The call uses the original channel and timestamp.
An existing own reaction counts as receipt confirmation.
The service retains Retry-After and the reaction request limit across restart.
Receipt confirmation grants no approval.
An existing reaction from that account counts as confirmation.
The reaction means received and grants no approval.

Agent request data travels inline in the note text, with a 26,000-byte limit.
Supporting files become visible Slack attachments, with a 2 MiB adapter limit per file.
The complete note text must fit within 39,000 bytes.
The app client grants an upload URL for each file.
The adapter checks that the URL uses HTTPS and the `files.slack.com` host.
It sends the staged bytes without a cookie, token, or Authorization header.
The request refuses redirects and stops after 30 seconds.
The adapter saves the file ID and upload phase.
It does not save the upload URL.
The app client completes each file privately through `files.completeUploadExternal`, without a channel.
The app client then posts the formatted note through `chat.postMessage`.
The adapter saves the note timestamp as `postedTs`.
The app client attaches the files to that note through `chat.update` with the same text and blocks.
Slack can show the note as edited.
The adapter checks the note timestamp and each file name and size in Slack records.
The protocol checks each downloaded file hash.
Draft creation, revision, and approval reject files above the active limits.
After correcting a failure before posting, use `a2anotes_retry_send` with the existing note ID and hash.
The service retains the current approval and checks saved attempts before it queues the note.
Uncertain delivery cannot use this operation.

Decision: the Slack app is the only production Slack transport.

## Optional native posting

Add `--send` to `a2a-notes desktop enable --url http://127.0.0.1:19322` to select native posting.
Restart A2A Notes after changing this setting.
Check `desktop.canSend` in `a2a-notes status`.
The account check reads only the workspace and member IDs from the app page.
The connector checks the inspected native module hashes before calling Slack's `apiCall`.
Slack handles its credentials inside the app.
A2A Notes records the attempt before dispatch and the receipt before marking the note sent.
The native request gets one SDK attempt.
The durable queue controls later attempts and honors Retry-After.
Native posting is the only posting path.
Unavailability before posting stops the note before posting. Use `a2anotes_retry_send` after Slack is ready.
Invalid credentials and policy failures stop the native operation.
Text notes use the existing display blocks.
File notes use the same display blocks. The hidden text keeps the A2A Notes data.
The signed binary file upload is the only direct Slack HTTP call.

Without `--send`, A2A Notes reads and confirms receipt, but it does not post notes or delivery notices.
The service still reads saved native receipts when it recovers an uncertain operation.
Closing the debugger connection does not permit another post for an uncertain note.

An outgoing note with saved Web API upload progress stops before the app adapter posts.
Recover that unfinished operation with the earlier adapter before migrating it.
A lost binary upload or a failed private completion starts with a new ticket. The earlier file stays private.
After the note is posted, a later attempt only attaches the saved files. It never posts the note again.
After an uncertain post, the adapter searches Slack records for the note ID.
If the note has no files yet, the service saves its timestamp and attaches the files.
