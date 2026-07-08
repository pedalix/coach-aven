// Central home for the orchestrator's turn-framing prompts (PR review, autofix, scheduled
// report, follow-up PR). Keep prompt copy here so it's easy to find and tune in one place.
// (The 3-layer system prompt lives in tasks.ts/buildSystemPrompt; the dream/memory prompt
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
export function investigationPrompt(ticket: InvestigationTicket, mentions: string): string {
  const ping = mentions ? `\n\nWhen done, @-mention ${mentions} so they see the findings.` : '';
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
    `[Read-only support investigation] This YouTrack ticket was flagged for AI review. Investigate it and EXPLAIN what's going on, then PROPOSE a solution or next step. Do NOT modify code, create branches, commit, or open PRs — analysis only.`,
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
    `- If YouTrack MCP tools are available (search_issues / get_issue / get_comments), search for similar tickets — especially already-resolved ones — before concluding, and cite any you find.`,
    `- Post ONE concise writeup, in the language the ticket is written in (a German ticket gets a German answer), shaped EXACTLY like this:`,
    `  1. *The problem, in plain language* — 2–3 sentences a support agent could relay to the affected user: what breaks, for whom, and how badly.`,
    `  2. *What I checked* — short bullets: each system/source you consulted (code, Grafana logs/metrics, ticket history, similar tickets, attachments) and the key thing it showed.`,
    `  3. *Technical root cause* — the code paths / queries / log lines that pin it down, with concrete evidence.`,
    `  4. *Proposed fix or next step* — concrete, with your confidence; if a claim needs data you don't have (a specific log line, a metric, a repro), name exactly what would confirm it rather than guessing.${ping}`,
  ].join('\n');
}

// Fired by the "Open a PR" follow-up button. Handles BOTH cases: a build thread where the work
// is already done (just commit + PR it) and an investigation thread where only a fix was
// PROPOSED (implement it first). Keep the "ask if risky" guard — investigations are read-only
// analyses, so acting on one may need judgment the button click didn't supply.
export const FOLLOW_UP_PR_PROMPT =
  'Turn this conversation into a pull request. If the change we discussed is not implemented yet, ' +
  'implement it now on a dedicated worktree/branch forked from origin/main; otherwise just make ' +
  'sure your existing changes are committed there. Then push and open a PR against the default ' +
  'branch with the gh CLI, describing the change and linking the ticket/thread it came from. If ' +
  'the right fix is ambiguous, architectural, or risky, ask here BEFORE writing code instead of ' +
  'guessing. If there is genuinely nothing to submit, say so instead of opening an empty PR.';

// Fired by the "📝 Report to YouTrack" button on an investigation thread. The turn's answer IS
// the draft: it's shown in the thread with an "✏️ Edit & send" button, a human edits it in a
// modal, and the orchestrator posts the result as an INTERNAL ticket comment (postInternalComment).
// Hence the hard rules: output ONLY the comment text, keep it short (the modal input and the
// support team's patience are both finite), and write for support agents — not developers, not
// the customer directly.
export function reportDraftPrompt(ticketId: string): string {
  return (
    `Draft an internal report comment for YouTrack ticket ${ticketId}, summarizing this ` +
    `investigation for the SUPPORT TEAM (internal — the customer will not see it, but write ` +
    `professionally). Structure: a 1–2 sentence plain-language conclusion first, then ` +
    `"What was checked" (bullet list of systems/sources and what each showed), then ` +
    `"Suggested fix / next steps". Plain Markdown (YouTrack renders it), no Slack-specific ` +
    `formatting, no @-mentions. HARD LIMIT 2500 characters. If the investigation is still ` +
    `inconclusive, say so honestly and list what info is missing. Output ONLY the comment ` +
    `text — no preamble, no sign-off, it will be posted verbatim.`
  );
}
