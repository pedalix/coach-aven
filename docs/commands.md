# Commands and buttons

<!-- Generated from the Home tab's cheat-sheet (homeBullets in src/chat/slack/blocks.ts) by src/commandsdoc.ts.
     Do not edit: change the cheat-sheet, then `UPDATE_SNAPSHOTS=1 npm test`. -->

What people can do with the agent, as its Home tab tells them. The examples use Slack's `/aven`; in Teams and the
web chat a command is `/<verb>` (`/aven <verb>` works too), and the web chat needs no mention: a top-level post in a
room starts a thread ([`web.md`](web.md), [`teams.md`](teams.md)). Operator settings are in
[`configuration.md`](configuration.md).

- **Build / collaborate** — @-mention me with a task in a project channel. I reply in a thread; keep replying (no need to re-mention) and I remember the conversation.
- **Quick private answer** — `/aven <question>` in a project channel. I answer privately in our DM.
- **DM me directly** — just message me in a DM; if it's not clear which project you mean, I'll show a picker.
- **Schedule a digest** — `/aven schedule weekdays 9:00 | what to report` posts a recurring read-only summary here; `/aven schedule task weekdays 19:30 | what to do` runs a job that may edit and commit as the project's instructions say; manage with `/aven routines` (`/aven routines all` lists every job across this workspace's projects). Routine results arrive as a thread — reply there to continue with the same context.
- **Share files** — drop screenshots, PDFs, or docs into a thread or DM (with or without a note) and I'll read them as part of the task; works in Slack Connect channels too. If I can't use a file, I'll reply saying which one and why. _(Voice/video not supported yet.)_
- **Jot a note** — start a message with `!` and I'll stay out of it (no agent run).
- **Stop me** — hit **✖ Cancel** on any working message.
- **See how I got there** — hit **🧭 Show steps** on a working message (live) or a finished answer for the tool-by-tool trail in a pop-up; a very long run comes condensed.
- **Background agents** — if I kick off a background subagent that's still running when I reply, I'll follow up with a new **🔔 Background update** message in the thread once it finishes. (A sandbox nobody is using may be put to sleep after a while; background work still running then ends with it.)
- **Long tasks** — if a task runs long I won't cut it off: past ~15 minutes the working message stops ticking and turns into a **🌙 Working in the background** card (**🧭 Show steps** still live, **✖ Cancel** still stops me), and the answer arrives as a **new message** in the thread when it's done.
- **Review a PR** — `/aven review <PR url or #number> [low|med|high]` posts a read-only review here (works in DMs too). `/aven review auto on|off [effort]` reviews new PRs automatically _(managed from the project's owner workspace)_.
- **Watch a PR** — `/aven autofix <PR>` pings here on CI failures / new reviews with a **Fix** button (`/aven autofix off <PR>` / `list`).
- **Auto-investigate support tickets** — tag a YouTrack ticket with the agreed label and I open a thread in the matching project channel: the ticket card (description, priority, links, files — **🔍 Full ticket** pops up the whole thing, comments included) followed by a read-only investigation, then I ping the owners. Reply in that thread to dig deeper (I keep the context) or ask me there to implement the fix and open a pull request, or hit **📝 Report to YouTrack** to post an internal comment back to the ticket — a pop-up takes your instructions (a one-liner is fine; fixed delivery rules are always appended), then the draft comes back for review/edit before posting (or tick _post immediately_ to send the answer word-for-word) (pilot; only for projects with a YouTrack mapping above). The card shows **who** flagged the ticket, and the writeup follows the ticket's own language so support can relay it — except when one of the team's own accounts applies the tag, which gets you the answer in English.
- **What's here** — `/aven access` shows this channel's repos + tools.
- **Inspect my context** — `/aven memory` shows what I've learned, with a button per topic to drill in (`/aven memory <topic>` also works, `/aven memory live` reads the sandbox now, `/aven memory log` shows snapshot history); `/aven prompt` shows my system prompt.
- **Memory upkeep** — `/aven dream on`/`off` schedules (or pauses) nightly memory consolidation, `/aven dream on weekly sun 3:00` a weekly one; `/aven dream` for status, `/aven dream now` to run it once.
- **Sandbox upkeep** — `/aven housekeeping on`/`off` schedules (or pauses) the nightly janitor (stale-worktree reap; on docker-in-docker projects also the dockerd guard and a docker prune when disk runs high); `/aven housekeeping` for the last run, `/aven housekeeping now` to run it once.
- **Status** — `/aven status` for a live view of sandboxes, sessions, open PRs — and (operators) the Claude subscription quota, on an installation that runs on a subscription token.
- **Check or restart a thread** — hit **⚙️ Session** on any finished answer for a private status card (session, repos/tools, running turn, PR) and a **🔄 Restart session** control if you want the next message to start a brand-new conversation.
- **Tell me if it landed** — every answer carries **👍 Helped** / **👎 Missed**. One click is enough; the count on the button updates so you see it registered, and a thumbs-down asks what went wrong in a short pop-up. Nothing is posted in the thread; click the other button to change your mind.
- **Usage** — `/aven usage [days]` for token/cost/turn totals per project (and per routine, for scheduled ones), plus how many answers people rated as helpful and what those cost — per-turn figures, last 30d by default; records from before the per-turn cost fix are listed separately as legacy. _(Operators' home workspace only.)_
- **Who may drive me** — `/aven users` shows this workspace's access (everyone, by default); admins can `restrict` to an allowlist and manage it with `allow @user` / `deny @user` / `open`.
- **Reload config** — `/aven reload` re-reads the project registry (projects.config.json + projects.d/*.md prompts) without a restart; applies to new sessions. _(Operators' home workspace only.)_
- **Connected sources** — projects with linked mail, chat or calendar archives are pulled every 15 minutes on the bot host and scrubbed before anything reaches me; ask me about a thread or a meeting and I cite the original.
- **Pasted secrets stay here** — passwords, tokens, API keys and connection strings in what you type are redacted to `[REDACTED:…]` before the model sees them (same secret → same tag, so I can still tell them apart). Prefer linking to a vault entry over pasting a credential; if I ask for one, give me a **reference**, not the value.

## On an installation with agent messaging

Shown when a project has a `messaging` block ([`agent-messaging.md`](agent-messaging.md)):

- **Agents asking agents** — an agent configured to send can ask other agents or request work from them, in this installation or another one; the answer arrives in its own thread as quoted data from that agent, and its trail shows when an answer folded into a running turn. When a thread holds another client's data, a message that would carry it elsewhere waits as a **✋ Held** card: anyone who may drive the thread can **Send** it (once) or **Dismiss** it.
- **Audit asks** — `/aven asks` lists the recent tasks between agents (held first, with cost), `/aven asks <task id>` shows a transcript, `/aven asks cancel <task id>` cancels one. _(Operators' home workspace only.)_
