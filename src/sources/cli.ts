// `orch sources …` — the operator CLI for per-project source ingestion (docs/sources.md).
//
//   orch sources auth  <slug> <google|slack|msgraph|youtrack|jira|asana> <action…>   one-time bootstrap / health checks
//   orch sources pull  <slug> [--only …] [--since …] [--full] [--calendars …] [--no-build] [--verbose]
//   orch sources build <slug>                                     rebuild store.sqlite + replica from raw/
//   orch sources audit <slug> [--no-gitleaks] [--gold FILE] [--dir EXTRA…]
//   orch sources serve <slug> [--listen host:port]               the sources tools over MCP streamable HTTP (SOURCES_SERVE_TOKEN)
//   orch sources daemon [--listen host:port] [--only a,b]       ingest + serve where the data lives (SOURCES_DAEMON_TOKEN; OpenSpec sources-daemon)
//   orch sources attribution redo <slug> --since D [--until D]   unpin a window's rule decisions; the next build re-decides them
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
import { configuredKinds, pinsPath, pullProject, refreshTenant, runAuth, runBuild, tenantZone } from './run.js';
import { openReadOnly } from './store.js';
import { pinnedIdsBetween } from './attribution/build.js';
import { appendPinLines, readPins, unpinLines } from './attribution/pins.js';
import { normalizeTime } from '../../snapshot/plain/sources-mcp.mjs';
import { tokenPath } from './tokens.js';
import { DEFAULT_LISTEN, replicaPathFor, SERVE_TOKEN_ENV, startServe } from './serve.js';
import { DAEMON_LISTEN, DAEMON_TOKEN_ENV, runDaemon } from './daemon.js';
import { describeLock, otherWriter } from './lock.js';
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

/** One writer per data directory (lock.ts): a manual pull/build waits for the bot or the daemon unless forced. */
function notWhileIngested(slug: string, force: boolean): void {
  const holder = otherWriter(slug);
  if (!holder) return;
  if (!force) throw new UsageError(`${slug} is ingested by ${describeLock(holder)} — its next pass does this anyway; --force to run now (only when no pass is in flight)`);
  process.stderr.write(`warning: ${slug} is ingested by ${describeLock(holder)}; running anyway (--force)\n`);
}

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
    .option('--force', 'run even while the bot or a sources daemon ingests this project (only when no pass is in flight)', false)
    .action(async (slug: string, o: { only?: string; since?: string; full: boolean; calendars?: string; chatsFull: boolean; build: boolean; verbose: boolean; force: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      notWhileIngested(slug, o.force);
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
    .option('--force', 'run even while the bot or a sources daemon ingests this project (only when no pass is in flight)', false)
    .action(async (slug: string, o: { verbose: boolean; force: boolean }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      notWhileIngested(slug, o.force);
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
    .command('serve <slug>')
    .description(`Serve the project's sources tools over MCP streamable HTTP from its replica (bearer from ${SERVE_TOKEN_ENV}; put nginx/agentgateway in front — docs/sources.md → Remote access)`)
    .option('--listen <hostport>', 'bind address', DEFAULT_LISTEN)
    .option('--db <path>', 'replica file (default data/<slug>/replica/store.sqlite)')
    .action(async (slug: string, o: { listen: string; db?: string }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      const token = process.env[SERVE_TOKEN_ENV] ?? '';
      if (!token) throw new UsageError(`${SERVE_TOKEN_ENV} is not set — refusing to serve a tenant store unauthenticated`);
      const server = await startServe(o.listen, { dbPath: o.db ?? replicaPathFor(p.slug), token, slug: p.slug });
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  sources
    .command('daemon')
    .description(`Ingest (pull → build → replica, per project interval) and serve every project with a sources block — or --only — over HTTP: POST /mcp/<slug>, GET /status/<slug> (bearer from ${DAEMON_TOKEN_ENV}). The bot then forwards with \`sources.daemon\` and stops ingesting with SOURCES_DAEMON=1.`)
    .option('--listen <hostport>', 'bind address', DAEMON_LISTEN)
    .option('--only <slugs>', 'comma list of projects (default: every project with a sources block)')
    .action(async (o: { listen: string; only?: string }) => {
      const token = process.env[DAEMON_TOKEN_ENV] ?? '';
      if (!token) throw new UsageError(`${DAEMON_TOKEN_ENV} is not set — refusing to serve tenant stores unauthenticated`);
      const reg = loadProjects(loadConfig().projectsConfigPath);
      const only = csv(o.only);
      const projects = reg.projects.filter((p) => p.sources && (!only || only.includes(p.slug)));
      const unknown = (only ?? []).filter((s) => !projects.some((p) => p.slug === s));
      if (unknown.length) throw new UsageError(`no sources project ${unknown.join(', ')} (known: ${reg.projects.filter((p) => p.sources).map((p) => p.slug).join(', ')})`);
      if (!projects.length) throw new UsageError('no project with a sources block to serve');
      const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
      let d: Awaited<ReturnType<typeof runDaemon>>;
      try {
        d = await runDaemon({ projects, listen: o.listen, token, log });
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      // First pass soon after start, as the bot does; then the minute tick inside runDaemon.
      setTimeout(() => void d.tick().catch((e: unknown) => log(`sources daemon tick: ${e instanceof Error ? e.message : String(e)}`)), 5_000);
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        log('sources daemon: stopping (a pass in flight finishes first)');
        void d.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  sources
    .command('attribution')
    .description('The attribution layer (docs/sources.md → Attribution)')
    .command('redo <slug>')
    .description("Unpin a window's rule decisions (days in the tenant's zone); the next build decides them with the current rules and pins them again once closed")
    .requiredOption('--since <day>', 'first day, YYYY-MM-DD')
    .option('--until <day>', 'last day, YYYY-MM-DD (default: --since)')
    .action((slug: string, o: { since: string; until?: string }) => {
      const p = project(slug);
      if (!p.sources) throw new UsageError(`project "${slug}" has no "sources" block in projects.config.json`);
      const tz = tenantZone(p);
      const lo = normalizeTime(o.since, 'since', tz)!;
      const hi = normalizeTime(o.until ?? o.since, 'until', tz)!;
      const db = openReadOnly(replicaPathFor(p.slug));
      try {
        const path = pinsPath(p.slug);
        const lines = unpinLines(readPins(path), pinnedIdsBetween(db, lo, hi), new Date().toISOString());
        appendPinLines(path, lines);
        console.log(`${slug}: unpinned ${lines.length} rule decision(s) between ${o.since} and ${o.until ?? o.since} (${tz}); the next build re-decides them`);
      } finally {
        db.close();
      }
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
