// Platform-neutral view models: WHAT the core wants shown, never HOW. Each chat driver
// renders them to its own platform (the Slack driver to Block Kit via blocks.ts). Text is
// GitHub markdown as the agent wrote it; converting it is the driver's job.
//
// This file grows one PR at a time (OpenSpec chat-driver-interface): the turn path's
// messages, then the interaction surface's dialogs/private replies/Home; commands and
// pollers add theirs later.

import type { AskQuestion } from '../claudeSession.js';
import type { ProjectConfig } from '../projects.js';
import type { PrWatch, RoutineRecord } from '../state.js';
import type { StoredProposal } from '../dispatch.js';
import type { YouTrackComment, YouTrackIssue } from '../youtrack.js';

// Context a completed answer needs for its follow-up buttons (Report to YouTrack, session
// panel): which conversation to enqueue a turn under, and where to post it.
export interface FollowUp {
  key: string;
  channel: string;
  threadTs?: string;
}

// The "how did I get here" affordance on a finished answer: a compact step-count/duration
// context line plus a "🧭 Show steps" button. The button carries ONLY the turnId — the trail
// itself lives in the engine's in-memory registry (events.ts fetches it on click and shows it
// ephemerally), so nothing heavy rides the message payload.
export interface TrailMeta {
  turnId: string;
  steps: number;
  elapsedMs: number;
}

// Everything a finished answer may decorate itself with. `ytReport` (the investigated ticket
// id) offers the "📝 Report to YouTrack" button; `ytDraft` marks this answer as a report
// DRAFT — it renders the "✏️ Edit & send" button instead of the usual follow-ups (a draft
// asking to be PR'd or re-reported would be noise). The draft TEXT lives server-side under
// `draftId` (turn.ts keeps it): Slack converts `markdown` blocks to `rich_text` on delivery,
// so the message's own blocks canNOT round-trip the draft — the button only carries the id.
export interface AnswerOpts {
  followUp?: FollowUp;
  trail?: TrailMeta;
  ytReport?: string;
  ytDraft?: { ticket: string; draftId: string };
  // Present on the messages a person is allowed to rate: a turn's answer, and any
  // background update belonging to it. Everything else a turn posts (status card, skip
  // notices, agent questions, ticket drafts) deliberately carries no rating control, so a
  // person has exactly one verdict to give per turn — see feedback.ts.
  rate?: RateMeta;
}

// What a rating click has to carry back: the turn it judges, plus the project and
// conversation key the record is attributed to. Rides in the button value as JSON.
export interface RateMeta {
  turnId: string;
  slug: string;
  key: string;
}

// Every message the core posts or rewrites in a conversation. One closed union, so a driver
// that forgets a kind fails to typecheck instead of rendering nothing.
export type MessageView =
  // The live working message: one status line (phase, clock, recent steps) with the turn's
  // controls (🧭 Show steps, ✖ Cancel). `notify` is the short text platforms use for
  // notifications/fallbacks ("Working…", "In queue…", or the line itself).
  | { kind: 'status'; line: string; turnId: string; notify: string }
  // A plain message with no controls: cancel/error/recovery notices, skip notices. As an
  // update it replaces whatever the message showed before, controls included.
  | { kind: 'text'; text: string }
  // A one-line headline the bot keeps rewriting (a routine's or a dispatched task's parent).
  // As an update it changes only the text — the message never had any layout to clear.
  | { kind: 'line'; text: string }
  // A dispatch proposal, with Send/Dismiss while pending and its outcome once decided.
  | { kind: 'proposal'; proposal: StoredProposal }
  // A message relayed on another project's behalf (an approved dispatch `message`), with its
  // provenance line (`by`: who approved it).
  | { kind: 'relayed'; text: string; from: string; by: string }
  // PR feedback on a watched PR (CI, reviews) with the 🔧 Fix control.
  | { kind: 'autofixNotice'; watch: PrWatch; notes: string[] }
  // A support ticket's one-line thread header, and the card that opens its thread.
  | { kind: 'ticketHeader'; ticket: YouTrackIssue; url: string; extras: string }
  | { kind: 'ticketCard'; ticket: YouTrackIssue; url: string; attachmentNames: string[]; flaggedBy?: string }
  // The soft deadline passed: the status freezes into a static card (controls stay).
  | { kind: 'background'; turnId: string; elapsedMs: number }
  // The background card's epitaph once the outcome was posted as a new message.
  | { kind: 'backgroundDone'; label: string; steps: number; elapsedMs: number }
  // A finished answer (or a 🔔 background update) with its decorations. `notice` is an
  // extra warning line under it (e.g. a failed YouTrack auto-post).
  | { kind: 'answer'; markdown: string; opts?: AnswerOpts; notice?: string }
  // A report the turn already posted to YouTrack on its own.
  | { kind: 'reported'; markdown: string; ticket: string; url: string; group: string }
  // A DM with no project hint: pick one of these (`pid` = the parked question).
  | { kind: 'projectPicker'; pid: string; projects: ProjectConfig[] }
  // An agent question with its options; `picks` = chosen option indices per question;
  // `done` renders the answered summary without controls.
  | {
      kind: 'question';
      questions: AskQuestion[];
      picks: Map<number, Set<number>>;
      multi: boolean;
      qid: string;
      done: boolean;
    };

