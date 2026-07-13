// Actor access control — WHO may drive the agent, per workspace (multi-tenancy slice 4,
// docs/multitenancy.md §7.3). The tenant gate (slack.ts) decides whether a WORKSPACE is
// served at all; this layer decides which USERS inside a served workspace may run turns,
// open PRs, and steer questions — vs only read along. Pure logic: storage lives in
// state.ts (`teamAccess`), enforcement at the entry handlers (events.ts / commands.ts).
//
// Default is OPEN everywhere — deliberately (Owen, 2026-07-13): adding a workspace must
// not add process; the allowlist is an opt-in lever for when a client actually asks for
// it, not a hoop for every install. What the default still carries: a client team's
// INSTALLING user (from the OAuth record) is its seed ADMIN, so someone over there can
// flip to `/aven users restrict` later without us touching state by hand.
// An explicit record (managed via `/aven users`) overrides the default either way.

export interface TeamAccess {
  mode: 'open' | 'allowlist';
  users: string[]; // may drive (admins always may, listed or not)
  admins: string[]; // may manage `/aven users` for their workspace
}

// The effective policy for a tenant: explicit record wins; otherwise the defaults above.
export function effectiveAccess(
  rec: TeamAccess | undefined,
  isHome: boolean,
  installerId?: string,
): TeamAccess {
  if (rec) return rec;
  if (isHome) return { mode: 'open', users: [], admins: [] };
  const seed = installerId ? [installerId] : [];
  return { mode: 'open', users: seed, admins: seed };
}

export function mayDrive(a: TeamAccess, userId: string | undefined): boolean {
  if (a.mode === 'open') return true;
  if (!userId) return false;
  return a.users.includes(userId) || a.admins.includes(userId);
}

// Home: every home-workspace user may manage (it's our own team). Client teams: admins only.
export function isAdmin(a: TeamAccess, userId: string | undefined, isHome: boolean): boolean {
  if (isHome) return true;
  return !!userId && a.admins.includes(userId);
}

// The one denial message, everywhere — names who can grant access instead of a dead end.
export function deniedText(a: TeamAccess): string {
  const admins = a.admins.length ? a.admins.map((u) => `<@${u}>`).join(', ') : 'your workspace admin';
  return `🔒 You're not on this workspace's allowlist for driving the agent — ask ${admins} to run \`/aven users allow @you\`.`;
}

// `/aven users …` argument grammar. `allow`/`deny` take a Slack mention (the slash payload
// escapes it as `<@U…|name>` or `<@U…>`); `open`/`restrict` flip the mode; bare = list.
export type UsersCmd =
  | { action: 'list' }
  | { action: 'allow'; userId: string }
  | { action: 'deny'; userId: string }
  | { action: 'open' }
  | { action: 'restrict' }
  | { action: 'error'; message: string };

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

export function parseUsersCmd(rest: string): UsersCmd {
  const [action, ...tail] = rest.trim().split(/\s+/).filter(Boolean);
  if (!action) return { action: 'list' };
  if (action === 'open' || action === 'restrict') return { action };
  if (action === 'allow' || action === 'deny') {
    const m = MENTION_RE.exec(tail.join(' '));
    if (!m) return { action: 'error', message: `Usage: \`/aven users ${action} @user\` (a real @-mention).` };
    return { action, userId: m[1] };
  }
  return { action: 'error', message: 'Usage: `/aven users` · `allow @user` · `deny @user` · `open` · `restrict`' };
}

// Apply a mutation to a policy, returning the next record to store. Deny also strips
// admin rights (an admin you deny should not keep the keys); the last admin of an
// allowlisted team cannot deny themselves into a lockout.
export function applyUsersCmd(
  a: TeamAccess,
  cmd: Exclude<UsersCmd, { action: 'list' } | { action: 'error' }>,
): { next: TeamAccess; note: string } | { error: string } {
  if (cmd.action === 'open') return { next: { ...a, mode: 'open' }, note: '🔓 Mode: *open* — anyone in this workspace may drive the agent.' };
  if (cmd.action === 'restrict')
    return { next: { ...a, mode: 'allowlist' }, note: '🔐 Mode: *allowlist* — only listed users (and admins) may drive.' };
  if (cmd.action === 'allow') {
    const users = a.users.includes(cmd.userId) ? a.users : [...a.users, cmd.userId];
    return { next: { ...a, users }, note: `✅ <@${cmd.userId}> may drive the agent.` };
  }
  // deny
  if (a.mode === 'allowlist' && a.admins.length === 1 && a.admins[0] === cmd.userId) {
    return { error: "Can't remove the last admin of an allowlisted workspace — `/aven users allow` another admin first." };
  }
  return {
    next: { ...a, users: a.users.filter((u) => u !== cmd.userId), admins: a.admins.filter((u) => u !== cmd.userId) },
    note: `🚫 <@${cmd.userId}> may no longer drive the agent.`,
  };
}

export function usersListText(a: TeamAccess, isHome: boolean): string {
  const lines = [
    `*Agent access — this workspace*`,
    `Mode: *${a.mode}*${a.mode === 'open' ? ' (anyone here may drive the agent)' : ''}${isHome && a.mode === 'open' ? ' — home default' : ''}`,
  ];
  if (a.mode === 'allowlist') {
    lines.push(`Allowed: ${a.users.length ? a.users.map((u) => `<@${u}>`).join(', ') : '_nobody yet_'}`);
  }
  lines.push(`Admins: ${a.admins.length ? a.admins.map((u) => `<@${u}>`).join(', ') : isHome ? '_everyone in the home workspace_' : '_none_'}`);
  lines.push('', 'Manage: `/aven users allow @user` · `deny @user` · `open` · `restrict`');
  return lines.join('\n');
}
