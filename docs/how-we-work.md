# How CoachAven is built and run

The working rules of this project in one place. Most are enforced by a test, a script, a CI job
or a file you can open, and the page that holds the mechanism is linked; the rest are decisions
you can read in `openspec/`. [`why.md`](why.md) is the story; this is the method.

## Invariants

Decided once, before any product was picked, and not renegotiated per feature.

- **The unit is the project.** Data, tools, prompts, memory, usage and billing are per project.
  People belong to many projects; who may drive is decided per workspace, and a workspace sees
  the projects its `workspaces` entry lists.
- **No model in the control plane.** The orchestrator and the sources daemon run deterministic
  code. Thinking happens in sandboxes, on the installation's own model credit. The bench (`src/lab/`)
  and the CLI probe may call a model on the operator's machine; production never does.
- **The orchestrator's own credentials never enter a sandbox.** Tokens are minted on the host per
  project, before every turn for GitHub (an hour) and at most daily for the gateway (a day); only
  the token enters a sandbox, never the App key or the client secret. The Claude credential and the
  MCP credentials a project declares are files inside its sandbox, so treat them as readable by
  the model. Every turn and every ingested message, ticket, transcript and activity record is
  scrubbed of secret-shaped strings first (`src/scrub.ts`).
- **The bot is a service identity.** The person asking is never the caller: the bot's tools see
  the project and the conversation, the person is recorded where they act (a rating, a Send, the
  envelope journal when it is on), and a turn's cost and the gateway's audit line join on the
  conversation. What the bot may reach is decided by the installation, its tokens, its gates and
  its gateway policy. What it does inside that reach is instruction (the git flow, the read-only
  review): Claude Code runs in the sandbox with its permission prompts off, so the reach is the
  guard.
- **Project definitions are files, not clicks.** What describes a project, its repositories,
  prompt, tools and sources, is a file in a repository, and what can be derived is rendered: the
  system prompt from three layers, project facts from scanners. What people flip at runtime, an
  auto-review, a watched pull request, a routine, who may drive, lives in `state.json`, which the
  bot owns.
- **Public mechanism, private specifics.** This repository documents and tests mechanisms under
  fictional names. Anything that names a host, a tenant, a customer or a person lives in an
  installation's private ops repo. CI enforces it (`scripts/public-guard.sh`, gitleaks).
- **Prod must not change as a side effect of a merge.** Every change is a bug fix, a
  default-preserving addition with a test, or behind a flag that is off by default and canaried
  first ([`rollout.md`](rollout.md)).
- **Learn in shadow before deciding live.** A feature that learns from people derives and shows
  first. It earns the right to hold a decision before it earns the right to make one, and it audits
  its own confident calls ([`attribution.md`](attribution.md)).

## Specs first

Shared-code work starts as an OpenSpec change in `openspec/changes/<name>/`: a proposal with a
*Why*, a spec delta with requirements and scenarios, a design, and tasks. `openspec list` shows
what is in flight; after the merge the change is archived (`openspec/changes/archive/`) and its
spec deltas are merged into `openspec/specs/`, the behaviour of record. The *Why* sections are the project's decision history; [`why.md`](why.md) and this page
are distilled from them.

Two rules keep the backlog honest.

- **A proposal names its consumer** (proposed with this page, 2026-10-17; it becomes a rule in
  `openspec/config.yaml` once adopted). Which installation runs it first, and who asked. A change
  without a consumer is a note on a direction, not a change. Implementation is cheap here;
  validated demand is not (see *Roadmap*).
- **An installation's plan records its decisions; this repository records behaviour.** An
  operator's or a client's plan lives in their ops repo; the public repo keeps the mechanism and
  its tests.

## Shipping

- **`main` is the canary.** The operator's own bot runs `main` and is restarted after every merge;
  production runs the last git tag. A tag is cut only after `main` has run on the canary for about
  two days, covering at least one full weekday cycle of routines, with no regression.
- **Three rollout buckets.** Every PR that touches shared code says which: (1) a bug fix or an
  invisible improvement, ungated, with tests; (2) default-preserving, a new key or code path whose
  default is today's shape, with a test that proves it; (3) a visible behaviour change behind a
  flag, off by default, canary first ([`rollout.md`](rollout.md)).
- **Flags are rollout stages, not switches.** Merged off, then on in the canary, then on in
  production as a deliberate step, then the default one release later, then retired. The ledger
  has a row per change with its gate (no flag has completed the whole cycle yet), and every work
  session starts by reading it and `git log <last tag>..main`.
- **Release notes are pull request titles.** Label `feature`, `fix`, `ci` or `docs`; the tag
  triggers CI (typecheck, tests, the public guard, gitleaks) and the GitHub Release. No changelog
  edits, no version bumps.
- **Installations deploy themselves.** The product repository publishes a release; an
  installation's ops repo deploys it (`npm run ops -- <slug> deploy`, or its own GitHub Action).
  The product repository holds no deploy secret for anyone.

## Tests as contracts

- **Pure logic in its own module with a test beside it.** Parsing, matching, scheduling and
  rendering never live inside a chat handler, and an import test keeps platform SDKs out of the
  core.
- **Golden fixtures for what reaches people.** The base system prompt is pinned byte-exact; Slack
  output is pinned by recorded call snapshots and Teams cards by goldens. A change to any of them is
  made on purpose and re-snapshotted ([`fixtures.md`](fixtures.md)).
