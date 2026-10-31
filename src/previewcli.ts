// `npm run preview` / `npm run preview -- stop [--clean]` (OpenSpec ship-dispatcher, spec `worktree-preview`): this
// checkout's code as a loopback web-chat bot on the quickstart's one scratch project, in .preview/ of the checkout.
// The files are built by preview.ts from the quickstart templates and the operator's preview.env; this file only
// finds a port, starts the bot detached, waits for its running line, and on stop removes the process and its sandboxes.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { PREVIEW_PORT_FROM, buildPreview, childEnv, parseEnvFile, previewPrefix } from './preview.js';

const HEALTH_LINE = 'Web chat running';
const START_WAIT_MS = 90_000;

const sh = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (dir: string): number | undefined => {
  const n = existsSync(`${dir}/pid`) ? Number(readFileSync(`${dir}/pid`, 'utf8').trim()) : NaN;
  return Number.isInteger(n) && n > 0 && alive(n) ? n : undefined;
};
const freePort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(root: string, branch: string, dir: string): Promise<number> {
  const running = readPid(dir);
  if (running) {
    console.log(`preview already running (pid ${running}): http://127.0.0.1:${readFileSync(`${dir}/port`, 'utf8').trim()}`);
    return 0;
  }
  const envPath = process.env.PREVIEW_ENV || `${homedir()}/.config/coach-aven/preview.env`;
  const needed = 'CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY), GITHUB_APP_ID + an absolute GITHUB_APP_PRIVATE_KEY_PATH (or a fine-grained GITHUB_TOKEN on the scratch repository), PREVIEW_REPO=<owner/repo>';
  if (!existsSync(envPath)) return console.error(`✗ no ${envPath} — create it with ${needed} (docs/local-dev.md → Preview)`), 1;

  // A worktree commit has no published image: the plain sandbox image of the newest release, unless preview.env names one.
  const newest = sh('git', ['tag', '-l', 'v*', '--sort=-v:refname'], root).stdout.split('\n')[0]?.trim();
  let port = PREVIEW_PORT_FROM;
  while (!(await freePort(port))) port++;
  const built = buildPreview(
    { envExample: readFileSync(`${root}/quickstart/.env.example`, 'utf8'), projectsExample: readFileSync(`${root}/quickstart/projects.config.example.json`, 'utf8') },
    parseEnvFile(readFileSync(envPath, 'utf8')),
    { port, branch, sandboxImage: `ghcr.io/pedalix/coach-aven-sandbox-plain:${newest || 'latest'}` },
  );
  if ('missing' in built) return console.error(`✗ ${envPath} lacks: ${built.missing.join(', ')}`), 1;

  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/.env`, built.env, { mode: 0o600 });
  chmodSync(`${dir}/.env`, 0o600);
  writeFileSync(`${dir}/projects.config.json`, built.projects);
  writeFileSync(`${dir}/port`, `${port}\n`);
  const logPath = `${dir}/bot.log`;
  const log = openSync(logPath, 'w');
  const bot = spawn(process.execPath, ['--import', 'tsx', `${root}/src/cli.ts`, 'web'], {
    cwd: root,
    env: childEnv(process.env, dir),
    detached: true,
    stdio: ['ignore', log, log],
  });
  bot.unref();
  writeFileSync(`${dir}/pid`, `${bot.pid}\n`);
  console.log(`▶ preview of ${branch} (pid ${bot.pid}, log ${logPath})`);

  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    await sleep(1000);
    const text = readFileSync(logPath, 'utf8');
    if (text.includes(HEALTH_LINE)) {
      console.log(`✓ http://127.0.0.1:${port} — the demo project on ${parseEnvFile(readFileSync(envPath, 'utf8')).PREVIEW_REPO}; stop with: npm run preview -- stop`);
      return 0;
    }
    if (!alive(bot.pid!)) break;
  }
  console.error(`✗ the preview did not report '${HEALTH_LINE}' — the end of ${logPath}:`);
  console.error(readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n'));
  await stop(branch, dir, false);
  return 1;
}

async function stop(branch: string, dir: string, clean: boolean): Promise<number> {
  const pid = readPid(dir);
  if (pid) {
    process.kill(-pid, 'SIGTERM'); // the detached group: the bot and anything it spawned
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
    if (alive(pid)) process.kill(-pid, 'SIGKILL');
    console.log(`✓ stopped the preview (pid ${pid})`);
  } else console.log('no preview process running here');
  const prefix = previewPrefix(branch);
  const ids = sh('docker', ['ps', '-aq', '--filter', `name=^${prefix}`]).stdout.split('\n').filter(Boolean);
  if (ids.length) {
    sh('docker', ['rm', '-f', ...ids]);
    console.log(`✓ removed ${ids.length} sandbox container${ids.length > 1 ? 's' : ''} (${prefix}*)`);
  }
  rmSync(`${dir}/pid`, { force: true });
  if (clean) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`✓ removed ${dir}`);
  }
  return 0;
}

const top = sh('git', ['rev-parse', '--show-toplevel']);
if (top.status !== 0) {
  console.error('✗ run npm run preview inside a checkout of the repository');
  process.exit(1);
}
const root = top.stdout.trim();
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout.trim();
const dir = `${root}/.preview`;
const args = process.argv.slice(2);
process.exitCode = args[0] === 'stop' ? await stop(branch, dir, args.includes('--clean')) : await start(root, branch, dir);
