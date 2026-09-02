import { readFileSync } from 'node:fs';

// Replay fixtures for the twin harness (twin.ts): real Slack envelopes captured on prod by
// the event journal (eventlog.ts, AVEN_EVENT_LOG=full), scrubbed, and committed under
// src/fixtures/. This closes the loop the journal was built for — the twin replays traffic
// Slack actually sent instead of envelopes we composed from memory. The first rating test
// asserted a hand-written `rich_text` block round-trips through chat.update; only Owen's
// manual click on prod proved the real shape matched. A captured envelope proves it in CI.
//
// SCRUBBING IS BY SHAPE, NOT BY BLACKLIST. Every string that could identify a person, a
// workspace, or a message is rewritten by rule; structure (keys, nesting, block types,
// timestamps, our own button/metadata values) is kept byte-for-byte. The fixture must be
// useless to a reader and indistinguishable from the original to a Bolt handler.
//
// Pure — no Slack, no fs except the loader — and tested (CLAUDE.md rule).

export interface Fixture {
  kind: string; // eventlog `kind` (app_mention, block_actions, view_submission, ...)
  subtype?: string; // action_id / callback_id / command, when the kind has one
  capturedOn: string; // YYYY-MM-DD — enough provenance, no clock
  // Which placeholder ids play which part, so a test can rehome() the fixture onto the
  // twin's own team/channel/user ids without knowing where each id appears.
  roles: { team?: string; channel?: string; actor?: string; bot?: string };
  body: Record<string, unknown>; // the scrubbed envelope, ready for TwinReceiver.send
}

