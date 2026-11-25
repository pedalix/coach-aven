## 1. Settings

- [ ] 1.1 `src/config.ts`: `SANDBOX_LIMIT_MEMORY` → bytes, `SANDBOX_LIMIT_CPUS` → nano-CPUs, on `cfg.sshDocker`; a bad value stops the boot naming the setting and the value — `src/config.test.ts`
- [ ] 1.2 The parsing is a pure function (sizes `512m`, `6g`, plain bytes; CPUs `4`, `0.5`; rejects `0`, negatives, words) — tested

## 2. The driver

- [ ] 2.1 `ensureSandboxScript`: with a setting set, `docker run` gets `--memory X --memory-swap X` and/or `--cpus N` — `src/sshdocker.test.ts`
- [ ] 2.2 After a started container: compare `HostConfig.Memory` / `NanoCpus`, `docker update` only when they differ; a failed update prints `limits=failed …` and does not fail the script — `src/sshdocker.test.ts`, and a run of the generated script against a fake `docker` on PATH
- [ ] 2.3 The driver logs a warning with the project on `limits=failed`
- [ ] 2.4 With both settings unset the generated script equals today's byte for byte — a test with the current script as the fixture

## 3. Docs

- [ ] 3.1 `docs/configuration.md`: the two settings; `docs/sandbox-drivers.md`: the item leaves *Not yet done*, a short section on sizing (limits cap, they do not reserve)
- [ ] 3.2 `npm run typecheck`, `npm test`, `openspec validate sandbox-limits --strict`, `openspec validate sandbox-drivers --type spec --strict` after the archive

## 4. After the merge

- [ ] 4.1 Probe `docker update` on a RUNNING container under sysbox on a canary host (the cgroup's `memory.max` and `cpu.max` change)
- [ ] 4.2 Set the two values on the first installation in its ops repository, on the maintainer's word; confirm every container carries them after its next prepare
