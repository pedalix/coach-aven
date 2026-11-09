// Temporary, operator-granted extra capabilities for one project (OpenSpec `project-grants`). Pure: the registry,
// the `/aven grant` grammar, which grants are active or expired at a moment, and the texts. state.ts stores the
// records, commands.ts runs the verb, the pollers' minute loop ends expired ones, and tasks.ts asks githubExtras()
// at every sandbox token mint — so "active" is decided at mint time, and a turn after the end gets the ordinary
// token even before the sweep has announced it.
//
// Why per project and time-boxed, not per call or per thread: one sandbox (and one token file) serves every thread
// of a project, so a narrower grant would promise an isolation the box cannot give (design D1). Tokens minted during
// a grant are not revoked at its end: whoever could copy one could already use it during the grant (design D8).

/** What a capability widens. Today only the GitHub token the bot seeds into the sandbox. */
export interface Capability {
  label: string; // human words for the announcements
  github: Record<string, 'read' | 'write'>; // extra permissions on the sandbox's installation token
}

export const CAPABILITIES = {
  // The agent's token omits `workflows` on purpose (src/github.ts AGENT_PERMISSIONS): with it, an `on: push`
  // workflow runs with the repository's Actions secrets.
  workflows: { label: 'GitHub workflows write', github: { workflows: 'write' } },
  // Dispatch, re-run and cancel workflow runs — a deploy, typically (OpenSpec agent-github-read-superset D3). Kept
  // apart from `workflows`: starting a deploy is not rewriting what it runs. It can also delete runs and their logs,
  // which is one more reason it is lent for a while and announced, never standing.
  actions: { label: 'GitHub Actions write', github: { actions: 'write' } },
} as const satisfies Record<string, Capability>;

export type CapabilityName = keyof typeof CAPABILITIES;

export const DEFAULT_GRANT_MS = 30 * 60_000;
export const MAX_GRANT_MS = 4 * 60 * 60_000;

/** One grant, as state.json keeps it: at most one per (project, capability). */
export interface GrantRecord {
  slug: string;
  capability: string;
  at: string; // ISO, granted
  until: string; // ISO, ends
  by: string; // user id of the operator who granted it
  teamId?: string; // owning tenant (absent = home), as routines: the end notice is posted with that tenant's driver
  surface?: string; // owning chat surface (absent = the default driver)
  channel: string; // where the grant was made and where its end is announced
}

export type GrantCmd =
  | { action: 'list' }
  | { action: 'grant'; capability: CapabilityName; ms: number }
  | { action: 'off'; capability: CapabilityName }
  | { action: 'error'; message: string };

const isCapability = (s: string): s is CapabilityName => Object.hasOwn(CAPABILITIES, s);
const names = (): string => Object.keys(CAPABILITIES).map((c) => `\`${c}\``).join(', ');

/** `30m`, `90m`, `2h` → milliseconds; anything else → undefined. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d{1,4})(m|h)$/.exec(s.trim().toLowerCase());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * (m[2] === 'h' ? 60 * 60_000 : 60_000);
}

/** The words after `grant`: nothing (list), `<capability> [<duration>]` or `<capability> off`. */
export function parseGrantCmd(args: string, cmd = '/aven'): GrantCmd {
  const usage = `Usage: \`${cmd} grant <capability> [30m|2h]\`, \`${cmd} grant <capability> off\` or \`${cmd} grant\` to list. Capabilities: ${names()}.`;
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { action: 'list' };
  if (words.length > 2) return { action: 'error', message: usage };
  const cap = words[0]!.toLowerCase();
  if (!isCapability(cap)) return { action: 'error', message: `There is no capability \`${cap}\`. Capabilities: ${names()}.` };
  const second = words[1]?.toLowerCase();
  if (second === 'off') return { action: 'off', capability: cap };
  if (second === undefined) return { action: 'grant', capability: cap, ms: DEFAULT_GRANT_MS };
  const ms = parseDuration(second);
  if (ms === undefined || ms === 0) return { action: 'error', message: usage };
  if (ms > MAX_GRANT_MS) return { action: 'error', message: `A grant lasts at most 4h — \`${second}\` is longer.` };
  return { action: 'grant', capability: cap, ms };
}

