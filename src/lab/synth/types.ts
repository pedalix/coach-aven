// The synthetic bench tenant `bench-agency` (OpenSpec-less lab code; see the spec in the lab notes, 05 Part 2):
// a fictional SMB digital agency whose whole month of work traffic is PLANNED first and rendered second.
//
//   world.ts  the world as typed data (people with every surface form, companies, initiatives, channels, hosts)
//   plan.ts   storylines + background traffic + noise → PlannedItem[] with exact truth, and the GIVEN tenant
//   (renderer)  fills `text: null` items with model-written prose from their Beat; never invents facts
//   (raw writer) writes every item's RawLine[] (puller contracts) after filling text slots → raw/ → buildStore()
//
// Why plan-then-render: truth must be exact by construction (labels are written from the skeleton, not
// inferred from prose), and the expensive model step must be replaceable/re-runnable without moving a single
// label. Everything here is deterministic for a seed (same seed → byte-identical plan.jsonl).
//
// Everything is FICTIONAL: invented people, *.example domains, no real company or client names.

import type { MentionUnit } from '../types.js';

export const SYNTH_VERSION = 1;

// --- people ------------------------------------------------------------------------------------------

export type Lang = 'de' | 'en' | 'ru' | 'it' | 'fr';
export type Register = 'formal' | 'neutral' | 'casual' | 'terse';

/** How a person writes — the renderer's persona card. */
export interface Persona {
  register: Register;
  typoRate: number; // 0..1: share of their messages with one natural typo
  emoji: 'none' | 'rare' | 'often';
  greeting?: string; // habitual opener ("Grüezi", "Hi all", "Привет")
  signature?: string; // mail signature block (fictional)
  translit?: number; // RU writers: share of messages in Latin transliteration
  swiss?: boolean; // Swiss spellings (ss for ß, "merci vielmal", "Grüezi")
  notes?: string; // free persona hint ("short, always mentions the ticket key")
}

/** The raw-mention field a surface form appears in — the bench's MentionUnit field vocabulary. */
export type MentionField = MentionUnit['field'];

export type FormKind =
  | 'email'
  | 'alias_email' // second address of the same person (alias domain, rebrand, short local part)
  | 'slack_label' // Slack display label as the puller writes it (incl. "Name | Company" Connect labels)
  | 'slack_handle'
  | 'opaque_id' // a raw Slack U-id the users map cannot resolve
  | 'login' // youtrack:<login>
  | 'login_org_suffix' // youtrack:<login>@<ORG> (no TLD — never parses as an e-mail)
  | 'full_name'
  | 'order_swapped' // "Müller, Jürg"
  | 'first_name'
  | 'nickname'
  | 'transliteration'
  | 'umlaut_variant' // ü → ue / u
  | 'typo'
  | 'glued_pair' // Gemini "Invited" chips joined without a separator
  | 'role_mailbox'; // a team/role address operated by a person (einkauf@, office@)

export type Expected = 'mapped' | 'merge' | 'question' | 'drop';

export interface SurfaceForm {
  raw: string; // exactly as the store will see it (author_raw, participant label, attendee name/email, assignee raw)
  form: FormKind;
  given: boolean; // listed (by identityKey) in the GIVEN annotations/people.json → resolves in the store today
  expected: Expected; // what an ideal identity step does with it against the GIVEN roster
  from?: string; // YYYY-MM-DD: first day this form is used (post-rebrand addresses, renamed labels)
  until?: string; // YYYY-MM-DD: last day (pre-rebrand forms)
  where?: string[]; // which raw fields carry it: 'slack' | 'mail' | 'pmail' | 'cal' | 'granola' | 'gmeet' | 'wispr' | 'yt' | 'jira'
  ambiguous?: string[]; // person ids the raw alone cannot tell apart ("Marco")
}

export type Side = 'us' | 'client' | 'vendor' | 'personal' | 'candidate' | 'prospect' | 'freelance';

export interface Person {
  id: string; // person_id (truth roster key; also people.json person_id when given)
  name: string; // canonical full name
  company: string; // company id
  side: Side;
  role: string; // one line for the persona card
  langs: Lang[]; // first = default language
  persona: Persona;
  email: string | null; // primary address, lower-case
  slack?: { id: string; handle: string; label: string; guest?: boolean; inDirectory: boolean };
  forms: SurfaceForm[]; // every surface form (truth roster)
  given: boolean; // present in the GIVEN people.json at all
  marker: { type: 'exclusive' | 'narrow' | 'broad'; initiatives: string[] } | null; // as GIVEN
}

