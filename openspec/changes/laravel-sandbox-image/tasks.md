# Tasks

## 1. The shim

- [x] 1.1 The bootstrap: `composer:2`, as the caller, the working directory mounted, `COMPOSER_IGNORE_PLATFORM_REQS=1`, the arguments as typed, one stderr line that says it is not the project's PHP. Verify: `src/sailshim.test.ts` (the `docker run` argv for seven argument lists, from a nested directory too).
- [x] 1.2 `sail` as a fourth name: `vendor/bin/sail <args>` as typed; without a `vendor/bin/sail`, exit 127 and the steps, like `php` and `artisan`. Verify: `src/sailshim.test.ts` (forwarding from the checkout root and from `app/Http`; the 127 lines; nothing runs).

## 2. The image

- [x] 2.1 `ENV APP_USER=root`, and the symlink loop over the four names. Verify: `src/sailshim.test.ts`; in the built image `[ "$APP_USER" = root ]` and `command -v sail`.
- [x] 2.2 The plain image's tools in the `apk add` list. Verify: `src/sailshim.test.ts` (the plain list is a subset of the laravel list); `command -v rg python3 pip3 make unzip rsync` in the built image.
- [x] 2.3 End to end, by hand, in a sandbox started the way the driver starts one, on a real lock file of 279 packages: bootstrap, `.env`, `sail up -d`, `artisan key:generate`, `composer install` inside Sail, migrations, `npm ci`, the build, the login page. Recorded in `design.md` (Context).

## 3. CI, docs, ledger

- [x] 3.1 CI: a pull request that touches `snapshot/Dockerfile` or `snapshot/shims/` builds the laravel image for `linux/amd64` (not published) and runs the spec's tool check. Verify: the job is green on this change's pull request.
- [x] 3.2 Docs: `snapshot/README.md`, `docs/sandbox-drivers.md`, `docs/troubleshooting.md`. Verify: doclinks, the public guard.
- [x] 3.3 `docs/rollout.md`: the ledger row.
- [x] 3.4 One PR (#196); typecheck, tests, guard, gitleaks.
- [x] 3.6 The dockerd guard nests cgroups before it starts dockerd (`src/housekeeping.ts`). Verify: `src/housekeeping.test.ts`; by hand in a `--privileged` `docker:29-dind` container on a cgroup-v2 host, `docker run -m 64m alpine true` fails with the old guard and exits 0 with the new one.
- [x] 3.7 Docs: every `docker rm proj-<slug>` instruction says `-v`.
- [ ] 3.5 `image.yml` publishes `coach-aven-sandbox-laravel:sha-<commit>` (amd64) beside the bot and the plain image; `release.yml` promotes it. Verify after the merge: the `main` run publishes the tag, the package is public (`docker pull` without a login), and the next release gives it `vX.Y.Z`.

## 4. Operators

- [ ] 4.1 Each installation that runs a laravel image: move `SANDBOX_IMAGE` (or the project's `sandbox.image`) to the published tag (or to its own rebuild from the merged `snapshot/`), restart the bot, `docker rm -v` the containers that should get it (`-v`: the inner Docker's store is an anonymous volume, which a plain `docker rm` leaves on the host). Verify in a recreated sandbox: `command -v sail rg python3`, `echo $APP_USER`, and `composer install` in a fresh Laravel checkout.
- [ ] 4.2 Archive this change: the delta into `openspec/specs/sandbox-image/`; `openspec validate sandbox-image --type spec --strict` passes.