- **The protocol we depend on is probed, not assumed.** The headless Claude Code stream-json
  protocol has no published schema, so every fact the bot relies on is a scenario with a verdict
  per CLI version, replayed in the test suite where a recording exists. A version bump starts
  with a probe
  ([`cli-probe.md`](cli-probe.md)).
- **Data decisions are measured.** The lab scores every variant of the ingest pipeline on the same
  units and the same gold, including a synthetic agency with exact truth; a variant reaches
  production by being ported into the deterministic layer behind an opt-in ([`lab.md`](lab.md)).
- **A twin, not a mock.** The Slack driver is exercised through a twin, the real Bolt app and
  handlers fed recorded envelopes with every Web API call recorded, and the turn path runs the
  real engine over a scripted session in place of the sandbox, so the chat side is tested end to
  end without a workspace.

## Installations

One installation is one bot process, one chat driver and one private **ops repo**, checked out at
`infra/<slug>/` of a product checkout and addressed by its slug in every command. The ops repo
holds the project registry, the prompts, the deploy target, the secrets, a Terraform root for the
Teams identity, the operator's notes, and, if the operator keeps them in Terraform, the hosts and
the gateway, there or in an infrastructure repository of their own. The
product repository holds the mechanisms those roots call (`infra/deploy/`, `infra/teams/`) and a
template for a new ops repo (`infra/deploy/ops.example/`). See [`infra/README.md`](../infra/README.md).

| In the product repository | In an ops repo |
|---|---|
| mechanisms, modules, templates, tests, docs under fictional names | hosts, tenants, ids, people, credentials, prompts with real context |
| the rollout ledger: what is in flight and why | the plan: what this installation decided, and when |
| runbooks for operations every installation has | notes on this installation's quirks |

## Who does what

| Role | Responsible for |
|---|---|
| **The product** (this repository) | the orchestrator, the chat drivers, the sandbox images, the sources store and the attribution layer, the modules and templates, the tests, the release |
| **The operator** (runs an installation) | the bot host and its service, the ops repo, secrets and their rotation, deploys and rollbacks, the sources daemon where the data lives, the MCP gateway if the installation has one, the canary before a tag |
| **The team or client** | the chat workspace and its one-time admin steps, the repositories and the GitHub App, the identities of its people, the credentials of its own systems, answers to the questions the agent asks |
| **The agent vendor** | Claude Code and the credit it runs on (a subscription token or an API key) |

The one-time admin steps, honestly:

- **Slack.** Create the app from `slack-app-manifest.json` and note two tokens. Minutes. Slack
  dials out, so the bot host needs no public endpoint.
- **Microsoft Teams.** One Entra tenant per installation; people from other organisations join it
  as guests. An Entra app registration, an Azure Bot and a Teams app package, created by the
  `infra/teams/` Terraform module under an `az login` that may create app registrations.
  Uploading the package to the organisation's catalog needs custom app upload allowed and an
  administrator with a Teams licence; the team owner consents to the app's resource-specific
  permissions when adding it; the Graph permission for channel documents (`supports_files`) needs
  one admin consent. Teams dials in, so the bot host needs a public HTTPS endpoint behind a
  reverse proxy, which Slack never needed. Hours, and a calendar slot ([`teams.md`](teams.md)).
- **GitHub.** A GitHub App with *Contents* and *Pull requests* read and write, *Checks* read and
  *Metadata* read, installed on the organisation or on the project's repositories and on the
  repositories its private packages come from, with its private key on the bot host. It is created by hand in GitHub's settings (there is no manifest for it), and
  installing it on a client's organisation needs an owner of that organisation, so for a client
  project this is the client's step. Grant less and that capability degrades with a warning in
  the log (without *Checks*, autofix cannot see CI), never a failed token. A personal token works
  for a trial.
- **Claude Code.** Exactly one credit per installation. To try it, `claude setup-token` on a Claude
  subscription: one command, and every project of the installation shares that subscription's
  limits. For a team or clients, an Anthropic API key: a console account, billing and a workspace;
  the key is billed and limited on its own, and `/aven usage` shows what it was billed at list
  prices. The sandbox can read either, so a key belongs in its own workspace with a spend limit.
- **Sandboxes.** A Docker host you own, which can be the bot host to start
  ([`sandbox-drivers.md`](sandbox-drivers.md)).

## Roadmap: a vector, not a queue

Implementation is not the constraint in this project; knowing what is worth building is. So the
roadmap sets directions, each with a "done when", and the "now" column holds only work with a
named consumer. Everything else waits for someone to ask, on purpose.

- **Reach.** Every team in its own chat, Slack or Teams, and agents that ask each other across
  installations. Done when a client installation is stood up from the templates without anyone
  having to rediscover a step.
- **Context.** The agent reads what the team reads, with exact readouts instead of guesses,
  wherever the data is allowed to live. Done when a tenant's store runs on the tenant's own
  infrastructure with the bot only forwarding calls.
- **Judgement.** Decisions with receipts: attribution that learns from people, audits itself and
  stays in shadow until it has earned a decision. Done when the loop decides live for one tenant
  with measured precision.
- **Trust.** Keys, data and decisions where a client's security reviewer expects them: tokens
  minted per turn, a gateway policy in one place, audit by identity, nothing in the sandbox that
  should not be there. Done when the gateway kit is public and canaried on a client-shaped
  installation.

Proactive work is the work that lowers the cost of the first consumer: the install path, the
documentation, a demo, the probe of a new CLI version. It never presumes which feature that
consumer will need.
