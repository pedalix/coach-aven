import { CHAT_DRIVERS, type ChatDriverName } from './chat/drivers.js';
// Tenant-scoped session keys — THE one place the team dimension of a key is encoded and
// decoded. A session key may carry an optional leading tenant segment:
//
//     thread:171234.5678                      ← HOME tenant (bare — pre-slice-2 keys stay valid)
//     T0CLIENT1:thread:171234.5678            ← another workspace
//     E0ORG9:dm:C123:caldora                  ← an enterprise (org-wide) install
//
// Home stays bare BY DESIGN: prod's existing state.json/queue.jsonl records keep working
// with zero migration, and the single-workspace (static-token) mode never prefixes at all.
// Consequence (documented in docs/multitenancy.md): slice 2 must deploy BEFORE any client
// team is admitted, or that team's pre-deploy bare keys orphan.
//
// The tenant id rule matches the installation store (installations.ts queryKey):
// enterpriseId ?? teamId — so config keys, gate checks, key prefixes, and token lookups
// all speak the same id. Slack ids: T… = team, E… = enterprise; neither contains ':'.

const TENANT_RE = /^[TE][A-Z0-9]{5,}$/;
// A conversation of an ADDITIONAL chat surface (OpenSpec multi-driver-installation D1) carries the
// driver's name as its first segment, before the tenant: `web:thread:…`, `slack:T0CLIENT1:thread:…`.
// The default surface's keys stay bare, so prod's records never change shape. Driver names never
// match TENANT_RE (lowercase) nor a key kind, so a head is never read twice.
const SURFACE_RE = new RegExp(`^(${CHAT_DRIVERS.join('|')}):`);

// The tenant id for an event/command — MIRRORS the installation store's queryKey rule
// exactly: the enterprise id identifies the tenant only for an ORG-WIDE install; a
// workspace-level install inside an Enterprise Grid still keys by its team id (its
// events carry enterprise_id too, but its token/config live under T…, not E…).
export function tenantOf(ctx: {
  teamId?: string;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
}): string | undefined {
  if (ctx.isEnterpriseInstall && ctx.enterpriseId) return ctx.enterpriseId;
  return ctx.teamId ?? ctx.enterpriseId;
}

// Normalize a raw tenant id to the STORAGE convention: undefined = home. This is the
// one rule for the `tenant vs tid` duality — inline `x === home ? undefined : x` copies
// drift on the edge cases (unknown tenant, unresolved home → home).
export function normalizeTenant(
  tenantId: string | undefined,
  homeTenant: string | undefined,
): string | undefined {
  if (!tenantId || !homeTenant || tenantId === homeTenant) return undefined;
  return tenantId;
}

// Prefix `base` with the tenant unless it IS the home tenant (or unknown) — home keys
// stay bare (see header). `homeTenant` undefined means single-workspace mode: never prefix.
export function withTeam(tenantId: string | undefined, homeTenant: string | undefined, base: string): string {
  const tid = normalizeTenant(tenantId, homeTenant);
  return tid ? `${tid}:${base}` : base;
}

// Decompose a key into its surface (undefined = the installation's default surface), its tenant
// (undefined = home) and the bare base key. Every helper below reads keys through this, so a
// surfaced key is a thread / dm / cron key like any other.
export function splitTeam(key: string): { surface?: ChatDriverName; tenantId?: string; base: string } {
  const m = SURFACE_RE.exec(key);
  const surface = m ? (m[1] as ChatDriverName) : undefined;
  const rest = m ? key.slice(m[0].length) : key;
  const i = rest.indexOf(':');
  if (i > 0) {
    const head = rest.slice(0, i);
    if (TENANT_RE.test(head)) return { ...(surface ? { surface } : {}), tenantId: head, base: rest.slice(i + 1) };
  }
  return { ...(surface ? { surface } : {}), base: rest };
}

// Is this (possibly tenant-prefixed) key a thread conversation?
export function isThreadKey(key: string): boolean {
  return splitTeam(key).base.startsWith('thread:');
}

// The thread root ts of a thread key (tenant prefix tolerated); undefined otherwise.
export function threadRoot(key: string): string | undefined {
  const { base } = splitTeam(key);
  return base.startsWith('thread:') ? base.slice('thread:'.length) : undefined;
}

// The project slug embedded in a key, for every non-thread shape (dm/cmd/cron/review/
// autofix/youtrack — the slug is the LAST segment when the bare key has ≥3 segments).
// Thread keys carry no slug — callers resolve those via the ChatRecord (full key!).
export function slugOfBase(key: string): string | undefined {
  const { base } = splitTeam(key);
  if (base.startsWith('thread:')) return undefined;
  const parts = base.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : undefined;
}
