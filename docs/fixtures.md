# Replay fixtures

Real Slack envelopes, captured on prod by the [event journal](../src/eventlog.ts), scrubbed,
and committed under `src/fixtures/`. The twin harness (`src/chat/slack/twin.ts`) replays them through
`app.processEvent` — so the tests drive the app with what Slack actually sent, not with
envelopes composed from memory.

> **Status: shipped.** 34 fixtures covering every envelope kind seen on prod so far; four
> replay tests in `src/twin.test.ts` (rating click with a real 10-block answer, thumbs-down,
> reason-modal submission, @-mention). Refresh whenever Slack changes a shape or a new
> interaction lands.

## Why

The first rating test asserted that a hand-written `rich_text` block survives `chat.update`.
It passed, and proved nothing: only a manual click on prod showed the real shape matched —
and the real answer turned out to carry a `table` block no hand-written test had. A captured
envelope proves it in CI, before the deploy.

## The loop

```
prod (AVEN_EVENT_LOG=full)  →  events/<day>.jsonl (raw envelopes)
        │ scripts/pull-fixtures.sh        one newest envelope per (kind, subtype)
        ▼
   stdin JSONL, UNSCRUBBED      never redirect this into the repo
        │ scripts/scrub-fixtures.ts      src/fixtures.ts — by shape, not blacklist
        ▼
src/fixtures/<kind>[.<subtype>].json   committed
        │ loadFixture() + rehome()       twin.test.ts
        ▼
   app.processEvent                      the twin, on real traffic
```

```sh
scripts/pull-fixtures.sh | npx tsx scripts/scrub-fixtures.ts     # refresh everything
scripts/pull-fixtures.sh 2026-09-02 | npx tsx scripts/scrub-fixtures.ts   # one day only
```

Needs prod's journal in **full** mode (`AVEN_EVENT_LOG=full`) — metadata-only lines have no
`raw` and are skipped — and the deploy env (`infra/prod/.env`) for the host.

## What scrubbing keeps and removes

**By shape, not by blacklist.** A blacklist of known names would have missed everything the
first eyeball pass over real fixtures caught: `first_name`, avatar URLs, `name_normalized`
channel names, PR URLs into a client repo, a prefilled report draft. Every rule below matches
a *kind* of value, so the next identifying field Slack adds is caught by the rule it belongs
to, not by someone noticing it.

| kept byte-for-byte | rewritten |
| --- | --- |
| keys, nesting, block types, `block_id`s | every Slack id → `T_FIX_1`, `U_FIX_2`… (stable per fixture, also inside mentions and JSON strings) |
| timestamps (`ts`, `thread_ts`, `event_time`) | any key ending in `name`, plus `domain`/`title`/`email` → `fixture` |
| our own values: button meta, radio options, `private_metadata`, `action_id`s | free text (`text`, `initial_value`, `fallback`, `alt_text`, `placeholder`) → mentions only + `[text]` |
| file `mimetype`, `size`, extension | typed input (`plain_text_input.value`) → `[text]`; every URL → `https://example.invalid/fixture`; avatar fields → `fixture` |
| | `token`, `trigger_id`, `response_url`, `client_msg_id`, `event_id`, `api_app_id` → constants; `enterprise` → `null`; file URLs/previews dropped |

The scrubber's tests (`src/fixtures.test.ts`) are the guarantee — a flat string search over
a synthetic envelope carrying every shape seen on prod must find nothing identifying. Still,
**eyeball a new fixture once** before its first commit: run the "remaining human-readable
strings" check (the one-liner in the PR that introduced this) and expect only `block_id`,
`hash`, and placeholders.

## Roles and rehoming

Each fixture records which placeholder ids play `team`, `channel`, `actor`, `bot`. A test
calls `rehome(fixture, { team: HOME, channel: 'C_SHARED', actor: 'U_HUMAN', bot: 'UBOT_…' })`
to point it at the twin's own ids — bare values and mention tokens alike. A
`view_submission` has no channel of its own; its channel role is read from the id the opener
tucked into `private_metadata`.

## Boundaries

- Fixtures are **shapes**, not conversations. One per (kind, subtype); the newest wins.
- Nothing from `scripts/pull-fixtures.sh`'s stdout is ever committed — only the scrubber's
  output is.
- Drop prod to `AVEN_EVENT_LOG=1` before real clients land (see `eventlog.ts`); fixtures
  from metadata-only lines are not possible, so capture what you need first.
