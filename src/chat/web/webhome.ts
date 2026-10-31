// The web chat's Home cheat-sheet (OpenSpec web-chat-driver): its own list, not the Slack App Home's with words
// swapped. The web is the installation's own application, not a shared workspace tool: there is nothing to mention,
// no DM picker, no Slack Connect and no workspace — a project is a room, every top-level post starts a thread, each
// person has a private conversation per project, and everyone signed in belongs to one organization. Written in the
// same mrkdwn as homeBullets (rendered by mrkdwnToHtml). webhome.test.ts keeps it in step with the Slack list: every
// `/aven <verb>` there is here as `/<verb>`, or in WEB_LACKS with the reason.
/** Slack verbs the web chat does not offer yet (web-chat-driver task 5.1), with why — the test reads this. */
export const WEB_LACKS: Record<string, string> = {
  autofix: 'the autofix watcher posts its Fix button to Slack or Teams only (web-chat-driver 5.1)',
};

export function webHomeBullets(opts: { messaging?: boolean } = {}): string[] {
  return [
    '• *Start a task* — post in a project\'s room: every top-level post starts a thread, no mention needed. Reply in the thread to continue; I remember the conversation.',
    '• *Ask privately* — each project has a 🔒 private conversation in the sidebar that only you see. Or type `/<your question>` anywhere: I answer where you are, for you alone.',
    '• *Jot a note* — start a post with `!` and I stay out of it.',
    '• *Share files* — 📎 Attach, drop or paste screenshots, PDFs, text or office documents into a post (up to 10 files); I read them as part of the task. A file I cannot use is named before anything is sent.',
    '• *Stop me* — *✖ Cancel* on any working message.',
    '• *See how I got there* — *🧭 Show steps* on a working message (live) or a finished answer opens the tool-by-tool trail.',
    "• *Long and background work* — past ~15 minutes the working message turns into *🌙 Working in the background* and the answer arrives as a new message in the thread; a background subagent that finishes after my answer posts a *🔔 Background update*.",
    '• *Review a PR* — `/review <PR url or #number> [low|med|high]` posts a read-only review in the room; `/review auto on|off [effort]` reviews new PRs automatically.',
    '• *Schedule* — `/schedule weekdays 9:00 | what to report` posts a recurring read-only summary in the room; `/schedule task weekdays 19:30 | what to do` runs a job that may edit and commit as the project\'s instructions say; `/routines` lists and manages them. A routine\'s result is a thread — reply there to continue with its context.',
    '• *What\'s here* — `/access` shows the project\'s repos and tools; `/status` the sandboxes, sessions and open PRs.',
    '• *Inspect my context* — `/memory` shows what I have learned (`/memory <topic>`, `/memory live`, `/memory log`); `/prompt` shows my system prompt.',
    '• *Upkeep* — `/dream on|off|now` for nightly memory consolidation (`/dream on weekly sun 3:00` for a weekly one), `/housekeeping on|off|now` for the nightly sandbox janitor; without an argument, the last run.',
    '• *Check or restart a thread* — *⚙️ Session* on a finished answer shows the session, repos, tools and PR, with *🔄 Restart session* to start the next message fresh.',
    '• *Tell me if it landed* — *👍 Helped* / *👎 Missed* on every answer; a thumbs-down asks what went wrong.',
    '• *Notifications* — *🔔 Notify* (once your browser allows it) shows a notification for an answer while the tab is hidden; the tab title counts new activity.',
    '• *Who may use me* — `/users`: everyone who signs in; the operators administer it.',
    '• *Operators* — `/usage [days]` for tokens, cost and turns per project and how many answers helped; `/reload` re-reads the project registry (new conversations).',
    ...(opts.messaging
      ? [
          '• *Agents asking agents* — an agent configured to send can ask other agents, here or in another installation; the answer arrives in its own thread as quoted data. A message that would carry this project\'s data elsewhere waits as a *✋ Held* card until someone *Sends* or *Dismisses* it.',
          '• *Audit asks* — `/asks` lists the recent tasks between agents (held first, with cost), `/asks <task id>` shows one, `/asks cancel <task id>` cancels it. _(Operators.)_',
        ]
      : []),
    '• *Pasted secrets stay here* — passwords, tokens and connection strings you type are redacted before the model sees them. Prefer a vault reference to a pasted credential.',
  ];
}

