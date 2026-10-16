# Security

Please report vulnerabilities privately to **owen@coachaven.com** — not in a public issue.
You will get an acknowledgement within a few days; fixes ship as a tagged release. There is no
bug bounty.

In scope: the orchestrator (`src/`), the sandbox images (`snapshot/`), the deploy tooling
(`infra/deploy/`, `infra/teams/`). Out of scope: third-party services the bot talks to (Slack, GitHub, Daytona,
Anthropic) and installations you do not operate.

What the design assumes: the sandbox is the untrusted side (the model runs there with a
per-project, short-lived GitHub token and only the MCP endpoints the project declares); the
orchestrator holds the long-lived secrets and scrubs every user turn and ingested document
before it reaches the model (`src/scrub.ts`). A finding that crosses that boundary is the
kind we most want to hear about.
