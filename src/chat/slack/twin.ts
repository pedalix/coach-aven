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
  // Base URL of the RecordingApi — when set, every envelope's response_url is rewritten
  // to land there before delivery, so respond() calls (block-action gates, session panels,
  // /aven's ephemeral flows) get captured just like Web API calls. A real response_url is
  // per-interaction and single-use; the twin just needs somewhere that answers ok:true.
  constructor(private readonly responseUrlBase?: string) {}
  init(app: bolt.App): void {
    this.app = app;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  // Deliver one envelope body to the app, exactly as SocketModeReceiver would.
  async send(body: Record<string, unknown>): Promise<void> {
    if (!this.app) throw new Error('twin receiver not initialized');
    if (this.responseUrlBase && typeof body.response_url === 'string') {
      body = { ...body, response_url: `${this.responseUrlBase}respond` };
    }
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
  // Force a method to answer ok:false, e.g. `api.failures['views.open'] = 'internal_error'`.
  // Slack's own failures are what the fallback paths exist for, so a test has to be able to
  // stage one — the show_trail modal died in prod exactly this way and nobody saw it.
  readonly failures: Record<string, string> = {};
  // Extra fields merged into a method's ok answer, e.g. `api.responses['conversations.open'] =
  // { channel: { id: 'D1' } }` — for the paths that read something back beyond ts.
  readonly responses: Record<string, Record<string, unknown>> = {};
  private server?: Server;
  private posted = 0;
  // seqTs: answer every chat.postMessage with a fresh ts (1000.0001, 1000.0002, …) so a
  // recording can tell WHICH message a later chat.update targets. Off by default — the
  // tenant twin tests were written against the constant ts.
  constructor(
    private readonly channelNames: Record<string, string> = {},
    private readonly files: Record<string, Record<string, unknown>> = {},
    private readonly seqTs = false,
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
        res.setHeader('content-type', 'application/json');
        if (this.failures[method]) {
          res.end(JSON.stringify({ ok: false, error: this.failures[method] }));
          return;
        }
        const ts = this.seqTs && method === 'chat.postMessage' ? `1000.${String(++this.posted).padStart(4, '0')}` : '9999.0001';
        const body: Record<string, unknown> = { ok: true, ts };
        if (method === 'conversations.info') {
          const id = String(payload.channel ?? '');
          body.channel = { id, name: this.channelNames[id] };
        }
        if (method === 'views.open') body.view = { id: 'V1' };
        if (method === 'files.info') body.file = this.files[String(payload.file ?? '')];
        Object.assign(body, this.responses[method] ?? {});
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

  // Forget recorded calls and restart the seqTs counter — one recording per scenario.
  reset(): void {
    this.calls.length = 0;
    this.posted = 0;
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
  // Set for buttons that live on a message INSIDE a thread — handlers read it to place
  // their ephemeral reply in the thread rather than the channel (see #80).
  threadTs?: string,
): Record<string, unknown> {
  return {
    type: 'block_actions',
    team: { id: team },
    user: { id: 'U_HUMAN', team_id: team },
    api_app_id: 'A0TWIN',
    trigger_id: 'trig.1',
    channel: { id: channel },
    message: threadTs ? { ts: '1.0', thread_ts: threadTs } : { ts: '1.0' },
    actions: [{ action_id: actionId, value, type: 'button' }],
    response_url: 'http://127.0.0.1:1/noop', // rewritten by TwinReceiver.send to the RecordingApi
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
  const receiver = new TwinReceiver(url);
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
