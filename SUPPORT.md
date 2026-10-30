# Support

CoachAven is run by a single maintainer. Support is **best-effort**: there is no SLA, and the
answers come in the maintainer's working rhythm, usually within a few working days.

## Where to ask

| You have | Go to |
|---|---|
| A question: how to set it up, configure a project, read an error | [Discussions → Q&A](https://github.com/pedalix/coach-aven/discussions) |
| An idea or a use case | [Discussions → Ideas](https://github.com/pedalix/coach-aven/discussions) |
| A bug you can reproduce | [a bug report](https://github.com/pedalix/coach-aven/issues/new/choose) |
| A security problem | private reporting, see [`SECURITY.md`](SECURITY.md) — never a public issue |
| Your own installation running for you | [coachaven.com](https://coachaven.com): we can run it for you |

Before you ask, the docs index ([`docs/README.md`](docs/README.md)) and the self-host quickstart in
the [`README`](README.md) cover most setup questions.

## What helps us help you

- The CoachAven version (the release tag, or the commit of `main`) and the chat surface (Slack,
  Teams, web).
- The sandbox host (local Docker or a remote one over SSH) and the sandbox image variant.
- The log lines around the problem, with secrets removed. The bot scrubs what reaches the model,
  but not what you paste into an issue.

## Out of scope

- Installations you do not operate, and problems in third-party services (Slack, Microsoft Teams,
  GitHub, Anthropic, your Docker host).
- Debugging your project's own code: that is what the agent is for.
- Private consulting in issues. For that, see [coachaven.com](https://coachaven.com).
