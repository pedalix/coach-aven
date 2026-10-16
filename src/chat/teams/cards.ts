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
import { proposalText } from '../../dispatch.js';
import { markdownToTeams, mrkdwnToTeams, MAX_TEAMS_TEXT } from './format.js';

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
      const o = v.opts ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actions: any[] = [];
      const prs = prUrls(v.markdown);
      for (const [i, url] of prs.slice(0, 5).entries()) actions.push(link(prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}`, url));
      if (o.trail && o.trail.steps > 0) actions.push(dialog('🧭 Show steps', 'show_trail', o.trail.turnId));
      if (o.ytDraft) actions.push(execute('✏️ Edit & send', 'yt_edit_send', JSON.stringify({ t: o.ytDraft.ticket, d: o.ytDraft.draftId })));
      else if (o.ytReport && o.followUp) actions.push(execute('📝 Report to YouTrack', 'yt_report', JSON.stringify({ t: o.ytReport, key: o.followUp.key, channel: o.followUp.channel, threadTs: o.followUp.threadTs })));
      const body2 = o.trail && o.trail.steps > 0 ? [text(`🧭 ${plural(o.trail.steps, 'step')} · ${fmtElapsed(o.trail.elapsedMs)}`, { isSubtle: true, size: 'Small' })] : [];
      return actions.length ? { text: t, card: card(body2, actions) } : { text: t };
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
    case 'proposal':
      return { text: mrkdwnToTeams(proposalText(v.proposal)) };
    case 'relayed':
      return { text: `${mrkdwnToTeams(v.text)}\n\n_proposed by **${v.from}** · ${mrkdwnToTeams(v.by)}_` };
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
      return { text: `**Scheduled jobs**\n\n${v.routines.map((r) => `- ${r.id} · ${r.kind} · ${r.spec}${r.enabled ? '' : ' (paused)'} — ${r.prompt.slice(0, 80)}`).join('\n') || '_none_'}` };
    case 'allRoutines':
      return {
        text: `**All scheduled jobs**\n\n${v.groups.map((g) => `**${g.slug}**\n${g.routines.map((r) => `- ${r.id} · ${r.kind} · ${r.spec}${r.enabled ? '' : ' (paused)'}`).join('\n') || '_none_'}`).join('\n\n')}`,
      };
    case 'memoryIndex':
      return { text: `**Memory — ${v.slug}**\n\n${markdownToTeams(v.markdown)}${mrkdwnToTeams(v.note)}`.slice(0, MAX_TEAMS_TEXT) };
    case 'sessionPanel': {
      const i = v.info;
      return {
        text:
          `⚙️ **Session — ${i.slug}**\n\n- repos: ${i.repos.join(', ')}\n- tools: ${i.mcp?.join(', ') || 'none'}\n` +
          `- session: ${i.hasSession ? `since ${i.sessionSince ?? '?'}` : 'none yet'}\n- turn: ${i.turnInFlight ? 'running' : 'idle'}\n- PR: ${i.prCreated ? 'created' : 'none'}`,
      };
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
      return { title: '👎 What went wrong?', card: card([text('_Feedback dialogs arrive with the next Teams release._')]) };
    case 'ticketLoading':
      return { title: v.id, card: card([text('⏳ Loading…')]) };
    case 'ticket':
      return { title: v.issue.id, card: card([text(`**[${v.issue.id}](${v.url})** — ${v.issue.summary}`), text(markdownToTeams(v.issue.description ?? '').slice(0, 20_000))]) };
    case 'ticketUnavailable':
      return { title: v.id, card: card([text(`Could not load [${v.id}](${v.url}).`)]) };
    case 'reportPrompt':
      return { title: `📝 Report to ${v.ticket}`, card: card([text('_Report dialogs arrive with the next Teams release._')]) };
    case 'report':
      return { title: `📝 Report to ${v.ticket}`, card: card([text(markdownToTeams(v.draft).slice(0, 20_000))]) };
    case 'reportExpired':
      return { title: `📝 Report to ${v.ticket}`, card: card([text('⌛ This draft has expired.')]) };
  }
}

// The Home card (Slack: the App Home tab), sent on personal install and on `/home`.
export function renderHomeView(v: HomeView): TeamsMessage {
  if (v.kind === 'onboarding') return { text: "👋 I'm Aven. This installation serves no projects yet — ask your operator to bind a channel." };
  const projects = v.projects.map((p: ProjectConfig) => `- **${p.slug}** — ${p.repos.join(', ')}${p.teamsChannel ? '' : ' _(no Teams channel bound yet)_'}`);
  // The shared cheat-sheet; Teams wording: commands are `@Aven /verb` in channels, `/verb` in 1:1.
  const bullets = homeBullets().map((b) => mrkdwnToTeams(b.replace(/\/aven /g, '/')));
  return {
    text:
      `**Aven — your coding agent**\n\n**Projects**\n${projects.join('\n') || '_none_'}\n\n` +
      `**How to use me**\n\n${bullets.join('\n\n')}\n\n_In channels, commands are \`@Aven /verb …\`; in this chat, \`/verb …\`._`,
  };
}
