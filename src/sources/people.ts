// The people/identities file a project may ship beside its config (docs/sources.md →
// "People"): who the humans behind the addresses are, so the store can resolve an e-mail,
// a Slack display name or a Graph UPN to one person and the sandbox-side search can filter
// by person instead of by three spellings. Pure loader + validation; the store reseeds the
// `people` and `identities` tables from this on every build (truncate + insert), so edits to
// the file take effect at the next pull without any migration.
//
// Shape (JSON array):
//   [{ "person_id": "vincent", "name": "Vera Lindqvist", "company": "hcg",
//      "identities": ["vera.lindqvist@home.example", "slack:Vera Lindqvist"],
//      "marker": { "type": "broad", "initiatives": ["hcg/hcg/st-steering"] } }]
// Canonical home: the tenant repo's annotations/people.json (docs/sources.md → "Tenant").
// `marker` says how much a person tells about WHICH initiative a conversation belongs to:
// exclusive (always these), narrow (one of these, content picks), broad (a hint at most). It is
// the tenant's review session that uses it; the store only carries it through to `people`.
// Migration: the older `default_initiative` field is read as { type: "broad", initiatives: [x] }.
// Identity kinds are inferred: contains "@" → email; "slack:" prefix → Slack display name
// or handle (what the Slack puller writes as author/participants); "msgraph:" prefix → UPN
// or Graph id; anything else → a bare display name (matched case-insensitively).
import { readFileSync } from 'node:fs';

export type IdentityKind = 'email' | 'slack' | 'msgraph' | 'name';

export type MarkerType = 'exclusive' | 'narrow' | 'broad';
export const MARKER_TYPES: readonly MarkerType[] = ['exclusive', 'narrow', 'broad'];

export interface PersonMarker {
  type: MarkerType;
  initiatives: string[];
}

export interface Person {
  person_id: string;
  name: string;
  company?: string;
  marker?: PersonMarker;
  identities: string[];
}

export interface Identity {
  /** Normalised match key — see `identityKey`. */
  identity: string;
  kind: IdentityKind;
  person_id: string;
}

const PERSON_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function identityKind(raw: string): IdentityKind {
  if (raw.startsWith('slack:')) return 'slack';
  if (raw.startsWith('msgraph:')) return 'msgraph';
  if (raw.includes('@')) return 'email';
  return 'name';
}

/** Lower-cased, trimmed, prefix stripped — the key both the file and the records are matched on. */
export function identityKey(raw: string): string {
  return raw.replace(/^(slack|msgraph):/, '').trim().toLowerCase();
}

export function validatePeople(raw: unknown, where = 'people'): Person[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: expected a JSON array of people`);
  const seenIds = new Set<string>();
  const seenIdent = new Map<string, string>();
  return raw.map((entry, i) => {
    const w = `${where}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${w}: must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.person_id !== 'string' || !PERSON_ID_RE.test(e.person_id)) throw new Error(`${w}: "person_id" must match ${PERSON_ID_RE}`);
    if (seenIds.has(e.person_id)) throw new Error(`${w}: duplicate person_id "${e.person_id}"`);
    seenIds.add(e.person_id);
    if (typeof e.name !== 'string' || !e.name.trim()) throw new Error(`${w}: "name" is required`);
    if (!Array.isArray(e.identities) || e.identities.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error(`${w}: "identities" must be an array of non-empty strings`);
    }
    // Matching is by normalised key alone (an e-mail is an e-mail whether or not it was
    // written with a prefix), so the same key must not point at two people. The same key
    // twice for ONE person (e.g. "slack:Owen" and "Owen") is harmless and collapses.
    for (const id of e.identities as string[]) {
      const key = identityKey(id);
      const owner = seenIdent.get(key);
      if (owner && owner !== e.person_id) throw new Error(`${w}: identity "${id}" already belongs to "${owner}"`);
      seenIdent.set(key, e.person_id);
    }
    const p: Person = { person_id: e.person_id, name: e.name.trim(), identities: (e.identities as string[]).map((s) => s.trim()) };
    // null is "unknown" — the tenant's collector writes it for people it has not placed yet.
    if (e.company !== undefined && e.company !== null) {
      if (typeof e.company !== 'string') throw new Error(`${w}: "company" must be a string`);
      p.company = e.company;
    }
    if (e.marker !== undefined && e.marker !== null) {
      const m = e.marker as Record<string, unknown> | null;
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${w}: "marker" must be an object`);
      if (typeof m.type !== 'string' || !(MARKER_TYPES as readonly string[]).includes(m.type)) throw new Error(`${w}: "marker.type" must be one of ${MARKER_TYPES.join(', ')}`);
      if (!Array.isArray(m.initiatives) || m.initiatives.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`${w}: "marker.initiatives" must be an array of initiative ids`);
      if (m.type !== 'broad' && m.initiatives.length === 0) throw new Error(`${w}: an ${m.type} marker needs at least one initiative`);
      p.marker = { type: m.type as MarkerType, initiatives: (m.initiatives as string[]).map((x) => x.trim()) };
    } else if (e.default_initiative !== undefined && e.default_initiative !== null) {
      // Migration path for pre-marker files.
      if (typeof e.default_initiative !== 'string') throw new Error(`${w}: "default_initiative" must be a string`);
      p.marker = { type: 'broad', initiatives: [e.default_initiative] };
    }
    return p;
  });
}

export function loadPeople(path: string): Person[] {
  return validatePeople(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** Flatten people into the identity rows the store seeds. */
export function identitiesOf(people: readonly Person[]): Identity[] {
  const out = new Map<string, Identity>();
  for (const p of people) {
    for (const raw of p.identities) {
      const identity = identityKey(raw);
      if (!out.has(identity)) out.set(identity, { identity, kind: identityKind(raw), person_id: p.person_id });
    }
  }
  return [...out.values()];
}

// Resolve what a record carries (an e-mail, "Name <addr>", a Slack label, a UPN) to a person.
// Deterministic and cheap: exact key match first, then the address inside "Name <addr>".
export function resolveIdentity(raw: string, index: ReadonlyMap<string, string>): string | undefined {
  const key = identityKey(raw);
  const hit = index.get(key);
  if (hit) return hit;
  const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(raw);
  if (m?.[1]) return index.get(m[1].toLowerCase());
  return undefined;
}

export function identityIndex(ids: readonly Identity[]): Map<string, string> {
  return new Map(ids.map((i) => [i.identity, i.person_id]));
}
