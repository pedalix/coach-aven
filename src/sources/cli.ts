// `orch sources …` — the operator CLI for per-project source ingestion (docs/sources.md).
//
//   orch sources auth  <slug> <google|slack|msgraph> <action…>   one-time bootstrap / health checks
//   orch sources pull  <slug> [--only …] [--since …] [--full] [--calendars …] [--no-build] [--verbose]
//   orch sources build <slug>                                     rebuild store.sqlite + replica from raw/
//   orch sources audit <slug> [--no-gitleaks] [--gold FILE] [--dir EXTRA…]
//
// Everything here runs on the BOT HOST as the bot's own user: it reads the same projects
// config the bot does, holds the tokens the sandbox must never see, and writes data/<slug>/.
// PR-C puts `pull` on the poller loop; the CLI stays for bootstrap, backfills and audits.
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { loadProjects, type ProjectConfig } from '../projects.js';
import { log } from '../log.js';
import { runAudit } from './audit.js';
import { UsageError } from './errors.js';
import { runGoogleAuth } from './google/auth.js';
import { pullGoogle } from './google/pull.js';
import { runMsgraphAuth } from './msgraph/auth.js';
import { pullMsgraph } from './msgraph/pull.js';
import { dataDir, ensureDir, rawDir, replicaDir, storePath } from './paths.js';
import { buildStore, type BuildSummary } from './store.js';
import { dirname, resolve } from 'node:path';
import { runSlackAuth } from './slack/auth.js';
import { pullSlack } from './slack/pull.js';
import { tokenPath, vaultPathsFor } from './tokens.js';
import { SOURCE_KINDS, type GoogleKind, type MsgraphKind, type PullContext, type PullSummary, type SourceKind } from './types.js';

function project(slug: string): ProjectConfig {
  const cfg = loadConfig();
  const reg = loadProjects(cfg.projectsConfigPath);
  const p = reg.projects.find((x) => x.slug === slug);
  if (!p) throw new UsageError(`unknown project "${slug}" (known: ${reg.projects.map((x) => x.slug).join(', ')})`);
  return p;
}

/** People file: `sources.people` relative to projects.config.json, else projects.d/<slug>.people.json beside it. */
function peoplePath(p: ProjectConfig): string {
  const base = dirname(loadConfig().projectsConfigPath);
  return resolve(base, p.sources?.people ?? `projects.d/${p.slug}.people.json`);
}

function runBuild(p: ProjectConfig, verbose: boolean): BuildSummary {
  const prefix = `[sources:${p.slug}/store]`;
  const s = buildStore({
    slug: p.slug,
    rawDir: rawDir(p.slug),
    storePath: storePath(p.slug),
    replicaDir: replicaDir(p.slug),
    peoplePath: peoplePath(p),
    log: (line) => (verbose || !line.startsWith('  ') ? log.info(`${prefix} ${line}`) : undefined),
  });
  log.info(`${prefix} ${s.lines} new lines from ${s.files} files → messages ${s.messages}, events ${s.events}, files ${s.fileRecords}, tombstones ${s.tombstones}` +
    `${s.replayed ? `, replayed ${s.replayed}` : ''}${s.malformed ? `, malformed ${s.malformed}` : ''}; people ${s.people}; replica ${s.replica ?? '(none)'}`);
  for (const f of s.truncatedFiles) log.warn(`${prefix} ${f} shrank below its consumed offset — re-read from 0`);
  for (const f of s.skippedFiles) log.warn(`${prefix} ${f}: unknown raw file name, skipped`);
  return s;
}

function isKind(k: string): k is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(k);
}

function pullContext(slug: string, kind: SourceKind, verbose: boolean): PullContext {
  const out = ensureDir(rawDir(slug));
  ensureDir(dataDir(slug));
  const prefix = `[sources:${slug}/${kind}]`;
  return {
    slug,
    outDir: out,
    tokenPath: tokenPath(slug, kind),
    vault: vaultPathsFor(slug),
    log: (line) => (verbose || !line.startsWith('  ') ? log.info(`${prefix} ${line}`) : undefined),
  };
}

function printSummary(s: PullSummary): void {
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  log.info(`[sources:${s.kind}] ${s.ok ? 'ok' : 'FAILED'}${s.reauth ? ' (RE-AUTH REQUIRED)' : ''}: ${total} records; ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing new'}`);
  for (const e of s.errors) log.warn(`[sources:${s.kind}] ${e}`);
}

const csv = (v: string | undefined): string[] | undefined => v?.split(',').map((x) => x.trim()).filter(Boolean);

