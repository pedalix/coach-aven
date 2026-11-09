# Design

## Context

- The sandbox token is minted per turn from `AGENT_PERMISSIONS` (`src/github.ts`), widened by the project's active
  grants (`githubExtras`, `src/grants.ts`) and intersected with what the installation approved
  (`intersectPermissions`): a permission the installation lacks is dropped (or lowered), never fatal.
- Grants are a registry (`CAPABILITIES`) with a generic grammar, announcements, listing and the effect note, all keyed
  by capability name; `workflows` is the only entry.
- On 2026-11-09 every installation had approved `deployments: read`, `actions: read`, `workflows: write`, but not
  `environments`, `administration`, `vulnerability_alerts`, `security_events`.

## Decisions

### D1 — One deliberate superset, approved once

The App asks for the reads an agent needs to explain a repository's delivery (deployments, environments, branch
protection via `administration: read`) and its security state (`vulnerability_alerts`, `security_events`), plus
`actions: write` for the grant. Asking in one round avoids a re-approval per capability; the intersecting mint means
the code ships first and each installation gains the reads when its owner approves.

*Why `administration: read` by default:* it is read-only — repository settings, branch protection, rulesets, deploy
key (public) lists — and an agent that knows the rules says up front that a push to `main` will be refused or a
deploy waits; the rules endpoint alone does not show classic branch protection.

*Why `security_events` while code scanning is off:* it costs nothing now (the API answers "Code Security must be
enabled") and saves a later approval round if a client buys it.

### D2 — Two reads stay out, by name

`secret_scanning_alerts` returns each detected secret in clear; `repository_hooks` returns hook URLs, which often embed
tokens. A comment beside `AGENT_PERMISSIONS` names both so a later widening does not add them by habit, and a test
pins that the requested set never contains them.

### D3 — `actions` is its own capability

`actions: write` dispatches, re-runs and cancels runs — and deletes runs and their logs. `workflows: write` changes the
files those runs execute. Kept apart, an operator can let the agent start a deploy without letting it rewrite what the
deploy does. `githubExtras` already merges grants per permission at the highest level, so `actions: write` replaces
the standing `actions: read`.

### D4 — The prompt hint names both grants

The existing paragraph (App-auth installations only) gains one sentence for a 403 on dispatch, re-run or cancel. The
golden prompt fixtures for App-auth change on purpose; token-mode prompts stay byte-identical.

## Risks / Trade-offs

- [A grant to `actions` lets the agent deploy a branch it pushed] → a repository that deploys via workflow should
  restrict its `production` environment to `main` (deployment branches; available on Team for private repositories —
  required reviewers are not); the docs say so.
- [`actions: write` can delete run logs] → time-boxed grant, announced in the channel; the bot's own event log keeps
  the turn.
- [A client organisation never approves the new reads] → its tokens stay as today; nothing breaks.

## Migration Plan

Merge → ship (home → staging → prod). Then the App's permissions are widened by hand and each installation approves;
check with a mint that the token carries the new reads. Rollback: ship the previous version; the App's extra
permissions are harmless unrequested.
