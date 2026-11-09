# Tasks

## 1. Token permissions

- [x] 1.1 `src/github.ts`: add `deployments`, `environments`, `administration`, `vulnerability_alerts`, `security_events` (all `read`) to `AGENT_PERMISSIONS`; a comment names the two reads left out (`secret_scanning_alerts`, `repository_hooks`) and why — `npm test` (`src/github.test.ts`)
- [x] 1.2 `src/github.test.ts`: the standing set is exactly the new ten; it never contains the two excluded reads (also with every capability granted); an installation without the new reads mints exactly today's set

## 2. The `actions` grant

- [x] 2.1 `src/grants.ts`: `CAPABILITIES.actions = { label: 'GitHub Actions write', github: { actions: 'write' } }` — test in `src/grants.test.ts`: parse `actions`, `githubExtras` gives `actions: write`, both grants give both
- [x] 2.2 `effectNote` compares levels, so `actions` approved read-only names `actions: write` as missing — test: read-only install, write install, absent permission
- [x] 2.3 `src/github.test.ts`: `requestedPermissions` with the actions extra on an install that approved write → `actions: write`; read-only install → `actions: read`
- [x] 2.4 `src/chat/slack/commands.record.test.ts`: `/aven grant` usage lists both capabilities (existing tests stay green)

## 3. Prompt and Home tabs

- [x] 3.1 `src/prompt.ts`: the App-auth grant paragraph adds the refused dispatch / re-run / cancel → `/aven grant actions`; `src/prompt.test.ts` asserts both grants; re-snapshot the App-auth golden fixtures on purpose (token-mode fixtures unchanged)
- [x] 3.2 Home tabs: `src/chat/slack/blocks.ts`, `src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts` name `workflows` and `actions`; re-snapshot the Slack Home on purpose; the Teams/web parity tests stay green

## 4. Docs and rollout

- [x] 4.1 `docs/security.md` (the Sandbox → GitHub row and the grants paragraph), `README.md`, `docs/how-we-work.md`: the App's permission superset and the two reads kept out
- [x] 4.2 `docs/rollout.md` ledger row: bucket 1 for the reads (intersecting mint), the grant gated by nature; what to watch (a mint per installation after approval)
- [x] 4.3 `npm run typecheck && npm test`; `scripts/public-guard.sh`; `openspec validate agent-github-read-superset --strict` and `openspec validate project-grants --type spec --strict`
