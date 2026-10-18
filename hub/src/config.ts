// HUB_CONFIG (a Worker secret; OpenSpec `hub-open-network`, design N7): the hub's registration policy.
// Names are claimed first come, first served by the key that connects with them (N1); the configuration
// only decides whether registration is open, which names are reserved — for the keys listed (the
// operator's own installations, a list so a rotation can overlap) or for nobody (revoked, or never to be
// claimed) — and the limits. The readable copy lives in the operator's ops repo; it holds public keys only.
//
//   { "registration": "open" | "closed",
//     "reserved": { "<name>": { "sign": [{ "key": "<b64url>", "notAfter"?: "<ISO>" }] } | null },
//     "limits"?: { "claimsPerIpPerDay": 5, "idleDays": 180, ... } }
//
// A version-1 configuration (`{"installations": …}`) is refused, loudly: read as version 2 it would be an
// open hub with nothing reserved — the opposite of what its operator wrote.
import { INSTALLATION_RE, KEY_RE } from '../../src/messaging/protocol.js';

export interface SignKey {
  /** Ed25519 public key, raw 32 bytes, base64url (what `orch hub keygen` prints). */
  key: string;
  /** ISO time after which the key no longer authenticates. */
  notAfter?: string;
}
export interface Limits {
  /** New names one IP address may claim per day. */
  claimsPerIpPerDay: number;
  /** A claimed name whose key has not connected for this long is released. */
  idleDays: number;
  /** Envelopes from one sender waiting for one recipient: count and bytes. */
  pairEnvelopes: number;
  pairBytes: number;
  /** Envelopes waiting for one recipient, from everyone. */
  backlogEnvelopes: number;
  backlogBytes: number;
  /** Installations one allow list may name. */
  allowMax: number;
}
export const DEFAULT_LIMITS: Limits = {
  claimsPerIpPerDay: 5,
  idleDays: 180,
  pairEnvelopes: 200,
  pairBytes: 10 * 1024 * 1024,
  backlogEnvelopes: 1000,
  backlogBytes: 50 * 1024 * 1024,
  allowMax: 1000,
};
export interface HubConfig {
  registration: 'open' | 'closed';
  /** Reserved names → their keys, or null: reserved for nobody. */
  reserved: Record<string, SignKey[] | null>;
  limits: Limits;
}
/** Reserved for nobody on every hub: the bot's default INSTALLATION_ID, and the hub's own name. */
export const BUILT_IN_RESERVED = ['local', 'hub'] as const;

/** Parse and validate the secret; a bad configuration fails loudly instead of admitting the wrong installations. */
export function parseHubConfig(raw: string | undefined): HubConfig {
  if (!raw) throw new Error('HUB_CONFIG is not set');
  const j = JSON.parse(raw) as Record<string, unknown> | null;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('HUB_CONFIG must be an object');
  if ('installations' in j) {
    throw new Error('HUB_CONFIG is in the version-1 shape ({"installations": …}); version 2 is {"registration": "open"|"closed", "reserved": {"<name>": {"sign": [{"key": …}]} | null}, "limits"?: {…}} — see docs/hub.md');
  }
  const registration = j.registration ?? 'open';
  if (registration !== 'open' && registration !== 'closed') throw new Error(`HUB_CONFIG: registration must be "open" or "closed", not ${JSON.stringify(registration)}`);
  const rawReserved = j.reserved ?? {};
  if (typeof rawReserved !== 'object' || rawReserved === null || Array.isArray(rawReserved)) throw new Error('HUB_CONFIG: reserved must be an object of names');
  const reserved: HubConfig['reserved'] = {};
  for (const [name, v] of Object.entries(rawReserved as Record<string, unknown>)) {
    if (!INSTALLATION_RE.test(name)) throw new Error(`HUB_CONFIG: bad name ${JSON.stringify(name)}`);
    if (v === null) {
      reserved[name] = null;
      continue;
    }
    if ((BUILT_IN_RESERVED as readonly string[]).includes(name)) throw new Error(`HUB_CONFIG: "${name}" is reserved for nobody on every hub`);
    const sign = (v as { sign?: unknown })?.sign;
    if (!Array.isArray(sign) || !sign.length) throw new Error(`HUB_CONFIG: ${name} has no signing key (reserve it for nobody with null)`);
    reserved[name] = sign.map((k) => {
      if (!k || typeof k.key !== 'string' || !KEY_RE.test(k.key) || (k.notAfter !== undefined && (typeof k.notAfter !== 'string' || Number.isNaN(Date.parse(k.notAfter))))) {
        throw new Error(`HUB_CONFIG: ${name} has a bad key entry`);
      }
      return { key: k.key, ...(k.notAfter ? { notAfter: k.notAfter } : {}) };
    });
  }
  for (const name of BUILT_IN_RESERVED) reserved[name] = null;
  const limits: Limits = { ...DEFAULT_LIMITS };
  const rawLimits = j.limits ?? {};
  if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) throw new Error('HUB_CONFIG: limits must be an object');
  for (const [k, v] of Object.entries(rawLimits as Record<string, unknown>)) {
    if (!(k in DEFAULT_LIMITS)) throw new Error(`HUB_CONFIG: unknown limit ${JSON.stringify(k)}`);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`HUB_CONFIG: limit ${k} must be a positive integer`);
    limits[k as keyof Limits] = v;
  }
  return { registration, reserved, limits };
}

/** The keys among `keys` that authenticate at `now`. */
export const keysValidAt = (keys: readonly SignKey[], now: number): SignKey[] => keys.filter((k) => k.notAfter === undefined || Date.parse(k.notAfter) > now);

/** The reserved name another configured key belongs to, if any: one key holds one name (N1). */
export function reservedNameOfKey(cfg: HubConfig, key: string): string | undefined {
  for (const [name, keys] of Object.entries(cfg.reserved)) if (keys?.some((k) => k.key === key)) return name;
  return undefined;
}
