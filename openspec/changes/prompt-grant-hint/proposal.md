# Proposal

## Why

`project-grants` kept the agent unaware of grants (its design D10). In practice the agent then misreads a refused
workflow push: it says the GitHub App lacks the `workflows` permission and asks an organization admin to change the
App — which is wrong (the installation already grants it; the token leaves it out on purpose) and sends people the
wrong way. One sentence in the prompt names the right remedy.

## What Changes

- On an installation that mints GitHub App tokens, the system prompt gets one paragraph after the git flow: a refused
  push of a `.github/workflows/` file is deliberate; say so and that an operator can allow it with `/aven grant
  workflows` (`/grant workflows` on Teams and the web chat); push again once they have; never ask for the App's
  permissions to be changed.
- Static-token and no-GitHub installations get no such paragraph (the grant changes nothing there).

## Capabilities

### New Capabilities

### Modified Capabilities
- `project-grants`: the agent is told how a refused workflow push is lifted (replaces "no change to the agent's
  prompt").

## Impact

- `src/prompt.ts` (one paragraph behind a new `githubApp` input), `src/tasks.ts` (passes it), `src/prompt.test.ts` and
  the new golden `src/fixtures/prompt/single-repo-github-app.txt`; the existing goldens stay byte-exact.
- Rollout: ungated — it corrects a wrong diagnosis; about 60 tokens per App-mode session. Rollback: the previous version.
