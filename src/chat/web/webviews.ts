// The core's views as HTML fragments, pure (OpenSpec web-chat-driver, design D1/D4). The web driver owns
// the page, so every view renders natively: controls are buttons the client script posts back as the
// same action families the core handles for Slack and Teams (`cancel_turn`, `show_trail`, `answer_q`, …)
// with the same values, dialogs are forms with the same field names, private replies are ordinary
// fragments the server shows to one person. Every piece of text goes through webformat.ts: agent
// markdown and the core's mrkdwn become safe HTML, everything else is escaped by the `h` template.
//
// Golden-tested: src/chat/web/webviews.test.ts pins every kind (src/fixtures/chat/web/views.json).

import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { ProjectConfig } from '../../projects.js';
import { fmtElapsed, prUrls } from '../../format.js';
import { plural, shortRepo } from '../slack/blocks.js';
import { webHomeBullets } from './webhome.js';
import { BAD_REASONS, type Tally } from '../../feedback.js';
import { Html, h, markdownToHtml, mrkdwnToHtml, plainText, raw } from './webformat.js';

export type NameOf = (id: string) => string | undefined;

export interface RenderCtx {
  nameOf?: NameOf;
  tally?: Tally; // the rating count of an answer, when the store has one
}

/** A rendered message: the fragment, and one line of text for notifications and thread cards. */
export interface Rendered {
  html: Html;
  text: string;
}

const btn = (label: string, action: string, value: string, cls = ''): Html =>
  h`<button type="button" class="btn${cls ? ` ${cls}` : ''}" data-action="${action}" data-value="${value}">${label}</button>`;
