# Chat drivers and their capabilities

One installation runs one chat driver by default (`orch slack` / `orch teams` / `orch web`), with others beside it
through `CHAT_SURFACES` ([Runtime config](runtime-config.md)). The platform-neutral core talks to every driver
through `ChatDriver` (`src/chat/driver.ts`, OpenSpec `chat-driver-interface`) and asks it what the platform can do
(`DriverCapabilities`) before promising it to people: the Home cheat-sheets pick their wording from it, and the turn
engine offers the agent an outbox only where files can be delivered.

The table is rendered from the drivers' own declarations and pinned by `src/chat/capabilities.test.ts`: a new
capability or a changed value fails the test until the table shows it (`UPDATE_SNAPSHOTS=1 npm test --
src/chat/capabilities.test.ts` rewrites it in place).

<!-- capabilities:start -->
| Capability | Slack | Teams | Web | Shadow (agent-to-agent journal) |
|---|---|---|---|---|
| Acknowledgements on the person's message (👀 / ✅ / ❌) | yes | yes | yes | no |
| Private replies (`native`: in place, only they see it; `fallback`: a direct message with a pointer in the thread) | `native` | `fallback` | `native` | `fallback` |
| Replies in a bot thread reach it only with a mention | no | no — the default (the team consented to RSC); an installation without that consent sets it to yes | no | no |
| Outbound files (the agent's outbox is posted into the thread) | yes | no | yes | no |
<!-- capabilities:end -->

What each surface does with the shared behaviours, for people: [Microsoft Teams](teams.md#what-differs-for-people-the-parity-matrix),
[Web chat](web.md#what-differs-for-people-the-parity-matrix). The shadow driver is not a surface people see: it
journals the conversation an agent here holds with another agent ([Agent messaging](agent-messaging.md)).

Outbound files — the agent's outbox, posted into the thread after its answer — are behind `OUTBOUND_FILES=1`
([Runtime config](runtime-config.md#outbound-files-outbound_files)); a driver that declares `no` is never offered
one, so on Teams the agent answers in text as before until a Teams delivery (Graph upload into the channel's
SharePoint, the 1:1 consent card) is built.
