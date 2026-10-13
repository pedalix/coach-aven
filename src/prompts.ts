// Central home for the orchestrator's turn-framing prompts (PR review, autofix, scheduled
// report, follow-up PR). Keep prompt copy here so it's easy to find and tune in one place.
// (The 3-layer system prompt lives in prompt.ts/buildSystemPrompt; the dream/memory prompt
// in dream.ts — they belong to those subsystems and can join here by coordination.)
//
// The review prompt borrows Claude Code's /code-review methodology (find → verify with a
// quote-to-refute burden of proof, a concrete failure scenario per finding, touched-function
// scope, precision↔recall as the effort lever) — compressed into a single turn rather than
// the skill's multi-agent fan-out. Reference: Piebald-AI/claude-code-system-prompts.

export type ReviewEffort = 'low' | 'med' | 'high';

// Parse an optional trailing effort token. Accepts low | med | medium | high.
export function parseEffort(token: string | undefined): ReviewEffort | undefined {
  const v = token?.toLowerCase();
  if (v === 'low' || v === 'high') return v;
  if (v === 'med' || v === 'medium') return 'med';
  return undefined;
}

// PR review prompt: read-only, posts a Slack summary, never touches GitHub. Effort tunes
// depth, the precision↔recall bias, and the findings cap.
export function reviewPrompt(repo: string, number: number, effort: ReviewEffort = 'med'): string {
  const cap = effort === 'low' ? 4 : effort === 'high' ? 10 : 8;
  const bias =
    effort === 'high'
      ? `Bias toward RECALL — a missed bug ships. Keep a candidate unless you can refute it from the code; treat realistic-but-uncertain triggers (races, nil on a rare/error path, falsy-zero treated as missing, off-by-one at a boundary, a regex/allowlist that lost an anchor) as real.`
      : `Bias toward PRECISION — every finding must be one a maintainer would act on. Drop anything you can't tie to a concrete trigger.`;
  const depth =
    effort === 'low'
      ? `Do a single focused pass over the diff; no deep cross-file tracing.`
      : `For each changed function also read its enclosing function, and check its callers/callees for broken contracts (a new precondition, a changed return shape or exception, an ordering dependency).${
          effort === 'high' ? ` After listing findings, do ONE fresh sweep of the diff for anything missed — don't re-confirm what's already listed, don't pad.` : ''
        }`;
  return [
    `[Read-only PR review — ${effort} effort] Review pull request #${number} in ${repo}. Post a Slack summary only — do NOT push code, comment on GitHub, or approve/request changes.`,
    '',
    `Scope: read the change with \`gh pr diff ${number} -R ${repo}\` (and \`gh pr view ${number} -R ${repo}\`). Review the changed hunks and their enclosing functions — a bug in an unchanged line of a TOUCHED function is in scope (the PR re-exposes or fails to fix it). Ignore style, naming, missing tests, and anything outside the diff. ${depth}`,
    '',
    `Find: correctness bugs (inverted condition, off-by-one, null/undefined deref, missing await, swallowed error; a removed guard / validation / error-path the new code doesn't re-establish; a broken caller/callee contract; language-specific traps; a wrapper/cache/proxy method that doesn't delegate to the wrapped instance) AND clear quality issues (duplicates an existing helper, needless complexity, wasted work on a hot path).`,
    '',
    `Verify EACH candidate before reporting it: either name the concrete inputs/state that trigger it and the resulting wrong output or crash, OR quote the exact line that proves it's already handled or impossible — and drop it. No finding without a concrete failure scenario. ${bias}`,
    '',
    `Output: post ONE concise review — a one-line verdict, then findings ranked most-severe first (cap ${cap}), each as \`file:line — what's wrong (concrete failure scenario)\`. If nothing survives verification, say it looks clean in one line.`,
  ].join('\n');
}

// Autofix turn (fired by the "Fix" button): a WRITE turn that addresses a PR's CI failure /
// review feedback on its branch, with /code-review --fix's skip discipline.
export function autofixPrompt(repo: string, number: number): string {
  return [
    `Address the latest feedback on pull request #${number} in ${repo}. Check out the PR branch (\`gh pr checkout ${number} -R ${repo}\`), then investigate with \`gh pr view\`, \`gh pr diff\`, \`gh pr checks ${number} -R ${repo}\` (read the failing CI logs) and the review comments.`,
    `Make the fix on that branch, commit, and push. Skip any change that would alter intended behavior, reach well outside this PR's diff, or that you judge a false positive — note the skip rather than arguing with it. If the right fix is ambiguous, architectural, or risky, ask before changing anything instead of guessing.`,
    `Finish with a short summary of what you changed and what you skipped.`,
  ].join('\n');
}

