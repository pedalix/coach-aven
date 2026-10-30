# Documentation

Start here, then go by what you are doing. Mechanisms only: anything that names a host, a tenant
or a person lives in an installation's private ops repo (`infra/<slug>/`).

## Start here

- [Why CoachAven](why.md): who it is for, what it does differently, what it is not.
- [How it is built and run](how-we-work.md): invariants, specs first, canary then tag, who does what.
- [Troubleshooting](troubleshooting.md): by symptom — the bot does not start, does not answer, the first turn fails.
- [Security: what goes where](security.md): the data flow, what a sandbox can reach, retention, accepted risks.
- [Try it on one machine](quickstart.md): the web chat and local sandboxes from one `docker compose up`, measured.
- [Self-host quickstart](../README.md#self-host-with-slack-or-teams): what you need and the six steps.
- [Security policy](../SECURITY.md) and [contributing](../CONTRIBUTING.md); licence Apache-2.0.

## What the agent can do

- [PR review and autofix](pr-review.md).
- [Project memory](memory.md).
- [Sources](sources.md): mail, chat, calendars and trackers into a scrubbed store the agent queries.
- [Attribution](attribution.md): which client and initiative a call, message or ticket belongs to;
  rules first, a model second, people's answers as the evidence.
- [Multi-workspace installs](multitenancy.md#enabling-multi-workspace-installs-operator-steps).

## Run an installation

- [`infra/README.md`](../infra/README.md): one installation = one ops repo at `infra/<slug>/`.
- [`infra/deploy/README.md`](../infra/deploy/README.md): deploy onto a plain Linux host; the ops repo template.
- [Runtime config](runtime-config.md): `.env`, `projects.config.json`, prompts, MCP, the gateway, flags.
- [Sandbox drivers](sandbox-drivers.md): containers on a Docker host you own; the driver seam.
- [Sandbox images](../snapshot/README.md): the `laravel` and `plain` variants, the build, the Claude Code CLI pin.
- [Microsoft Teams](teams.md) and [Teams pitfalls](teams-pitfalls.md): the second chat driver.
- [Local dev](local-dev.md): running beside a production bot without colliding with it.
- [Rollout ledger](rollout.md): `main` → canary → prod, and the flags in flight.
- [Observability](observability.md) and [Housekeeping](housekeeping.md).

## Under the hood

- [The stream-json contract](stream-json-contract.md) and the [CLI probe](cli-probe.md).
- [Fixtures](fixtures.md): the recorded snapshots and goldens.
- [Project facts](project-facts.md): derived, machine-written state with provenance.
- [Contributor guide](../CLAUDE.md): commands, conventions, where things live in `src/`; the rules
  for a PR are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- [The lab](lab.md): the bench for the ingest pipeline.
- `openspec/specs/`: the behaviour of record. `openspec list`: what is in flight.