export interface Company {
  id: string;
  name: string;
  umbrella: string | null; // billing frame (registry umbrella); null = not a client/agency (vendors, personal)
  domains: string[]; // mail domains, oldest first (a rebrand appends)
  side: Side;
}

// --- registry ------------------------------------------------------------------------------------------

/** One initiative of the TRUE world. `registered: false` = a truth-only topic the GIVEN registry lacks. */
export interface WorldInitiative {
  id: string; // label id (alias-resolved): 'alpenhof/relaunch', 'unregistered:zermatt-pitch'
  umbrella: string;
  company: string;
  name: string;
  status: 'active' | 'planned' | 'done' | 'alias';
  billing_code: string;
  registered: boolean;
  admin?: boolean; // the umbrella's non-billable admin bucket
  personal?: boolean;
}

export interface Channel {
  id: string; // C… / D… / G… (raw ids)
  name: string; // name at window start (no '#'); DMs/mpims: the container label
  kind: 'public' | 'private' | 'connect' | 'dm' | 'mpim';
  container: string; // the puller's label: '#ext-swl', 'dm:@jonas', 'mpim:@lea+@tobias'
  renamed?: { at: string; name: string; container: string }; // rename: lines after `at` carry the new label
  members: string[]; // person ids (humans who post here)
  initiative: string | null; // the channel's TRUE default topic (null = mixed)
}

export interface Repo {
  container: string; // 'git.brightwell.example/brightwell/booker' as the activity puller writes it
  initiative: string; // truth
  renamed?: { at: string; container: string };
}

/** A monitored host (#ops-alerts) or a deployed app (#deploys): item-level routing truth for shared bot channels. */
export interface Asset {
  name: string; // host name or app name as it appears in bot text
  kind: 'host' | 'app';
  initiative: string; // truth (may be 'unregistered:<slug>')
}

export interface BotSender {
  id: string; // stable key ('uptime', 'sentry', 'nl-webweekly', …)
  kind: 'slack_bot' | 'mail_bot' | 'newsletter' | 'notification' | 'receipt' | 'digest' | 'autoreply';
  label: string; // Slack author label / display name
  address?: string; // mail From (lower-case)
  slackBotId?: string; // B… id
  unflagged?: boolean; // Slack: legacy line without is_bot and a raw B-id author (the bot-flag gap)
}

export interface World {
  version: number;
  slug: string; // 'bench-agency'
  tz: string; // 'Europe/Zurich' — days are local days here
  since: string; // window start, local YYYY-MM-DD (a Monday)
  until: string; // window end, local YYYY-MM-DD (a Sunday)
  now: string; // the loader's fixed clock (ISO UTC)
  subject: string; // person id of the owner (subject-centric layer)
  agency: string; // company id of the agency
  accounts: {
    slackTeam: string; // T…
    slackUrl: string; // workspace URL permalinks are built on
    selfSlackId: string; // the subject's U-id
    work: string; // gmail + gcal + gmeet account (lower-case)
    personal: string; // personal gmail account
    granola: string;
    wispr: string;
    youtrack: string; // host
    jira: string; // site
    host: string; // activity machine name
  };
  companies: Company[];
  people: Person[];
  initiatives: WorldInitiative[];
  channels: Channel[];
  repos: Repo[];
  assets: Asset[];
  bots: BotSender[];
  // Renames (truth): what changed when. The GIVEN tenant reflects the end-of-window state imperfectly.
  renames: { kind: 'initiative' | 'channel' | 'tracker_key' | 'repo' | 'domain'; from: string; to: string; at: string }[];
  /** slack.users.json exactly as the raw writer must write it (Marco Rossi's guest id deliberately absent). */
  slackUsers: { id: string; name: string; real_name: string; is_bot: boolean; is_app_user: boolean; deleted: boolean; profile: { display_name: string; real_name: string } }[];
}

// --- planned items ----------------------------------------------------------------------------------

