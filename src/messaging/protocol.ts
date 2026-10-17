// The messaging wire format (OpenSpec `agent-messaging`, design D2, D4, D5, D14): frames between a bot
// and the hub, the envelope and its sealed payload, addresses, domains and the accept-pattern matcher.
// Pure, and it imports nothing from `node:` (imports.test.ts): the hub (a Worker) shares it.
//
// Versions (D5): home runs `main` and prod the last tag, so within `v: 1` every change to frames and
// payload is additive — parsers copy the fields they know and ignore the rest — and an envelope with
// an unknown `v` is refused (`rejected: unsupported version`, both versions named), never guessed at.
import { isId } from './a2a.js';

export const PROTOCOL_VERSION = 1;
/** The context string of every signature and key derivation. */
export const SIG_CONTEXT = 'coach-aven-hub/1';
/** An installation id: also a path and key segment once validated (design D10). */
export const INSTALLATION_RE = /^[a-z0-9-]{1,32}$/;
/** An agent name: a project slug. */
export const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A tenant's domain tag: the first 8 hex of the SHA-256 of its tenant id (design D14). */
const DOMAIN_RE = /^([a-z0-9-]{1,32})(?:~([0-9a-f]{8}))?$/;

export const METHODS = ['ask', 'answer', 'cancel', 'agents', 'cards'] as const;
export type Method = (typeof METHODS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string';
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
const nat = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

// ── addresses ────────────────────────────────────────────────────────────────────────────────────
export interface Address {
  installation: string;
  agent: string;
}
export const formatAddress = (a: Address): string => `${a.installation}/${a.agent}`;

/** Strict `<installation>/<agent>`. */
export function parseAddress(s: unknown): Address | undefined {
  if (!str(s)) return undefined;
  const i = s.indexOf('/');
  if (i < 0) return undefined;
  const installation = s.slice(0, i);
  const agent = s.slice(i + 1);
  return INSTALLATION_RE.test(installation) && AGENT_RE.test(agent) ? { installation, agent } : undefined;
}

/** A target as an agent writes it: `<installation>/<agent>`, or a bare `<agent>` of the own installation. */
export function parseTarget(s: unknown, ownInstallation: string): Address | undefined {
  if (!str(s)) return undefined;
  const t = s.trim();
  return t.includes('/') ? parseAddress(t) : AGENT_RE.test(t) ? { installation: ownInstallation, agent: t } : undefined;
}

// ── domains (D14) ────────────────────────────────────────────────────────────────────────────────
export const isDomain = (s: unknown): s is string => str(s) && DOMAIN_RE.test(s);
/** The installation a domain belongs to: `bluefin` and `bluefin~1a2b3c4d` both belong to `bluefin`. */
export const domainInstallation = (d: string): string | undefined => DOMAIN_RE.exec(d)?.[1];
/** A remote sender's domain must name its authenticated installation (D14, "Domain claims"). */
export const domainClaimOk = (domain: string, installation: string): boolean => domainInstallation(domain) === installation;

// ── who may ask (D2) ─────────────────────────────────────────────────────────────────────────────
/**
 * Whether an agent's accept list admits a sender. Absent or empty: nobody. A pattern is
 * `<installation>/<agent>`, a bare `<agent>` of the own installation, or `*` — every agent of the
 * accepting agent's OWN domain. No pattern covers a whole other domain.
 */
export function accepts(
  patterns: readonly string[] | undefined,
  sender: Address,
  o: { ownInstallation: string; ownDomain: string; senderDomain: string },
): boolean {
  for (const p of patterns ?? []) {
    if (p === '*') {
      if (o.senderDomain === o.ownDomain) return true;
      continue;
    }
    const a = parseTarget(p, o.ownInstallation);
    if (a && a.installation === sender.installation && a.agent === sender.agent) return true;
  }
  return false;
}

// ── envelope and payload (D5) ────────────────────────────────────────────────────────────────────
export interface EnvelopeHeader {
  v: number;
  id: string;
  /** `<installation>/<agent>`; the hub overwrites the installation with the authenticated one. */
  from: string;
  to: string;
  method: Method;
  task: string;
}
/** Sealed between installations: `eph` (X25519, b64url), `ct` (iv | ciphertext | tag, b64url), `sig` (Ed25519, b64url). */
export interface Envelope extends EnvelopeHeader {
  eph?: string;
  ct?: string;
  sig?: string;
}
/** A conversation's marks: each other domain whose data reached it → the domains that already have that data (D14). */
export type Marks = Record<string, string[]>;
export interface Payload {
  /** The A2A message (ask) or status (answer); parsed by the method's handler. */
  message?: unknown;
  domain: string;
  toDomain?: string;
  marks: Marks;
  depth: number;
  /** On a terminal status: what the answering turns cost. */
  cost?: number;
}

export type ParsedEnvelope =
  | { ok: true; env: Envelope }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'unsupported version'; theirs: unknown; ours: number };

