// Chat surfaces (OpenSpec `multi-driver-installation`): an installation runs one DEFAULT chat driver
// and may run additional ones; each running driver is a surface. A conversation belongs to the
// surface it started on, for life — its key says which: the default surface's keys keep the shapes
// of a single-driver installation (bare, or tenant-prefixed for another Slack workspace), an
// additional surface's keys carry the driver's name first (`web:thread:…`). `teamkeys.ts` parses
// both; this module is the vocabulary the composition root and the drivers share.

import type { ChatDriver } from './driver.js';
import { CHAT_DRIVERS, type ChatDriverName } from './drivers.js';
import { splitTeam } from '../teamkeys.js';

/** Which driver a record or key belongs to: its surface (undefined = default) and tenant (undefined = home). */
export interface DriverRef {
  surface?: ChatDriverName;
  tenantId?: string;
}
/** Resolves the chat driver of a surface + tenant; throws when none is live (the caller logs and skips). */
export type DriverFor = (ref: DriverRef) => ChatDriver;

export const isSurface = (s: unknown): s is ChatDriverName => typeof s === 'string' && (CHAT_DRIVERS as readonly string[]).includes(s);

/** A key for an additional surface: the driver's name first. The default surface (undefined) leaves keys as they are. */
export function withSurface(surface: ChatDriverName | undefined, key: string): string {
  return surface ? `${surface}:${key}` : key;
}

/** The surface and tenant a key names, and its bare base. */
export function splitSurface(key: string): {
  surface?: ChatDriverName;
  tenantId?: string;
  base: string;
} {
  return splitTeam(key);
}

/** The driver a conversation key resolves to. */
export function driverForKey(driverFor: DriverFor, key: string): ChatDriver {
  const { surface, tenantId } = splitTeam(key);
  return driverFor({
    ...(surface ? { surface } : {}),
    ...(tenantId ? { tenantId } : {}),
  });
}

/** `CHAT_SURFACES`: the additional surfaces an installation runs, validated against the drivers this build has. */
export function parseSurfaces(raw: string | undefined): ChatDriverName[] {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = names.filter((n) => !isSurface(n));
  if (bad.length) throw new Error(`CHAT_SURFACES names unknown chat drivers: ${bad.join(', ')} — this build has ${CHAT_DRIVERS.join(', ')}`);
  return [...new Set(names as ChatDriverName[])];
}
