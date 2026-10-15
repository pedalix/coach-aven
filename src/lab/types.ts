// The lab bench contract. Every producer (the real-store exporter, the synthetic tenant, the silver
// labeller) writes datasets in this shape, and every pipeline variant reads it — so the parts can be
// built in parallel and swapped without touching each other.
//
// A dataset is a directory:
//   meta.json                 DatasetMeta
//   store.sqlite              the frozen store the units were exported from (variants may query it read-only)
//   tenant/                   the tenant data the pipeline is GIVEN (initiatives.json, annotations/*) — as of the
//                             freeze, i.e. deliberately imperfect for synthetic tenants
//   units/<unitKind>.jsonl    FragmentUnit | ItemUnit | MentionUnit — features only, never labels
//   gold/<task>.jsonl         GoldRow — one per labelled unit and task; several tiers may coexist
//
// Real datasets live outside the repo (private data); only the synthetic tenant is committed.

export type TaskId =
  | 't1-fragment' // the subject's fragment (call topic, message run, work block) → initiative
  | 't1-item' // an item of the stream (thread, ticket, message, meeting) → initiative
  | 't2-dedup' // an item → its repeat family (a clustering)
  | 't3-identity' // a raw participant mention → person(s)
  | 't4-kind' // an incoming item → request | question | commitment | incident | info | noise
  | 't4-addressee'; // an incoming item → who must act/answer (setKey of person ids, or 'none')

export const TASKS: TaskId[] = ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'];

export type UnitKind = 'fragment' | 'item' | 'mention';
export const UNIT_OF: Record<TaskId, UnitKind> = {
  't1-fragment': 'fragment',
  't1-item': 'item',
  't2-dedup': 'item',
  't3-identity': 'mention',
  't4-kind': 'item',
  't4-addressee': 'item',
};

// Closed label vocabularies. Initiative labels are registry ids (alias_of resolved) plus these:
export const NONE = 'none'; // not work / noise / nothing to attribute
export const UNREGISTERED = 'unregistered'; // real work on a topic the registry does not know yet
export const KINDS = ['request', 'question', 'commitment', 'incident', 'info', 'noise'] as const;
export type Kind = (typeof KINDS)[number];
// Identity labels: a person_id, a '+'-joined sorted list for a glued mention, or one of these:
export const SYSTEM = 'system'; // a bot / role mailbox / integration
export const UNKNOWN = 'unknown'; // a real person who is not in the roster (would be a "new person")

export interface DatasetMeta {
  name: string; // e.g. 'owen-ops-real', 'bench-agency'
  kind: 'real' | 'synthetic';
  tenant: string; // slug
  tz: string; // tenant zone: days are LOCAL days in this zone
  since: string; // YYYY-MM-DD (local)
  until: string; // YYYY-MM-DD (local)
  subject?: string; // person_id of the owner (subject-centric tenants)
  createdAt: string;
  sourceStore: string; // where store.sqlite was copied from / how it was built
  labelSpace: {
    initiatives: string[]; // closed list for t1 (registry ids incl. admin buckets and personal), alias-resolved
    umbrellas: Record<string, string>; // initiative id → umbrella (billing frame) for umbrella-level scoring
    people: string[]; // closed list for t3/t4-addressee
  };
  counts: Partial<Record<UnitKind, number>>;
  notes?: string;
}

// --- units -------------------------------------------------------------------------------------------

export interface FragmentUnit {
  id: string; // frag-<UTC day>-<kind>-<hash>[#n] — the production fragmenter's id
  day: string; // local day
  kind: 'call' | 'thread' | 'work';
  start: string;
  end: string;
  minutes: number; // wall minutes of the draft (weight-scaled for call topics)
  title: string;
  source: string;
  container: string | null;
  participants: string[]; // resolved person ids (production resolution at freeze)
  projectKeys: string[];
  repo: string | null;
  weight: number;
  refs: string[]; // store refs of the evidence
  text: string; // evidence text, truncated (summary section / run messages / work items)
  ladder?: { state: string; initiative?: string; candidates?: string[]; rule?: string; hint?: string }; // today's production ladder, for reference
}

