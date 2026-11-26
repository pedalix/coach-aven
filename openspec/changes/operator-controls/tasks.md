## 1. Check the CLI

- [ ] 1.1 CLI-probe scenario on the pinned version: a session started with each accepted model name and with
      each effort level starts and answers; record the verdicts
- [x] 1.2 If the pinned CLI has no effort flag: mark the effort requirements as waiting for the next pin and
      say so in the PR; continue without them — not the case: the help of 2.1.314 lists `--effort <level>`
      (low, medium, high, xhigh, max) and model aliases; 1.1, a recorded run, still needs a probe credit

## 2. Operators

- [x] 2.1 `OPERATOR_CONTROLS` in `src/config.ts` (exactly `1` → on), `docs/configuration.md`
- [x] 2.2 Pure logic in `src/access.ts`: the operator rule (config ∪ chat list, nobody named → earlier rule),
      the `operators` command grammar, add / remove with the first-add and last-operator rules; tests
- [x] 2.3 The list in `src/state.ts` (who added, when); survives a restart
- [x] 2.4 `/aven operators` in `src/chat/core/commands.ts`; one `isOperator` used by `reload`, `usage`, `asks`,
      `grant` on all three platforms
- [x] 2.5 Test that with the flag off the Slack rule is today's

## 3. Model and effort per project

- [x] 3.1 Accepted names and levels in one constant beside the CLI pin; parsing and reply texts as pure logic
      with tests
- [x] 3.2 Store the chat-set values with who and when (`src/state.ts`)
- [x] 3.3 Session start takes the project's value, then the installation's (`src/tasks.ts`,
      `src/claudeSession.ts`); test that a project with nothing set starts exactly as today
- [x] 3.4 `/aven model`, `/aven effort` (set, `default`, read) in `src/chat/core/commands.ts`

## 4. What an operator sees

- [x] 4.1 The per-project operator view model in `src/chat/core/`; the Home view and the Session card info
      carry it only for an operator with the flag on
- [x] 4.2 Slack: the Home's section and the card's part in `src/chat/slack/blocks.ts`, packed under the view
      limits; snapshots for an operator and for someone else, and unchanged snapshots with the flag off
- [ ] 4.3 Teams (`src/chat/teams/cards.ts`) and web (`src/chat/web/webviews.ts`) render the same — the read-out
      is rendered on both; the menu and Reload exist on Slack only, so this stays open
- [x] 4.4 Actions in `src/chat/core/interactions.ts`: reload, grant, end grant, model, effort — each re-checks
      the operator rule and calls the command's handler
- [x] 4.5 A grant from the Home is announced in the project's conversation; refused when there is none

## 5. Cheat-sheets and docs

- [x] 5.1 `homeBullets`, `src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts`: the new verbs, shown with
      the flag on
- [x] 5.2 `docs/runtime-config.md` (operators, model, effort, what reaches a running conversation),
      `docs/rollout.md` ledger row

## 6. Rollout

- [ ] 6.1 Home installation: flag on, the walk-through of the migration plan, findings fixed
- [ ] 6.2 First production installation on the operator's word; date in the ledger
