// `orch sources …` — the operator CLI for per-project source ingestion (docs/sources.md).
//
//   orch sources auth  <slug> <google|slack|msgraph|youtrack|jira|asana> <action…>   one-time bootstrap / health checks
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
import { runAudit } from './audit.js';
import { UsageError } from './errors.js';
import { ageDecrypt, rescrubDir } from './common/rescrub.js';
import { dataDir, rawDir, vaultDir } from './paths.js';
import { configuredKinds, pullProject, refreshTenant, runAuth, runBuild } from './run.js';
import { tokenPath } from './tokens.js';
import { SOURCE_KINDS, type SourceKind } from './types.js';

function project(slug: string): ProjectConfig {
  const cfg = loadConfig();
  const reg = loadProjects(cfg.projectsConfigPath);
  const p = reg.projects.find((x) => x.slug === slug);
  if (!p) throw new UsageError(`unknown project "${slug}" (known: ${reg.projects.map((x) => x.slug).join(', ')})`);
  return p;
}

function isKind(k: string): k is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(k);
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
      process.exitCode = await runAuth(ctx, kind, args, p);
    });

  sources
    .command('pull <slug>')
    .description('Pull every configured source of a project into data/<slug>/raw (incremental; scrubbed at write)')
    .option('--only <kinds>', 'comma list of google,slack,msgraph,youtrack,jira,asana,meetings,local')
    .option('--since <date>', 'YYYY-MM-DD lower bound for FIRST backfills (overrides the config)')
    .option('--full', 'ignore cursors and resync everything', false)
    .option('--calendars <ids>', 'extra Google calendar ids (comma list)')
    .option('--chats-full', 'msgraph: open every chat (daily edit/delete sweep)', false)
    .option('--no-build', 'leave store.sqlite and the replica as they are (default: build after the pull)')
    .option('--verbose', 'per-conversation / per-folder lines', false)
    .action(async (slug: string, o: { only?: string; since?: string; full: boolean; calendars?: string; chatsFull: boolean; build: boolean; verbose: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      const only = csv(o.only)?.filter(isKind);
      const wanted = configuredKinds(p).filter((k) => !only || only.includes(k));
      if (!wanted.length) throw new UsageError(`nothing to pull (configured: ${configuredKinds(p).join(', ') || 'none'})`);
      const r = await pullProject(p, {
        only: wanted,
        ...(o.since ? { since: o.since } : {}),
        full: o.full,
        ...(csv(o.calendars) ? { calendars: csv(o.calendars)! } : {}),
        chatsFull: o.chatsFull,
        build: o.build,
        verbose: o.verbose,
      });
      // 3 = a human must re-run auth; 1 = something failed; mirrors the pullers' own codes.
      process.exitCode = r.reauth ? 3 : r.ok ? 0 : 1;
    });

  sources
    .command('build <slug>')
    .description('Rebuild data/<slug>/store.sqlite incrementally from raw/ and publish the read-only replica')
    .option('--verbose', 'per-file lines', false)
    .action(async (slug: string, o: { verbose: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      await refreshTenant(p);
      runBuild(p, o.verbose);
    });

  sources
    .command('rescrub <slug>')
    .description('Replay the current scrubber rules over withheld bodies in data/<slug>/raw: bodies that are no longer carriers are appended inline-scrubbed (the next build picks them up)')
    .requiredOption('--identity <file>', 'age identity (private key) matching the project\'s vault.recipient — the bot host holds only the public half')
    .option('--write', 'append the restored records (default: dry run, counts only)', false)
    .option('--verbose', 'one line per restored record', false)
    .action((slug: string, o: { identity: string; write: boolean; verbose: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      const c = rescrubDir(rawDir(p.slug), {
        decrypt: ageDecrypt(vaultDir(p.slug), o.identity),
        write: o.write,
        ...(o.verbose ? { log: (line: string) => process.stderr.write(`${line}\n`) } : {}),
      });
      const why = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
      process.stderr.write(
        `${o.write ? 'restored' : 'would restore'} ${c.restored} of ${c.withheld} withheld records in ${c.files} files ` +
          `(still carriers ${c.stillWithheld}${why ? `: ${why}` : ''}; no vault entry ${c.noVault}; not message-shaped ${c.skipped})\n`,
      );
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