const link = (label: string, url: string): Html => h`<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
const actions = (items: Html[]): Html => (items.length ? h`<div class="actions">${items}</div>` : raw(''));
const md = (s: string, c?: RenderCtx): Html => markdownToHtml(s, c?.nameOf);
const mk = (s: string, c?: RenderCtx): Html => mrkdwnToHtml(s, c?.nameOf);

// The two rating buttons; with a tally the labels carry the per-turn count ("👍 Helped · 2"), which IS
// the click's confirmation (the message is re-rendered with it — refreshRating).
export function ratingButtons(rate: { turnId: string; slug: string; key: string }, tally: Tally = { good: 0, bad: 0 }): Html[] {
  const value = JSON.stringify({ t: rate.turnId, s: rate.slug, k: rate.key });
  const label = (base: string, n: number) => (n > 0 ? `${base} · ${n}` : base);
  return [btn(label('👍 Helped', tally.good), 'fb_good', value, 'rate'), btn(label('👎 Missed', tally.bad), 'fb_bad', value, 'rate')];
}

const liveActions = (turnId: string): Html => actions([btn('🧭 Show steps', 'show_trail', turnId), btn('✖ Cancel', 'cancel_turn', turnId, 'danger')]);

export function renderMessageView(v: MessageView, c: RenderCtx = {}): Rendered {
  switch (v.kind) {
    case 'status':
      return {
        html: h`<div class="status${v.queued ? ' queued' : ''}"><span class="spinner" aria-hidden="true"></span><div class="status-line">${mk(v.line || '…', c)}</div></div>${liveActions(v.turnId)}`,
        text: plainText(v.notify || v.line),
      };
    case 'text':
      return { html: h`<div class="text">${mk(v.text, c)}</div>`, text: plainText(v.text) };
    case 'line':
      return { html: h`<div class="line">${mk(v.text, c)}</div>`, text: plainText(v.text) };
    case 'background':
      return {
        html: h`<div class="card background"><p>🌙 <strong>Working in the background</strong> — running for ${fmtElapsed(v.elapsedMs)}, longer than usual.</p><p>I'll post the answer here as a new message when it's done. <strong>🧭 Show steps</strong> stays live; <strong>✖ Cancel</strong> stops me.</p></div>${liveActions(v.turnId)}`,
        text: 'Working in the background',
      };
    case 'backgroundDone':
      return { html: h`<div class="text">${mk(v.label, c)}<p class="meta">🧭 ${plural(v.steps, 'step')} · ${fmtElapsed(v.elapsedMs)}</p></div>`, text: plainText(v.label) };
    case 'answer':
      return { html: answerHtml(v, c), text: plainText(v.markdown) };
    case 'reported':
      return {
        html: h`<p class="reported">✅ Reported to <a href="${v.url}" target="_blank" rel="noopener noreferrer">${v.ticket}</a> (${v.group})</p><div class="answer md">${md(v.markdown, c)}</div>`,
        text: `Reported to ${v.ticket}`,
      };
    case 'projectPicker':
      return {
        html: h`<p>Which project should I work on? <em>(this conversation isn't tied to a room)</em></p>${actions(v.projects.slice(0, 20).map((p: ProjectConfig) => btn(p.slug, 'dm_pick_project', `${v.pid}:${p.slug}`)))}`,
        text: 'Which project should I work on?',
      };
    case 'heldAsk': {
      // agent-messaging D9: the held message with Send / Dismiss while pending (the same action ids everywhere).
      const what = v.held.kind === 'task' ? h`a task for <strong>${v.held.target}</strong>` : h`a reply to <strong>${v.held.target}</strong>`;
      const head = v.state === 'pending' ? h`✋ <strong>Held for your Send:</strong> ${what}` : v.state === 'sent' ? h`✅ <strong>Sent:</strong> ${what}` : h`🚫 <strong>Dismissed:</strong> ${what}`;
      const foot = v.state === 'pending' ? h`Held because ${v.held.why}. Anyone who may drive this thread can send it.` : h`${v.state === 'sent' ? 'Sent' : 'Dismissed'}${v.note ? ` — ${v.note}` : ''}`;
      return {
        html: h`<div class="card held"><p>${head}</p><blockquote>${v.held.text.slice(0, 2500)}</blockquote><p class="meta">${foot}</p></div>${v.state === 'pending' ? actions([btn('Send', 'held_send', v.held.id, 'primary'), btn('Dismiss', 'held_dismiss', v.held.id)]) : raw('')}`,
        text: `Held: ${v.held.kind} for ${v.held.target}`,
      };
    }
    case 'autofixNotice':
      return {
        html: h`<p>🔧 <strong>${shortRepo(v.watch.repo)}#${v.watch.number}</strong> — ${v.notes.join('; ')} <a href="https://github.com/${v.watch.repo}/pull/${v.watch.number}" target="_blank" rel="noopener noreferrer">View PR</a></p>${actions([btn('🔧 Fix it', 'autofix_apply', JSON.stringify({ slug: v.watch.slug, repo: v.watch.repo, number: v.watch.number, channel: v.watch.channel }), 'primary')])}`,
        text: `${shortRepo(v.watch.repo)}#${v.watch.number}: ${v.notes.join('; ')}`,
      };
    case 'ticketHeader':
      return { html: h`<p class="ticket-head">🎫 <a href="${v.url}" target="_blank" rel="noopener noreferrer">${v.ticket.id}</a> — ${v.ticket.summary}${v.extras ? h` <span class="meta">· ${v.extras}</span>` : ''}</p>`, text: `${v.ticket.id} — ${v.ticket.summary}` };
    case 'ticketCard': {
      const t = v.ticket;
      const meta = [t.reporter ? `👤 ${t.reporter}` : '', t.createdAt ? `created ${t.createdAt.slice(0, 10)}` : '', v.flaggedBy ? `🏷 flagged by ${v.flaggedBy}` : '', ...t.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean);
      return {
        html: h`<div class="card ticket"><p>🎫 <strong><a href="${v.url}" target="_blank" rel="noopener noreferrer">${t.id}</a></strong> — ${t.summary}</p><div class="md">${md(t.description.trim().slice(0, 1500) || '_(no description)_', c)}</div>${meta.length ? h`<p class="meta">${meta.join('  ·  ')}</p>` : ''}${t.links.length ? h`<ul class="links">${t.links.map((l) => h`<li>🔗 ${l.type} <strong>${l.id}</strong> — ${l.summary}${l.resolved ? ' (resolved)' : ''}</li>`)}</ul>` : ''}${v.attachmentNames.length ? h`<p class="meta">📎 ${v.attachmentNames.join(', ')}</p>` : ''}</div>${actions([btn('🔍 Full ticket', 'ticket_modal', t.id)])}`,
        text: `${t.id} — ${t.summary}`,
      };
    }
    case 'question':
      return renderQuestion(v);
  }
}

