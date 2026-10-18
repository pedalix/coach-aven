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
// open hub with nothing reserved — the opposite of what its operator wrote. So is any key this parser
// does not know, at every level: a misspelt `"registraton": "closed"` must not leave a hub open.
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

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Refuse keys outside `allowed`: the configuration is small, and a typo in it must fail, not fall back. */
function onlyKeys(x: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(x).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`HUB_CONFIG: unknown ${unknown.length > 1 ? 'keys' : 'key'} ${unknown.map((k) => JSON.stringify(k)).join(', ')} in ${where}`);
}

/** Parse and validate the secret; a bad configuration fails loudly instead of admitting the wrong installations. */
export function parseHubConfig(raw: string | undefined): HubConfig {
  if (!raw) throw new Error('HUB_CONFIG is not set');
  const j = JSON.parse(raw) as unknown;
  if (!isObject(j)) throw new Error('HUB_CONFIG must be an object');
  if (Object.hasOwn(j, 'installations')) {
    throw new Error('HUB_CONFIG is in the version-1 shape ({"installations": …}); version 2 is {"registration": "open"|"closed", "reserved": {"<name>": {"sign": [{"key": …}]} | null}, "limits"?: {…}} — see docs/hub.md');
  }
  onlyKeys(j, ['registration', 'reserved', 'limits'], 'the configuration');
  const registration = j.registration ?? 'open';
  if (registration !== 'open' && registration !== 'closed') throw new Error(`HUB_CONFIG: registration must be "open" or "closed", not ${JSON.stringify(registration)}`);
  const rawReserved = j.reserved ?? {};
  if (!isObject(rawReserved)) throw new Error('HUB_CONFIG: reserved must be an object of names');
  const reserved: HubConfig['reserved'] = {};
  for (const [name, v] of Object.entries(rawReserved)) {
    if (!INSTALLATION_RE.test(name)) throw new Error(`HUB_CONFIG: bad name ${JSON.stringify(name)}`);
    if (v === null) {
      reserved[name] = null;
      continue;
    }
    if ((BUILT_IN_RESERVED as readonly string[]).includes(name)) throw new Error(`HUB_CONFIG: "${name}" is reserved for nobody on every hub`);
    if (!isObject(v)) throw new Error(`HUB_CONFIG: ${name} must be {"sign": [...]} or null`);
    onlyKeys(v, ['sign'], `reserved.${name}`);
    const sign = v.sign;
    if (!Array.isArray(sign) || !sign.length) throw new Error(`HUB_CONFIG: ${name} has no signing key (reserve it for nobody with null)`);
    reserved[name] = sign.map((k: unknown) => {
      if (!isObject(k)) throw new Error(`HUB_CONFIG: ${name} has a bad key entry`);
      onlyKeys(k, ['key', 'notAfter'], `reserved.${name}.sign`);
      if (typeof k.key !== 'string' || !KEY_RE.test(k.key) || (k.notAfter !== undefined && (typeof k.notAfter !== 'string' || Number.isNaN(Date.parse(k.notAfter))))) {
        throw new Error(`HUB_CONFIG: ${name} has a bad key entry`);
      }
      return { key: k.key, ...(typeof k.notAfter === 'string' ? { notAfter: k.notAfter } : {}) };
    });
  }
  for (const name of BUILT_IN_RESERVED) reserved[name] = null;
  const limits: Limits = { ...DEFAULT_LIMITS };
  const rawLimits = j.limits ?? {};
  if (!isObject(rawLimits)) throw new Error('HUB_CONFIG: limits must be an object');
  onlyKeys(rawLimits, Object.keys(DEFAULT_LIMITS), 'limits');
  for (const [k, v] of Object.entries(rawLimits)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`HUB_CONFIG: limit ${k} must be a positive integer`);
    limits[k as keyof Limits] = v;
  }
  return { registration, reserved, limits };
}

/**
 * A name's reservation: its keys, null (nobody), or undefined (not reserved). Always through this: any
 * `[a-z0-9-]{1,32}` is a name, `constructor` included, and `name in cfg.reserved` would find
 * Object.prototype's.
 */
export const reservation = (cfg: HubConfig, name: string): SignKey[] | null | undefined => (Object.hasOwn(cfg.reserved, name) ? cfg.reserved[name] : undefined);

/** The keys among `keys` that authenticate at `now`. */
export const keysValidAt = (keys: readonly SignKey[], now: number): SignKey[] => keys.filter((k) => k.notAfter === undefined || Date.parse(k.notAfter) > now);

/** The reserved name another configured key belongs to, if any: one key holds one name (N1). */
export function reservedNameOfKey(cfg: HubConfig, key: string): string | undefined {
  for (const [name, keys] of Object.entries(cfg.reserved)) if (keys?.some((k) => k.key === key)) return name;
  return undefined;
}