// Prepended to every scheduled report turn: read-only, summarise, change nothing.
// Scheduled task (kind 'task'): unlike a digest it may change files — the project's own
// system prompt says where and how (e.g. a tenant repo's annotation files). Still bounded:
// no PRs into other repos, one summary message plus whatever escalations the instructions ask for.
export const TASK_FRAMING =
  "[Scheduled task] Run the task below as the project's instructions describe — you MAY edit and commit " +
  "files when the instructions say so (follow the project's system prompt for where and how), never open " +
  'PRs against other repositories, never post more than one summary message plus any escalation messages ' +
  'the instructions call for. If nothing needed doing, say so in one line.\n\n';

// Framing for a fired report/task routine (dream/housekeeping never reach a turn).
export function routineFraming(kind: string | undefined): string {
  return kind === 'task' ? TASK_FRAMING : REPORT_FRAMING;
}

export const REPORT_FRAMING =
  '[Scheduled read-only digest] Do NOT modify code, create branches, commit, or open PRs. ' +
  'Read-only: gather the requested information and post one concise summary. If nothing is ' +
  'noteworthy, say so briefly.\n\n';

// Support-ticket investigation turn (fired by the YouTrack-label poller). Read-only: the
// agent works out what's happening and proposes a fix, grounded in the project's code and
// (where wired) its Grafana logs/metrics/traces — it changes nothing. The ticket body is
// assembled orchestrator-side and passed in (fields/links pre-flattened by youtrack.ts, so
// the whole ticket — not just title+description — reaches the agent). `mentions` are
// pre-formatted `<@U…>` strings.
export interface InvestigationTicket {
  id: string;
  summary: string;
  description: string;
  comments: string; // pre-joined "[author, date] text" paragraphs
  reporter?: string;
  createdAt?: string; // ISO 8601
  fields?: { name: string; value: string }[];
  links?: { type: string; id: string; summary: string; resolved: boolean }[];
}
// `flaggedBy` / `replyLanguage` come from WHO applied the trigger tag (youtrack.ts
// tagApplier): a support agent's flag gets an answer in the ticket's own language, because it
// is relayed to the customer; a teammate on the englishTaggers list gets English, because the
// reader is us. Both default to the original behaviour when the tagger is unknown.
export function investigationPrompt(
  ticket: InvestigationTicket,
  mentions: string,
  opts: { flaggedBy?: string; replyLanguage?: string } = {},
): string {
  const ping = mentions ? `\n\nWhen done, @-mention ${mentions} so they see the findings.` : '';
  const lang = opts.replyLanguage;
  const writeupLang = lang
    ? `in ${lang} — ALWAYS ${lang}, whatever language the ticket itself is written in`
    : `in the language the ticket is written in (a German ticket gets a German answer)`;
  const closingLang = lang ? `in ${lang}` : `in the ticket's language`;
  const meta = [
    ticket.reporter ? `reported by ${ticket.reporter}` : '',
    ticket.createdAt ? `created ${ticket.createdAt.slice(0, 10)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const fields = (ticket.fields ?? []).map((f) => `${f.name}: ${f.value}`).join(' · ');
  const links = (ticket.links ?? [])
    .map((l) => `- ${l.type} ${l.id} — ${l.summary}${l.resolved ? ' (RESOLVED)' : ' (open)'}`)
    .join('\n');
  return [
    `[Read-only support investigation] This YouTrack ticket was flagged for AI review${opts.flaggedBy ? ` by ${opts.flaggedBy}` : ''}. Investigate it and EXPLAIN what's going on, then PROPOSE a solution or next step. Do NOT modify code, create branches, commit, or open PRs — analysis only.`,
    '',
    `Ticket ${ticket.id}: ${ticket.summary}${meta ? `\n(${meta})` : ''}`,
    ...(fields ? ['', `Fields: ${fields}`] : []),
    ...(links ? ['', `Linked issues:\n${links}`] : []),
    '',
    `Description:\n${ticket.description.trim() || '(none)'}`,
    '',
    `Comments:\n${ticket.comments.trim() || '(none)'}`,
    '',
    `Your job:`,
    `- Work out what the user is actually experiencing and the most likely ROOT CAUSE, grounded in THIS project's code and (where available) its Grafana logs/metrics/traces.`,
    ...(links
      ? [
          `- Check the linked issues first — a RESOLVED duplicate/related ticket may already name the cause or the fix; say so if it does.`,
        ]
      : []),
    `- If YouTrack MCP tools are available (search_issues / get_issue / get_comments — through the MCP gateway they are named youtrack_search_issues / youtrack_get_issue / youtrack_get_comments), search for similar tickets — especially already-resolved ones — before concluding, and cite any you find.`,
    `- FACTS ONLY: every claim in your writeup must be backed by something you actually saw — a log line, a code path you read, a metric, a resolved similar ticket. Never present a hypothesis as a finding; when the evidence is missing, say plainly that you don't know and name exactly what data would settle it.`,
    `- Post ONE concise writeup, ${writeupLang}. Your reader is a SUPPORT AGENT, not a developer: plain everyday language throughout — no file paths, class names, queries, or stack traces in the writeup. Shape it EXACTLY like this:`,
    `  1. *What's going on* — 2–3 sentences the support agent could relay to the affected user: what breaks, for whom, how badly, and the most likely cause in everyday words.`,
    `  2. *What I checked* — short bullets naming each source in plain words (the application's error logs, the booking code, similar past tickets, the attached screenshots) and the key thing each showed.`,
    `  3. *How sure I am* — a confidence score (High / Medium / Low) with a 1–2 sentence justification that cites your strongest concrete evidence; missing data lowers the score, and you say what's missing.`,
    `  4. *Suggested next step* — the concrete action, in plain words: what support should tell the user, and/or what to hand to a developer.`,
    `- Do NOT include a technical deep-dive section. Close with exactly one short line ${closingLang} meaning: "If you want any technical details, just shoot." — the reply thread keeps your full context, so you can provide them on request.${ping}`,
  ].join('\n');
}