export const isActive = (g: GrantRecord, now: number): boolean => Date.parse(g.until) > now;

export function activeGrants(records: GrantRecord[], slug: string, now: number): GrantRecord[] {
  return records.filter((g) => g.slug === slug && isActive(g, now));
}

export function expiredGrants(records: GrantRecord[], now: number): GrantRecord[] {
  return records.filter((g) => !isActive(g, now));
}

const RANK: Record<string, number> = { read: 1, write: 2 };

/** The extra GitHub permissions a project's sandbox token requests at `now`: the union of its active grants. */
export function githubExtras(records: GrantRecord[], slug: string, now: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of activeGrants(records, slug, now)) {
    const cap = isCapability(g.capability) ? CAPABILITIES[g.capability] : undefined;
    for (const [perm, level] of Object.entries(cap?.github ?? {})) {
      if ((RANK[level] ?? 0) > (RANK[out[perm] ?? ''] ?? 0)) out[perm] = level;
    }
  }
  return out;
}

const labelOf = (capability: string): string => (isCapability(capability) ? CAPABILITIES[capability].label : capability);

/** "14:30 (Europe/Zurich)" — the end time in the installation's routine time zone. */
export function clock(iso: string, tz: string): string {
  const t = new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  return `${t} (${tz})`;
}

/** The channel-visible announcement of a new or extended grant. */
export function grantNotice(g: GrantRecord, tz: string): string {
  return (
    `:unlock: <@${g.by}> gave *${g.slug}* ${labelOf(g.capability)} until ${clock(g.until, tz)}. ` +
    `Every turn of this project that starts before then gets it.`
  );
}

/** The channel-visible announcement of an ended grant; `by` = who ended it early, absent = its time ran out. */
export function endNotice(g: GrantRecord, by?: string): string {
  const how = by ? `<@${by}> ended` : 'Time is up for';
  return (
    `:lock: ${how} *${g.slug}*'s ${labelOf(g.capability)}. ` +
    `New turns get the usual token; tokens already handed out expire within the hour.`
  );
}

/** `/aven grant` with no arguments. */
export function grantListText(slug: string, active: GrantRecord[], tz: string): string {
  if (active.length === 0) return `:information_source: *${slug}* holds no grants.`;
  const lines = active.map((g) => `• \`${g.capability}\` (${labelOf(g.capability)}) until ${clock(g.until, tz)}, granted by <@${g.by}>`);
  return `*${slug}* grants:\n${lines.join('\n')}`;
}

/**
 * What the grant's private reply adds when it cannot take effect (design D9): the installation does not mint App
 * tokens, or the App installation holding the project's repositories has not approved the permission. `granted` is
 * that installation's permission map (undefined when it could not be read — then nothing is claimed).
 */
export function effectNote(authKind: string | undefined, capability: CapabilityName, granted: Record<string, string> | undefined): string {
  if (authKind !== 'app') {
    return authKind === 'token'
      ? 'This installation uses a static GitHub token, so the grant changes nothing here — the token\'s own scopes apply.'
      : 'This installation has no GitHub App auth, so the grant changes nothing here.';
  }
  if (!granted) return '';
  // By level, not presence: `actions` is approved read-only on most installations, which a write grant cannot use.
  const needs = Object.entries(CAPABILITIES[capability].github as Record<string, string>);
  const missing = needs.filter(([p, level]) => (RANK[granted[p] ?? ''] ?? 0) < (RANK[level] ?? 0));
  const named = missing.map(([p, level]) => (granted[p] ? `\`${p}: ${level}\`` : `\`${p}\``));
  return missing.length
    ? `The GitHub App installation for this project has not approved ${named.join(', ')} — an organization owner must approve it before the grant has any effect.`
    : '';
}
