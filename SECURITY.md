# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
this repository ([private vulnerability reporting](https://github.com/pedalix/coach-aven/security/advisories/new)) —
not in a public issue. You will get an acknowledgement within a few days; fixes ship as a tagged
release. There is no bug bounty.

In scope: the orchestrator (`src/`), the sandbox images (`snapshot/`), the deploy tooling
(`infra/deploy/`, `infra/teams/`). Out of scope: third-party services the bot talks to (Slack, GitHub, Anthropic)
and installations you do not operate.

What goes where, retention and the accepted risks, in one page: [`docs/security.md`](docs/security.md).

What the design assumes: the sandbox is the untrusted side (the model runs there with a
per-project, short-lived GitHub token, the Claude credential and only the MCP endpoints and
credentials the project declares); the orchestrator keeps its own long-lived secrets (the GitHub
App key, chat tokens, gateway client secret, source credentials) out of every sandbox and scrubs
every user turn and ingested document before it reaches the model (`src/scrub.ts`). A finding that crosses that boundary is the
kind we most want to hear about.

The Claude credential is readable inside the sandbox, a subscription token or an API key alike, and so is anything that
runs there (package scripts, dependencies, a client repository's tooling, text the agent reads). On an API key, use a
dedicated key in its own Anthropic workspace with a monthly spend limit ([`docs/runtime-config.md`](docs/runtime-config.md)
→ *Model credit*).
