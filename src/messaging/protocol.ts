// The messaging wire format (OpenSpec `agent-messaging`, design D2, D4, D5, D14; `hub-open-network`,
// design N2, N3, N5): frames between a bot and the hub, the message a bot works with, the envelope on the
// wire and what it seals, addresses, domains and the accept-pattern matcher. Pure, and it imports
// nothing from `node:` (imports.test.ts): the hub (a Worker) shares it.
//
// Two shapes of one message:
// - inside an installation, an `Envelope`: `<installation>/<agent>` addresses, method and task in clear.
//   The local transport carries it as it is; it never leaves the bot process.
// - between installations, a `WireEnvelope`: only the version, the id and the two installations in clear;
//   the agents, the method, the task and the payload travel sealed (`Sealed`, seal.ts). The hub routes
//   installations and learns nothing about agents (N5).
//
// Versions (D5, N8): within one version every change to frames and payload is additive — parsers copy
// the fields they know and ignore the rest — and an envelope or `auth` of another version is refused
// (`unsupported version`, both versions named), never guessed at. Version 2 replaced version 1 without
// a compatibility layer: only the operator's canary installations ever spoke version 1.
import { isId } from './a2a.js';

export const PROTOCOL_VERSION = 2;
/** The context string of every signature and key derivation. */
export const SIG_CONTEXT = 'coach-aven-hub/2';
/**
 * An installation name: unique on its hub, first come first served (N1); also a path and key segment
 * once validated (design D10). `@` and `.` stay out of it: `<name>@<host>` is kept for addresses on
 * other hubs (federation, not built).
 */
export const INSTALLATION_RE = /^[a-z0-9-]{1,32}$/;
/**
 * A public key as `orch hub keygen` prints it: 32 raw bytes, base64url without padding, in its one
 * canonical spelling — the 43rd character carries 4 bits and 2 zero bits, so only 16 letters may end it.
 * A lenient decoder reads the other 48 endings as the same bytes: compared as strings, one key would then
 * pass as several (and hold several names on a hub).
 */
export const KEY_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
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

/**
 * Whether a target or an installation names another hub: `<name>@<host>` before the first `/`. Kept for
 * federation and refused for now, with its own reason rather than "not a target" (`hub-open-network`).
 */
export const isOtherHub = (s: unknown): boolean => str(s) && s.trim().split('/')[0]!.includes('@');

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

// ── the message, the wire envelope and what it seals (D5, N5) ────────────────────────────────────
export interface EnvelopeHeader {
  v: number;
  id: string;
  /** `<installation>/<agent>`; between installations, the installation is the one the hub authenticated. */
  from: string;
  to: string;
  method: Method;
  task: string;
}
/** A message as the bot handles it: in clear, inside one installation only (see the top of this file). */
export type Envelope = EnvelopeHeader;

/**
 * An envelope between installations (N5): installation names in clear, everything else in `ct`.
 * `eph` (X25519, b64url), `ct` (iv | ciphertext | tag, b64url), `sig` (Ed25519, b64url).
 */
export interface WireEnvelope {
  v: number;
  id: string;
  /** The sending installation; the hub overwrites it with the authenticated one. */
  from: string;
  to: string;
  eph: string;
  ct: string;
  sig: string;
}
export type WireHeader = Pick<WireEnvelope, 'v' | 'id' | 'from' | 'to'>;
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
  /**
   * On a task's first message only: the skill it asks for (agent-skills), one of the ids the target's card
   * offers. Additive within version 2: an older release ignores it and runs a general request. Parsed as
   * any string (capped): the receiver validates it, and answers a bad one `rejected: unknown skill`.
   */
  skill?: string;
}

export type ParsedWire =
  | { ok: true; env: WireEnvelope }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'unsupported version'; theirs: unknown; ours: number };

/** An envelope from the wire: the hub routes on it, the receiver opens it. Only the known fields are kept. */
export function parseWireEnvelope(x: unknown): ParsedWire {
  if (!obj(x)) return { ok: false, reason: 'malformed' };
  const a = x as Any;
  if (a.v !== PROTOCOL_VERSION) return typeof a.v === 'number' ? { ok: false, reason: 'unsupported version', theirs: a.v, ours: PROTOCOL_VERSION } : { ok: false, reason: 'malformed' };
  if (!isId(a.id) || !str(a.from) || !INSTALLATION_RE.test(a.from) || !str(a.to) || !INSTALLATION_RE.test(a.to)) return { ok: false, reason: 'malformed' };
  if (!str(a.eph) || !str(a.ct) || !str(a.sig)) return { ok: false, reason: 'malformed' };
  return { ok: true, env: { v: a.v, id: a.id, from: a.from, to: a.to, eph: a.eph, ct: a.ct, sig: a.sig } };
}

/** What a wire envelope seals besides the payload (N5): the agents, the method and the task. */
export interface Sealed {
  /** The sending agent: an agent of the envelope's `from` installation. */
  from: string;
  to: string;
  method: Method;
  task: string;
  payload: Payload;
}

/** The sealed half of a message, ready for seal.ts. */
export const sealedOf = (env: Envelope, payload: Payload): Sealed => ({
  from: parseAddress(env.from)!.agent,
  to: parseAddress(env.to)!.agent,
  method: env.method,
  task: env.task,
  payload,
});
/** The clear half of a message: the installations only. */
export const wireHeaderOf = (env: Envelope): WireHeader => ({ v: env.v, id: env.id, from: parseAddress(env.from)!.installation, to: parseAddress(env.to)!.installation });
/** A delivered envelope and its opened content, joined back into the message the bot handles. */
export const joinEnvelope = (w: WireHeader, s: Sealed): Envelope => ({ v: w.v, id: w.id, from: `${w.from}/${s.from}`, to: `${w.to}/${s.to}`, method: s.method, task: s.task });