function answerHtml(v: Extract<MessageView, { kind: 'answer' }>, c: RenderCtx): Html {
  const o = v.opts ?? {};
  const items: Html[] = [];
  const prs = prUrls(v.markdown);
  for (const url of prs.slice(0, 5)) items.push(link(prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}`, url));
  if (o.trail && o.trail.steps > 0) items.push(btn('🧭 Show steps', 'show_trail', o.trail.turnId));
  if (o.ytDraft) items.push(btn('✏️ Edit & send', 'yt_edit_send', JSON.stringify({ t: o.ytDraft.ticket, d: o.ytDraft.draftId }), 'primary'));
  else {
    if (o.ytReport && o.followUp) items.push(btn('📝 Report to YouTrack', 'yt_report', JSON.stringify({ t: o.ytReport, key: o.followUp.key, channel: o.followUp.channel, threadTs: o.followUp.threadTs })));
    if (o.followUp) items.push(btn('⚙️ Session', 'session_panel', JSON.stringify({ key: o.followUp.key, channel: o.followUp.channel, threadTs: o.followUp.threadTs })));
    if (o.rate) items.push(...ratingButtons(o.rate, c.tally));
  }
  const meta = o.trail && o.trail.steps > 0 ? h`<p class="meta">🧭 ${plural(o.trail.steps, 'step')} · ${fmtElapsed(o.trail.elapsedMs)}</p>` : raw('');
  return h`<div class="answer md">${md(v.markdown, c)}</div>${v.notice ? h`<div class="notice">${mk(v.notice, c)}</div>` : ''}${meta}${actions(items)}`;
}

function renderQuestion(v: Extract<MessageView, { kind: 'question' }>): Rendered {
  if (v.done) return { html: h`<div class="text"><p>✅ Answered</p></div>`, text: 'Answered' };
  const blocks = v.questions.map((q, qi) => {
    const set = v.picks.get(qi) ?? new Set<number>();
    const shown = q.options.slice(0, 6);
    return h`<div class="question"><p><strong>${q.header ? `${q.header}: ` : ''}${q.question}</strong></p><ul class="options">${shown.map((o, oi) => h`<li>${btn(`${set.has(oi) ? '✅ ' : ''}${o.label.slice(0, 60)}`, 'answer_q', JSON.stringify({ qid: v.qid, qi, oi }), set.has(oi) ? 'picked' : '')}${o.description ? h` <span class="meta">— ${o.description}</span>` : ''}</li>`)}</ul></div>`;
  });
  return {
    html: h`<div class="card ask"><p>❓ <strong>The agent needs your input</strong>${v.multi ? h` <em>(pick one or more, then Submit)</em>` : ''}</p>${blocks}</div>${v.multi ? actions([btn('Submit', 'submit_q', JSON.stringify({ qid: v.qid }), 'primary')]) : raw('')}`,
    text: `The agent needs your input: ${plainText(v.questions[0]?.question ?? '', 100)}`,
  };
}

// ── private replies ───────────────────────────────────────────────────────────────────────────────

type RoutineLike = Extract<PrivateView, { kind: 'routines' }>['routines'][number];
// One row per scheduled job, in the Slack list's vocabulary (`routineListBlocks`): the dot is the enabled
// state, dream/housekeeping show their label (and last digest) instead of a prompt, a task is tagged.
function routineRow(r: RoutineLike): Html {
  const dot = r.enabled ? '🟢' : '⚪️';
  const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
  if (r.kind === 'dream' || r.kind === 'housekeeping') {
    const label = r.kind === 'dream' ? '🌙 dream' : '🧹 housekeeping';
    return h`<li>${dot} <strong>${r.id}</strong> ${label} — <code>${r.spec}</code> (${r.tz})${last}${r.lastSummary ? h` — <em>${r.lastSummary}</em>` : ''}</li>`;
  }
  const p = r.prompt.length > 90 ? `${r.prompt.slice(0, 87)}…` : r.prompt;
  const tag = r.kind === 'task' ? ' 🛠 task' : '';
  const skipped = r.lastOutcome === 'skipped' ? ' ⏭ skipped (nothing new)' : '';
  return h`<li>${dot} <strong>${r.id}</strong>${tag} — <code>${r.spec}</code> (${r.tz})${last}${skipped} — ${p}</li>`;
}
const ROUTINES_MANAGE = h`<p class="meta"><em>Manage:</em> <code>/routines run|off|on|rm &lt;id&gt;</code> (<code>run</code> = fire now) · <code>/routines all</code> for every project</p>`;

export function renderPrivateView(v: PrivateView, c: RenderCtx = {}): Rendered {
  switch (v.kind) {
    case 'text':
      return { html: h`<div class="text">${mk(v.text, c)}</div>`, text: plainText(v.text) };
    case 'markdown':
      return { html: h`${v.title ? h`<p><strong>${v.title}</strong></p>` : ''}<div class="md">${md(v.markdown, c)}</div>${v.note ? h`<div class="meta">${mk(v.note, c)}</div>` : ''}`, text: plainText(v.title ?? v.markdown) };
    case 'statusReport': {
      const r = v.report;
      const rows = r.projects.map(
        (p) =>
          h`<li><strong>${p.slug}</strong> — ${p.state ?? 'not created'} · ${plural(p.repos, 'repo')} · ${plural(p.sessions, 'session')} (${p.active} active)${p.openPRs === undefined ? '' : ` · ${plural(p.openPRs, 'open PR')}`}${p.jobs || p.dreams || p.hk ? ` · routines: ${p.jobs} jobs, ${p.dreams} dreams, ${p.hk} housekeeping` : ''}${p.sources ? h`<br><span class="meta">sources: ${p.sources}</span>` : ''}</li>`,
      );
      const flags = [`sandboxes ${r.sandboxesOk ? '✅' : '⚠️'}`, `GitHub ${r.githubOk ? '✅' : '⚠️'}`, `${plural(r.turnsInFlight, 'turn')} in flight`];
      return { html: h`<p><strong>CoachAven status</strong></p><ul>${rows}</ul><p class="meta">${flags.join(' · ')}</p>${r.claudeQuota ? h`<div class="meta">${mk(r.claudeQuota, c)}</div>` : ''}`, text: 'CoachAven status' };
    }
    case 'access':
      return {
        html: h`<p><strong>Access for ${v.project.slug}</strong></p><ul><li>repos: ${v.project.repos.join(', ')}</li><li>tools: ${(v.project.mcp ?? []).map((m) => m.name).join(', ') || 'none'}</li></ul>`,
        text: `Access for ${v.project.slug}`,
      };
    case 'routines':
      return {
        html: v.routines.length
          ? h`<p><strong>Scheduled jobs</strong></p><ul class="routines">${v.routines.map(routineRow)}</ul>${ROUTINES_MANAGE}`
          : h`<p><em>No scheduled jobs in this room.</em></p><p>Create one: <code>/schedule weekdays 9:00 | one-line status on open PRs and active threads</code></p>`,
        text: 'Scheduled jobs',
      };
    case 'allRoutines':
      return {
        html: h`<p><strong>All scheduled jobs</strong></p>${v.groups.map((g) => h`<p><strong>${g.slug}</strong></p>${g.routines.length ? h`<ul class="routines">${g.routines.map(routineRow)}</ul>` : h`<p><em>none</em></p>`}`)}${ROUTINES_MANAGE}`,
        text: 'All scheduled jobs',
      };
    case 'memoryIndex':
      return {
        html: h`<p><strong>Memory — ${v.slug}</strong></p><div class="md">${md(v.markdown, c)}</div><div class="meta">${mk(v.note, c)}</div>${actions(v.topics.slice(0, 24).map((t) => btn((t.title || t.file).slice(0, 75), 'mem_open', JSON.stringify({ s: v.slug, f: t.file }))))}`,
        text: `Memory — ${v.slug}`,
      };
    case 'sessionPanel': {
      const i = v.info;
      const session = i.hasSession ? h`active${i.sessionSince ? h` <em>(since ${i.sessionSince.slice(0, 16).replace('T', ' ')})</em>` : ''}` : h`<em>none yet — the next message starts one</em>`;
      return {
        html: h`<div class="card session"><p>⚙️ <strong>${i.slug}</strong> — this thread's session</p><ul><li><strong>Repos:</strong> ${i.repos.map((r) => h`<code>${shortRepo(r)}</code>`).map((x, n) => (n ? h`, ${x}` : x))}</li><li><strong>Tools (MCP):</strong> ${i.mcp?.length ? i.mcp.map((m) => h`<code>${m}</code>`).map((x, n) => (n ? h`, ${x}` : x)) : h`<em>none</em>`}</li><li><strong>Session:</strong> ${session}</li><li><strong>Turn running:</strong> ${i.turnInFlight ? 'yes' : 'no'}</li>${i.prCreated ? h`<li><strong>PR:</strong> opened from this thread</li>` : ''}</ul></div>${i.hasSession ? actions([btn('🔄 Restart session', 'session_restart', v.value, 'danger confirm')]) : raw('')}`,
        text: `Session — ${i.slug}`,
      };
    }
  }
}

