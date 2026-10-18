# Why CoachAven

CoachAven is a coding agent for teams that run many projects for many people: digital agencies
with a dozen client codebases, and small SaaS companies where the same five engineers carry the
product, the support inbox and the on-call phone. It lives where those teams already talk, Slack
today and Microsoft Teams in canary, one agent per project, and it works the way a careful
colleague would: it reads the repositories, the tickets and the conversation, runs the build and
the tests in its own sandbox, and opens a pull request for the team to review.

It is open source (Apache-2.0) and self-hosted: one Node process you run, sandboxes on a Docker
host you own, your Slack or Teams app, your GitHub App, your own Claude Code subscription. One
person maintains it and runs it for real installations.

This page is the story: who it is for, what problem it solves, how it is built and why that shape,
and what it is not. The mechanism behind every claim is in the rest of `docs/` (index:
[`docs/README.md`](README.md)); the behaviour of record is in `openspec/specs/`.

## Who it is for

- **Agencies.** Twelve client projects, three stacks, people who belong to several projects at
  once, and hours that have to land on the right initiative to be billed. The agent has to respect
  the boundary between clients, know which channel belongs to which codebase, and tell the owner
  at the end of the day what the day was spent on, with the receipts.
- **Small SaaS teams.** One product, a support inbox, an error tracker, a ticket tracker, a deploy
  a day. The agent has to answer "why did this error spike?" with the actual trace, investigate a
  ticket, review a pull request as it opens, and do all of it from inside the team's chat without
  a new tool to learn.

Both share a shape: the **project** is the unit of work, data and access, and the people around it
are many-to-many. CoachAven is built around that unit.

## The problem

A coding agent that only sees a repository is a bright junior with amnesia. Most of what a project
*is* lives elsewhere: in the client channel where the decision was made, in the mail thread with the
specification, in the tracker, in the calendar, in the monitoring. The moment an agent is allowed to
see those things, three questions decide whether a team can use it at all:

1. **Whose keys.** Which credentials does the agent hold, who can read them, and what happens when
   the model is talked into printing them.
2. **Whose data.** Which client's mail and chat may the agent read, where does that copy live, and
   who decides what it may learn from it.
3. **Whose decision.** When the agent attributes an hour to a client, closes a ticket or writes to
   a production system, did a person decide, or did the model?

Most agent products answer those with "trust us". CoachAven answers them with architecture, and
this page says where a rule is enforced by a mechanism and where it is a rule the prompt carries.

## What it is

```
 Slack / Teams ⇄ chat driver
       │
 orchestrator   one Node process, no model calls of its own
       │        (state, routines, pollers, the scrubbed store, the tokens)
       ▼
 one warm sandbox per project   a persistent Claude Code process, a git worktree per task,
                                the project's MCP (Model Context Protocol) tools,
                                the team's own Claude subscription
```

- **The control plane holds no model.** The orchestrator is deterministic code: it binds channels
  to projects, queues turns, mints tokens, runs the schedule and keeps the journals (queue, usage,
  drafts). Every piece of thinking happens inside a sandbox, with the team's own Claude Code and
  subscription. The agent is yours; CoachAven is the harness.
- **One sandbox per project, one worktree per task.** The agent works like an engineer with a
  checkout: a branch per task, builds and tests in its own containers, a pull request at the end.
  `pr` is the default git flow: the prompt forks a branch and opens a pull request. The project's
  token can push, so protect the default branch on GitHub with required reviews; then "people
  merge" is a rule GitHub enforces, not the model.
- **Long-lived secrets never reach the model.** What enters a sandbox is short-lived and scoped:
  the GitHub token is minted for the project's repositories only, fresh before every turn and good
  for an hour; a gateway token is minted on the host at most once a day and
  only the token enters the sandbox; every user turn and every ingested message, ticket, transcript
  and activity record is scrubbed of secret-shaped strings before the model sees it.
- **The project is the unit.** Channels bind to projects; the system prompt has three layers (the
  orchestrator base, the project's own prompt, the repository's `CLAUDE.md`); memory, the data
  store, usage and access are per project.
