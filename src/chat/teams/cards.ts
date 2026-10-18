// The core's views as Teams messages, pure (OpenSpec teams-chat-driver). A Teams message is
// markdown text plus, when the view carries controls, one Adaptive Card. Controls are the
// same families the core handles for Slack (`cancel_turn`, `show_trail`, `answer_q`, …) with
// the same values, so src/chat/core/ needs no Teams branch: a card action's `data` is
// `{ action, value }`, a dialog opener additionally says `msteams: { type: 'task/fetch' }`
// (Teams opens a dialog only as the answer to that invoke — driver.ts resolves it).
//
// Golden-tested: src/chat/teams/cards.test.ts pins every kind.

import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { ProjectConfig } from '../../projects.js';
import { fmtElapsed, prUrls } from '../../format.js';
import { homeBullets, plural } from '../slack/blocks.js';
import { markdownToTeams, mrkdwnToTeams, MAX_TEAMS_TEXT } from './format.js';
import { BAD_REASONS } from '../../feedback.js';
import type { Tally } from '../../feedback.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Adaptive Card JSON
export type AdaptiveCard = { type: 'AdaptiveCard'; $schema: string; version: string; body: any[]; actions?: any[] };
export interface TeamsMessage {
  text?: string; // Teams markdown
  card?: AdaptiveCard;
}

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function card(body: any[], actions?: any[]): AdaptiveCard {
  return { type: 'AdaptiveCard', $schema: SCHEMA, version: '1.5', body, ...(actions?.length ? { actions } : {}) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = (t: string, extra: Record<string, unknown> = {}): any => ({ type: 'TextBlock', text: t, wrap: true, ...extra });
const execute = (title: string, action: string, value: string) => ({ type: 'Action.Execute', title, data: { action, value } });
const dialog = (title: string, action: string, value: string) => ({
  type: 'Action.Submit',
  title,
  data: { msteams: { type: 'task/fetch' }, action, value },
});
const link = (title: string, url: string) => ({ type: 'Action.OpenUrl', title, url });

// The two rating buttons; with a tally the labels carry the per-turn count ("👍 Helped · 2"),
// which IS the click's confirmation (the card is re-rendered with it — refreshRating).
// 👍 is a plain Execute; 👎 opens the reason dialog, so it is a task/fetch opener.
const RATING_LABEL = { fb_good: '👍 Helped', fb_bad: '👎 Missed' } as const;
export function ratingActions(rate: { turnId: string; slug: string; key: string }, tally: Tally = { good: 0, bad: 0 }) {
  const value = JSON.stringify({ t: rate.turnId, s: rate.slug, k: rate.key });
  const label = (id: keyof typeof RATING_LABEL, n: number) => (n > 0 ? `${RATING_LABEL[id]} · ${n}` : RATING_LABEL[id]);
  return [execute(label('fb_good', tally.good), 'fb_good', value), dialog(label('fb_bad', tally.bad), 'fb_bad', value)];
}

// The post-answer card: everything a finished answer offers, in ONE card after the text
// (Teams keeps text and cards apart — driver.ts). `tally` re-renders it with fresh counts.
export function answerCard(v: Extract<MessageView, { kind: 'answer' }>, tally?: Tally): AdaptiveCard | undefined {
  const o = v.opts ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = [];
  const prs = prUrls(v.markdown);
  for (const url of prs.slice(0, 5)) actions.push(link(prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}`, url));
  if (o.trail && o.trail.steps > 0) actions.push(dialog('🧭 Show steps', 'show_trail', o.trail.turnId));
  if (o.ytDraft) actions.push(execute('✏️ Edit & send', 'yt_edit_send', JSON.stringify({ t: o.ytDraft.ticket, d: o.ytDraft.draftId })));
  else {
    if (o.ytReport && o.followUp) actions.push(execute('📝 Report to YouTrack', 'yt_report', JSON.stringify({ t: o.ytReport, key: o.followUp.key, channel: o.followUp.channel, threadTs: o.followUp.threadTs })));
    if (o.followUp) actions.push(execute('⚙️ Session', 'session_panel', JSON.stringify({ key: o.followUp.key, channel: o.followUp.channel, threadTs: o.followUp.threadTs })));
    if (o.rate) actions.push(...ratingActions(o.rate, tally));
  }
  if (!actions.length) return undefined;
  const body = o.trail && o.trail.steps > 0 ? [text(`🧭 ${plural(o.trail.steps, 'step')} · ${fmtElapsed(o.trail.elapsedMs)}`, { isSubtle: true, size: 'Small' })] : [];
  // Teams shows six primary actions; the rest fold into an overflow menu.
  return card(body, actions.map((a, i) => (i < 6 ? a : { ...a, mode: 'secondary' })));
}

const liveActions = (turnId: string) => [dialog('🧭 Show steps', 'show_trail', turnId), execute('✖ Cancel', 'cancel_turn', turnId)];

export function renderMessageView(v: MessageView): TeamsMessage {
  switch (v.kind) {
    case 'status':
      return { card: card([text(mrkdwnToTeams(v.line || '…'))], liveActions(v.turnId)) };
    case 'text':
      return { text: mrkdwnToTeams(v.text) };
    case 'line':
      return { text: mrkdwnToTeams(v.text) };
    case 'background':
      return {
        card: card(
          [
            text(
              `🌙 **Working in the background** — running for ${fmtElapsed(v.elapsedMs)}, longer than usual.\n\n` +
                "I'll post the answer here as a new message when it's done. **🧭 Show steps** stays live; **✖ Cancel** stops me.",
            ),
          ],
          liveActions(v.turnId),
        ),
      };
    case 'backgroundDone':
      return { text: `${mrkdwnToTeams(v.label)}\n\n🧭 ${plural(v.steps, 'step')} · ${fmtElapsed(v.elapsedMs)}` };
    case 'answer': {
      const body = markdownToTeams(v.markdown);
      const t = v.notice ? `${body}\n\n_${mrkdwnToTeams(v.notice)}_` : body;
      const c = answerCard(v);
      return c ? { text: t, card: c } : { text: t };
    }
    case 'reported':
      return { text: `✅ Reported to [${v.ticket}](${v.url}) (${v.group})\n\n${markdownToTeams(v.markdown)}` };
    case 'projectPicker':
      return {
        card: card(
          [text("Which project should I work on? _(a 1:1 chat isn't tied to a channel)_")],
          v.projects.slice(0, 20).map((p) => execute(p.slug, 'dm_pick_project', `${v.pid}:${p.slug}`)),
        ),
      };
    case 'heldAsk': {
      // agent-messaging D9: the held message with Send / Dismiss while pending (the same action ids as Slack).
      const what = v.held.kind === 'task' ? `a task for **${v.held.target}**` : `a reply to **${v.held.target}**`;
      const quoted = v.held.text.slice(0, 2500).split('\n').map((l) => `> ${l}`).join('\n');
      const head = v.state === 'pending' ? `✋ **Held for your Send:** ${what}` : v.state === 'sent' ? `✅ **Sent:** ${what}` : `🚫 **Dismissed:** ${what}`;
      const foot = v.state === 'pending' ? `_Held because ${v.held.why}. Anyone who may drive this thread can send it._` : `_${v.state === 'sent' ? 'Sent' : 'Dismissed'}${v.note ? ` — ${v.note}` : ''}_`;
      return {
        card: card(
          [text(head), text(quoted), text(foot, { isSubtle: true })],
          v.state === 'pending' ? [execute('Send', 'held_send', v.held.id), execute('Dismiss', 'held_dismiss', v.held.id)] : [],
        ),
      };
    }
    case 'autofixNotice':
      return { text: `🔧 ${v.watch.repo}#${v.watch.number}: ${v.notes.join('; ')}` };
    case 'ticketHeader':
      return { text: `🎫 [${v.ticket.id}](${v.url}) — ${v.ticket.summary}${v.extras ? `  ·  ${v.extras}` : ''}` };
    case 'ticketCard':
      return { text: `🎫 **[${v.ticket.id}](${v.url})** — ${v.ticket.summary}${v.flaggedBy ? `\n\n_flagged by ${v.flaggedBy}_` : ''}` };
    case 'question':
      return renderQuestion(v);
  }
}

function renderQuestion(v: Extract<MessageView, { kind: 'question' }>): TeamsMessage {
  if (v.done) return { text: '✅ Answered' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any[] = [text(`❓ **The agent needs your input**${v.multi ? '  _(pick one or more, then Submit)_' : ''}`)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = [];
  v.questions.forEach((q, qi) => {
    const set = v.picks.get(qi) ?? new Set<number>();
    const shown = q.options.slice(0, 6);
    body.push(text(`**${q.header ? `${q.header}: ` : ''}${q.question}**`));
    body.push(
      text(shown.map((o, oi) => `${set.has(oi) ? '✅' : '•'} **${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n\n')),
    );
    // Every option is a button of the `answer_q` family, value = indices only (label-length-safe).
    body.push({
      type: 'ActionSet',
      actions: shown.map((o, oi) => execute(o.label.slice(0, 40), 'answer_q', JSON.stringify({ qid: v.qid, qi, oi }))),
    });
  });
  if (v.multi) actions.push(execute('Submit', 'submit_q', v.qid));
  return { card: card(body, actions) };
}

// Replies only the acting person sees — Teams has no ephemeral messages, so these go to the
// person's 1:1 chat (driver.ts); here they are just text.
// One line per scheduled job, in the Slack list's vocabulary (`routineListBlocks`): the dot is
// the enabled state, dream/housekeeping show their label (and last digest) instead of a prompt,
// a task is tagged, a report has no kind at all — so the kind is never printed raw.
type RoutineLike = Extract<PrivateView, { kind: 'routines' }>['routines'][number];
function routineLine(r: RoutineLike): string {
  const dot = r.enabled ? '🟢' : '⚪️';
  const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
  if (r.kind === 'dream' || r.kind === 'housekeeping') {
    const label = r.kind === 'dream' ? '🌙 dream' : '🧹 housekeeping';
    const s = r.lastSummary ? ` — _${r.lastSummary}_` : '';
    return `- ${dot} **${r.id}** ${label} — \`${r.spec}\` (${r.tz})${last}${s}`;
  }
  const p = r.prompt.length > 90 ? `${r.prompt.slice(0, 87)}…` : r.prompt;
  const tag = r.kind === 'task' ? ' 🛠 task' : '';
  // Empty-slot skip (ROUTINE_SKIP_EMPTY): the last slot posted one line instead of a run.
  const skipped = r.lastOutcome === 'skipped' ? ' ⏭ skipped (nothing new)' : '';
  return `- ${dot} **${r.id}**${tag} — \`${r.spec}\` (${r.tz})${last}${skipped} — ${p}`;
}
const ROUTINES_MANAGE = '_Manage:_ `/routines run|off|on|rm <id>` (`run` = fire now) · `/routines all` for every project';

export function renderPrivateView(v: PrivateView): TeamsMessage {
  switch (v.kind) {
    case 'text':
      return { text: mrkdwnToTeams(v.text) };
    case 'markdown':
      return { text: `${v.title ? `**${v.title}**\n\n` : ''}${markdownToTeams(v.markdown)}${v.note ? mrkdwnToTeams(v.note) : ''}`.slice(0, MAX_TEAMS_TEXT) };
    case 'statusReport': {
      const r = v.report;
      const rows = r.projects.map(
        (p) =>
          `- **${p.slug}** — ${p.state ?? 'not created'} · ${plural(p.repos, 'repo')} · ${plural(p.sessions, 'session')} (${p.active} active)` +
          `${p.openPRs === undefined ? '' : ` · ${plural(p.openPRs, 'open PR')}`}` +
          `${p.jobs || p.dreams || p.hk ? ` · routines: ${p.jobs} jobs, ${p.dreams} dreams, ${p.hk} housekeeping` : ''}` +
          `${p.sources ? `\n  sources: ${p.sources}` : ''}`,
      );
      const flags = [`sandboxes ${r.daytonaOk ? '✅' : '⚠️'}`, `GitHub ${r.githubOk ? '✅' : '⚠️'}`, `${plural(r.turnsInFlight, 'turn')} in flight`];
      return { text: `**CoachAven status**\n\n${rows.join('\n')}\n\n${flags.join(' · ')}${r.claudeQuota ? `\n\n${mrkdwnToTeams(r.claudeQuota)}` : ''}` };
    }
    case 'access':
      return { text: `**Access for ${v.project.slug}**\n\n- repos: ${v.project.repos.join(', ')}\n- tools: ${(v.project.mcp ?? []).map((m) => m.name).join(', ') || 'none'}` };
    case 'routines':
      return {
        text: v.routines.length
          ? `**Scheduled jobs**\n\n${v.routines.map(routineLine).join('\n')}\n\n${ROUTINES_MANAGE}`
          : `_No scheduled jobs in this channel._\n\nCreate one: \`/schedule weekdays 9:00 | one-line status on open PRs and active threads\``,
      };
    case 'allRoutines':
      return {
        text: `**All scheduled jobs**\n\n${v.groups.map((g) => `**${g.slug}**\n${g.routines.map(routineLine).join('\n') || '_none_'}`).join('\n\n')}\n\n${ROUTINES_MANAGE}`,
      };
    case 'memoryIndex':
      return { text: `**Memory — ${v.slug}**\n\n${markdownToTeams(v.markdown)}${mrkdwnToTeams(v.note)}`.slice(0, MAX_TEAMS_TEXT) };
    case 'sessionPanel': {
      const i = v.info;
      const lines =
        `⚙️ **Session — ${i.slug}**\n\n- repos: ${i.repos.join(', ')}\n\n- tools: ${i.mcp?.join(', ') || 'none'}\n\n` +
        `- session: ${i.hasSession ? `since ${i.sessionSince ?? '?'}` : 'none yet'}\n\n- turn: ${i.turnInFlight ? 'running' : 'idle'}\n\n- PR: ${i.prCreated ? 'created' : 'none'}`;
      // Restart only when there is a session to forget (as on Slack); the value is the panel's own.
      return { card: card([text(lines)], i.hasSession ? [execute('🔄 Restart session', 'session_restart', v.value)] : []) };
    }
  }
}

// Dialogs (Teams task modules) — a titled card; the driver answers the opening invoke with it.
export function renderDialogView(v: DialogView): { title: string; card: AdaptiveCard } {
  switch (v.kind) {
    case 'trail': {
      const t = v.trail;
      if (!t) return { title: '🧭 Steps', card: card([text("_This turn's step-by-step trail is no longer available (I've been restarted since it ran)._")]) };
      if (!t.steps.length) return { title: '🧭 Steps', card: card([text('_No steps yet — still preparing._')]) };
      const head = `🧭 ${plural(t.steps.length, 'step')} · ${fmtElapsed(t.elapsedMs)}${t.done ? '' : ' so far'}`;
      let body = t.steps.join('\n\n');
      if (body.length > 20_000) body = `…\n\n${body.slice(-20_000)}`;
      return {
        title: '🧭 Steps',
        card: card([text(head, { isSubtle: true, size: 'Small' }), text(body), ...(t.done ? [] : [text('⏳ Still running — close and reopen to catch up.', { isSubtle: true })])]),
      };
    }
    case 'feedback':
      // A radio group, not a dropdown: the six causes are the point (feedback.ts). The submit
      // carries the dialog family and the private meta, as the Slack modal does.
      return {
        title: '👎 What went wrong?',
        card: card(
          [
            { type: 'Input.ChoiceSet', id: 'reason', style: 'expanded', isRequired: true, errorMessage: 'Pick one', choices: BAD_REASONS.map((r) => ({ title: r.label, value: r.value })) },
            { type: 'Input.Text', id: 'note', isMultiline: true, placeholder: 'Optional: what would have helped? e.g. "the file was in services/, not src/"' },
          ],
          [{ type: 'Action.Submit', title: 'Send', data: { dialog: 'feedback', meta: JSON.stringify({ t: v.meta.turnId, s: v.meta.slug, k: v.meta.key, c: v.meta.channel, ts: v.meta.ts }) } }],
        ),
      };
    case 'ticketLoading':
      return { title: v.id, card: card([text('⏳ Loading…')]) };
    case 'ticket':
      return { title: v.issue.id, card: card([text(`**[${v.issue.id}](${v.url})** — ${v.issue.summary}`), text(markdownToTeams(v.issue.description ?? '').slice(0, 20_000))]) };
    case 'ticketUnavailable':
      return { title: v.id, card: card([text(`Could not load [${v.id}](${v.url}).`)]) };
    case 'reportPrompt':
      // The generation prompt, editable; "post immediately" as a one-choice multi-select (Teams
      // has no checkbox — a multi-select ChoiceSet submits a comma-separated string, which
      // events.ts turns into the array the core expects for the fields named in `multi`).
      return {
        title: `📝 Report to ${v.ticket}`,
        card: card(
          [
            text('**Instructions for the draft** — edit before running:', { isSubtle: true }),
            { type: 'Input.Text', id: 'instructions', isMultiline: true, isRequired: true, errorMessage: 'Say what to write', value: v.prompt },
            { type: 'Input.ChoiceSet', id: 'now', isMultiSelect: true, style: 'expanded', choices: [{ title: 'Post to the ticket immediately (no review)', value: 'now' }] },
            text(`_${mrkdwnToTeams(v.contract)}_`, { isSubtle: true, size: 'Small' }),
          ],
          [{ type: 'Action.Submit', title: 'Draft the report', data: { dialog: 'yt_prompt', multi: ['now'], meta: JSON.stringify({ t: v.ticket, key: v.meta.key, channel: v.meta.channel, threadTs: v.meta.threadTs }) } }],
        ),
      };
    case 'report':
      return {
        title: `📝 Report to ${v.ticket}`,
        card: card(
          [
            text('Posted as an **internal** comment on the ticket — edit first if needed:', { isSubtle: true }),
            { type: 'Input.Text', id: 'text', isMultiline: true, isRequired: true, errorMessage: 'Nothing to post', value: v.draft.slice(0, 20_000) },
          ],
          [{ type: 'Action.Submit', title: 'Send to YouTrack', data: { dialog: 'yt_send', meta: JSON.stringify({ t: v.ticket, channel: v.meta.channel, ts: v.meta.ts, threadTs: v.meta.threadTs }) } }],
        ),
      };
    case 'reportExpired':
      return { title: `📝 Report to ${v.ticket}`, card: card([text('⌛ This draft has expired.')]) };
  }
}

// The Home card (Slack: the App Home tab), sent on personal install and on `/home`.
export function renderHomeView(v: HomeView): TeamsMessage {
  if (v.kind === 'onboarding') return { text: "👋 I'm Aven. This installation serves no projects yet — ask your operator to bind a channel." };
  const projects = v.projects.map((p: ProjectConfig) => `- **${p.slug}** — ${p.repos.join(', ')}${p.teamsChannel ? '' : ' _(no Teams channel bound yet)_'}`);
  // The shared cheat-sheet; Teams wording: commands are `@Aven /verb` in channels, `/verb` in 1:1.
  const bullets = homeBullets(v.messaging ? { messaging: true } : {}).map(mrkdwnToTeams); // `/aven verb` → `/verb` happens there
  return {
    text:
      `**Aven — your coding agent**\n\n**Projects**\n${projects.join('\n') || '_none_'}\n\n` +
      `**How to use me**\n\n${bullets.join('\n\n')}\n\n_In channels, commands are \`@Aven /verb …\`; in this chat, \`/verb …\`._`,
  };
}
