// Envelope-metadata journal (AVEN_EVENT_LOG=1): one JSONL line per Slack envelope the
// bot receives, plus the decisions taken on it (gated / claim lost). The record → replay
// loop this feeds: journal lines captured on dev/prod (especially during the Slack
// Connect spike, whose envelope shapes we've never seen live) become sanitized fixtures
// for the twin harness (src/twin.ts), which replays them through app.processEvent — a
// "digital twin" of Slack calibrated on real traffic instead of guesses.
//
// PRIVACY BY WHITELIST: only structural fields are ever copied — never message text,
// button values, or view state. A field missing from EnvelopeMeta cannot leak.
// Deliberately a Slack-free pure extractor + a tiny appender (testable, CLAUDE.md rule).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { eventsDir } from './paths.js';

export interface EnvelopeMeta {
  at: string; // ISO receive time
  kind: string; // event type ('app_mention', 'message'), or 'command' / 'block_actions' / 'view_submission'
  subtype?: string; // message subtype, or the command verb / action_id family (never free text)
  team?: string; // context team id
  enterprise?: string;
  isEnterpriseInstall?: boolean;
  channel?: string;
  channelType?: string; // im / channel / group
  ts?: string; // event ts (dedup identity)
  threadTs?: string;
  user?: string;
  botId?: string; // present on bot-authored messages (the ignore path)
  extShared?: boolean; // is_ext_shared_channel — the Slack Connect marker
  decision?: string; // appended by the pipeline: 'gated', 'claim-lost', … (absent = delivered to handlers)
  // FULL-capture mode only (AVEN_EVENT_LOG=full): the raw envelope body, verbatim —
  // including message text and button values. For trusted-workspace phases where the
  // goal is a complete twin-fixture dataset; the default '1' mode never sets this.
  raw?: unknown;
}

// Extract the whitelist from a raw Bolt body+context. Tolerant of any shape — unknown
// payloads degrade to { kind: 'unknown' } rather than throwing in middleware.
export function envelopeMeta(
  body: unknown,
  context: { teamId?: string; enterpriseId?: string; isEnterpriseInstall?: boolean },
  now = new Date(),
): EnvelopeMeta {
  const b = (body ?? {}) as {
    type?: string;
    command?: string;
    event?: {
      type?: string;
      subtype?: string;
      channel?: string | { id?: string };
      channel_type?: string;
      ts?: string;
      thread_ts?: string;
      user?: string;
      bot_id?: string;
      is_ext_shared_channel?: boolean;
    };
    actions?: Array<{ action_id?: string }>;
    channel?: { id?: string };
  };
  const e = b.event;
  const meta: EnvelopeMeta = {
    at: now.toISOString(),
    kind: e?.type ?? (b.command ? 'command' : (b.type ?? 'unknown')),
    team: context.teamId,
    enterprise: context.enterpriseId,
  };
  if (context.isEnterpriseInstall) meta.isEnterpriseInstall = true;
  if (e) {
    if (e.subtype) meta.subtype = e.subtype;
    meta.channel = typeof e.channel === 'string' ? e.channel : e.channel?.id;
    if (e.channel_type) meta.channelType = e.channel_type;
    if (e.ts) meta.ts = e.ts;
    if (e.thread_ts) meta.threadTs = e.thread_ts;
    if (e.user) meta.user = e.user;
    if (e.bot_id) meta.botId = e.bot_id;
    if (e.is_ext_shared_channel) meta.extShared = true;
  } else if (b.command) {
    meta.subtype = b.command; // the /aven part only — never the arguments
    meta.channel = b.channel?.id;
  } else if (b.actions?.length) {
    // action_id family only (our own ids, e.g. "make_pr", "mem_open:…" → "mem_open") —
    // never the value payload.
    meta.subtype = b.actions[0]?.action_id?.split(':')[0];
    meta.channel = b.channel?.id;
  }
  return meta;
}

const dayFile = (d: Date) => `${d.toISOString().slice(0, 10)}.jsonl`;

export class EventLog {
  // `dir` is injectable for tests (same pattern as Store/QueueJournal/UsageLog).
  constructor(private readonly dir: string = eventsDir()) {}

  // Best-effort: observability must never sink an event.
  append(meta: EnvelopeMeta): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, dayFile(new Date(meta.at))), JSON.stringify(meta) + '\n');
    } catch (e) {
      log.error(`event log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// The process-wide journal, or undefined when AVEN_EVENT_LOG isn't set — call sites do
// `eventLog?.append(...)`, so the disabled path costs one undefined check.
//   AVEN_EVENT_LOG=1    → metadata-only (the privacy whitelist above)
//   AVEN_EVENT_LOG=full → metadata + the raw envelope body (trusted workspaces only —
//                         raw carries message text; don't run this once real clients land)
export const eventLog: EventLog | undefined = ['1', 'full'].includes(process.env.AVEN_EVENT_LOG ?? '')
  ? new EventLog()
  : undefined;
export const eventLogRaw: boolean = process.env.AVEN_EVENT_LOG === 'full';
