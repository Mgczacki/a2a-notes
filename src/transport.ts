import type { SendCheckpoint, AgentDeliveryStatus } from './store.ts';
// The contract between the protocol core (src/service.ts) and a delivery service. The core stores stable message
// and attachment IDs. An adapter maps them to its own IDs, checks identities, and moves text and file bytes.
export interface Person { address: string; name: string; realName: string; title: string; active: boolean; email?: string; image?: string }
export interface Identity { transport: string; address: string; name: string; scopes: string[]; missingScopes: string[]; optionalMissing: string[]; available?: boolean }

// One message that the adapter read from the service. text is the message text after markup escapes are reversed.
export interface Received {
  conversation: string; ref: string; ts: string; channel: string; sender: string; text: string; threadTs?: string;
  // the adapter found A2A Notes data that it could not read; the core keeps the message for the person with this reason
  automated?: boolean;
  // Slack verified that this is the signed-in member's self-conversation.
  ownerConversation?: boolean;
  error?: string;
}
// What a person reads. Each adapter formats it for its own service (src/slack-format.ts for Slack).
export interface Display {
  messageId?: string; subject: string; body: string; audience: 'person' | 'agent' | 'both'; senderName: string;
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
  checkpoint?: SendCheckpoint;
  saveCheckpoint?: (checkpoint: SendCheckpoint) => void;
}
export interface SendResult { channel: string; ts: string; files: Record<string, string> }

export class TransportError extends Error {
  // definite: the service answered and did not post the message. A timeout or lost reply is not definite.
  readonly method?: string;
  readonly rateLimited: boolean;
  constructor(message: string, readonly definite: boolean, readonly retryAfter = 0, methodOrRateLimited?: string | boolean, readonly status?: number, readonly requestId?: string, readonly failureCode?: 'app_control_unavailable') {
    super(message);
    this.method = typeof methodOrRateLimited === 'string' ? methodOrRateLimited : undefined;
    this.rateLimited = methodOrRateLimited === true || status === 429 || retryAfter > 0;
  }
}

export interface Transport {
  readonly name: string;
  // the adapter name in `Transport-File-<fileField>` lines
  readonly fileField: string;
  identity(): Identity | null;
  findPeople(query: string, limit: number, cursor?: string): Promise<{ people: Person[]; next?: string }>;
  checkRecipient(address: string): Promise<Person>;
  // Reject a draft that cannot fit through this adapter before approval.
  checkDraft?(input: SendInput): void;
  send(input: SendInput): Promise<SendResult>;
  // Checks saved attempts before a stopped note can return to the queue. This method must not post.
  verifyRetry?(to: string, messageId: string, checkpoint: SendCheckpoint): Promise<void>;
  // The adapter interprets its saved reference. Receipt grants no approval.
  acknowledge?(reference: Record<string, string>): Promise<void>;
  // Send a fixed delivery notice. It grants no authority and contains no message body.
  notifyDelivery?(reference: Record<string, string>, status: AgentDeliveryStatus): Promise<void>;
  // looks for a message that this account sent with this ID, after a send that may or may not have posted
  findSent(to: string, messageId: string, since?: string, progress?: { cursor?: string; save: (cursor?: string) => void; expectedFiles?: {name: string; size: number}[] }): Promise<{ channel: string; ts: string; filesMissing?: boolean } | null>;
  // reads messages newer than each saved cursor, oldest first. handle stores and checks one message; the adapter
  // calls save after handle returns, so a failed message is read again at the next scan.
  scan(cursors: Record<string, string>, handle: (m: Received) => Promise<void>, save: (conversation: string, ts: string) => void, threads?: { channel: string; ts: string }[]): Promise<{ conversations: number; messages: number }>;
  download(fileRef: string, received: Received, maxBytes: number): Promise<Buffer>;
  // the display name of a member address, for the person reading the inbox (optional)
  nameOf?(address: string): Promise<string | undefined>;
  // a member with name and profile picture address, for a client that shows people (optional)
  personOf?(address: string): Promise<Person | undefined>;
}