// Fired by the "📝 Report to YouTrack" button on an investigation thread. The turn's answer IS
// the draft: it's shown in the thread with an "✏️ Edit & send" button, a human edits it in a
// modal, and the orchestrator posts the result as an INTERNAL ticket comment (postInternalComment).
// The prompt is split in two on purpose: reportDraftPrompt is the EDITABLE part (content
// guidance — users replace it wholesale with one-liners like "report that it is live"), while
// reportDeliveryContract carries the non-negotiable delivery rules and is appended server-side
// to whatever the user submits. Before the split, overwriting the prompt dropped "output ONLY
// the comment text", the agent tried to post via its read-only YouTrack MCP, and auto-post
// shipped its "I can't post this, here's a ready-to-paste comment:" preamble to the ticket.
export function reportDraftPrompt(ticketId: string): string {
  return (
    `Draft an internal report comment for YouTrack ticket ${ticketId}, summarizing this ` +
    `investigation for the SUPPORT TEAM (internal — the customer will not see it, but write ` +
    `professionally). Structure: a 1–2 sentence plain-language conclusion first, then ` +
    `"What was checked" (bullet list of systems/sources and what each showed), then ` +
    `"Suggested fix / next steps". If the investigation is still inconclusive, say so ` +
    `honestly and list what info is missing.`
  );
}

// Always appended after the (possibly user-rewritten) report instructions — never editable.
// Shown read-only in the prompt modal so the "you see the exact prompt that runs" promise
// still holds. Keep it self-contained: it must survive ANY instructions above it.
export function reportDeliveryContract(ticketId: string): string {
  return (
    `DELIVERY CONTRACT (fixed — applies regardless of the instructions above): your answer ` +
    `will be posted VERBATIM as an internal comment on YouTrack ticket ${ticketId} by the ` +
    `orchestrator. Do NOT try to post it yourself — your YouTrack access is read-only. ` +
    `Output ONLY the comment text: no preamble, no meta-commentary about tools or posting, ` +
    `no sign-off. Plain Markdown (YouTrack renders it), no Slack-specific formatting, ` +
    `no @-mentions. HARD LIMIT 2500 characters.`
  );
}