export type Source = 'slack' | 'gmail' | 'gcal' | 'youtrack' | 'jira' | 'granola' | 'gmeet' | 'wispr' | 'git' | 'claude';
export type ItemType = 'message' | 'task' | 'comment' | 'event' | 'meeting' | 'activity';

/** The renderer's brief for ONE human-written text. It may not add facts (keys, dates, amounts, names) beyond these. */
export interface Beat {
  brief: string; // 1–2 sentences: what this item says
  persona: string; // writer's person id (persona card in world.people) or 'aven' (the project agent)
  lang: Lang;
  translit?: boolean; // Russian written in Latin letters
  mix?: Lang; // code-switch: a phrase or two in this language
  register: Register;
  required: string[]; // verbatim tokens: ticket keys, URLs, amounts, dates, '@Label' mentions, names to greet
  forbidden: string[]; // must not appear: other tickets' keys, initiative ids, truth vocabulary
  words: [number, number]; // length range
  pos?: { index: number; of: number }; // thread position (0 = root) and planned thread size
  context: string[]; // plan ids the writer has seen (thread so far / quoted mail), oldest first
  smallTalk?: boolean; // greeting/thanks/lunch — no work content at all
  mail?: { greet: string; signOff: boolean }; // mails: whom to greet, whether to sign
  /** Meetings (primary copy only): the call content the renderer writes as CallContent. */
  meeting?: {
    topics: { heading: string; share: number; brief: string }[]; // H2 sections; body length ∝ share
    nextSteps: { owner: string; ownerLabel: string; brief: string; due: string | null; commitment: string | null }[];
    speakers: string[]; // transcript speaker labels, in speaking order of first appearance
    minutes: number;
  };
}

/** Deterministic text derived from another item's final text (duplicates, forwards, cross-posts, edits). */
export interface DeriveOp {
  prefix?: string; // prepended verbatim (forward headers, "cross-post from #x:")
  suffix?: string;
  quote?: boolean; // prefix every line of the source with "> "
  perturb?: 'typo' | 'truncate'; // first emission of an edited message: swap two letters / drop the last sentence
  re60?: boolean; // Slack reply subject: 're: ' + Slack's truncate(flattened parent text, 60)
}

export type RenderSpec =
  | { mode: 'template' } // `text` is final now (bots, newsletters, notifications, digests, activity)
  | { mode: 'derived'; from: string; op: DeriveOp } // text = applyDerive(final text of `from`, op); a meeting copy instead
  //                                                    styles its call's CallContent (rendered once on `from`) with formatCopy()
  | { mode: 'human'; beat: Beat }; // `text` is null until the renderer fills it

/** Which part of an item's rendered output a raw-record slot takes. */
export type TextPart =
  | 'text' // message/mail/comment/ticket description body
  | 'summary' // meeting copy: markdown summary in its recorder's style
  | 'transcript'
  | 'next_steps' // string[] — extractNextSteps(summary) exactly as the puller computes it
  | 'flatten'; // meeting `text`: flatten({title, summary, next_steps}) of the filled record itself

/** A slot in a raw record: JSON path ← part of a plan item's final text (after rendering / derivation). */
export interface Fill {
  path: string; // dot path into `record` ('text', 'subject', 'comments.3.text', 'summary')
  item: string; // plan id whose text is used
  part: TextPart;
  op?: DeriveOp; // applied to the item's text before it goes in (edits' first emission, reply subjects)
}

/** One raw JSONL line exactly in its puller's contract; `fill` slots are null in `record` until rendered. */
export interface RawLine {
  file: string; // path under raw/ ('slack/slack.messages.jsonl', 'google/<acct>/messages.jsonl', …)
  at: string; // emission time (ISO UTC): lines of a file are written in (at, plan order) order
  record: Record<string, unknown>;
  fill: Fill[];
}

// --- truth ------------------------------------------------------------------------------------------

export interface Share {
  id: string; // registry id (alias-resolved), '<umbrella>/admin', 'personal/personal' or 'unregistered:<slug>'
  share: number; // sums to 1 over an item's shares
}

/** Which rung SHOULD decide the item (spec 2.8): a diagnostic for per-rung recall. */
export type DecidableBy = 'rule' | 'key' | 'channel' | 'marker' | 'title' | 'content' | 'context' | 'ambiguous';

