// Composer credentials beyond GitHub (OpenSpec bitbucket-repos D8): a Bitbucket client's lock file downloads its
// private packages' dist zips from bitbucket.org, lists them through a private registry, and pulls hundreds of public
// ones from GitHub. composer runs inside Sail's containers, which see the checkout but not the sandbox's git config,
// so the one thing it reads everywhere is `auth.json` in the checkout.
//
// A project's `composerAuth` names further registries: host → { username, password }, where either may hold `${VAR}`
// refs to the bot's environment. The refs are checked when the config loads (an unknown one fails the load, unlike an
// MCP header, where it resolves to '' — an empty password would only fail later, inside `composer install`) and
// resolved only when the file is written, so no value sits in the loaded registry.
//
// Pure: no I/O. Tested in composerauth.test.ts.

export interface ComposerCredential {
  username: string;
  password: string;
}

export type ComposerAuthConfig = Record<string, ComposerCredential>;

const REF = /\$\{([A-Z0-9_]+)\}/g;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

const refsOf = (s: string): string[] => [...s.matchAll(REF)].map((m) => m[1]!);

/** The shape is right and every `${VAR}` is set in `env`; returns the value as given (refs unresolved). */
export function validateComposerAuth(value: unknown, where: string, env: Record<string, string | undefined>): ComposerAuthConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object of host → { "username", "password" }`);
  }
  const out: ComposerAuthConfig = {};
  for (const [host, cred] of Object.entries(value as Record<string, unknown>)) {
    if (!HOST.test(host)) throw new Error(`${where}: ${JSON.stringify(host)} is not a host name`);
    const c = cred as Partial<Record<string, unknown>>;
    const keys = typeof cred === 'object' && cred !== null ? Object.keys(cred) : [];
    if (typeof c?.username !== 'string' || typeof c?.password !== 'string' || keys.some((k) => k !== 'username' && k !== 'password')) {
      throw new Error(`${where} "${host}" must be { "username": "…", "password": "…" } (strings, nothing else)`);
    }
    for (const field of ['username', 'password'] as const) {
      for (const name of refsOf(c[field] as string)) {
        if (!env[name]) throw new Error(`${where} "${host}" ${field}: \${${name}} is not set in the bot's environment`);
      }
    }
    out[host] = { username: c.username, password: c.password };
  }
  return out;
}

/** The entries with every `${VAR}` replaced from `env` (validated at load, so none is missing). */
export function resolveComposerAuth(cfg: ComposerAuthConfig, env: Record<string, string | undefined>): ComposerAuthConfig {
  const sub = (s: string) => s.replace(REF, (_, name: string) => env[name] ?? '');
  return Object.fromEntries(Object.entries(cfg).map(([host, c]) => [host, { username: sub(c.username), password: sub(c.password) }]));
}

/**
 * composer's auth.json: `http-basic` per host, in this order — GitHub (the turn's token), Bitbucket (its token), then
 * the project's registries (a project entry for the same host wins).
 */
export function composerAuthJson(opts: {
  githubToken?: string;
  bitbucket?: { username: string; token: string };
  extra?: ComposerAuthConfig;
}): string {
  const basic: ComposerAuthConfig = {};
  if (opts.githubToken) basic['github.com'] = { username: 'x-access-token', password: opts.githubToken };
  if (opts.bitbucket) basic['bitbucket.org'] = { username: opts.bitbucket.username, password: opts.bitbucket.token };
  Object.assign(basic, opts.extra ?? {});
  return JSON.stringify({ 'http-basic': basic }) + '\n';
}

/**
 * Copy the prepared auth.json (`src`, written by the file API — values never on a command line) into every checkout
 * that has a composer.json, keep it out of git, refresh copies in the agent's worktrees; a checkout without
 * composer.json loses a stale one. The same per-checkout steps as composerAuthScript (project.ts), with a copy for
 * the printf.
 */
export function composerAuthCopyScript(src: string, checkoutDirs: string[]): string {
  const perCheckout = checkoutDirs.map(
    (d) =>
      `if [ -f ${d}/composer.json ]; then ` +
      `cp ${src} ${d}/auth.json && chmod 600 ${d}/auth.json; ` +
      `grep -qx auth.json ${d}/.git/info/exclude 2>/dev/null || echo auth.json >> ${d}/.git/info/exclude; ` +
      `for w in ${d}-wt/*/; do [ -f "$w/auth.json" ] && cp ${d}/auth.json "$w/auth.json"; done; ` +
      `else rm -f ${d}/auth.json; fi`,
  );
  return perCheckout.join('; ') + '; true';
}
