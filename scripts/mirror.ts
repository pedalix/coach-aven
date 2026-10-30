#!/usr/bin/env -S npx tsx
// The repo-mirror job for an installation on the systemd path: the deployer's crontab runs
//   node --import tsx scripts/mirror.ts      (from the installation directory, or with AVEN_DIR set)
// It is `orch mirror` (src/mirrorjob.ts): the list is mirrors.json in the installation directory, the
// cache mirrors/ beside it. A compose installation runs the CLI command from the image instead
// (docs/runtime-config.md → *Repo mirrors*). This file stays until the systemd path retires.
import { runMirror } from '../src/mirrorjob.js';

process.exit(await runMirror());