// Slack ids: one type letter, then 8+ upper-alphanumerics with at least one digit.
// T team, U/W user, C/G/D channel, A app, E enterprise, B bot, F file.
const ID_RE = /^[TUWCGDAEBF](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;
// The same id shape embedded in a longer string — a mention, a JSON-encoded value (our own
// private_metadata carries a channel id), a URL. Word-bounded so timestamps, hashes and our
// lowercase turnIds never match.
const EMBEDDED_ID_RE = /\b[TUWCGDAEBF](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g;
const MENTION_RE = /<([@#])([TUWCGDAEBF][A-Z0-9]{8,})(\|[^>]*)?>/g;

// Keys whose string value is replaced by a constant, whatever it holds.
const CONSTANT_KEYS: Record<string, string> = {
  token: 'FIXTURE_TOKEN',
  trigger_id: 'FIXTURE.trigger.id',
  response_url: 'https://hooks.slack.invalid/fixture',
  client_msg_id: 'fixture-client-msg-id',
  event_id: 'EvFIXTURE',
  event_context: 'FIXTURE_CONTEXT',
  api_app_id: 'AFIXTURE',
};
// Keys that name a human, a workspace, or a channel by name — matched by shape: anything
// ending in `name` (username, first_name, name_normalized, old_name, channel_name...), plus
// the handful Slack spells differently.
const NAME_KEY_RE = /name(_normalized)?$|^(domain|team_domain|title|email)$/;
// Keys whose string is free text a person (or the bot, on their behalf) wrote: message text,
// a prefilled textarea, attachment fallbacks, alt text. Only mentions survive.
const TEXT_KEYS = new Set(['text', 'initial_value', 'fallback', 'pretext', 'alt_text', 'placeholder']);
// Profile images and their hashes identify a person as surely as a name.
const AVATAR_KEY_RE = /^(image_\d+|image_original|avatar_hash)$/;
// File fields that are URLs or previews — carry content, dropped outright.
const FILE_DROP_RE = /^(url_|permalink|thumb_|preview|edit_link|deanimate)/;
const URL_RE = /^https?:\/\//i;

class IdMap {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  map(id: string): string {
    const known = this.seen.get(id);
    if (known) return known;
    const prefix = id[0];
    const n = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, n);
    const out = `${prefix}_FIX_${n}`;
    this.seen.set(id, out);
    return out;
  }
  get(id: string | undefined): string | undefined {
    return id ? (this.seen.get(id) ?? this.map(id)) : undefined;
  }
}

// Free text keeps only its mention tokens (remapped) — a mention is routing, the rest is
// content. `<@UBOT> please look at the cable car sales` → `<@U_FIX_2> [text]`.
function scrubText(s: string, ids: IdMap): string {
  const mentions: string[] = [];
  s.replace(MENTION_RE, (_m, sigil: string, id: string) => {
    mentions.push(`<${sigil}${ids.map(id)}>`);
    return '';
  });
  return mentions.length ? `${mentions.join(' ')} [text]` : '[text]';
}

const fileName = (n: number, original: unknown): string => {
  const ext = typeof original === 'string' && /\.[a-z0-9]{1,5}$/i.test(original) ? original.slice(original.lastIndexOf('.')) : '';
  return `file-${n}${ext.toLowerCase()}`;
};

function walk(value: unknown, ids: IdMap, ctx: { key?: string; parentType?: string; inFile: boolean; files: { n: number } }): unknown {
  if (typeof value === 'string') {
    if (ctx.key && ctx.key in CONSTANT_KEYS) return CONSTANT_KEYS[ctx.key];
    if (ID_RE.test(value)) return ids.map(value);
    if (ctx.key && AVATAR_KEY_RE.test(ctx.key)) return 'fixture';
    if (ctx.key && NAME_KEY_RE.test(ctx.key)) return ctx.inFile && ctx.key === 'name' ? fileName(++ctx.files.n, value) : 'fixture';
    if (ctx.key && TEXT_KEYS.has(ctx.key)) return scrubText(value, ids);
    // Typed-in values are content; option/button values are ours (taxonomy, turn meta).
    if (ctx.key === 'value' && ctx.parentType === 'plain_text_input') return '[text]';
    // Every URL points at something real — a PR in a client repo, an avatar, a file.
    if (URL_RE.test(value)) return 'https://example.invalid/fixture';
    // Any other string may still embed an id — in a mention or a JSON-encoded value.
    return value.replace(EMBEDDED_ID_RE, (id) => ids.map(id));
  }
  if (Array.isArray(value)) {
    const inFile = ctx.inFile || ctx.key === 'files';
    return value.map((v) => walk(v, ids, { ...ctx, key: undefined, inFile }));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parentType = typeof obj.type === 'string' ? obj.type : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'enterprise' && v !== null && typeof v === 'object') {
        out[k] = null; // whole enterprise object is identity
        continue;
      }
      if (ctx.inFile && FILE_DROP_RE.test(k)) continue;
      out[k] = walk(v, ids, { key: k, parentType, inFile: ctx.inFile, files: ctx.files });
    }
    return out;
  }
  return value; // numbers, booleans, null pass through — timestamps are not identity
}

// Which real ids played which part, read off the raw envelope BEFORE scrubbing so the roles
// can be expressed in placeholder ids afterwards.
function detectRoles(raw: Record<string, unknown>): { team?: string; channel?: string; actor?: string; bot?: string } {
  const ev = (raw.event ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const team = str(raw.team_id) ?? str((raw.team as Record<string, unknown> | undefined)?.id);
  // A view_submission carries no channel of its own — the only one is whatever the modal's
  // opener tucked into private_metadata, so fall back to the first channel-shaped id there.
  const pmChannel = str((raw.view as Record<string, unknown> | undefined)?.private_metadata)?.match(/[CGD](?=[A-Z0-9]*\d)[A-Z0-9]{8,}/)?.[0];
  const channel =
    str(ev.channel) ??
    str((ev.item as Record<string, unknown> | undefined)?.channel) ??
    str((raw.channel as Record<string, unknown> | undefined)?.id) ??
    str(raw.channel_id) ??
    str((raw.container as Record<string, unknown> | undefined)?.channel_id) ??
    pmChannel;
  const actor = str(ev.user) ?? str((raw.user as Record<string, unknown> | undefined)?.id) ?? str(raw.user_id);
  let bot: string | undefined;
  const text = str(ev.text);
  if (text) {
    for (const m of text.matchAll(MENTION_RE)) {
      if (m[1] === '@' && m[2] !== actor) {
        bot = m[2];
        break;
      }
    }
  }
  if (!bot) {
    const auth = (raw.authorizations as Array<Record<string, unknown>> | undefined)?.[0];
    if (auth?.is_bot === true) bot = str(auth.user_id);
  }
  return { team, channel, actor, bot };
}

// Pure: one captured envelope → a committable fixture. Deterministic for a given input.
export function scrubEnvelope(raw: Record<string, unknown>, meta: { kind: string; subtype?: string; capturedOn: string }): Fixture {
  const ids = new IdMap();
  const realRoles = detectRoles(raw);
  // Map role ids FIRST so they get the lowest placeholder numbers, regardless of where
  // they first appear in the walk — makes fixtures readable (T_FIX_1 is always the team).
  for (const id of [realRoles.team, realRoles.channel, realRoles.actor, realRoles.bot]) if (id) ids.map(id);
  const body = walk(raw, ids, { inFile: false, files: { n: 0 } }) as Record<string, unknown>;
  return {
    kind: meta.kind,
    subtype: meta.subtype,
    capturedOn: meta.capturedOn,
    roles: { team: ids.get(realRoles.team), channel: ids.get(realRoles.channel), actor: ids.get(realRoles.actor), bot: ids.get(realRoles.bot) },
    body,
  };
}

// Pure: swap the fixture's placeholder role ids for the twin's real ones, everywhere they
// occur — as bare id values and inside mention tokens alike. Returns a fresh body.
export function rehome(f: Fixture, to: { team?: string; channel?: string; actor?: string; bot?: string }): Record<string, unknown> {
  const swaps: Array<[string, string]> = [];
  for (const role of ['team', 'channel', 'actor', 'bot'] as const) {
    const from = f.roles[role];
    const target = to[role];
    if (from && target) swaps.push([from, target]);
  }
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const [from, target] of swaps) s = s.split(from).join(target);
      return s;
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return swap(f.body) as Record<string, unknown>;
}

// Load a committed fixture by file stem, e.g. loadFixture('block_actions.fb_good').
export function loadFixture(name: string): Fixture {
  const path = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}
