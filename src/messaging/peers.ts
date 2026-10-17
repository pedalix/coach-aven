// The peers this installation talks to through the hub (OpenSpec `agent-messaging`, design D2, D6):
// `hub.peers.json` beside projects.config.json pins each peer installation's public keys, a list per
// peer for rotation — `orch hub keygen` prints an entry to paste. Only pinned peers are addressable,
// and an envelope opens only with the pinned signing key of its sender: the hub never distributes keys.
//
//   { "bluefin": { "keys": [ { "sign": "<ed25519 x, b64url>", "box": "<x25519 x, b64url>", "notAfter"?: "<ISO>" } ] } }
//
// Read at boot and on `/aven reload`. A reload that drops a peer ends every open task with it
// (`failed: peer removed`, endTasksWithPeer) — as the hub reporting it removed does.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from '../state.js';
import { isOpen, type InTask, type OutTask } from './records.js';
import { INSTALLATION_RE, parseAddress } from './protocol.js';
import type { PeerKey } from './seal.js';

export const PEERS_FILE = 'hub.peers.json';
export type Peers = Record<string, PeerKey[]>;
export interface PeersRef {
  current: Peers;
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding

/** Where the peers file lives: beside the projects configuration. */
export const peersPath = (projectsConfigPath: string): string => join(dirname(projectsConfigPath), PEERS_FILE);

/** Pure: validate the file's content. Throws naming the peer and field — a typo must not silently unpin a key. */
export function parsePeers(x: unknown, where: string, ownInstallation: string): Peers {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${where} must be an object of peer installations`);
  const out: Peers = {};
  for (const [id, entry] of Object.entries(x as Record<string, unknown>)) {
    if (!INSTALLATION_RE.test(id)) throw new Error(`${where}: "${id}" is not an installation id ([a-z0-9-]{1,32})`);
    if (id === ownInstallation) throw new Error(`${where}: "${id}" is this installation — its own agents are reached without the hub`);
    const keys = (entry as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || !keys.length) throw new Error(`${where}: "${id}" needs a non-empty "keys" list`);
    out[id] = keys.map((k, i) => {
      const a = (k ?? {}) as Record<string, unknown>;
      if (typeof a.sign !== 'string' || !KEY_RE.test(a.sign)) throw new Error(`${where}: "${id}" keys[${i}].sign is not a public key`);
      if (typeof a.box !== 'string' || !KEY_RE.test(a.box)) throw new Error(`${where}: "${id}" keys[${i}].box is not a public key`);
      if (a.notAfter !== undefined && (typeof a.notAfter !== 'string' || Number.isNaN(Date.parse(a.notAfter)))) {
        throw new Error(`${where}: "${id}" keys[${i}].notAfter is not a date`);
      }
      return { sign: a.sign, box: a.box, ...(a.notAfter !== undefined ? { notAfter: a.notAfter as string } : {}) };
    });
  }
  return out;
}

/** Read the peers file; none is an empty set (messaging inside the installation needs no peers). */
export function loadPeers(path: string, ownInstallation: string): Peers {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parsePeers(raw, path, ownInstallation);
}

/** The keys valid at `now` (no `notAfter`, or later): what a seal uses (the first) and what an open tries (all). */
export const validKeys = (keys: readonly PeerKey[] | undefined, now: Date): PeerKey[] =>
  (keys ?? []).filter((k) => k.notAfter === undefined || Date.parse(k.notAfter) > now.getTime());

/** Pure: which peers a reload drops. */
export const droppedPeers = (before: Peers, after: Peers): string[] => Object.keys(before).filter((p) => !(p in after)).sort();

/**
 * End every open task with `peer` (D2 "Peers", D8): outgoing tasks to its agents and incoming tasks from
 * it end `failed` with `reason`. Returns what was ended, so the caller can tell the conversations and
 * close shadow sessions. Ended tasks are left as they are.
 */
export function endTasksWithPeer(store: Store, peer: string, reason: string, now = new Date()): { out: OutTask[]; in: InTask[] } {
  const at = now.toISOString();
  const { out, in: inc } = store.messagingTasks();
  const ended = { out: [] as OutTask[], in: [] as InTask[] };
  for (const t of out) {
    if (!isOpen(t) || parseAddress(t.target)?.installation !== peer) continue;
    ended.out.push(store.patchOutTask(t.id, { state: 'failed', reason, updatedAt: at })!);
  }
  for (const t of inc) {
    if (!isOpen(t) || t.origin !== peer) continue;
    ended.in.push(store.patchInTask(t.origin, t.id, { state: 'failed', reason, updatedAt: at })!);
  }
  return ended;
}
