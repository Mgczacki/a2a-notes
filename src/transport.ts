// The contract between the protocol core (src/service.ts) and a delivery service. The core stores stable message
// and attachment IDs. An adapter maps them to its own IDs, checks identities, and moves text and file bytes.
export interface Person { address: string; name: string; realName: string; title: string; active: boolean; email?: string }
export interface Identity { transport: string; address: string; name: string; scopes: string[]; missingScopes: string[]; optionalMissing: string[] }

// One message that the adapter read from the service. text is the message text after markup escapes are reversed.
export interface Received {
  conversation: string; ref: string; ts: string; channel: string; sender: string; text: string; threadTs?: string;
  // the adapter found A2A Notes data that it could not read; the core keeps the message for the person with this reason
  error?: string;
}
// What a person reads. Each adapter formats it for its own service (src/slack-format.ts for Slack).
export interface Display {
  subject: string; body: string; audience: 'person' | 'agent' | 'both'; senderName: string;
  agentFile?: { name: string; size: number }; files: { name: string; size: number }[];
}
export interface SendInput {
  to: string; messageId: string;
  // builds the exact A2ANotes/1 text after the uploads, from attachment ID -> adapter file ID
  wire: (fileMap: Record<string, string>) => string;
  // what the adapter shows to a person; each adapter formats it for its own service
  display: Display;
  files: { id: string; name: string; bytes: Buffer }[];
  threadTs?: string;
}
export interface SendResult { channel: string; ts: string; files: Record<string, string> }

export class TransportError extends Error {
  // definite: the service answered and did not post the message. A timeout or lost reply is not definite.
  constructor(message: string, readonly definite: boolean, readonly retryAfter = 0) { super(message); }
}

export interface Transport {
  readonly name: string;
  // the adapter name in `Transport-File-<fileField>` lines
  readonly fileField: string;
  identity(): Identity | null;
  findPeople(query: string, limit: number, cursor?: string): Promise<{ people: Person[]; next?: string }>;
  checkRecipient(address: string): Promise<Person>;
  send(input: SendInput): Promise<SendResult>;
  // looks for a message that this account sent with this ID, after a send that may or may not have posted
  findSent(to: string, messageId: string): Promise<{ channel: string; ts: string } | null>;
  // reads messages newer than each saved cursor, oldest first. handle stores and checks one message; the adapter
  // calls save after handle returns, so a failed message is read again at the next scan.
  scan(cursors: Record<string, string>, handle: (m: Received) => Promise<void>, save: (conversation: string, ts: string) => void): Promise<{ conversations: number; messages: number }>;
  download(fileRef: string, received: Received, maxBytes: number): Promise<Buffer>;
}
