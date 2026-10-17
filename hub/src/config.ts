// HUB_CONFIG (a Worker secret, design D3): which installations the hub enrols and the public halves of
// their signing keys — a list per installation, so a rotation can overlap. Adding or removing an
// installation is one line in the operator's ops repo plus `wrangler deploy`.
import { INSTALLATION_RE } from '../../src/messaging/protocol.js';

export interface SignKey {
  /** Ed25519 public key, raw 32 bytes, base64url (what `orch hub keygen` prints). */
  key: string;
  /** ISO time after which the key no longer authenticates. */
  notAfter?: string;
}
export interface HubConfig {
  installations: Record<string, { sign: SignKey[] }>;
}

/** Parse and validate the secret; a bad configuration fails loudly instead of enrolling nobody silently. */
export function parseHubConfig(raw: string | undefined): HubConfig {
  if (!raw) throw new Error('HUB_CONFIG is not set');
  const j = JSON.parse(raw) as { installations?: unknown };
  if (!j || typeof j.installations !== 'object' || j.installations === null) throw new Error('HUB_CONFIG: no installations');
  const installations: HubConfig['installations'] = {};
  for (const [id, v] of Object.entries(j.installations as Record<string, unknown>)) {
    if (!INSTALLATION_RE.test(id)) throw new Error(`HUB_CONFIG: bad installation id ${JSON.stringify(id)}`);
    const sign = (v as { sign?: unknown })?.sign;
    if (!Array.isArray(sign) || !sign.length) throw new Error(`HUB_CONFIG: ${id} has no signing key`);
    installations[id] = {
      sign: sign.map((k) => {
        if (!k || typeof k.key !== 'string' || (k.notAfter !== undefined && typeof k.notAfter !== 'string')) throw new Error(`HUB_CONFIG: ${id} has a bad key entry`);
        return { key: k.key, ...(k.notAfter ? { notAfter: k.notAfter } : {}) };
      }),
    };
  }
  return { installations };
}

/** The keys of an installation that authenticate at `now`. */
export const keysValidAt = (cfg: HubConfig, installation: string, now: number): SignKey[] =>
  (cfg.installations[installation]?.sign ?? []).filter((k) => k.notAfter === undefined || Date.parse(k.notAfter) > now);
