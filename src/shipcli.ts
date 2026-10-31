// `npm run ship` and `npm run where` (OpenSpec ship-dispatcher): gather the facts the planner needs (overlays, what each
// installation runs, main's CI and images, tags, ancestry, merged PRs), then run the plan's steps — tag, wait for the
// release workflow, `deploy.sh <slug> deploy <version>` — under one lock, one journal line per step. Decisions live in
// ship.ts; this file only talks to git, gh, docker and deploy.sh, through a Runner the tests replace.
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  journalLine, journalSince, parseOverlay, planShip, renderPlan, whereReport,
  type MainCommit, type Overlay, type Pin, type Pr, type ShipFacts, type Step,
} from './ship.js';
import { acquireShipLock } from './shiplock.js';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface Runner {
  // Captures output unless `inherit` (deploy.sh and the release watch print their progress to the operator).
  run(cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number; inherit?: boolean }): RunResult;
  runAsync(cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
}

export const realRunner: Runner = {
  run(cmd, args, o = {}) {
    const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', timeout: o.timeoutMs, stdio: o.inherit ? 'inherit' : 'pipe' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
  },
  runAsync(cmd, args, o = {}) {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      const t = o.timeoutMs ? setTimeout(() => { stderr += `timed out after ${o.timeoutMs! / 1000} s`; p.kill('SIGKILL'); }, o.timeoutMs) : undefined;
      p.on('close', (code) => { if (t) clearTimeout(t); resolve({ status: code ?? 1, stdout, stderr }); });
      p.on('error', (e) => { if (t) clearTimeout(t); resolve({ status: 1, stdout, stderr: String(e) }); });
    });
  },
};

export interface Deps {
  root: string; // the checkout that holds the overlays (infra/<slug>/deploy.env)
  runner: Runner;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => void;
}

const DEFAULT_IMAGE = 'ghcr.io/pedalix/coach-aven';
const PIN_TIMEOUT_MS = 10_000;
const RELEASE_WAIT_MS = 20 * 60_000;

const git = (d: Deps, ...args: string[]) => d.runner.run('git', args, { cwd: d.root });
const ok = (r: RunResult) => r.status === 0;
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const short = (c: string) => c.slice(0, 7);

