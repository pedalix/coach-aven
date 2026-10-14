# Proposal

## Why

The Slack puller archives every conversation the token's user is a member of. A tenant store that must hold only a company's shared channels (Bluefin's Slack Connect channels in Owen's workspace, later Vincent's workspace) cannot be built without pulling the user's private DMs and internal channels into it. A per-project allow-list keeps a tenant store inside its tenant boundary.

## What Changes

- `sources.slack.channels`: optional list of channel names or ids; when set, only those conversations are pulled (DMs/MPIMs excluded unless listed by id).
- `sources.slack.kinds`: optional subset of `channel`, `group` (private), `im`, `mpim`; default all (today's shape).
- Validation at boot (`src/sources/config.ts`); the pull log names skipped conversations once per run with `--verbose`.
- Docs: `docs/sources.md` config table.

## Capabilities

### New Capabilities
- `sources-slack-scope`: which Slack conversations a project's store may contain.

### Modified Capabilities
- (none)

## Impact

- `src/sources/slack/pull.ts`, `src/sources/config.ts` (+ tests), `docs/sources.md`, `docs/rollout.md` row.
- Rollout bucket 2: both keys absent = today's behaviour; tested by the existing pull tests with no config.
- Previously pulled lines of a conversation later excluded stay in raw (append-only) until a purge; a fresh tenant store (bluefin-ops) starts scoped from the first pull.
