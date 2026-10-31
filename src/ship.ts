// Pure planner for `npm run ship` and `npm run where` (OpenSpec ship-dispatcher): which installation gets which
// version, in what order, and whether the stage rule allows it. Every fact about the world — the overlays, what each
// installation runs, main's CI, the tags, git ancestry, the merged PRs — comes in as data or an oracle, so the rules
// that can be silently wrong are tested here (ship.test.ts). shipcli.ts only gathers the facts and runs the steps
// through deploy.sh, which stays the one thing that touches an installation.

// One installation's overlay (infra/<slug>/deploy.env), as far as ship reads it.
export interface Overlay {
  slug: string;
  stage?: number;
  stageError?: string; // STAGE present but not a positive integer
  canary: boolean; // CANARY=1: takes main's sha-<commit> images
}

// What an installation runs now, read where it runs (deploy.sh <slug> pinned), or why it could not be read.
export type Pin = { version: string; commit: string } | { unreachable: string };

// A first-parent main commit, newest first, with what ship needs to know before the lowest stage may take it.
export interface MainCommit {
  commit: string;
  ci: 'success' | 'failure' | 'pending' | 'none';
  image: boolean; // ghcr.io/<owner>/coach-aven:sha-<commit> is published
}

export interface Pr {
  number: number;
  title: string;
  labels: string[];
}

export interface ShipFacts {
  overlays: Overlay[];
  pins: Record<string, Pin>; // staged installations only
  main: MainCommit[];
  isAncestor(a: string, b: string): boolean; // a is b, or an ancestor of b
  tagCommit(tag: string): string | undefined; // vX.Y.Z → its commit
  tagsAt(commit: string): string[]; // release tags pointing at the commit
  releaseTagsReachable(commit: string): string[]; // every vX.Y.Z reachable from the commit
  prsBetween(from: string | undefined, to: string): Pr[]; // merged on main's first parent in from..to
}

export interface ShipRequest {
  targets: string[];
  commit?: string; // full sha, resolved by the caller
  version?: string; // vX.Y.Z (existing → that release; new → the tag to create) or sha-<40 hex>
}

export interface Step {
  slug: string;
  stage: number;
  canary: boolean;
  commit: string;
  version: string;
  createTag: boolean; // ship tags `version` on `commit` and waits for the release workflow before deploying
  from?: { version: string; commit: string };
  prs: Pr[]; // merged between what the installation ran and `commit`
}

export type Plan = { steps: Step[]; notes: string[] } | { refusal: string };

const short = (c: string) => c.slice(0, 7);
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^sha-([0-9a-f]{40})$/;

