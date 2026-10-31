// The Teams Home card's cheat-sheet (OpenSpec teams-chat-driver): its own list, not the Slack App Home's with words
// swapped. Teams is a shared workspace tool like Slack — the bot is @-mentioned in a channel and answers in the reply
// chain — but it has no DMs, slash commands or Slack Connect: commands are `@CoachAven /verb` in a channel and `/verb`
// in the 1:1 chat or a reply chain, a private reply is a targeted message or the 1:1 chat, files come through
// Microsoft Graph, and the installation (not a workspace) is the unit. Written in the same mrkdwn as homeBullets
// (cards.ts renders it with mrkdwnToTeams). teamshome.test.ts keeps it in step with the Slack list.

export function teamsHomeBullets(opts: { messaging?: boolean } = {}): string[] {
  return [
    ...(opts.messaging
      ? [
          '• *Agents asking agents* — an agent configured to send can ask other agents or request work from them, in this installation or another one; the answer arrives in its own reply chain as quoted data from that agent. When a conversation holds another client\'s data, a message that would carry it elsewhere waits as a *✋ Held* card: anyone who may drive the conversation can *Send* it (once) or *Dismiss* it.',
          '• *Audit asks* — `/asks` lists the recent tasks between agents (held first, with cost), `/asks <task id>` shows a transcript, `/asks cancel <task id>` cancels one. _(Operators only.)_',
        ]
      : []),
    '• *Build / collaborate* — @-mention me with a task in a project\'s channel. I answer in the reply chain; keep replying there (no need to mention me again) and I remember the conversation.',
    '• *Quick private answer* — `@CoachAven /<your question>` in a project\'s channel: I answer you alone (a message only you see, or our 1:1 chat).',
    '• *Our 1:1 chat* — message me directly; if this installation serves several projects, I show a picker.',
    '• *Schedule a digest* — `/schedule weekdays 9:00 | what to report` in a project\'s channel posts a recurring read-only summary there; `/schedule task weekdays 19:30 | what to do` runs a job that may edit and commit as the project\'s instructions say; manage with `/routines` (`/routines all` lists every job of this installation). A routine\'s result opens a reply chain — reply there to continue with its context.',
    '• *Share files* — upload them in our 1:1 chat, paste images anywhere, or attach documents to a channel message with a word of text; I read them as part of the task. If I cannot use a file, I say which one and why. _(Voice/video not supported yet.)_',
    '• *Jot a note* — start a message with `!` and I stay out of it (no agent run).',
    '• *Stop me* — *✖ Cancel* on the status card.',
    '• *See how I got there* — *🧭 Show steps* on the status card (live) or a finished answer opens the tool-by-tool trail in a dialog.',
    "• *Background agents* — if a background subagent I started is still running when I answer, a *🔔 Background update* follows in the reply chain once it finishes. (A sandbox nobody is using may be put to sleep after a while; background work still running then ends with it.)",
    "• *Long tasks* — I won't cut a long task off: past ~15 minutes the status card turns into *🌙 Working in the background* (*🧭 Show steps* and *✖ Cancel* still work), and the answer arrives as a new message in the reply chain.",
    '• *Review a PR* — `/review <PR url or #number> [low|med|high]` posts a read-only review in the channel; `/review auto on|off [effort]` reviews new PRs automatically.',
    '• *Watch a PR* — `/autofix <PR>` pings the channel on CI failures and new reviews with a *Fix* button (`/autofix off <PR>` / `list`).',
    '• *Auto-investigate support tickets* — tag a YouTrack ticket with the agreed label and I open a reply chain in the matching project\'s channel: the ticket card (*🔍 Full ticket* for the whole thing), a read-only investigation, then a ping to the owners. Reply there to dig deeper or to have the fix implemented as a pull request, or *📝 Report to YouTrack* to post an internal comment back after you review the draft. _(Only for projects with a YouTrack mapping.)_',
    '• *What\'s here* — `/access` shows this channel\'s repos and tools.',
    '• *Inspect my context* — `/memory` shows what I have learned (`/memory <topic>`, `/memory live`, `/memory log`); `/prompt` shows my system prompt.',
    '• *Memory upkeep* — `/dream on|off` schedules (or pauses) nightly memory consolidation, `/dream on weekly sun 3:00` a weekly one; `/dream` for status, `/dream now` to run it once.',
    '• *Sandbox upkeep* — `/housekeeping on|off` schedules (or pauses) the nightly janitor; `/housekeeping` for the last run, `/housekeeping now` to run it once.',
    '• *Status* — `/status` for a live view of sandboxes, sessions and open PRs — and (operators) the Claude subscription quota, on an installation that runs on a subscription token.',
    '• *Check or restart a conversation* — *⚙️ Session* on a finished answer shows the session, repos, tools and PR, with *🔄 Restart session* to start the next message fresh.',
    '• *Tell me if it landed* — *👍 Helped* / *👎 Missed* on every answer; a thumbs-down asks what went wrong in a dialog.',
    '• *Usage* — `/usage [days]` for token, cost and turn totals per project (and per routine), plus how many answers helped and what those cost. _(Operators only.)_',
    '• *Who may drive me* — `/users` shows who may (everyone in a bound channel, by default); the operators can `restrict` to an allowlist and manage it with `allow @person` / `deny @person` (a real mention) / `open`.',
    '• *Reload config* — `/reload` re-reads the project registry without a restart; applies to new conversations. _(Operators only.)_',
    '• *Connected sources* — projects with linked mail, chat or calendar archives are pulled regularly and scrubbed before anything reaches me; ask me about a conversation or a meeting and I cite the original.',
    '• *Pasted secrets stay here* — passwords, tokens, API keys and connection strings in what you type are redacted to `[REDACTED:…]` before the model sees them. Prefer a vault reference to a pasted credential.',
  ];
}
