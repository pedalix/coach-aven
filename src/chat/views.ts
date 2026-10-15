// Platform-neutral view models: WHAT the core wants shown, never HOW. Each chat driver
// renders them to its own platform (the Slack driver to Block Kit via blocks.ts). Text is
// GitHub markdown as the agent wrote it; converting it is the driver's job.
//
// This file grows one PR at a time (OpenSpec chat-driver-interface): PR 1 carries the turn
// path's views; actions/dialogs/Home, commands and pollers add theirs later.

import type { AskQuestion } from '../claudeSession.js';

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

// Everything the turn engine shows. One closed union, so a driver that forgets a kind fails
// to typecheck instead of rendering nothing.
export type TurnView =
  // The live working message: one status line (phase, clock, recent steps) with the turn's
  // controls (🧭 Show steps, ✖ Cancel). `notify` is the short text platforms use for
  // notifications/fallbacks ("Working…", "In queue…", or the line itself).
  | { kind: 'status'; line: string; turnId: string; notify: string }
  // A plain message with no controls: cancel/error/recovery notices, skip notices. As an
  // update it replaces whatever the message showed before, controls included.
  | { kind: 'text'; text: string }
  // The soft deadline passed: the status freezes into a static card (controls stay).
  | { kind: 'background'; turnId: string; elapsedMs: number }
  // The background card's epitaph once the outcome was posted as a new message.
  | { kind: 'backgroundDone'; label: string; steps: number; elapsedMs: number }
  // A finished answer (or a 🔔 background update) with its decorations. `notice` is an
  // extra warning line under it (e.g. a failed YouTrack auto-post).
  | { kind: 'answer'; markdown: string; opts?: AnswerOpts; notice?: string }
  // A report the turn already posted to YouTrack on its own.
  | { kind: 'reported'; markdown: string; ticket: string; url: string; group: string }
  // An agent question with its options; `picks` = chosen option indices per question.
  | {
      kind: 'question';
      questions: AskQuestion[];
      picks: Map<number, Set<number>>;
      multi: boolean;
      qid: string;
      done: boolean;
    };
