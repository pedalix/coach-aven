// The Teams test double: a TeamsApi that records what the Connector would receive and answers
// with sequential ids. Shared by the driver tests (one call sequence per ChatDriver method)
// and the pollers recorder (what the bot posts on its own, replayed against this driver).

import type { OutActivity, TeamsApi } from './driver.js';

export interface RecordedCall {
  op: string;
  conv: string;
  id?: string;
  activity?: OutActivity;
}

export class Recorder implements TeamsApi {
  calls: RecordedCall[] = [];
  seq = 0;
  personal: string | undefined = 'a:PERSONAL1';
  targetedFails = false; // the platform refusing targeted sends (not installed, a guest, …)
  names = new Map<string, string>(); // what the roster lookup answers
  async send(conv: string, activity: OutActivity) {
    this.calls.push({ op: 'send', conv, activity });
    return { id: `m${++this.seq}` };
  }
  async sendTargeted(conv: string, activity: OutActivity) {
    this.calls.push({ op: 'sendTargeted', conv, activity });
    if (this.targetedFails) throw new Error('HTTP 403 BotNotInConversationRoster');
    return { id: `m${++this.seq}` };
  }
  async update(conv: string, id: string, activity: OutActivity) {
    // The Connector's rule, learnt on the real tenant: an edit may carry text or a card, not both.
    if (activity.text !== undefined && activity.attachments?.length) {
      const err = new Error('Request failed with status code 400') as Error & { response?: unknown };
      err.response = { status: 400, data: { error: { code: 'BadSyntax', message: 'Activity resulted into multiple skype activities' } } };
      throw err;
    }
    this.calls.push({ op: 'update', conv, id, activity });
  }
  async openPersonal(user: string) {
    this.calls.push({ op: 'openPersonal', conv: user });
    return this.personal;
  }
  async react(conv: string, id: string, type: string, op: 'add' | 'remove') {
    this.calls.push({ op: `react:${op}:${type}`, conv, id });
  }
  async memberName(conv: string, user: string) {
    this.calls.push({ op: 'memberName', conv, id: user });
    return this.names.get(user);
  }
}
