// The actor gate (multi-tenancy slice 4 §7.3): WHO inside a served workspace may DRIVE the
// agent — start/steer turns, post reports — vs only read along (trails, ticket dialogs,
// memory stay open to viewers). Policy: home defaults open; a client tenant defaults to an
// allowlist seeded with its installing user; `/aven users` manages it (access.ts).
// Platform-neutral: tenant and user ids are whatever the chat driver normalized.

import type { Store } from '../../state.js';
import { normalizeTenant } from '../../teamkeys.js';
import { effectiveAccess, mayDrive, deniedText } from '../../access.js';

export type ActorGate = (tenant: string | undefined, userId: string | undefined) => { ok: boolean; denial: string };

export function createActorGate(store: Store, homeTeamId: string | undefined): ActorGate {
  return (tenant, userId) => {
    const isHome = normalizeTenant(tenant, homeTeamId) === undefined;
    const a = effectiveAccess(
      tenant ? store.getTeamAccess(tenant) : undefined,
      isHome,
      tenant ? store.installerOf(tenant) : undefined,
    );
    return { ok: mayDrive(a, userId), denial: deniedText(a) };
  };
}