/** What an opened envelope sealed, or undefined (malformed: dropped as unexpected). Unknown payload fields are ignored. */
export function parseSealed(x: unknown): Sealed | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!str(a.from) || !AGENT_RE.test(a.from) || !str(a.to) || !AGENT_RE.test(a.to)) return undefined;
  if (!(METHODS as readonly string[]).includes(a.method) || !isId(a.task)) return undefined;
  const payload = parsePayload(a.payload);
  return payload ? { from: a.from, to: a.to, method: a.method, task: a.task, payload } : undefined;
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
    // Kept even when malformed (a non-string, a bad id): the receiver answers `rejected: unknown skill`
    // rather than dropping the whole message, so the asker is told at once.
    ...(a.skill !== undefined ? { skill: (typeof a.skill === 'string' ? a.skill : JSON.stringify(a.skill) ?? '').slice(0, SKILL_ID_KEEP) } : {}),
  };
}

/** How much of a received `skill` is kept, valid or not, to quote it back in a rejection. */
const SKILL_ID_KEEP = 100;

// The exact texts the crypto signs or binds (seal.ts; the hub verifies `challengeText`), N2 and N5:
// - the AAD binds the clear header, the envelope id with it (a ciphertext replayed under a new id fails);
// - the key derivation binds the ephemeral key and the RECEIVER's encryption key (as HPKE does), so a
//   name that changed hands cannot open an envelope sealed to its earlier key;
// - the signature covers the header, `eph` and `ct`, made with the sender's signing key;
// - the challenge answer binds the hub's host (no replay at another hub), the claimed name, the key that
//   claims it, and the nonce.
export const headerAad = (h: WireHeader): string => JSON.stringify([h.v, h.id, h.from, h.to]);
export const signingText = (e: Omit<WireEnvelope, 'sig'>): string => JSON.stringify([e.v, e.id, e.from, e.to, e.eph, e.ct]);
export const kdfInfo = (eph: string, recipientBox: string): string => `${SIG_CONTEXT}|${eph}|${recipientBox}`;
export const challengeText = (host: string, name: string, key: string, nonce: string): string => `${SIG_CONTEXT}|${host}|${name}|${key}|${nonce}`;

// ── frames (D4, D5, N2–N4) ───────────────────────────────────────────────────────────────────────
export interface Removed {
  installation: string;
  at: string;
}
export type ClientFrame =
  /** The answer to the challenge (N2): the name claimed, the key that claims it, its signature. */
  | { t: 'auth'; v: number; name: string; key: string; sig: string }
  /** An `auth` of another version (the version-1 shape has no `v`): refused `unsupported version`. */
  | { t: 'auth-unsupported'; theirs: unknown }
  /** The installations this one hears from: its pinned peers (N3). */
  | { t: 'allow'; installations: string[] }
  /** `env` is routed on its clear header; the receiver opens it (and judges its version). */
  | { t: 'send'; env: Record<string, unknown> }
  | { t: 'ack'; seq: number };
export type HubFrame =
  | { t: 'challenge'; nonce: string; now: string }
  /** `online` and `removed` only along relationships (N4): never a list of who is on the hub. */
  | { t: 'hello'; now: string; online: string[]; removed: Removed[] }
  | { t: 'deliver'; seq: number; env: Record<string, unknown> }
  | { t: 'routed'; id: string }
  | { t: 'rejected'; id: string; reason: string }
  /** By envelope id only (N5): the sender knows which of its tasks it belonged to. */
  | { t: 'expired'; id: string }
  | { t: 'presence'; online: string[]; removed?: Removed[] };

const removedList = (x: unknown): Removed[] | undefined =>
  Array.isArray(x) && x.every((r) => obj(r) && str((r as Any).installation) && str((r as Any).at))
    ? x.map((r) => ({ installation: (r as Any).installation, at: (r as Any).at }))
    : undefined;

/** A frame from a bot, or undefined (malformed, or a kind this side does not know: ignored). */
export function parseClientFrame(x: unknown): ClientFrame | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (a.t === 'auth') {
    if (a.v !== PROTOCOL_VERSION) return { t: 'auth-unsupported', theirs: a.v ?? 1 };
    return str(a.name) && INSTALLATION_RE.test(a.name) && str(a.key) && KEY_RE.test(a.key) && str(a.sig) ? { t: 'auth', v: a.v, name: a.name, key: a.key, sig: a.sig } : undefined;
  }
  if (a.t === 'allow') {
    const list: unknown = a.installations;
    return strings(list) && list.every((i) => INSTALLATION_RE.test(i)) ? { t: 'allow', installations: [...new Set(list)].sort() } : undefined;
  }
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
      return str(a.now) && strings(a.online) && removed ? { t: 'hello', now: a.now, online: a.online, removed } : undefined;
    }
    case 'deliver':
      return nat(a.seq) && obj(a.env) ? { t: 'deliver', seq: a.seq, env: a.env } : undefined;
    case 'routed':
      return str(a.id) ? { t: 'routed', id: a.id } : undefined;
    case 'rejected':
      return str(a.id) && str(a.reason) ? { t: 'rejected', id: a.id, reason: a.reason } : undefined;
    case 'expired':
      return str(a.id) ? { t: 'expired', id: a.id } : undefined;
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
