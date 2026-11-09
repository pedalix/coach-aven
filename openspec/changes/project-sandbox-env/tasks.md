# Tasks

## 1. Pure logic (`src/projectenv.ts` + `src/projectenv.test.ts`)

- [ ] 1.1 `checkEnvKey(key)`: the name pattern and the deny-list of D2 (one exported constant) — test: valid, malformed, each reserved family (`npm test`)
- [ ] 1.2 `resolveProjectEnv(slug, env, source)`: replace `${VAR}` refs, throw naming project, key and variable on an unknown ref, never the value — test: literal, one ref, two refs in one value, unknown ref (assert the message has no value)
- [ ] 1.3 `envFileText(values)`: `export NAME='value'` lines with single-quote escaping — test: quotes, spaces, `$`, newline; round-trip through `sh -c '. file; printf %s "$NAME"'` in the test
- [ ] 1.4 `redactValues(text, entries)`: values of 8+ characters, longest first, `[redacted:<KEY>]` — test: overlap, repeats, short value untouched, empty entries returns the same string

## 2. Config load (`src/projects.ts`)

- [ ] 2.1 Validate keys and resolve values in `loadProjects` with the injected environment; keep the resolved map on the project, the raw refs nowhere else — test in `src/projects.test.ts`: resolved value, unknown ref fails the load, reserved key fails, `{}` and absent load as before
- [ ] 2.2 `/aven reload` path: a failing `env` refuses the reload and keeps the running config (existing reload error path) — test beside the reload tests

## 3. Sandbox seeding and launch

- [ ] 3.1 `seedProjectEnv(sandbox, values)` in `src/project.ts` (upload + one `chmod` exec, D3); returns without any sandbox call for no values — test in `src/project.test.ts` with the recording fake: calls for values, zero calls for `{}`
- [ ] 3.2 Call it in `src/tasks.ts` right after `seedGatewayAuth` in both branches of `ensureSession`
- [ ] 3.3 `claudeLaunch` takes `projectEnv: boolean`; with it, the command starts with `set -a; . /root/.aven/env; set +a;` — test in `src/claudeSession.test.ts`: the command without it is byte-identical to today's (golden string), with it carries the prefix and no value

## 4. Chat output

- [ ] 4.1 A redacting `ChatDriver` decorator (outside `src/chat/slack/`, platform-neutral) that applies `redactValues` to every text field of the view models it posts or updates — test: answer, progress update, question view
- [ ] 4.2 `src/turn.ts` wraps the driver for turns of a project with values only — test with the Slack twin: a project with a value redacts it in the posted answer; the existing recorded call snapshots stay unchanged (no `UPDATE_SNAPSHOTS`)

## 5. Docs and rollout

- [ ] 5.1 `docs/runtime-config.md`: the `env` field, `${VAR}` from `.env` (restart) vs. the mapping (reload), the file path, what is redacted and what is not, removal (D5) — `npm run typecheck && npm test` stays green
- [ ] 5.2 `projects.config.example.json`: one commented example value with a `${VAR}` ref (fictional names); `src/projects.ts` header comment no longer says "wired later"
- [ ] 5.3 `.claude/skills/manage-project/SKILL.md`: the `env` row of the field table (what it is for, `.env` + restart)
- [ ] 5.4 `docs/rollout.md` ledger row: bucket 2, gate = a project's `env`, what to watch (the file, a tool call's env, a redacted answer)
- [ ] 5.5 `scripts/public-guard.sh` passes on the diff (fictional names only); `openspec validate project-sandbox-env --strict`

## 6. Canary check

- [ ] 6.1 On the home bot, a scratch project with one fake value: the file is `0600`, a shell command in a new session sees the value, an answer quoting it shows `[redacted:<KEY>]`, `ps` in the sandbox shows no value, and a project without `env` behaves as before
