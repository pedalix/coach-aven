// Shared shapes for per-project source ingestion (docs/sources.md).
//
// A "source" is an external system the bot reads on a project's behalf — mail, chat, calendar,
// files — into an append-only, scrubbed JSONL archive on the bot host. The pullers are
// orchestrator-side competencies exactly like the composer dependency scanner (deps.ts): they
// hold tokens the sandbox must never see and write derived state the sandbox only reads.
// PR-A ships the pullers + CLI; the store build, the poller and the sandbox-side search tool
// follow (see docs/sources.md "What comes next").
import type { VaultPaths } from './common/vault.js';

export type SourceKind = 'google' | 'slack' | 'msgraph';
export const SOURCE_KINDS: readonly SourceKind[] = ['google', 'slack', 'msgraph'];

export type GoogleKind = 'gmail' | 'drive' | 'calendar';
export type MsgraphKind = 'mail' | 'calendar' | 'chats' | 'channels' | 'files';

export interface GoogleSourcesConfig {
  /** Account e-mails to pull; each must have been bootstrapped with `orch sources auth <slug> google login`. */
  accounts: string[];
  /** YYYY-MM-DD lower bound for the FIRST backfill of mail/files (later runs are incremental). */
  since?: string;
  /** Calendar ids read in addition to each account's primary calendar (default: primary only). */
  calendars?: string[];
  /** Which Google products to pull (default all three). */
  kinds?: GoogleKind[];
}

export interface SlackSourcesConfig {
  /** Team ids (T…) or workspace names as stored by `auth slack add`; every stored workspace when empty. */
  workspaces: string[];
  /** YYYY-MM-DD lower bound for the first contact with a conversation (else the workspace's backfill_days). */
  since?: string;
  /** How long a thread stays polled for replies (default 30). */
  threadWindowDays?: number;
  /** Hours of history re-read each run to catch edits/deletes (default 48; 0 disables). */
  editWindowHours?: number;
}

export interface MsgraphSourcesConfig {
  /** Entra tenant GUID — the authority is always the tenant, never /common. */
  tenant: string;
  /** UPNs (or `<tenant>:<upn>` keys) to pull. */
  accounts: string[];
  /** YYYY-MM-DD horizon for the first sync (default 180 days back). */
  since?: string;
  /** Subset of mail,calendar,chats,channels,files (default all). */
  only?: MsgraphKind[];
}

export interface SourcesConfig {
  google?: GoogleSourcesConfig;
  slack?: SlackSourcesConfig;
  msgraph?: MsgraphSourcesConfig;
  /** Poller interval (PR-C); default 15. Validated now so a typo fails at boot, not later. */
  intervalMinutes?: number;
  /** Path (relative to projects.config.json) of the people/identities JSON used by the store build (PR-B). */
  people?: string;
}

export type Logger = (line: string) => void;

/** Everything a puller needs; built by cli.ts (and later the poller) from the project + paths. */
export interface PullContext {
  slug: string;
  /** `data/<slug>/raw` — pullers write `<kind>/…` underneath. */
  outDir: string;
  /** `~/.config/coach-aven/sources/<slug>/<kind>.json` for this puller's kind. */
  tokenPath: string;
  /** Where carrier bodies are filed; undefined = scrub but do not preserve (logged once). */
  vault?: VaultPaths;
  log: Logger;
}

export interface AuthContext {
  slug: string;
  tokenPath: string;
  log: Logger;
}

/** What one puller run did — the poller (PR-C) stores this under facts/<slug>.json. */
export interface PullSummary {
  kind: SourceKind;
  /** False when any account/workspace failed (the others may have succeeded). */
  ok: boolean;
  /** A human must re-run `orch sources auth …`; retrying will not help. */
  reauth: boolean;
  /** Records written per `<account>/<kind>` (or per file for Slack). */
  counts: Record<string, number>;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

/** Stable, path-safe project slug — it becomes a directory name under data/ and ~/.config. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
