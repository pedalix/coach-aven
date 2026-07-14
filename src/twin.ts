// The Slack "digital twin" harness: drive the REAL Bolt app + REAL event handlers with
// synthetic (or journal-replayed) envelopes, no network to Slack at all. The emulation
// boundary is deliberately the RECEIVER, not the WebSocket wire: SocketModeReceiver's
// whole job is to turn envelopes into app.processEvent(event) calls, so a tiny Receiver
// that does the same gives byte-equivalent handler behavior without touching the
// slack-sdk's transport (reconnects/acks are Slack's code, not ours).
//
// Web API calls DO happen — against a local recording HTTP stub (Bolt's documented
// clientOptions.slackApiUrl seam), so tests assert exactly which method was called with
// WHICH WORKSPACE'S TOKEN. Envelope fixtures can come from the AVEN_EVENT_LOG journal
// (src/eventlog.ts) — record on prod/dev, replay here.
//
// Test infrastructure by design: imported only from *.test.ts.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bolt from '@slack/bolt';
import type { Receiver, ReceiverEvent } from '@slack/bolt';

const { App } = bolt;

// ── the receiver twin ────────────────────────────────────────────────────────
export class TwinReceiver implements Receiver {
  private app?: bolt.App;
  init(app: bolt.App): void {
    this.app = app;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  // Deliver one envelope body to the app, exactly as SocketModeReceiver would.
  async send(body: Record<string, unknown>): Promise<void> {
    if (!this.app) throw new Error('twin receiver not initialized');
    const event: ReceiverEvent = { body, ack: async () => {} };
    await this.app.processEvent(event);
  }
}

// ── the recording Web API stub ───────────────────────────────────────────────
export interface ApiCall {
  method: string; // e.g. "chat.postMessage"
  token: string; // which workspace's token made the call
  payload: Record<string, unknown>;
}

// Minimal Slack Web API: records every call, answers ok:true, serves
// conversations.info from a configurable channel-name map (the wildcard binding needs it),
// and files.info from a file-fixture map (the Connect tombstone hydration needs it —
// an id missing from the map answers ok with NO file, Slack's access-denied shape).
export class RecordingApi {
  readonly calls: ApiCall[] = [];
  private server?: Server;
  constructor(
    private readonly channelNames: Record<string, string> = {},
    private readonly files: Record<string, Record<string, unknown>> = {},
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url ?? '/').replace(/^\//, '').split('?')[0];
        const raw = Buffer.concat(chunks).toString();
        let payload: Record<string, unknown> = {};
        try {
          payload = req.headers['content-type']?.includes('json')
            ? JSON.parse(raw || '{}')
            : Object.fromEntries(new URLSearchParams(raw));
        } catch {
          /* keep {} */
        }
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(payload.token ?? '');
        this.calls.push({ method, token, payload });
        const body: Record<string, unknown> = { ok: true, ts: '9999.0001' };
        if (method === 'conversations.info') {
          const id = String(payload.channel ?? '');
          body.channel = { id, name: this.channelNames[id] };
        }
        if (method === 'views.open') body.view = { id: 'V1' };
        if (method === 'files.info') body.file = this.files[String(payload.file ?? '')];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  of(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

// ── envelope builders (the shapes Slack actually sends, fields we consume) ───
export interface EnvelopeOpts {
  team: string; // team the INSTALLATION receiving this envelope belongs to
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  threadTs?: string;
  channelType?: string;
  extShared?: boolean;
  files?: unknown[]; // raw Slack file objects; on a message this also sets subtype file_share
}

export function mentionEnvelope(o: EnvelopeOpts): Record<string, unknown> {
  return {
    team_id: o.team,
    api_app_id: 'A0TWIN',
    type: 'event_callback',
    event: {
      type: 'app_mention',
      channel: o.channel,
      ts: o.ts,
      thread_ts: o.threadTs,
      text: o.text ?? '<@UBOT> do something',
      user: o.user ?? 'U_HUMAN',
      ...(o.extShared ? { is_ext_shared_channel: true } : {}),
      ...(o.files ? { files: o.files } : {}),
    },
  };
}

export function messageEnvelope(o: EnvelopeOpts): Record<string, unknown> {
  return {
    team_id: o.team,
    api_app_id: 'A0TWIN',
    type: 'event_callback',
    event: {
      type: 'message',
      channel: o.channel,
      channel_type: o.channelType ?? 'channel',
      ts: o.ts,
      thread_ts: o.threadTs,
      text: o.text ?? 'a follow-up',
      user: o.user ?? 'U_HUMAN',
      ...(o.extShared ? { is_ext_shared_channel: true } : {}),
      ...(o.files ? { files: o.files, subtype: 'file_share' } : {}),
    },
  };
}

export function homeOpenedEnvelope(team: string, user = 'U_HUMAN'): Record<string, unknown> {
  return {
    team_id: team,
    api_app_id: 'A0TWIN',
    type: 'event_callback',
    event: { type: 'app_home_opened', tab: 'home', user },
  };
}

export function blockActionEnvelope(
  team: string,
  actionId: string,
  value: string,
  channel = 'C_ANY',
): Record<string, unknown> {
  return {
    type: 'block_actions',
    team: { id: team },
    user: { id: 'U_HUMAN', team_id: team },
    api_app_id: 'A0TWIN',
    trigger_id: 'trig.1',
    channel: { id: channel },
    message: { ts: '1.0' },
    actions: [{ action_id: actionId, value, type: 'button' }],
    response_url: 'http://127.0.0.1:1/noop', // overwritten by createTwinApp
  };
}

// ── the app factory ──────────────────────────────────────────────────────────
// A real Bolt App wired to the twin receiver + recording API. `authorize` mints a
// per-team token `xoxb-<team>` (matching what the recording asserts on), exactly like
// the installation store would.
export async function createTwinApp(
  channelNames: Record<string, string> = {},
  files: Record<string, Record<string, unknown>> = {},
): Promise<{
  app: bolt.App;
  receiver: TwinReceiver;
  api: RecordingApi;
  stop: () => Promise<void>;
}> {
  const api = new RecordingApi(channelNames, files);
  const url = await api.start();
  const receiver = new TwinReceiver();
  const app = new App({
    receiver,
    clientOptions: { slackApiUrl: url },
    authorize: async ({ teamId, enterpriseId }) => ({
      botToken: `xoxb-${teamId ?? enterpriseId ?? 'unknown'}`,
      botId: 'B_TWIN',
      botUserId: `UBOT_${teamId ?? enterpriseId ?? 'unknown'}`,
      teamId,
      enterpriseId,
    }),
  });
  return { app, receiver, api, stop: () => api.stop() };
}
