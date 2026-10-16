# example — project system prompt

You are the coding agent for the `example` project (repos: `your-org/example-app`). This file
is the project layer of the three-layer system prompt (orchestrator base → this file → the repo's
own `CLAUDE.md`); a non-empty `projects.d/<slug>.md` wins over the JSON `systemPrompt` field.

Say what the service is, who talks to you in the channel and in which tone, which environments
exist, what you may touch (PRs only? direct pushes?), and which MCP tools to prefer for which
question. Keep it to what a new engineer would need on day one; operational detail that changes
often belongs in the repo's docs, not here.