// The "⚙️ Session" status card for one conversation.
export interface SessionPanelInfo {
  slug: string;
  repos: string[];
  mcp?: string[]; // MCP tool names
  hasSession: boolean;
  sessionSince?: string; // ChatRecord.updatedAt, ISO
  turnInFlight: boolean;
  prCreated: boolean;
}

// The `/aven status` report.
export interface ProjectStatus {
  slug: string;
  repos: number;
  state?: string; // Daytona sandbox state; undefined = sandbox never created
  sessions: number; // conversations bound to this project in state.json
  active: number; // conversations with a turn in flight right now
  openPRs?: number; // undefined = couldn't be determined
  jobs: number; // scheduled report routines
  dreams: number; // scheduled dream routines
  hk: number; // scheduled housekeeping routines
  sources?: string; // sources/sync.ts statusLine for projects with a `sources` block
}
export interface StatusReport {
  projects: ProjectStatus[];
  turnsInFlight: number;
  daytonaOk: boolean;
  githubOk: boolean;
  // Subscription quota line (ratelimit.ts) — operator info about OUR one Claude plan, so
  // only the home workspace's report carries it.
  claudeQuota?: string;
}

// Replies only the acting person sees (Slack: ephemeral).
export type PrivateView =
  | { kind: 'text'; text: string }
  // Agent-written markdown shown as-is (an answer, a memory file, a system prompt), with an
  // optional bold title line and a trailing note.
  | { kind: 'markdown'; markdown: string; title?: string; note?: string }
  | { kind: 'statusReport'; report: StatusReport }
  | { kind: 'access'; project: ProjectConfig }
  | { kind: 'routines'; routines: RoutineRecord[] }
  | { kind: 'allRoutines'; groups: { slug: string; routines: RoutineRecord[] }[] }
  // The memory index with a drill-down control per topic it links.
  | { kind: 'memoryIndex'; slug: string; markdown: string; note: string; topics: { title: string; file: string }[] }
  // `value` is the panel's own control payload (the conversation it describes), echoed by
  // its 🔄 Restart session button.
  | { kind: 'sessionPanel'; info: SessionPanelInfo; value: string };

// Pop-up dialogs (Slack: modals). Opened from a click; some are swapped in place once data
// arrives (ticket: loading → ticket | unavailable).
export type DialogView =
  | { kind: 'trail'; trail: { steps: string[]; elapsedMs: number; done: boolean } | undefined }
  | { kind: 'feedback'; meta: { turnId: string; slug: string; key: string; channel?: string; ts?: string } }
  | { kind: 'ticketLoading'; id: string }
  | { kind: 'ticket'; issue: YouTrackIssue; url: string; comments: YouTrackComment[]; attachmentNames: string[] }
  | { kind: 'ticketUnavailable'; id: string; url: string }
  // The report prompt the user may edit before the draft turn runs.
  | {
      kind: 'reportPrompt';
      ticket: string;
      prompt: string;
      contract: string;
      meta: { key: string; channel: string; threadTs?: string };
    }
  // A report draft, editable before it is posted to the ticket.
  | { kind: 'report'; ticket: string; draft: string; meta: { channel: string; ts: string; threadTs?: string } }
  | { kind: 'reportExpired'; ticket: string };

// The per-person home surface (Slack: the App Home tab). `projects` are the viewer tenant's;
// `prefix` is that tenant's channel-name wildcard. No projects → the onboarding view.
export type HomeView = { kind: 'home'; projects: ProjectConfig[]; prefix: string } | { kind: 'onboarding' };
