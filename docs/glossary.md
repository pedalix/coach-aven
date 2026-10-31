# Glossary

The words these docs use, each in a sentence or two.

- **Installation.** One running bot with its configuration and state: one directory (`AVEN_DIR`), one model credit,
  one or more chat surfaces. An agency runs one per client or one for many projects.
- **Project.** The unit of work: a slug, its repositories, its prompt, tools and sources. A channel, a Teams channel
  or a web room drives it.
- **Sandbox.** A long-running container per project, on a Docker host the installation runs, where Claude Code works.
  *Warm* means it is kept between tasks; the idle stop stops it after a while without activity, and the next turn
  wakes it.
- **Turn and session.** A turn is one message to the agent and its answer. The session is the persistent Claude Code
  conversation behind a thread, a reply chain or a private conversation.
- **Chat surface (chat driver).** Where people talk to the agent: Slack, Microsoft Teams or the web chat. An
  installation has a default surface and may add others (`CHAT_SURFACES`).
- **Routine.** A prompt the bot runs on a schedule and posts to the project's channel. A digest is read-only; a task
  may edit and commit.
- **Git flow.** `pr`: the agent works on a branch and opens a pull request. `direct`: it commits to the checkout.
- **MCP server and gateway.** An MCP server is a tool endpoint the agent can call (Grafana, Sentry, a tracker). A gateway
  is one policy-enforcing proxy in front of several of them, which hands the sandbox a short-lived token instead of the
  upstream credentials.
- **Sources and readouts** (extension). The project's mail, chat, calendar and ticket archives the bot pulls, scrubs and
  lets the agent search. A readout is a precomputed answer over them.
- **Scrubbing.** Replacing secret-shaped strings with a `[REDACTED:…]` marker before what people type, and what sources
  ingest, reaches the model.
- **Model credit.** What pays for the sandboxes' Claude Code: a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) or an
  Anthropic API key (`ANTHROPIC_API_KEY`), exactly one per installation.
- **Ops repository (overlay).** A private repository at `infra/<slug>/` holding one installation's hosts, secrets, prompts
  and project registry. This repository holds only mechanisms.
- **Canary, tag, flag ledger.** `main` runs on the maintainer's installation first. A `vX.Y.Z` tag is what production
  runs. A flag stages a change, and every flag is listed with its stage in [`rollout.md`](rollout.md).
- **Socket Mode.** The Slack connection the bot dials out on, so no public URL is needed. Teams dials in, so it needs one.
- **DinD and Sail.** Docker inside the sandbox, so that a Laravel Sail stack can run there. The plain sandbox image has none.
- **Quickstart.** The trial installation in `quickstart/`: the web chat and unprivileged local sandboxes from one
  `docker compose up` ([`quickstart.md`](quickstart.md)).
- **CoachAven and `aven`.** The product is CoachAven everywhere people read it, the agent's own voice included. Two
  names keep the short form on purpose, because renaming them would break what installations already have: the
  `/aven` command (an installed Slack slash command) and the `aven-` channel prefix (`SLACK_CHANNEL_PREFIX`).