// ── dialogs ───────────────────────────────────────────────────────────────────────────────────────
// A dialog is a titled fragment the client shows in a <dialog>; a form in it posts the dialog's id and its
// values to the dialog endpoint (data-dialog = the family; checkbox groups and the fields named in
// data-multi arrive as arrays, as the core's handlers expect). The form's family and private metadata
// (`submit`) stay on the server with the dialog (driver.ts): the browser never carries them, so nobody can
// submit a dialog with metadata of their choosing (the security review of 2026-10-30).

export interface RenderedDialog {
  title: string;
  html: Html;
  /** The form's submit handler and metadata, kept by the driver beside the dialog's id. */
  submit?: { id: string; meta: string };
}

const form = (id: string, meta: string, body: Html, submit: string, multi: string[] = []): { html: Html; submit: { id: string; meta: string } } => ({
  html: h`<form class="dialog-form" data-dialog="${id}"${multi.length ? h` data-multi="${multi.join(',')}"` : ''}>${body}<div class="actions"><button type="submit" class="btn primary">${submit}</button></div></form>`,
  submit: { id, meta },
});

export function renderDialogView(v: DialogView, c: RenderCtx = {}): RenderedDialog {
  switch (v.kind) {
    case 'trail': {
      const t = v.trail;
      if (!t) return { title: '🧭 Steps', html: h`<p><em>This turn's step-by-step trail is no longer available (I've been restarted since it ran).</em></p>` };
      if (!t.steps.length) return { title: '🧭 Steps', html: h`<p><em>No steps yet — still preparing.</em></p>` };
      let steps = t.steps;
      let cut = false;
      while (steps.join('\n').length > 20_000 && steps.length > 1) {
        steps = steps.slice(1);
        cut = true;
      }
      return {
        title: '🧭 Steps',
        html: h`<p class="meta">🧭 ${plural(t.steps.length, 'step')} · ${fmtElapsed(t.elapsedMs)}${t.done ? '' : ' so far'}</p>${cut ? h`<p class="meta">… (earlier steps omitted)</p>` : ''}<ol class="trail">${steps.map((s) => h`<li>${mk(s, c)}</li>`)}</ol>${t.done ? '' : h`<p class="meta">⏳ Still running — this view updates live.</p>`}`,
      };
    }
    case 'feedback':
      return {
        title: '👎 What went wrong?',
        ...form(
          'feedback',
          JSON.stringify({ t: v.meta.turnId, s: v.meta.slug, k: v.meta.key, c: v.meta.channel, ts: v.meta.ts }),
          h`<fieldset class="reasons">${BAD_REASONS.map((r, i) => h`<label><input type="radio" name="reason" value="${r.value}"${i === 0 ? ' required' : ''}> ${r.label}</label>`)}</fieldset><label>Optional: what would have helped?<textarea name="note" rows="3" maxlength="2000" placeholder='e.g. "the file was in services/, not src/"'></textarea></label>`,
          'Send',
        ),
      };
    case 'ticketLoading':
      return { title: v.id, html: h`<p>⏳ Loading…</p>` };
    case 'ticket': {
      const t = v.issue;
      return {
        title: t.id,
        html: h`<p><strong><a href="${v.url}" target="_blank" rel="noopener noreferrer">${t.id}</a></strong> — ${t.summary}</p>${t.fields.length ? h`<p class="meta">${t.fields.map((f) => `${f.name}: ${f.value}`).join('  ·  ')}</p>` : ''}<div class="md">${md((t.description || '_(no description)_').slice(0, 20_000), c)}</div>${t.links.length ? h`<ul class="links">${t.links.map((l) => h`<li>🔗 ${l.type} <strong>${l.id}</strong> — ${l.summary}${l.resolved ? ' (resolved)' : ''}</li>`)}</ul>` : ''}${v.attachmentNames.length ? h`<p class="meta">📎 ${v.attachmentNames.join(', ')}</p>` : ''}${v.comments.length ? h`<h3>Comments</h3>${v.comments.slice(-30).map((cm) => h`<div class="comment"><p class="meta">${cm.author}${cm.createdAt ? ` · ${cm.createdAt.slice(0, 16).replace('T', ' ')}` : ''}</p><div class="md">${md(cm.text.slice(0, 4000), c)}</div></div>`)}` : ''}`,
      };
    }
    case 'ticketUnavailable':
      return { title: v.id, html: h`<p>Could not load <a href="${v.url}" target="_blank" rel="noopener noreferrer">${v.id}</a>.</p>` };
    case 'reportPrompt':
      return {
        title: `📝 Report to ${v.ticket}`,
        ...form(
          'yt_prompt',
          JSON.stringify({ t: v.ticket, key: v.meta.key, channel: v.meta.channel, threadTs: v.meta.threadTs }),
          h`<label><strong>Instructions for the draft</strong> — edit before running:<textarea name="instructions" rows="6" required>${v.prompt}</textarea></label><label><input type="checkbox" name="now" value="now"> Post to the ticket immediately (no review)</label><div class="meta contract">${mk(v.contract, c)}</div>`,
          'Draft the report',
          ['now'],
        ),
      };
    case 'report':
      return {
        title: `📝 Report to ${v.ticket}`,
        ...form(
          'yt_send',
          JSON.stringify({ t: v.ticket, channel: v.meta.channel, ts: v.meta.ts, threadTs: v.meta.threadTs }),
          h`<p class="meta">Posted as an <strong>internal</strong> comment on the ticket — edit first if needed:</p><textarea name="text" rows="12" required>${v.draft.slice(0, 20_000)}</textarea>`,
          'Send to YouTrack',
        ),
      };
    case 'reportExpired':
      return { title: `📝 Report to ${v.ticket}`, html: h`<p>⌛ This draft has expired.</p>` };
  }
}

