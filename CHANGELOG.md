# Changelog

All notable changes to CoachAven are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by tagging `vX.Y.Z` on `main` — the
[Release & Deploy workflow](.github/workflows/release.yml) turns the matching section
below into the GitHub Release notes and deploys to prod. Before tagging, move the
`Unreleased` notes into a new dated version section and bump `version` in `package.json`.

## [Unreleased]

## [0.2.0] - 2026-06-26

### Added
- **PR buttons in Slack answers.** Answers are scanned for GitHub PR URLs and surface
  them as clickable **🔗 View PR** buttons. When a turn makes changes but opens no PR, an
  **🔀 Open a PR** button enqueues a follow-up turn that branches, commits, pushes, and PRs.
- **Slack ↔ PR traceability.** For channel threads, the bot resolves the thread permalink
  and weaves it into the agent's system prompt so PR descriptions link back to the Slack
  discussion.
- **App Home tab.** A self-documenting dashboard listing every project, its channel and
  repos, plus a usage cheat-sheet — self-serve onboarding without reading the README.
- **CI/CD release pipeline.** Tag-triggered GitHub Actions workflow that typechecks,
  publishes a GitHub Release from this changelog, and deploys to the prod box over SSH.

### Changed
- `infra/prod/deploy.sh` splits its SSH preflight so day-2 ops (`export`/`import`/`deploy`)
  require only the **deployer** key; root is checked only for `install`/`down`. This lets
  CI deploy without ever holding a root credential.
- Slack app manifest enables the App Home tab and subscribes to `app_home_opened`.
  **Manual step on deploy:** re-apply the manifest to the prod (and dev) Slack apps.