/** Spec 2.8 kinds. The bench's t4-kind vocabulary (src/lab/types.ts KINDS) has no 'answer': benchKind() maps it to 'info'. */
export type TruthKind = 'request' | 'question' | 'commitment' | 'incident' | 'answer' | 'info' | 'noise';
export type NoiseType = 'small_talk' | 'notification' | 'newsletter' | 'autoreply';

/** Noise catalogue tags (spec 2.5) — several per item. */
export type NoiseTag =
  | 'notification'
  | 'alert'
  | 'flap'
  | 'refire'
  | 'deploy'
  | 'integration'
  | 'autoreply'
  | 'newsletter'
  | 'newsletter_overlap' // newsletter vocabulary overlapping client work
  | 'exact_dup'
  | 'near_repeat'
  | 'bump'
  | 'crosspost'
  | 'forward'
  | 'recorder_copy'
  | 'late_copy' // gmeet doc arriving a day late
  | 'call_split_trap' // copies of one call whose windows do not overlap enough to cluster
  | 'ticket_duplicate'
  | 'digest'
  | 'receipt'
  | 'invite'
  | 'small_talk'
  | 'multi_initiative'
  | 'rename'
  | 'unregistered'
  | 'name_only'
  | 'glued'
  | 'identity_variant'
  | 'opaque_id'
  | 'edit'
  | 'tombstone'
  | 'cancelled'
  | 'status_variant'
  | 'private'
  | 'recurring'
  | 'unflagged_bot' // Slack bot line without is_bot (raw B-id author)
  | 'ambiguous'
  | 'over_broad_title' // the GIVEN registry's "sync" title pattern fires wrongly
  | 'stale_rule'; // the GIVEN #ops-alerts rule is wrong for this item

export interface Addressee {
  to: string[]; // person ids who must act/answer (sorted)
  side?: string; // company id when addressed to a side ("you guys at SWL")
  agent?: 'aven'; // addressed to the project agent
  broadcast?: boolean; // @channel / all-hands / newsletter-like
  addressing: 'explicit' | 'implicit' | 'none'; // @mention / To: vs DM-or-context vs nobody
}

export interface CommitmentTruth {
  id: string; // 'cm-…' — the same commitment across recorder copies and follow-ups
  owner: string; // person id
  to: string[]; // person ids it was promised to
  due: string | null; // YYYY-MM-DD local
  outcome: 'kept' | 'missed' | 'open';
  keptBy?: string | null; // plan id of the item that fulfils it
}

/** One raw surface-string occurrence on an item, with its identity truth. */
export interface IdentityOcc {
  field: MentionField;
  raw: string; // as the store sees it
  truth: string; // person id | '+'-joined sorted person ids (glued) | 'system'
  form: FormKind | 'system';
  expected: Expected;
  ambiguous?: string[]; // person ids a careful reader could not tell apart from the raw alone ("Marco")
}

export type DedupType = 'exact' | 'near' | 'flap' | 'bump' | 'crosspost' | 'forward' | 'recorder_copy' | 'digest' | 'ticket_duplicate';

export interface ItemTruth {
  // t1 — initiative
  label: string; // primary: the largest share's id, or 'none'
  shares: Share[]; // [] when label is 'none'
  decidableBy: DecidableBy;
  // t2 — repeats. cluster = this item's ref when it belongs to no planned cluster.
  cluster: string;
  dedupType: DedupType | null;
  canonical: boolean; // the cluster's representative
  family: string | null; // template family of machine items ('alert:<rule>:<host>', 'deploy:<app>', 'newsletter:<sender>')
  // t4 — kind + addressee (null where the task does not apply: events, activity, meeting copies)
  kind: TruthKind | null;
  noiseType?: NoiseType;
  addressee: Addressee | null;
  expectsReply: boolean;
  answeredBy: string | null; // plan id of the answering item
  commitments: CommitmentTruth[]; // made in this item (meeting copies: the call's next steps)
  // descriptive
  lang: Lang | null;
  human: boolean; // written by a person (not a bot/notification/template)
  fromSubject: boolean;
  fromAgent: boolean; // the project agent "Aven"
  incoming: boolean; // human, not from the subject, not from the agent
  noise: NoiseTag[];
  storyline: string; // 's1-alpenhof' … 's8-ambiguity', 'background', 'noise'
  deleted: boolean; // tombstoned by plan — final store row deleted, excluded from scoring
  identities: IdentityOcc[]; // every raw surface string on this item
}