// deploy.env is sourced by bash: the last assignment of a key wins, comments and blank lines are not assignments.
export function parseOverlay(slug: string, deployEnv: string): Overlay {
  const get = (key: string): string | undefined => {
    let v: string | undefined;
    for (const line of deployEnv.split('\n')) {
      const m = line.match(new RegExp(`^\\s*${key}=(.*)$`));
      if (m) v = m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    return v;
  };
  const canary = get('CANARY') === '1';
  const raw = get('STAGE');
  if (raw === undefined || raw === '') return { slug, canary };
  return /^[1-9]\d*$/.test(raw)
    ? { slug, stage: Number(raw), canary }
    : { slug, canary, stageError: `STAGE must be a positive integer (got "${raw}")` };
}

export function compareTags(a: string, b: string): number {
  const pa = a.match(TAG)!.slice(1).map(Number);
  const pb = b.match(TAG)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export const highestTag = (tags: string[]): string | undefined =>
  tags.filter((t) => TAG.test(t)).sort(compareTags).at(-1);

// The tag ship creates: the next minor when a PR merged since the last release carries `feature`, else the next
// patch. The highest reachable tag — not the newest by date — is the base, so a hotfix line cannot confuse it.
export function nextVersion(last: string | undefined, prs: Pr[]): string {
  if (!last) return 'v0.1.0';
  const [maj, min, pat] = last.match(TAG)!.slice(1).map(Number);
  return prs.some((p) => p.labels.includes('feature')) ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`;
}

function whyNot(m: MainCommit): string {
  if (m.ci === 'pending') return 'CI is still running';
  if (m.ci === 'failure') return 'CI failed';
  if (m.ci === 'none') return 'no CI run on main';
  return 'its image is not published';
}

export function planShip(req: ShipRequest, facts: ShipFacts): Plan {
  const bySlug = new Map(facts.overlays.map((o) => [o.slug, o]));
  const staged = facts.overlays.filter((o): o is Overlay & { stage: number } => o.stage !== undefined);
  const known = staged.map((o) => o.slug).join(', ') || 'none';
  if (!req.targets.length) return { refusal: `name the installations to ship (staged: ${known})` };

  const targets: (Overlay & { stage: number })[] = [];
  for (const slug of new Set(req.targets)) {
    const o = bySlug.get(slug);
    if (!o) return { refusal: `no installation "${slug}" (no infra/${slug}/deploy.env) — staged: ${known}` };
    if (o.stageError) return { refusal: `infra/${slug}/deploy.env: ${o.stageError}` };
    if (o.stage === undefined)
      return { refusal: `infra/${slug}/deploy.env has no STAGE — ship acts only on installations with STAGE=<n> (staged: ${known})` };
    targets.push(o as Overlay & { stage: number });
  }
  targets.sort((a, b) => a.stage - b.stage || a.slug.localeCompare(b.slug));
  const lowest = Math.min(...staged.map((o) => o.stage));

  // An explicit version that already exists names its commit (a rollback, a re-ship); a new vX.Y.Z is the tag to
  // create on the chosen commit; sha-<commit> names a main commit and suits a canary only.
  let explicitCommit = req.commit;
  let explicitVersion: string | undefined;
  if (req.version) {
    const sha = req.version.match(SHA);
    if (TAG.test(req.version)) {
      explicitVersion = req.version;
      const at = facts.tagCommit(req.version);
      if (at) {
        if (explicitCommit && explicitCommit !== at)
          return { refusal: `${req.version} is commit ${short(at)}, not ${short(explicitCommit)} — pass one of --version or --commit` };
        explicitCommit = at;
      }
    } else if (sha) {
      explicitVersion = req.version;
      explicitCommit = sha[1];
    } else return { refusal: `"${req.version}" is not a version — vX.Y.Z, or sha-<40 hex> for a canary` };
  }

  const pins: Record<string, Pin> = { ...facts.pins };
  const planned = new Map<string, string>(); // commit → tag created in this run
  const steps: Step[] = [];
  const notes: string[] = [];

  for (const t of targets) {
    // ── the commit ──
    let commit: string;
    if (explicitCommit) commit = explicitCommit;
    else if (t.stage === lowest) {
      const i = facts.main.findIndex((m) => m.ci === 'success' && m.image);
      if (i < 0) {
        const newest = facts.main[0];
        return { refusal: newest ? `no main commit to ship: the newest, ${short(newest.commit)}, ${whyNot(newest)}, and none before it has green CI and an image` : 'no main commits found' };
      }
      for (const m of facts.main.slice(0, i)) notes.push(`skipped ${short(m.commit)}: ${whyNot(m)}`);
      commit = facts.main[i].commit;
    } else {
      // A later stage gets what the stage right below it runs; several installations there → the oldest commit,
      // which every other one contains.
      const below = Math.max(...staged.filter((o) => o.stage < t.stage).map((o) => o.stage));
      const there = staged.filter((o) => o.stage === below);
      const commits: string[] = [];
      for (const o of there) {
        const p = pins[o.slug];
        if (!p || 'unreachable' in p)
          return { refusal: `cannot read what ${o.slug} (stage ${below}) runs${p && 'unreachable' in p ? `: ${p.unreachable}` : ''} — check it, then pass --commit` };
        commits.push(p.commit);
      }
      const oldest = commits.find((c) => commits.every((o) => facts.isAncestor(c, o)));
      if (!oldest)
        return { refusal: `stage ${below} runs diverging commits (${there.map((o) => `${o.slug} ${short((pins[o.slug] as { commit: string }).commit)}`).join(', ')}) — ship one of them with --commit` };
      commit = oldest;
    }

    // ── the stage rule: above the lowest stage, only what a lower stage runs (or an ancestor of it) ──
    if (t.stage > lowest) {
      const lower = staged.filter((o) => o.stage < t.stage);
      const ok = lower.some((o) => {
        const p = pins[o.slug];
        return p && !('unreachable' in p) && facts.isAncestor(commit, p.commit);
      });
      if (!ok) {
        const runs = lower
          .map((o) => {
            const p = pins[o.slug];
            return `${o.slug} (stage ${o.stage}): ${!p ? 'unknown' : 'unreachable' in p ? 'unreachable' : `${p.version} (${short(p.commit)})`}`;
          })
          .join(', ');
        return { refusal: `${t.slug} (stage ${t.stage}) only takes a commit a lower stage already runs; ${short(commit)} runs nowhere below — ${runs}` };
      }
    }

    // ── the version ──
    let version: string;
    let createTag = false;
    if (explicitVersion) {
      version = explicitVersion;
      if (SHA.test(version) && !t.canary)
        return { refusal: `${t.slug} is a release installation: it takes vX.Y.Z, not ${short(version)}…` };
      createTag = TAG.test(version) && !facts.tagCommit(version) && planned.get(commit) !== version;
    } else if (t.canary) version = `sha-${commit}`;
    else {
      const existing = highestTag([...facts.tagsAt(commit), ...(planned.has(commit) ? [planned.get(commit)!] : [])]);
      if (existing) version = existing;
      else {
        const last = highestTag(facts.releaseTagsReachable(commit));
        version = nextVersion(last, facts.prsBetween(last, commit));
        const taken = facts.tagCommit(version);
        if (taken) return { refusal: `${version} already exists on ${short(taken)} — pass --version for ${short(commit)}` };
        createTag = true;
      }
    }
    if (createTag) planned.set(commit, version);

    const now = pins[t.slug];
    const from = now && !('unreachable' in now) ? now : undefined;
    if (from && from.version === version) {
      notes.push(`${t.slug} already runs ${version}`);
      continue;
    }
    steps.push({ slug: t.slug, stage: t.stage, canary: t.canary, commit, version, createTag, ...(from ? { from } : {}), prs: facts.prsBetween(from?.commit, commit) });
    pins[t.slug] = { version, commit };
  }
  return { steps, notes };
}

// The plan as the operator reads it: per installation in stage order, the move, the range, the PRs.
export function renderPlan(plan: { steps: Step[]; notes: string[] }): string {
  const out: string[] = [];
  for (const s of plan.steps) {
    const kind = s.canary ? 'canary' : 'release';
    const to = s.createTag ? `${s.version} (new tag on ${short(s.commit)})` : s.canary && s.version.startsWith('sha-') ? `sha-${short(s.commit)}` : `${s.version} (${short(s.commit)})`;
    const was = s.from ? (s.from.version.startsWith('sha-') ? `sha-${short(s.from.commit)}` : s.from.version) : 'nothing pinned';
    out.push(`${s.slug} (stage ${s.stage}, ${kind}): ${was} → ${to}`);
    out.push(s.prs.length ? `  ${s.prs.length} PR${s.prs.length > 1 ? 's' : ''}:` : '  no merged PRs in the range');
    for (const p of s.prs) out.push(`    #${p.number} ${p.title}${p.labels.length ? ` [${p.labels.join(', ')}]` : ''}`);
  }
  if (!plan.steps.length) out.push('nothing to ship');
  for (const n of plan.notes) out.push(`note: ${n}`);
  return out.join('\n');
}

// One line of infra/ships.log per step: history only — no decision reads it (design D4).
export const journalLine = (at: Date, s: Step, outcome: 'ok' | 'failed'): string =>
  `${at.toISOString().replace(/\.\d{3}Z$/, 'Z')} ${s.slug} ${s.version} ${s.commit.slice(0, 12)} ${outcome}\n`;

// When the journal saw a slug reach a version (its last `ok` line), for `where`'s "since".
export function journalSince(journal: string, slug: string, version: string): string | undefined {
  let at: string | undefined;
  for (const line of journal.split('\n')) {
    const [t, s, v, , o] = line.split(' ');
    if (s === slug && v === version && o === 'ok') at = t;
  }
  return at;
}

// `where`: each staged installation's version, commit and lag behind main; with a target, ✓ when the installation
// runs that commit (it is the pinned one or an ancestor of it). An unreachable installation is named and fails the
// report.
export function whereReport(
  overlays: Overlay[],
  pins: Record<string, Pin>,
  o: {
    target?: { label: string; commit: string };
    isAncestor(a: string, b: string): boolean;
    behind(commit: string): number;
    since(slug: string, version: string): string | undefined;
  },
): { text: string; ok: boolean } {
  const staged = overlays.filter((x) => x.stage !== undefined).sort((a, b) => a.stage! - b.stage! || a.slug.localeCompare(b.slug));
  if (!staged.length) return { text: 'no staged installations (STAGE=<n> in infra/<slug>/deploy.env)', ok: false };
  let ok = true;
  const lines = o.target ? [`${o.target.label} (${short(o.target.commit)}):`] : [];
  for (const x of staged) {
    const p = pins[x.slug];
    if (!p || 'unreachable' in p) {
      ok = false;
      lines.push(`  ${x.slug}: unreachable${p && 'unreachable' in p ? ` (${p.unreachable})` : ''}`);
      continue;
    }
    const v = p.version.startsWith('sha-') ? `sha-${short(p.commit)}` : `${p.version} (${short(p.commit)})`;
    const since = o.since(x.slug, p.version);
    const tail = since ? `, since ${since}` : '';
    if (o.target) lines.push(`  ${x.slug} ${o.isAncestor(o.target.commit, p.commit) ? '✓' : '✗'} ${v}${tail}`);
    else {
      const n = o.behind(p.commit);
      lines.push(`  ${x.slug} (stage ${x.stage}): ${v} — ${n === 0 ? 'at main' : `${n} commit${n > 1 ? 's' : ''} behind main`}${tail}`);
    }
  }
  return { text: lines.join('\n'), ok };
}
