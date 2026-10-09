// Shared shapes for per-project source ingestion (docs/sources.md).
//
// A "source" is an external system the bot reads on a project's behalf — mail, chat, calendar,
// files — into an append-only, scrubbed JSONL archive on the bot host. The pullers are
// orchestrator-side competencies exactly like the composer dependency scanner (deps.ts): they
// hold tokens the sandbox must never see and write derived state the sandbox only reads.
// PR-A ships the pullers + CLI; the store build, the poller and the sandbox-side search tool
// follow (see docs/sources.md "What comes next").
import type { VaultPaths } from './common/vault.js';

export type SourceKind = 'google' | 'slack' | 'msgraph' | 'youtrack' | 'jira' | 'asana' | 'meetings' | 'local';
export const SOURCE_KINDS: readonly SourceKind[] = ['google', 'slack', 'msgraph', 'youtrack', 'jira', 'asana', 'meetings', 'local'];
/** Meeting recorders: one `meeting` shape (meetings/normalise.ts), several providers. */
export type MeetingProvider = 'granola' | 'gmeet' | 'wispr';
export const MEETING_PROVIDERS: readonly MeetingProvider[] = ['granola', 'gmeet', 'wispr'];
/** The task-tracker family: same contract, one normalised `task` shape (trackers/task.ts). */
export type TrackerKind = 'youtrack' | 'jira' | 'asana';
export const TRACKER_KINDS: readonly TrackerKind[] = ['youtrack', 'jira', 'asana'];

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

export interface YoutrackSourcesConfig {
  /** Base URL, e.g. https://acme.youtrack.cloud */
  url: string;
  /** Read the permanent token from this env var instead of ~/.config/coach-aven/sources/<slug>/youtrack.json. */
  tokenEnv?: string;
  /** Project short names (CG, CAR, …). */
  projects: string[];
  /** Login to scope to: issues assigned to, reported by, or commented on by this user. Unset = whole projects. */
  assignee?: string;
  /** YYYY-MM-DD lower bound on `updated` for the first pull (default 90 days back). */
  since?: string;
}

export interface JiraSourcesConfig {
  /** Atlassian Cloud host, e.g. contoso.atlassian.net */
  site: string;
  /** Account e-mail for basic auth (also read from the token file / netrc when omitted). */
  email?: string;
  /** Take e-mail + API token from ~/.netrc's `machine <site>` entry. */
  fromNetrc?: boolean;
  /** Overrides the default "involves me" JQL; `updated >= …` is always ANDed on. */
  jql?: string;
  since?: string;
}

export interface AsanaSourcesConfig {
  /** Workspace gid. */
  workspace: string;
  /** `me` (default) or a user gid/e-mail — whose assigned tasks to pull. */
  assignee?: string;
  /** Project gids pulled in full on top of the assignee's tasks. */
  projects?: string[];
  since?: string;
}

export interface MeetingsSourcesConfig {
  /** Granola Personal API (Business plan): token in ~/.config/coach-aven/sources/<slug>/granola.json. */
  granola?: { since?: string };
  /** Gemini "Notes by Gemini" docs in the listed Google accounts' Drive (uses the google token). */
  gmeet?: { accounts: string[]; since?: string };
  /** Wispr Flow Notetaker via its remote MCP endpoint (device-code OAuth, token in wispr.json). */
  wispr?: { since?: string };
}

/**
 * Hands-on work on the bot's own machine (local/pull.ts): git commits under `roots` by any of
 * `authors`, and Claude Code transcripts under `claudeProjectsDir`. No credentials.
 */
export interface LocalSourcesConfig {
  /** Absolute directories scanned for git repos (depth ≤ 4). */
  roots: string[];
  /** git --author patterns (name or e-mail fragments), OR-ed. */
  authors: string[];
  /** e.g. /home/me/.claude/projects — omit to skip Claude sessions. */
  claudeProjectsDir?: string;
  /** YYYY-MM-DD window start for the first pull (default 30 days back). */
  since?: string;
}

/**
 * The tenant repo: where the project's own decisions live (people with markers, fragments →
 * initiatives, rules). The bot keeps a host-side checkout under data/<slug>/tenant and READS it
 * at build time; it never writes there — the sandbox commits, the bot indexes.
 */
export interface TenantConfig {
  /** owner/name on GitHub. */
  repo: string;
  /** Branch to track (default: the repo's default branch). */
  ref?: string;
  /** Directory inside the repo holding people.json, fragments.jsonl, … (default "annotations"). */
  path?: string;
}

export interface SourcesConfig {
  google?: GoogleSourcesConfig;
  slack?: SlackSourcesConfig;
  msgraph?: MsgraphSourcesConfig;
  youtrack?: YoutrackSourcesConfig;
  jira?: JiraSourcesConfig;
  asana?: AsanaSourcesConfig;
  meetings?: MeetingsSourcesConfig;
  local?: LocalSourcesConfig;
  tenant?: TenantConfig;
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