export interface PlannedItem {
  id: string; // plan id: '<source>-<seq>' — stable for a seed
  ref: string; // store ref source:account:id (comments: '<task ref>#c<comment id>')
  altRef?: string; // 'meeting:<src>:<id>' / 'activity:<src>:<id>' shorthands (fragment refs)
  type: ItemType;
  source: Source;
  account: string;
  ts: string; // ISO UTC: message ts / mail date / event start / meeting start / comment ts / ticket created
  day: string; // local day in world.tz
  threadId: string; // the store's thread id (threadIdOf) for messages; the ref otherwise
  thread?: { root: string; index: number; size: number }; // planned conversation: root plan id, position, size
  container: string | null; // as stored after relabelling (Slack label at that time, gmail folder, calendar, repo)
  author: string | null; // raw author/organizer/reporter string as the store sees it
  authorPerson: string | null; // truth person id ('system' for machines)
  title?: string; // ticket title / mail subject / event or meeting title / activity title — planned, final
  keys: string[]; // tracker keys this item carries (required in its text)
  render: RenderSpec;
  text: string | null; // final text when render.mode === 'template', else null until rendered/derived
  rendered: boolean; // text is final now
  lines: RawLine[]; // raw JSONL lines in emission order (edits, status re-emits, tombstones, late copies)
  meeting?: { call: string; recorder: 'granola' | 'gmeet' | 'wispr'; primary: boolean; invited?: string; style: 'granola' | 'gmeet' | 'wispr' };
  truth: ItemTruth;
}

/** What the renderer returns for a call (rendered once, on the primary copy) — formatCopy() styles each copy. */
export interface CallContent {
  intro: string; // 1–3 sentence overview
  topics: { heading: string; body: string }[]; // same headings and order as the beat's topics
  nextSteps: { ownerLabel: string; text: string }[]; // same order as the beat's nextSteps
  transcript: { speaker: string; text: string }[];
}

// --- truth files (truth/) ---------------------------------------------------------------------------

export interface TruthItemRow {
  ref: string;
  plan: string; // plan id
  unit: 'message' | 'thread' | 'task' | 'comment' | 'meeting' | 'meeting_topic' | 'event' | 'activity';
  day: string;
  label: string; // initiative label (spec 2.8: registry id | 'none' | 'unregistered:<slug>')
  initiatives: Share[];
  decidable_by: DecidableBy;
  kind: TruthKind | null;
  noise_type?: NoiseType;
  addressee: Addressee | null;
  expects_reply: boolean;
  answered_by: string | null; // ref
  commitments?: CommitmentTruth[];
  lang: Lang | null;
  noise: NoiseTag[];
  cluster: string;
  storyline: string;
  human: boolean;
  incoming: boolean;
  deleted: boolean;
}

export interface DedupRow {
  cluster_id: string;
  type: DedupType;
  members: string[]; // refs
  canonical: string; // ref
}

export interface IdentityRow {
  raw: string;
  truth: string; // person id | '+'-joined | 'system'
  given: boolean; // every person in `truth` is in the GIVEN roster
  form: FormKind | 'system';
  expected: Expected;
  fields: MentionField[];
  sources: string[];
  seen: number;
  first_ref: string;
  ambiguous?: string[];
}

export interface RosterEntry {
  person_id: string;
  name: string;
  company: string;
  side: Side;
  given: boolean;
  forms: SurfaceForm[];
}

export interface PatternRow {
  pattern_id: string;
  initiative: string;
  members: string[]; // refs
  first_seen: string;
  last_seen: string;
  note: string;
}

export interface Truth {
  items: TruthItemRow[];
  dedup: DedupRow[];
  identities: IdentityRow[];
  roster: RosterEntry[];
  patterns: PatternRow[];
  commitments: (CommitmentTruth & { ref: string; what: string })[];
}

/** The GIVEN tenant files, path (relative to tenant/) → content. JSON values are written pretty, .jsonl as text. */
export type GivenTenant = Record<string, unknown>;

export interface Plan {
  world: World;
  items: PlannedItem[];
  truth: Truth;
}