- **The bot is a service identity.** The person asking is never the caller: the bot's tools see
  the project and the conversation, and the person is recorded where they act, a rating, a Send,
  the envelope journal when it is on. Who may drive the bot is open inside a bound channel by
  default, with an allow-list per workspace the moment a client wants one (`/aven users`); what
  the bot may reach is decided by the installation, and inside that reach the sandbox runs Claude
  Code with its permission prompts off, so the reach is the guard.

## What is different

**It reads what the team reads.** A project can declare *sources*: mail, chat, calendars, trackers,
recorded calls, and the owner's own machine (its git repositories and coding sessions). The
orchestrator pulls them with credentials the sandbox never sees, scrubs them and builds a store
the agent queries through a tool. On top of the raw store sit *readouts* that answer exactly what
the model would otherwise guess: which inbound messages have no reply after N hours, which tickets
have not moved for N days, what the owner promised in last week's calls. The store runs as a
daemon wherever the data is allowed to live, the owner's laptop or the client's VM, and the bot
only forwards the agent's calls. ([`sources.md`](sources.md))

**It learns from people, and shows its work.** For an agency the day has to end with hours on
*initiatives*, a client's billable lines of work as the agency's own registry names them. The
attribution layer, which decides which initiative each call, message run and work block belongs
to, lets rules decide what rules can decide, lets the model propose the rest, and ranks a few
questions a day for the owner (the review that asks them and records the answers is the canary
tenant's own tooling today; the platform path is OpenSpec `attribution-answers`, in flight);
every decision is a line in the attribution ledger with who decided, by which rule or guess, and
how sure. The learning loop runs in *shadow* first: it derives and
shows, and the timelog stays the same until the loop has earned the right to decide, while it
audits its own confident calls against the owner's answers. The bench that measures it runs on a
synthetic agency with exact truth, so a change to the pipeline is argued with numbers.
([`attribution.md`](attribution.md), [`lab.md`](lab.md))

**Tools under one policy.** The agent reaches a project's systems, monitoring, error tracking, the
ticket tracker, a read-only database, through MCP. An installation can put an MCP gateway in front
of them: one route per project, one policy that says which identity may call which tool, an audit
line per call that joins the gateway's log to the bot's own, and upstream credentials that never
leave the gateway host. In the operator's gateway, people reach the same route with their own identities. The gateway
itself is not in this repository today: you bring one (the operator runs an agentgateway behind
an OAuth2 client per project). What ships here is the bot's side of the
contract: the `gateway-m2m` entry, a token minted on the host, the session header that joins the
two audit logs. A reusable kit is on the roadmap. ([`runtime-config.md`](runtime-config.md),
*MCP gateway*)

**It runs on a schedule and on events.** Routines fire on a schedule into the project's channel,
a morning brief, an evening close, a review, and, behind a flag the canary runs today, skip the
whole turn when nothing changed since the last one. Pull requests get a review in the project's
channel as they open, once the channel turns it on, a summary in chat at the effort the team set,
never a comment or an approval on GitHub (read-only by prompt framing, not by a token scope), and
a watched pull request offers a fix when CI fails. A support ticket labelled for the bot in
YouTrack gets its card and a read-only investigation in the channel, with the findings offered
back as a draft internal comment nobody sees until a person sends it. A nightly janitor, switched
on per project, keeps the sandboxes healthy. Every
turn's tokens and cost are attributed to its project (`/aven usage`), so an agency can see what
each client costs. The headless Claude Code protocol everything depends on is probed per CLI
version with recorded verdicts, so a version bump is a measured step.
([`pr-review.md`](pr-review.md), [`housekeeping.md`](housekeeping.md), [`cli-probe.md`](cli-probe.md))

**Agents that ask each other** (in flight). An owner's own planning agent, a project whose subject
is a person rather than a client, can ask the project agents of other installations and get the
answer back into its own turn, end-to-end encrypted through a relay that cannot read the
envelopes, with the answering side kept out of the chat. Planned as the OpenSpec change
`agent-messaging`; `openspec/changes/` holds the spec-first proposals this repository plans its
work in.

## A day with it: an agency

Names and numbers below are fictional.

Owen works with Bluefin, an agency with six client projects. Each project has a channel; each
channel has its agent.

- **08:30.** The brief lands in Owen's channel: what came in overnight across the client stores,
  which messages addressed to Bluefin have no reply, which tickets are stale. A quiet slot, nothing
  new in any client's mail or chat and nothing due, costs no model turn (a flag the canary runs
  today).
