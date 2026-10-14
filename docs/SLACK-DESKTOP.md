# Slack Desktop transport

A2A Notes uses the signed-in Slack Desktop app through a local debugging connection.
It makes no direct Slack Web API requests.
It calls the app's own API client inside the app.
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
Restart Slack while A2A Notes listens if no new native socket is visible.
Each pending event enters `desktop-events.json` before intake.
The adapter checks the direct message conversation with `conversations.info`.
Ordinary text supplies no instruction or approval.
Recovery reads the 50 latest records of up to 20 direct conversations with `conversations.history`.
Recovery does not provide a complete history export.

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

Small attachments travel as encoded data in the original message.
The complete message must fit within 39,000 bytes.
The adapter verifies the sender and timestamp before it returns file bytes.
The protocol checks the file hash.
Larger files fail before posting.
This version does not use native file upload or download controls.
Changed app controls cause a visible error.
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
Small attachments remain in the original message data.
The native path also sends the existing display blocks.
This preference makes no direct Slack HTTP call from A2A Notes.

Without `--send`, A2A Notes reads and confirms receipt, but it does not post notes or delivery notices.
The service still reads saved native receipts when it recovers an uncertain operation.
Closing the debugger connection does not permit another post for an uncertain note.

An outgoing note with saved Web API upload progress stops before the app adapter posts.
Recover that unfinished operation with the earlier adapter before migrating it.
The app adapter cannot replace an earlier shared file with an inline attachment.
