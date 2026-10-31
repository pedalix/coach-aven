# Design

## Context

- `resolveSandboxOptions(input)` (`src/sandboxopts.ts`) gives `{ privileged: true, dind: true }` to a project without a block and `?? true` per missing field. `loadProjects` validates with it; five places re-read the raw block (the `docker run` flags, the dockerd guard at chat preparation and in housekeeping, the idle stop's dind answer, the prompt's Sail paragraph).
- The image is one setting, `SNAPSHOT_IMAGE` (`config.snapshot.image`), pulled before each chat preparation (`driver.ensureImage()`) and passed to `docker run`.
- `docker run` happens only when the container does not exist: an existing container keeps its flags and its image.
- Installations on 2026-10-31: prod has 11 block-less projects on a remote sysbox host; staging and home have only plain blocks on a local host.

## Decisions

### D1. Image and privilege belong to the project
- `sandbox.image` names the project's image; unset means `SANDBOX_IMAGE`.
- `sandbox.dind: true` asks for docker-in-docker and implies `privileged`.
- The installation keeps the driver, the host, the default image and the dind runtime (`sysbox-runc` or `privileged`).

The two are independent on purpose: an installation of mostly Laravel projects sets the laravel image as its default and writes `"dind": true` on each project that gets it, so privilege is visible where it applies. A mismatched pair (the laravel image without dind, the plain image with dind) fails loudly at the first command or at the dockerd guard. Labels on images to catch it earlier: not needed (the maintainer).

*Why not an installation-wide mode default (`SANDBOX_DEFAULT`, first merged)?* It hides the most dangerous setting in one global place, and the reason for it — one image per installation — goes away with `sandbox.image`.

### D2. The `SANDBOX_` names, the old ones as fallbacks
`SANDBOX_IMAGE`, `SANDBOX_HOST`, `SANDBOX_DIND_RUNTIME`; a new name wins over its old one. The old names are read so no installation breaks on upgrade, and the boot names them once. `infra/deploy/deploy.sh` reads the host under either name. The fallbacks were removed right after every operated installation renamed (2026-10-31), the maintainer's call; the release notes name the renames.

### D3. Warnings now, the flip later
Pure `privilegeWarnings` in `src/sandboxopts.ts`, logged at boot (`src/chat/root.ts`) and at `/aven reload`:
1. block-less projects, named, with the fix (`"dind": true` to keep docker-in-docker);
2. a privileged project on a local sandbox host without `SANDBOX_LOCAL_PRIVILEGED=1`.

The runtime-unset warning of the first merge is dropped: with docker-in-docker written per project, the runtime default (`privileged`) is documented, not a silent choice.

The flip (block-less = plain) is a later bucket-3 change, after prod writes `"dind": true`. It also lists containers whose flags or image differ from their project's, since `docker run` alone applies them.

### D4. Egress
Not filtered, not planned (the maintainer, 2026-10-31): one line in `docs/security.md`.

## Risks / Trade-offs

- **A changed `sandbox.image` does not reach an existing container** until it is removed. Same as the flags today; the docs say `docker rm proj-<slug>`.
- **Two names for a while.** One boot line per old name keeps it visible.
- **A large project image on first use** is pulled before chat preparation (`ensureImage`); the `/aven` command and housekeeping wake paths rely on `docker run` pulling it within its timeout, as the installation image did before.