export interface ItemUnit {
  id: string; // store ref (message/task/meeting/event), or thread:<thread_id>
  day: string;
  ts: string;
  type: 'message' | 'thread' | 'task' | 'comment' | 'meeting' | 'event';
  source: string;
  account: string;
  container: string | null;
  thread: string | null;
  author: string | null; // raw author label/email
  authorPerson: string | null; // production resolution
  isBot: boolean; // production is_bot
  participants: string[]; // raw labels/emails
  toPersons: string[]; // production message_people role='to'
  subject: string | null;
  text: string; // truncated (2,000 chars)
  keys: string[]; // tracker keys / urls found in the text
  context?: { ref: string; author: string | null; ts: string; text: string }[]; // up to 3 previous messages of the thread
  fromSubject?: boolean; // authored by the dataset subject
}

export interface MentionUnit {
  id: string; // mention:<field>:<hash(raw|ref)>
  day: string; // local day of the first occurrence (replay order)
  raw: string; // the surface string as stored (name, email, label, glued line)
  field: 'author' | 'participant' | 'attendee' | 'organizer' | 'assignee' | 'reporter' | 'comment_author' | 'owner';
  source: string;
  ref: string; // where it was seen (first occurrence)
  seen: number; // occurrences in the window
  context: {
    title?: string;
    start?: string;
    container?: string | null;
    coMentions?: string[]; // other raw mentions on the same record
    linkedEvent?: { title: string; start: string; attendees: string[] } | null; // calendar event linked to a meeting (±15 min, same title)
    speakers?: string[]; // transcript speaker labels (meetings)
  };
  production: string | null; // person_id the store resolves it to today (null = unresolved / dropped)
}

export type Unit = FragmentUnit | ItemUnit | MentionUnit;

// --- gold --------------------------------------------------------------------------------------------

export type GoldTier =
  | 'human' // the owner's own decision or answer
  | 'synthetic' // exact by construction (the generator's truth)
  | 'opus' // silver: a strong model with full context, two passes + adjudication
  | 'model' // the production review agent's in-session decision (unstable; reference only)
  | 'rule'; // the production ladder (tautological for ladder variants; a no-regression set)

export interface GoldRow {
  id: string;
  task: TaskId;
  label: string; // the primary label (closed vocabulary of the task)
  alts?: string[]; // other labels that also count as correct (multi-initiative splits, accepted synonyms)
  shares?: { label: string; share: number }[]; // t1 splits as given
  tier: GoldTier;
  agree?: number; // silver only: share of labeller passes that agreed on `label`
  note?: string;
}

// --- predictions and variants -----------------------------------------------------------------------

export interface Prediction {
  id: string;
  label: string | null; // null = abstain → a question to a person
  conf: number; // [0,1]; only the order matters
  rung: string; // which stage decided ('rule:<id>', 'knn', 'llm:haiku', 'case', 'abstain', …)
  costUsd?: number; // model spend attributed to this unit
  why?: string; // short rationale (never shown to a model as truth)
}

// What the loop knows about earlier days. 'human' rows are answers to questions (= gold), 'machine'
// rows are the pipeline's own confident decisions (which may be wrong — that is the point of the replay).
export interface MemoryRow {
  id: string;
  task: TaskId;
  day: string;
  label: string;
  source: 'human' | 'machine' | 'seed'; // seed = the tenant's ledger as given at the start of the window
}

export interface DayCtx {
  dataset: DatasetMeta;
  dir: string; // dataset directory (store.sqlite, tenant/ inside)
  day: string;
  pool: Unit[]; // every unit of this kind on this day, decided or not — context (threads, cases), never a to-do list
  memory: MemoryRow[]; // rows of days strictly before `day` (policy-dependent)
  state: Map<string, unknown>; // variant-private state that survives across days of one run
  llm: LlmLike | null; // null when the run forbids model calls
  log: (msg: string) => void;
}

export interface LlmLike {
  call(c: { model: string; system: string; prompt: string; timeoutMs?: number }): Promise<{ text: string; costUsd: number; error?: string; cached: boolean }>;
}

export interface Variant {
  name: string;
  description: string;
  tasks: TaskId[];
  // Decide one day's units of one task. Called in day order. Must never read gold.
  decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]>;
  // Optional nightly pass after a day's answers are in (recalibration, rule mining — the "dream").
  nightly?(task: TaskId, ctx: DayCtx): Promise<void>;
}