- **During the day** a developer asks the `caldora` agent why the orders dropped yesterday; the
  agent reads the dashboard and the error trace through the gateway with the bot's own identity,
  not the developer's, and answers with the links. A ticket labelled for the bot in YouTrack gets
  an investigation card in the channel; the fix is one ask away in the same thread and comes back
  as a pull request.
- **18:30.** The close: the day's calls, message runs and work blocks are cut into fragments and
  attributed to initiatives. The attribution ledger keeps every decision. The timelog, minutes per
  day and initiative, is a readout over it, and the basis of billing.
- **19:30.** The review asks Owen three questions: two escalations the rules could not decide and
  one audit of a decision the loop was sure about. His answers become evidence lines. Tomorrow's
  timelog is the same whether the loop is on or off, until the loop has proven itself.

This is the operator's own day today. It needs the project's sources (mail, chat, calendar, call
recorders), a daemon where that data may live, and a registry of initiatives and people in a
private tenant repository; the learning part runs in shadow on one installation, and the review
that asks the questions and writes the answers back is that tenant's own tooling until the
platform path (OpenSpec `attribution-answers`) lands.

## A day with it: a SaaS team

Halden is a five-person product company. One project, one channel, one agent.

- A pull request opens; the agent posts a review in the project's channel at the effort the team
  set, a summary in chat, nothing written to GitHub.
- A support mail with a stack trace is pasted into the channel; the agent finds the error-tracker
  issue and the commit that introduced it, and opens a fix on a branch.
- The on-call engineer asks "what changed in the 14:00 deploy?" and gets the diff and the CI run.
- A weekly routine, a prompt on a schedule, posts on Monday what moved in the tracker and what the
  agent fixed.

## What it is not

- **Not a hosted service.** You run it: one Node process on a small VM, sandboxes on a Docker host
  you own or a self-hosted Daytona (a sandbox service), your Slack or Teams app, your GitHub App,
  your Claude Code subscription. A single operator maintains the product and runs installations
  for real users; support is best-effort ([`CONTRIBUTING.md`](../CONTRIBUTING.md)).
- **Not a chat of its own.** It lives in Slack or Teams. A web chat was designed and deliberately
  not built (OpenSpec `web-chat-driver`); for a trial, Slack in your own workspace is the way in.
- **Not autonomous deployment.** The agent opens pull requests; people merge. The bot's own side
  effects, a dispatch to another project, a fix on a pull request, a comment back to the tracker,
  wait for a person's button (dispatch is off by default). Inside its sandbox the agent runs
  Claude Code with its permission prompts off; the prompt tells it to ask, with buttons in the
  chat, before anything risky, and the hard limits sit outside the sandbox: a per-project token
  whose pushes and merges stop at your branch protection, and the MCP tools the project declares
  with whatever access the installation gave them.
- **Not a model.** Claude Code does the thinking, under a Claude Max subscription token
  (`claude setup-token`; there is no API-key mode today) whose rate limits every project of the
  installation shares.

## Status

Two installations run it for real users on Slack, one of them with client projects and a sources
daemon; a staging installation runs the Teams driver, in canary. The attribution loop runs
in shadow on the operator's own tenant. `main` is the canary and production runs the last tag;
what is in flight is `openspec list` and the rollout ledger in [`rollout.md`](rollout.md). The
repository is public under Apache-2.0 with fictional names only; everything that names a host, a
tenant or a person lives in an installation's private ops repo ([`how-we-work.md`](how-we-work.md)).

## Try it

A Slack workspace you can create apps in, a GitHub App (a personal token for a trial), a Claude
Code token and a Docker host: the six steps are the README's
[self-host quickstart](../README.md#self-host-quickstart). The one-time admin steps and how long
each takes are in [`how-we-work.md`](how-we-work.md), *Who does what*. Questions and feature
requests: open an issue. Vulnerabilities: [`SECURITY.md`](../SECURITY.md).
