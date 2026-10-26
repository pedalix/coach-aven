# Observability

How we watch the CoachAven **control plane** (the bot/orchestrator) — errors, performance,
logs. The heavy work runs in the project sandboxes; this is about the long-lived Node process.

## Decision: Sentry, not a dedicated Grafana pipeline

For the control plane at its current scale (low traffic, ~handful of projects), **Sentry**
covers errors + tracing + structured logs with near-zero infra, so we use it instead of
standing up an Alloy→Loki→Grafana pipeline just for the bot.

- **Grafana stays for the projects** (caldora/dorfberg workloads, infra metrics) — right tool there.
- A dedicated logs pipeline for the control plane would be overkill today; revisit only if we
  outgrow Sentry's free tier or need cross-system fleet dashboards.
- **Note:** Sentry deprecated standalone custom metrics (beta ended 2024-10) — "metrics" now
  come from **span attributes** (we aggregate trace data), not Prometheus-style counters.

### Free-tier fit
Volume is a non-issue at our scale (free: 5k errors, 5M spans, 5GB logs/mo; 30-day retention).
The real free limits are **1 user** and **email-only alerts** (no Slack alerting on free). The
bot can mirror its own errors into a Slack channel to cover the alerting gap without paying.

### Data-egress caveat
Sentry is SaaS and CoachAven handles **private repos + Slack text**, so:
- `sendDefaultPii: false`,
- secrets scrubbed from every outbound event (`beforeSend` → `scrubText`: GitHub/Slack tokens,
  JWTs, API keys),
- **structured logs are opt-in** (`SENTRY_LOGS=1`) — errors + traces (low content) flow by
  default; log *content* only ships if you turn it on.

## What's instrumented (`src/sentry.ts`)

- **Off unless `SENTRY_DSN` is set** — dev and CI run clean.
- **Errors:** the central `errText()` formatter calls `captureError(err)`, so every `/aven` /
  turn / command error becomes a Sentry issue with a stack. Fatal startup errors are captured
  in `cli.ts` (then `flushSentry()` before exit).
- **Performance:** each agent turn runs inside a `Sentry.startSpan('aven.turn')`, tagged with
  the project — so turn latency shows up in tracing.
- **Logs (opt-in):** `log.info/warn/error` forward to `Sentry.logger.*` when `SENTRY_LOGS=1`.

## Claude subscription quota

All turns run on one Claude Max plan whose 5-hour / 7-day windows are an opaque server-side
counter — the usage log (`/aven usage`) says what turns cost, not how close we are to the
wall. The CLI emits a `rate_limit_event` at the start of every turn (see
`docs/stream-json-contract.md`); `src/ratelimit.ts` parses it, one engine-wide tracker
keeps the latest state, and transitions post to `AVEN_ALERT_CHANNEL`: ⚠️ on
`allowed_warning`/`rejected` (once per window — the CLI repeats the same status every turn),
✅ once on recovery. `/aven status` (home workspace) shows the current line, e.g.
`Claude quota ✅ · 5h 12% · 7d 42% · as of 3m ago`. Percentages need a sandbox CLI that
sends `unifiedWindows`; older CLIs still yield the status and reset time.

Not wired (yet): the `GET https://api.anthropic.com/api/oauth/usage` endpoint the interactive
`/usage` command uses. It returns the same percentages on demand, but needs a token with the
`user:profile` scope — a `claude setup-token` token (what prod runs on) gets 403.

## Enabling on prod

1. Create a Sentry project (Node), get the DSN.
2. Add to the installation's `infra/<slug>/.env`: `SENTRY_DSN=…` (optionally `SENTRY_TRACES_SAMPLE_RATE`,
   `SENTRY_LOGS=1`, `SENTRY_RELEASE=vX.Y.Z`).
3. `npm run ops -- <slug> export && npm run ops -- <slug> restart`.

`SENTRY_RELEASE` ties issues to a version. It's a static env today; wiring it from the
release tag (CI) is an easy follow-up.

## Config (env)

| Var | Effect |
| --- | --- |
| `SENTRY_DSN` | enables Sentry (unset = off) |
| `SENTRY_ENVIRONMENT` | env name (default `NODE_ENV` or `production`) |
| `SENTRY_RELEASE` | version tag for issues (optional) |
| `SENTRY_TRACES_SAMPLE_RATE` | 0–1, default 1 (trace every turn at this volume) |
| `SENTRY_LOGS` | `1` to also stream structured logs (sends log content) |