export function registerSourcesCommands(program: Command): void {
  const sources = program.command('sources').description('Per-project source ingestion: OAuth bootstrap, pulls, secret audits (docs/sources.md)').enablePositionalOptions();

  sources
    .command('auth <slug> <kind> [args...]')
    .description('Bootstrap or check credentials for one source kind of a project, e.g. `auth owen-ops google login --client pedalix`')
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (slug: string, kind: string, args: string[]) => {
      if (!isKind(kind)) throw new UsageError(`kind must be one of ${SOURCE_KINDS.join(', ')}`);
      const p = project(slug);
      const ctx = { slug: p.slug, tokenPath: tokenPath(p.slug, kind), log: (line: string) => process.stderr.write(`${line}\n`) };
      const code = kind === 'google' ? await runGoogleAuth(ctx, args) : kind === 'slack' ? await runSlackAuth(ctx, args) : await runMsgraphAuth(ctx, args);
      process.exitCode = code;
    });

  sources
    .command('pull <slug>')
    .description('Pull every configured source of a project into data/<slug>/raw (incremental; scrubbed at write)')
    .option('--only <kinds>', 'comma list of google,slack,msgraph')
    .option('--since <date>', 'YYYY-MM-DD lower bound for FIRST backfills (overrides the config)')
    .option('--full', 'ignore cursors and resync everything', false)
    .option('--calendars <ids>', 'extra Google calendar ids (comma list)')
    .option('--chats-full', 'msgraph: open every chat (daily edit/delete sweep)', false)
    .option('--no-build', 'leave store.sqlite and the replica as they are (default: build after the pull)')
    .option('--verbose', 'per-conversation / per-folder lines', false)
    .action(async (slug: string, o: { only?: string; since?: string; full: boolean; calendars?: string; chatsFull: boolean; build: boolean; verbose: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      const only = csv(o.only);
      const wanted = SOURCE_KINDS.filter((k) => p.sources![k] && (!only || only.includes(k)));
      if (!wanted.length) throw new UsageError(`nothing to pull (configured: ${SOURCE_KINDS.filter((k) => p.sources![k]).join(', ') || 'none'})`);
      let ok = true;
      let reauth = false;
      for (const kind of wanted) {
        const ctx = pullContext(p.slug, kind, o.verbose);
        let s: PullSummary;
        if (kind === 'google') {
          const g = p.sources.google!;
          s = await pullGoogle(ctx, {
            accounts: g.accounts,
            ...(g.kinds ? { kinds: g.kinds as GoogleKind[] } : {}),
            ...(o.since ?? g.since ? { since: o.since ?? g.since } : {}),
            full: o.full,
            calendars: [...(g.calendars ?? []), ...(csv(o.calendars) ?? [])],
          });
        } else if (kind === 'slack') {
          const sl = p.sources.slack!;
          s = await pullSlack(ctx, {
            workspaces: sl.workspaces,
            ...(o.since ?? sl.since ? { since: o.since ?? sl.since } : {}),
            ...(sl.threadWindowDays !== undefined ? { threadWindowDays: sl.threadWindowDays } : {}),
            ...(sl.editWindowHours !== undefined ? { editWindowHours: sl.editWindowHours } : {}),
          });
        } else {
          const m = p.sources.msgraph!;
          s = await pullMsgraph(ctx, {
            accounts: m.accounts.map((a) => (a.includes(':') ? a : `${m.tenant}:${a}`)),
            ...(m.only ? { only: m.only as MsgraphKind[] } : {}),
            ...(o.since ?? m.since ? { since: o.since ?? m.since } : {}),
            chatsFull: o.chatsFull,
            verbose: o.verbose,
          });
        }
        printSummary(s);
        ok &&= s.ok;
        reauth ||= s.reauth;
      }
      // Build even after a partial failure: whatever landed in raw/ should reach the replica.
      if (o.build) runBuild(p, o.verbose);
      // 3 = a human must re-run auth; 1 = something failed; mirrors the pullers' own codes.
      process.exitCode = reauth ? 3 : ok ? 0 : 1;
    });

  sources
    .command('build <slug>')
    .description('Rebuild data/<slug>/store.sqlite incrementally from raw/ and publish the read-only replica')
    .option('--verbose', 'per-file lines', false)
    .action((slug: string, o: { verbose: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      runBuild(p, o.verbose);
    });

  sources
    .command('audit <slug>')
    .description('Scan data/<slug> (raw + replica + vault-free) and the gold set for secrets that got through')
    .option('--no-gitleaks', 'skip the gitleaks second opinion')
    .option('--gold <file>', 'gold set to measure recall on (default src/fixtures/scrub-gold.jsonl)')
    .option('--dir <dirs>', 'extra directories (comma list), e.g. the bot event log')
    .action((slug: string, o: { gitleaks: boolean; gold?: string; dir?: string }) => {
      project(slug); // validates the slug against the registry
      const dirs = [rawDir(slug), `${dataDir(slug)}/replica`, ...(csv(o.dir) ?? [])];
      process.exitCode = runAudit({ dirs, gitleaks: o.gitleaks, ...(o.gold ? { gold: o.gold } : {}) });
    });
}