export function parseEnvelope(x: unknown): ParsedEnvelope {
  if (!obj(x)) return { ok: false, reason: 'malformed' };
  const a = x as Any;
  if (a.v !== PROTOCOL_VERSION) return typeof a.v === 'number' ? { ok: false, reason: 'unsupported version', theirs: a.v, ours: PROTOCOL_VERSION } : { ok: false, reason: 'malformed' };
  if (!isId(a.id) || !isId(a.task) || !parseAddress(a.from) || !parseAddress(a.to) || !(METHODS as readonly string[]).includes(a.method)) return { ok: false, reason: 'malformed' };
  for (const k of ['eph', 'ct', 'sig'] as const) if (a[k] !== undefined && !str(a[k])) return { ok: false, reason: 'malformed' };
  const env: Envelope = { v: a.v, id: a.id, from: a.from, to: a.to, method: a.method, task: a.task };
  if (a.eph !== undefined) env.eph = a.eph;
  if (a.ct !== undefined) env.ct = a.ct;
  if (a.sig !== undefined) env.sig = a.sig;
  return { ok: true, env };
}

export function parsePayload(x: unknown): Payload | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!isDomain(a.domain) || !nat(a.depth) || !obj(a.marks)) return undefined;
  if (a.toDomain !== undefined && !isDomain(a.toDomain)) return undefined;
  if (a.cost !== undefined && (typeof a.cost !== 'number' || !(a.cost >= 0))) return undefined;
  const marks: Marks = {};
  for (const [d, holders] of Object.entries(a.marks)) {
    if (!isDomain(d) || !strings(holders) || !holders.every(isDomain)) return undefined;
    marks[d] = [...holders];
  }
  return {
    ...(a.message !== undefined ? { message: a.message } : {}),
    domain: a.domain,
    ...(a.toDomain !== undefined ? { toDomain: a.toDomain } : {}),
    marks,
    depth: a.depth,
    ...(a.cost !== undefined ? { cost: a.cost } : {}),
  };
}

// The exact texts the crypto signs or binds (seal.ts; the hub verifies `challengeText`).
export const headerAad = (h: EnvelopeHeader): string => JSON.stringify([h.v, h.id, h.from, h.to, h.method, h.task]);
export const signingText = (e: Envelope): string => JSON.stringify([e.v, e.id, e.from, e.to, e.method, e.task, e.eph ?? null, e.ct ?? null]);
export const kdfInfo = (h: EnvelopeHeader): string => `${SIG_CONTEXT}|${h.from}|${h.to}|${h.task}`;
export const challengeText = (host: string, installation: string, nonce: string): string => `${SIG_CONTEXT}|${host}|${installation}|${nonce}`;

// ── frames (D4, D5) ──────────────────────────────────────────────────────────────────────────────
export interface Removed {
  installation: string;
  at: string;
}
export type ClientFrame =
  | { t: 'auth'; installation: string; sig: string }
  /** `env` is routed on its header; the receiver parses it (and judges its version). */
  | { t: 'send'; env: Record<string, unknown> }
  | { t: 'ack'; seq: number };
export type HubFrame =
  | { t: 'challenge'; nonce: string; now: string }
  | { t: 'hello'; now: string; enrolled: string[]; online: string[]; removed: Removed[] }
  | { t: 'deliver'; seq: number; env: Record<string, unknown> }
  | { t: 'routed'; id: string }
  | { t: 'rejected'; id: string; reason: string }
  | { t: 'expired'; id: string; task: string; to: string }
  | { t: 'presence'; online: string[]; removed?: Removed[] };

const removedList = (x: unknown): Removed[] | undefined =>
  Array.isArray(x) && x.every((r) => obj(r) && str((r as Any).installation) && str((r as Any).at))
    ? x.map((r) => ({ installation: (r as Any).installation, at: (r as Any).at }))
    : undefined;

/** A frame from a bot, or undefined (malformed, or a kind this side does not know: ignored). */
export function parseClientFrame(x: unknown): ClientFrame | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (a.t === 'auth') return INSTALLATION_RE.test(String(a.installation)) && str(a.sig) ? { t: 'auth', installation: a.installation, sig: a.sig } : undefined;
  if (a.t === 'send') return obj(a.env) ? { t: 'send', env: a.env } : undefined;
  if (a.t === 'ack') return nat(a.seq) ? { t: 'ack', seq: a.seq } : undefined;
  return undefined;
}

/** A frame from the hub, or undefined (malformed, or a kind this side does not know: ignored). */
export function parseHubFrame(x: unknown): HubFrame | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  switch (a.t) {
    case 'challenge':
      return str(a.nonce) && str(a.now) ? { t: 'challenge', nonce: a.nonce, now: a.now } : undefined;
    case 'hello': {
      const removed = removedList(a.removed ?? []);
      return str(a.now) && strings(a.enrolled) && strings(a.online) && removed ? { t: 'hello', now: a.now, enrolled: a.enrolled, online: a.online, removed } : undefined;
    }
    case 'deliver':
      return nat(a.seq) && obj(a.env) ? { t: 'deliver', seq: a.seq, env: a.env } : undefined;
    case 'routed':
      return str(a.id) ? { t: 'routed', id: a.id } : undefined;
    case 'rejected':
      return str(a.id) && str(a.reason) ? { t: 'rejected', id: a.id, reason: a.reason } : undefined;
    case 'expired':
      return str(a.id) && str(a.task) && str(a.to) ? { t: 'expired', id: a.id, task: a.task, to: a.to } : undefined;
    case 'presence': {
      if (!strings(a.online)) return undefined;
      if (a.removed === undefined) return { t: 'presence', online: a.online };
      const removed = removedList(a.removed);
      return removed ? { t: 'presence', online: a.online, removed } : undefined;
    }
    default:
      return undefined;
  }
}
