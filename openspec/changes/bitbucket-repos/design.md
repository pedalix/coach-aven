# Design

## Context

GitHub is assumed in five places, all reached from a project's `repos` (strings, `owner/name`):

- **Clone and fetch** (`src/project.ts` `cloneRepo`): the URL is `https://github.com/${repo}.git`, and every fetch
  first resets `origin` to that URL (it heals a token baked into the remote by an earlier session).
- **The sandbox credential** (`seedGitHubAuth`): `/root/.gh-token` plus a *global* git credential helper that answers
  `x-access-token` + the token for any HTTPS host, and `gh auth login`.
- **The mint** (`src/tasks.ts` `scopedRepos` → `getGitHubToken`): an installation token for the project's repos plus
  the dependency repos on record; the installation is found from `repos[0]`'s owner, and a repo GitHub does not know
  fails the whole mint, so the turn.
- **The prompt** (`src/prompt.ts`): origin URLs, the `pr`/`direct` flow, the repo list.
- **PR work** (`src/pollers.ts` auto-review/autofix, `/aven status`'s open-PR count): per repo, via the GitHub API.

`repoName` takes the second path segment, which for a three-segment entry would be the workspace.

Bitbucket Cloud (Atlassian docs, checked 2026-11-18): git over HTTPS accepts an API token with the static username
`x-token-auth` (or `x-bitbucket-api-token-auth`); cloning needs the scope `read:repository:bitbucket`. Workspace,
project and repository access tokens use `x-token-auth` too.

## Decisions

### D1 — The host is a prefix of the entry, not a new field

`bitbucket.org/<workspace>/<repo>` in the same `repos` list. A bare two-segment entry stays GitHub, so no existing
config changes meaning. One pure module (`src/repohost.ts`) parses an entry into `{ host, owner, name, url }` and
splits a list by host; every caller asks it instead of splitting strings.

*Rejected:* an object form (`{ "host": "bitbucket", "repo": "…" }`): every reader of `repos` would need a second shape,
and the string form already carries the host the way people write it.

### D2 — Read-only, by token and by prompt

The boundary is the token: an operator gives `read:repository:bitbucket` only, so a push is refused by Bitbucket. The
prompt says the repos are read-only and how to propose a change (a diff in the reply), so the agent does not try. No
`gitFlow` for Bitbucket repos: `pr` and `direct` both push.

*Rejected:* pull requests on Bitbucket. They need the Bitbucket API in the bot (pollers, reviews, CI status), which is
a product of its own; nobody has asked for it.

### D3 — A helper scoped to `bitbucket.org`, the GitHub helper untouched

`seedBitbucketAuth` writes `/root/.bb-token` (600, via the file API) and sets, in the global git config:

```
credential.https://bitbucket.org.helper = ""                     # resets the list for this host
credential.https://bitbucket.org.helper = !f() { echo username=x-token-auth; echo "password=$(cat /root/.bb-token)"; }; f
```

Git applies a URL-specific `credential.<url>.helper` on top of the generic one, and an empty value resets the list,
so for `bitbucket.org` the Bitbucket helper answers whichever section comes first in the file. Checked on 2026-11-18
with `git credential fill` (git 2.55) in both orders and after re-setting the generic helper in place: `bitbucket.org`
got `x-token-auth` + the Bitbucket token, `github.com` got `x-access-token` + the GitHub token, every time. The generic GitHub
helper stays exactly as it is, which keeps GitHub-only projects byte-identical. A project without Bitbucket repos is not
seeded at all, so its exec calls stay exactly today's; a section an earlier config left behind stays and answers
`bitbucket.org` only, with a token file that no longer changes.

*Rejected:* scoping the GitHub helper to `github.com`: correct too, but it changes the seeding of every existing
sandbox for nothing those projects need.

### D4 — The mint sees GitHub repos only

`scopedRepos` filters by host before `tokenRepos`; the installation lookup uses the first GitHub repo. With the App and
no GitHub repo, the turn calls `seedGitHubAuth(sandbox, '')` (the existing `none` path: no token file, no helper, `gh`
logged out). A static `GITHUB_TOKEN` needs no repo to mint for, so it is seeded as today: it is what keeps a
Bitbucket project's public GitHub dependencies under GitHub's authenticated rate limit (a lock file with 263 GitHub
`dist` URLs would hit the anonymous 60 requests an hour). The bot's GitHub identity lookup runs only with a token.

### D8 — Composer: one `auth.json`, three kinds of entry

`composerAuthScript` already writes `auth.json` per checkout (Sail's containers mount the checkout but not the
sandbox's git config, so a file is the one thing composer sees everywhere). It now merges, in this order:

- `github.com` from `/root/.gh-token`, as today, when there is a GitHub token;
- `bitbucket.org` → `BITBUCKET_EMAIL` (else `x-token-auth`) + the Bitbucket token, when the project has a Bitbucket
  repo. Found during the canary preparation (2026-11-18): Bitbucket's download URLs (`/<ws>/<repo>/get/<ref>.zip`)
  take an API token only with the account e-mail as the user name (`x-token-auth` → 401), while git takes only
  `x-token-auth` (the e-mail → authentication failed). So the installation names the e-mail beside the token — a Bitbucket client's
  lock file typically downloads its private packages' `dist` zips from `bitbucket.org` (seen: 65 of 331 packages),
  while its source URLs are SSH, which the sandbox has no key for;
- the project's `composerAuth`, each `{ username, password }` resolved at load like an MCP header's `${VAR}`, except
  that an unknown ref fails the load (an empty password would only fail later, inside `composer install`).

The values are read from files or written by the file API, never on a command line; the file stays excluded from git
as today. A project without Bitbucket repos and without `composerAuth` gets exactly today's file.

*Rejected:* an installation-wide extra-registry setting. One installation can host several clients' projects, and a
registry token of one must not reach another's sandbox.

### D5 — Clone URL by host; the healing reset keeps its purpose

`cloneRepo` takes the URL from `repohost` for both the clone and the `remote set-url` reset (which still removes any
token baked into a remote). The retry wrapper stays: its patterns are git's transient network errors, plus GitHub's
"Repository not found" right after a mint, which Bitbucket does not produce but costs nothing to keep.

### D6 — One credential per installation, checked at load

`BITBUCKET_TOKEN` is read into the config; the projects check fails the load when any project has a Bitbucket entry
and the token is empty, naming those projects (the same place unknown `gitFlow` values fail). The value never reaches
a log line; the sandbox gets it as a file each turn, like the GitHub token.

### D7 — Duplicate checkout names fail the load

`repoName` becomes the entry's last segment. Two entries with the same name already shared one directory (the second
clone found the first and fetched it); now the load says so. No existing GitHub-only project can have such a pair
and work, so this is a bug fix, not a behaviour change for a working config.

## Risks

- **Token lifetime.** A Bitbucket API token expires at the date its owner chose (at most a year); it is not refreshed
  like the GitHub installation token. An expired token fails the clone or fetch with an authentication error, which
  the turn reports. Rotation: one value in `.env`, then a restart.
- **Whose token.** A personal API token reads what its owner can read. A workspace access token is the better fit for
  an installation (not tied to a person), but needs a workspace admin to create it.
- **Registry tokens in the sandbox.** A `composerAuth` token is readable by the agent (it is in a file it can open);
  give a read-only one, as for `BITBUCKET_TOKEN`. npm and other registries are not covered.
