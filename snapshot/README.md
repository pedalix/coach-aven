# Sandbox images

The tooling (git, gh, node, Claude Code and, in `laravel`, the Sail shims and imagemagick) is baked
into the image; the bot's `provisionTooling()` (`src/project.ts`) only tops up what the image lacks:
imagemagick where it is missing, and the Claude Code pin. Two variants, one directory per Dockerfile:

- **`laravel`** (`Dockerfile`, the historical default): `docker:28-dind` + the Sail shims in
  `shims/`, linux/amd64 only. Needs sysbox or `--privileged` on the sandbox host.
- **`plain`** (`plain/Dockerfile`): drops dockerd, builds amd64 + arm64 and runs unprivileged —
  for projects that never start containers of their own, and for arm64 hosts. Pair it with the
  project's `sandbox` block (`dind: false`, `privileged: false`; `docs/sandbox-drivers.md`).

Build and push with `build-and-push.sh` (usage and prerequisites in its header):

```bash
IMAGE=ghcr.io/<your-org>/coach-aven-sandbox-laravel ./build-and-push.sh        # laravel
IMAGE=ghcr.io/<your-org>/coach-aven-sandbox-plain   ./build-and-push.sh plain  # plain
```

The image repo is the installation's: `IMAGE` is required for a push. One exception: this repository's CI publishes
the `plain` variant of every `main` commit and release as `ghcr.io/pedalix/coach-aven-sandbox-plain:sha-<commit>` /
`:vX.Y.Z`, the same version names as the bot image, for the quickstart (`docs/quickstart.md`) and anyone whose projects
need nothing beyond its toolchain. Anything more (PHP, a database client, Sail) is an image of your own. Point
`SANDBOX_IMAGE` at the `:<gitsha>` tag the build prints, not `:latest`; the image is
deployment-wide, so a plain project lives on an instance whose fleet image is the plain variant.

The Claude Code CLI inside sandboxes is pinned by `CLAUDE_CLI_VERSION` (warm sandboxes converge in
place; `"cliVersion"` per project is the canary) — see `src/cliversion.ts`. Pin only probed versions
(`PROBED_CLI_VERSIONS`): a bump starts with `npm run cli-probe -- run --cli <version>` and its report
(`docs/cli-probe.md`). The image build refuses an unprobed version and the repo's gate test holds the
Dockerfiles' and `.env.example`'s defaults to the set; the bot itself checks only the `x.y.z` shape,
so an installation's `.env` and a project's `cliVersion` are on the operator's honour.

Why no PHP/Composer in the image: with Sail, the Laravel runtime lives in the project's own
containers at the project's own versions; bare `php`/`composer`/`artisan` are shimmed into the
Sail container.