export function readOverlays(root: string): { overlays: Overlay[]; images: Record<string, string> } {
  const dir = `${root}/infra`;
  const overlays: Overlay[] = [];
  const images: Record<string, string> = {};
  if (!existsSync(dir)) return { overlays, images };
  for (const slug of readdirSync(dir).sort()) {
    const f = `${dir}/${slug}/deploy.env`;
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    overlays.push(parseOverlay(slug, text));
    const m = [...text.matchAll(/^\s*IMAGE=["']?([^"'\s]+)/gm)].at(-1);
    images[slug] = m?.[1] ?? DEFAULT_IMAGE;
  }
  return { overlays, images };
}

// No overlays here: a worktree. Name the checkout that has them (the first `git worktree list` entry, the main one).
function overlaysElsewhere(d: Deps): string {
  const main = lines(git(d, 'worktree', 'list', '--porcelain').stdout).find((l) => l.startsWith('worktree '))?.slice(9);
  return main && main !== d.root
    ? `no overlays under ${d.root}/infra — ship and where run in the checkout that holds them: cd ${main}`
    : `no overlays under ${d.root}/infra (infra/<slug>/deploy.env)`;
}

// What each staged installation runs, read where it runs, in parallel; a version maps to its commit through git.
export async function readPins(d: Deps, overlays: Overlay[]): Promise<Record<string, Pin>> {
  const staged = overlays.filter((o) => o.stage !== undefined);
  const read = await Promise.all(
    staged.map((o) => d.runner.runAsync('bash', [`${d.root}/infra/deploy/deploy.sh`, o.slug, 'pinned'], { cwd: d.root, timeoutMs: PIN_TIMEOUT_MS })),
  );
  const pins: Record<string, Pin> = {};
  staged.forEach((o, i) => {
    const r = read[i];
    const version = r.stdout.trim();
    if (!ok(r) || !version) {
      pins[o.slug] = { unreachable: lines(r.stderr).at(-1)?.replace(/^✗\s*/, '') || `deploy.sh pinned exited ${r.status}` };
      return;
    }
    const sha = version.match(/^sha-([0-9a-f]{40})$/);
    const commit = sha ? sha[1] : git(d, 'rev-list', '-n1', `refs/tags/${version}`).stdout.trim();
    pins[o.slug] = commit ? { version, commit } : { unreachable: `pinned ${version}, which is not a tag in this clone (git fetch --tags)` };
  });
  return pins;
}

// main's first parent, newest first, with CI state; the image is checked newest-first until one is found — the
// planner takes the first green commit with an image and never looks further.
function readMain(d: Deps, image: string): MainCommit[] {
  const commits = lines(git(d, 'rev-list', '--first-parent', '-n', '30', 'origin/main').stdout);
  const runs = JSON.parse(d.runner.run('gh', ['run', 'list', '-w', 'ci.yml', '-b', 'main', '-e', 'push', '-L', '100', '--json', 'headSha,status,conclusion'], { cwd: d.root }).stdout || '[]') as {
    headSha: string; status: string; conclusion: string;
  }[];
  const ci = new Map<string, MainCommit['ci']>();
  for (const r of runs) if (!ci.has(r.headSha)) ci.set(r.headSha, r.status !== 'completed' ? 'pending' : r.conclusion === 'success' ? 'success' : 'failure');
  let found = false;
  return commits.map((commit) => {
    const state = ci.get(commit) ?? 'none';
    let img = false;
    if (state === 'success' && !found) {
      img = ok(d.runner.run('docker', ['manifest', 'inspect', `${image}:sha-${commit}`], { timeoutMs: 30_000 }));
      found = img;
    }
    return { commit, ci: state, image: img };
  });
}

function prReader(d: Deps): (from: string | undefined, to: string) => Pr[] {
  let cache: Map<number, Pr> | undefined;
  const pr = (n: number): Pr => {
    if (!cache) {
      const list = JSON.parse(d.runner.run('gh', ['pr', 'list', '--state', 'merged', '-L', '300', '--json', 'number,title,labels'], { cwd: d.root }).stdout || '[]') as {
        number: number; title: string; labels: { name: string }[];
      }[];
      cache = new Map(list.map((p) => [p.number, { number: p.number, title: p.title, labels: p.labels.map((l) => l.name) }]));
    }
    if (!cache.has(n)) {
      const r = d.runner.run('gh', ['pr', 'view', String(n), '--json', 'number,title,labels'], { cwd: d.root });
      const p = ok(r) ? (JSON.parse(r.stdout) as { title: string; labels: { name: string }[] }) : { title: '(unknown)', labels: [] };
      cache.set(n, { number: n, title: p.title, labels: p.labels.map((l) => l.name) });
    }
    return cache.get(n)!;
  };
  return (from, to) => {
    if (!from) return [];
    const subjects = lines(git(d, 'log', '--first-parent', '--format=%s', `${from}..${to}`).stdout);
    return subjects
      .map((s) => s.match(/^Merge pull request #(\d+)/)?.[1])
      .filter((n): n is string => !!n)
      .map(Number)
      .reverse()
      .map(pr);
  };
}

export async function gatherFacts(d: Deps, overlays: Overlay[], images: Record<string, string>): Promise<ShipFacts> {
  if (!ok(git(d, 'fetch', '-q', 'origin', 'main', '--tags'))) d.err('! git fetch failed — working from the local refs');
  const staged = overlays.filter((o) => o.stage !== undefined).sort((a, b) => a.stage! - b.stage!);
  const pins = await readPins(d, overlays);
  return {
    overlays,
    pins,
    main: readMain(d, images[staged[0]?.slug] ?? DEFAULT_IMAGE),
    isAncestor: (a, b) => a === b || ok(git(d, 'merge-base', '--is-ancestor', a, b)),
    tagCommit: (t) => git(d, 'rev-list', '-n1', `refs/tags/${t}`).stdout.trim() || undefined,
    tagsAt: (c) => lines(git(d, 'tag', '--points-at', c, '-l', 'v*').stdout),
    releaseTagsReachable: (c) => lines(git(d, 'tag', '--merged', c, '-l', 'v*').stdout),
    prsBetween: prReader(d),
  };
}

// The tag's release workflow: wait for its run to appear, watch it, report its conclusion.
function waitForRelease(d: Deps, tag: string): { ok: boolean; url?: string } {
  const deadline = d.now().getTime() + 2 * 60_000;
  let run: { databaseId: number; url: string } | undefined;
  while (!run && d.now().getTime() < deadline) {
    const list = JSON.parse(d.runner.run('gh', ['run', 'list', '-w', 'release.yml', '-L', '20', '--json', 'databaseId,headBranch,url'], { cwd: d.root }).stdout || '[]') as {
      databaseId: number; headBranch: string; url: string;
    }[];
    run = list.find((r) => r.headBranch === tag);
    if (!run) d.sleep(5_000);
  }
  if (!run) return { ok: false };
  d.out(`▶ waiting for the release workflow: ${run.url}`);
  d.runner.run('gh', ['run', 'watch', String(run.databaseId), '--exit-status', '--interval', '15'], { cwd: d.root, timeoutMs: RELEASE_WAIT_MS, inherit: true });
  const v = JSON.parse(d.runner.run('gh', ['run', 'view', String(run.databaseId), '--json', 'conclusion'], { cwd: d.root }).stdout || '{}') as { conclusion?: string };
  return { ok: v.conclusion === 'success', url: run.url };
}

// Run the steps in stage order; stop at the first failure. One journal line per step that was attempted.
export function executeSteps(d: Deps, steps: Step[]): number {
  mkdirSync(`${d.root}/infra`, { recursive: true });
  const journal = `${d.root}/infra/ships.log`;
  const tagged = new Set<string>();
  for (const s of steps) {
    const fail = (why: string): number => {
      appendFileSync(journal, journalLine(d.now(), s, 'failed'));
      const back = s.from ? ` — it still runs ${s.from.version}, or roll back with: npm run ship -- ${s.slug} --version ${s.from.version}` : '';
      d.err(`✗ ${s.slug}: ${why}${back}. Later stages were not touched.`);
      return 1;
    };
    if (s.createTag && !tagged.has(s.version)) {
      d.out(`▶ tagging ${s.version} on ${short(s.commit)}`);
      if (!ok(git(d, 'tag', s.version, s.commit))) return fail(`could not create tag ${s.version}`);
      // A tag that never reached origin must not stay local: the planner would take it for an existing release on the
      // next run and deploy a version whose image was never published.
      if (!ok(git(d, 'push', 'origin', s.version))) return git(d, 'tag', '-d', s.version), fail(`could not push tag ${s.version} (the local tag is removed; run ship again)`);
      tagged.add(s.version);
      const rel = waitForRelease(d, s.version);
      if (!rel.ok) return fail(rel.url ? `the release workflow for ${s.version} did not succeed: ${rel.url}` : `no release workflow run appeared for ${s.version}`);
    }
    d.out(`▶ ${s.slug} (stage ${s.stage}) → ${s.version}`);
    const r = d.runner.run('bash', [`${d.root}/infra/deploy/deploy.sh`, s.slug, 'deploy', s.version], { cwd: d.root, inherit: true });
    if (!ok(r)) return fail(`deploy of ${s.version} failed`);
    appendFileSync(journal, journalLine(d.now(), s, 'ok'));
    d.out(`✓ ${s.slug} runs ${s.version}`);
  }
  return 0;
}

export async function runShip(d: Deps, o: { targets: string[]; plan: boolean; commit?: string; version?: string }): Promise<number> {
  const { overlays, images } = readOverlays(d.root);
  if (!overlays.length) return d.err(overlaysElsewhere(d)), 1;
  let commit: string | undefined;
  if (o.commit) {
    const r = git(d, 'rev-parse', '--verify', '--quiet', `${o.commit}^{commit}`);
    if (!ok(r)) return d.err(`✗ ${o.commit} is not a commit here (git fetch?)`), 1;
    commit = r.stdout.trim();
  }
  // The lock spans reading the pins through the last deploy, so a plan is never executed against stale facts.
  let release: (() => void) | undefined;
  if (!o.plan) {
    const lock = acquireShipLock(`${d.root}/infra/.ship.lock`, o.targets);
    if (!lock.ok) return d.err(`✗ ${lock.message}`), 1;
    if (lock.note) d.err(`! ${lock.note}`);
    release = lock.release;
    const onSignal = (sig: NodeJS.Signals) => { lock.release(); process.kill(process.pid, sig); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    const plan = planShip({ targets: o.targets, ...(commit ? { commit } : {}), ...(o.version ? { version: o.version } : {}) }, await gatherFacts(d, overlays, images));
    if ('refusal' in plan) return d.err(`✗ ${plan.refusal}`), 1;
    d.out(renderPlan(plan));
    // A tag push that would fail on credentials (a locked keyring after a reboot) shows before anything moves.
    for (const s of plan.steps.filter((x) => x.createTag)) {
      const r = git(d, 'push', '--dry-run', 'origin', `${s.commit}:refs/tags/${s.version}`);
      if (!ok(r)) return d.err(`✗ cannot push tag ${s.version}: ${lines(r.stderr).at(-1) ?? 'git push --dry-run failed'}`), 1;
      if (o.plan) d.out(`push access for ${s.version}: ok`);
    }
    if (o.plan || !plan.steps.length) return 0;
    return executeSteps(d, plan.steps);
  } finally {
    release?.();
  }
}

export async function runWhere(d: Deps, ref?: string): Promise<number> {
  const { overlays } = readOverlays(d.root);
  if (!overlays.length) return d.err(overlaysElsewhere(d)), 1;
  if (!ok(git(d, 'fetch', '-q', 'origin', 'main', '--tags'))) d.err('! git fetch failed — working from the local refs');
  let target: { label: string; commit: string } | undefined;
  if (ref) {
    const pr = ref.match(/^#?(\d+)$/);
    if (pr) {
      const r = d.runner.run('gh', ['pr', 'view', pr[1], '--json', 'state,mergeCommit'], { cwd: d.root });
      const v = ok(r) ? (JSON.parse(r.stdout) as { state: string; mergeCommit?: { oid: string } | null }) : undefined;
      if (!v) return d.err(`✗ no PR #${pr[1]}`), 1;
      if (v.state !== 'MERGED' || !v.mergeCommit) return d.err(`✗ PR #${pr[1]} is ${v.state.toLowerCase()}, not merged — it runs nowhere`), 1;
      target = { label: `#${pr[1]}`, commit: v.mergeCommit.oid };
    } else {
      const r = git(d, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      if (!ok(r)) return d.err(`✗ ${ref} is neither a PR number nor a commit here`), 1;
      target = { label: ref, commit: r.stdout.trim() };
    }
  }
  const journalPath = `${d.root}/infra/ships.log`;
  const journal = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
  const report = whereReport(overlays, await readPins(d, overlays), {
    ...(target ? { target } : {}),
    isAncestor: (a, b) => a === b || ok(git(d, 'merge-base', '--is-ancestor', a, b)),
    behind: (c) => Number(git(d, 'rev-list', '--count', `${c}..origin/main`).stdout.trim() || 0),
    since: (slug, version) => journalSince(journal, slug, version),
  });
  d.out(report.text);
  return report.ok ? 0 : 1;
}

function deps(): Deps {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) {
    console.error('✗ run ship and where inside the checkout that holds the overlays (infra/<slug>/)');
    process.exit(1);
  }
  return {
    root: top.stdout.trim(),
    runner: realRunner,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    now: () => new Date(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const program = new Command().name('npm run').description('Move installations in stage order, and see what runs where (OpenSpec ship-dispatcher)');
  program
    .command('ship')
    .description('deploy the named installations in STAGE order: the lowest stage gets the newest green main, every later stage what the stage below runs')
    .argument('<slugs...>', 'installations (infra/<slug>/ with STAGE=<n> in deploy.env)')
    .option('--plan', 'print what would ship and change nothing')
    .option('--commit <ref>', 'ship this commit (a later stage still only takes what a lower stage runs)')
    .option('--version <version>', 'vX.Y.Z (an existing release: a rollback or re-ship; a new one: the tag to create) or sha-<commit> for a canary')
    .action(async (slugs: string[], opts: { plan?: boolean; commit?: string; version?: string }) => {
      process.exitCode = await runShip(deps(), { targets: slugs, plan: !!opts.plan, ...(opts.commit ? { commit: opts.commit } : {}), ...(opts.version ? { version: opts.version } : {}) });
    });
  program
    .command('where')
    .description('what each staged installation runs; with a PR number or a commit, whether each runs it')
    .argument('[ref]', 'a PR number (#142 or 142) or a commit')
    .action(async (ref?: string) => {
      process.exitCode = await runWhere(deps(), ref);
    });
  await program.parseAsync(process.argv);
}
