import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSlackText } from './slack-format.ts';
import { savePrivate } from './store.ts';
import { TransportError } from './transport.ts';
import type { DesktopPost } from './slack-desktop-native.ts';

interface Record {
  team: string; owner: string; to: string; channel: string; messageId: string;
  hash: string; wireHash: string; started: boolean; ts?: string; conflict?: boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const wireHash = (text: string) => { const read = readSlackText(text); return hash('text' in read ? read.text : text); };

export class DesktopDeliveries {
  private file: string;
  private records: Record[];
  constructor(dir: string) {
    this.file = join(dir, 'desktop-deliveries.json');
    const saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(saved) || saved.length > 10000 || saved.some(r =>
      !/^T[A-Z0-9]+$/.test(r.team) || !/^[UW][A-Z0-9]+$/.test(r.owner) || !/^D[A-Z0-9]+$/.test(r.channel) ||
      !/^[a-f0-9-]{36}$/i.test(r.messageId) || !/^slack:T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(r.to) ||
      !/^[a-f0-9]{64}$/.test(r.hash) || !/^[a-f0-9]{64}$/.test(r.wireHash) || typeof r.started !== 'boolean' ||
      r.ts !== undefined && !/^\d+\.\d+$/.test(r.ts) || r.conflict !== undefined && typeof r.conflict !== 'boolean')) throw new Error('The saved desktop deliveries could not be checked.');
    this.records = saved;
  }
  private save() { savePrivate(this.file, this.records); }
  verifyRetry(team: string, owner: string, to: string, messageId: string, channel: string) {
    const r = this.records.find(r => r.messageId === messageId);
    if (r && (r.team !== team || r.owner !== owner || r.to !== to || r.channel !== channel || r.started || r.ts || r.conflict))
      throw new TransportError('The saved native attempt does not permit another post.', true);
  }
  begin(input: DesktopPost) {
    const expected = hash(JSON.stringify([input.team, input.owner, input.to, input.channel, input.text, input.blocks, input.threadTs || '']));
    let record = this.records.find(r => r.messageId === input.messageId);
    if (record && record.hash !== expected) throw new TransportError('The saved native send content changed.', true);
    if (record?.conflict) throw new TransportError('Slack returned two timestamps for the same native send.', true);
    if (record?.ts) return {channel:record.channel, ts:record.ts};
    if (record?.started) throw new TransportError('The native send is uncertain. No second post was attempted.', false);
    if (!record) {
      if (this.records.length >= 10000) throw new TransportError('The saved native deliveries reached their limit.', true);
      record = {team:input.team, owner:input.owner, to:input.to, channel:input.channel, messageId:input.messageId,
        hash:expected, wireHash:wireHash(input.text), started:false};
      this.records.push(record);
    }
    record.started = true; this.save();
    return null;
  }
  failed(messageId: string, definite: boolean) { const r = this.records.find(r => r.messageId === messageId); if (r && definite && !r.ts) { r.started = false; this.save(); } }
  confirmed(messageId: string, channel: string, ts: string) {
    const record = this.records.find(r => r.messageId === messageId);
    if (!record || record.channel !== channel || !/^\d+\.\d+$/.test(ts)) throw new TransportError('The native acknowledgement does not match its saved send.', false);
    if (record.ts && record.ts !== ts) {record.conflict = true;this.save();throw new TransportError('Slack returned two timestamps for the same native send.', true);}
    record.ts = ts; this.save(); return {channel, ts};
  }
  echo(team: string, owner: string, event: {user:string; channel:string; ts:string; text:string; client_msg_id?:string}) {
    if (event.user !== owner || !event.client_msg_id) return;
    const record = this.records.find(r => r.team === team && r.owner === owner && r.messageId === event.client_msg_id && r.channel === event.channel);
    if (!record?.started || record.wireHash !== wireHash(event.text)) return;
    this.confirmed(record.messageId, record.channel, event.ts);
  }
  receipt(team: string, owner: string, to: string, messageId: string) {
    const r = this.records.find(r => r.team === team && r.owner === owner && r.to === to && r.messageId === messageId && r.ts);
    if (r?.conflict) throw new TransportError('Slack returned two timestamps for the same native send.', true);
    return r ? {channel:r.channel, ts:r.ts!} : null;
  }
}
