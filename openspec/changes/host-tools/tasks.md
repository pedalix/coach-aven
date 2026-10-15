# Tasks

## 1. Control channel

- [ ] 1.1 `claudeSession.ts`: write `initialize` with `sdkMcpServers` + `sdkMcpServerConfigs` right after process start, gated per server; route `control_request{mcp_message}` to a `HostToolRouter` injected at construction; verify with the fake-stream session test (registration frame written before the first user message; a `tools/call` round trip; no registration when nothing is gated).
- [ ] 1.2 Reattach: the snapshot scan recognises a pending `mcp_message` and the session answers it with a JSON-RPC error after reattach; verify with the existing reattach test fixture extended by one pending-call snapshot.

## 2. Host tools

- [ ] 2.1 `src/hosttools.ts`: JSON-RPC handling (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, unknown method → error) and the tool table `propose`, `registry`, `routine` over narrow deps; verify with `src/hosttools.test.ts` (each tool with fake deps; spoofed project ignored; invalid record → tool error).
- [ ] 2.2 `propose` → `dispatchrun.ingest` (same validation, state, rendering, cap); ids as content hash; verify the dispatch tests still pass with the file-less entry and a repeated call is a no-op.
- [ ] 2.3 `scripts/host-tools-smoke.ts`: a real `claude` (pinned version) against the router, one `tools/list` and one `tools/call`; run on every CLI pin bump.

## 3. Sources over the channel

- [ ] 3.1 Register `sources` for projects with a `sources` block and no `sources` url entry; route to `handleMessage` with the caller's replica path; verify by the parity test (channel vs stdio over the fixture replica) and `src/sources/mcp.test.ts` for the registration rule.
- [ ] 3.2 Prompt paragraph: drop the `/data/sources` path, say the tools are served by the orchestrator; re-snapshot `src/fixtures/prompt/*.txt`.

## 4. Removal and docs

- [ ] 4.1 Remove the outbox poller, `src/hostmcp.ts`, `snapshot/plain/host-mcp.mjs`, `withOutboxMount`, `withSourcesMount`, the sources sha upload in `project.ts` and the stdio `sources` spec; `npm test` green, `scripts/public-guard.sh` clean.
- [ ] 4.2 `docs/runtime-config.md` → *Host tools* (flag, tools, caller rule); `docs/sources.md` → *Remote access* rewritten (channel by default, url override, daemon forward later); `docs/rollout.md` row (bucket 3 `HOST_TOOLS`, bucket 2 sources path); no Slack surface changes, so the Home tab is untouched (state it in the PR).

## 5. Canary

- [ ] 5.1 Home: `HOST_TOOLS=1`, restart in the window, `docker rm proj-bluefin-ops proj-owen-ops` (recreated without mounts); verify the next owen-ops and bluefin-ops briefs use `mcp__sources__*` and the session log shows both servers as in-process; one `propose` round trip with buttons; log the per-call latency of a transcript page.