// ── Home ──────────────────────────────────────────────────────────────────────────────────────────
// The web's own cheat-sheet (webhome.ts — a dedicated application: rooms, no mentions, no DM picker, one
// organization), with the room links the web serves.

export function renderHomeView(v: HomeView, rooms: (slug: string) => string | undefined = () => undefined): Html {
  if (v.kind === 'onboarding') return h`<p>👋 I'm CoachAven. This installation serves no projects yet — ask your operator to add one.</p>`;
  const projects = v.projects.map((p) => {
    const url = rooms(p.slug);
    return h`<li>${url ? h`<a href="${url}"><strong>${p.slug}</strong></a>` : h`<strong>${p.slug}</strong>`} — ${p.repos.map(shortRepo).join(', ')}</li>`;
  });
  const bullets = webHomeBullets(v.messaging ? { messaging: true } : {}).map((b) => h`<li>${mrkdwnToHtml(b.replace(/^•\s*/, ''))}</li>`);
  return h`<h2>CoachAven — your coding agent</h2><h3>Projects</h3><ul class="projects">${projects.length ? projects : h`<li><em>none</em></li>`}</ul><h3>How to use me</h3><ul class="cheatsheet">${bullets}</ul><p class="meta"><em>Commands are <code>/verb …</code> in any room, thread or private conversation; their replies are for you alone.</em></p>`;
}
