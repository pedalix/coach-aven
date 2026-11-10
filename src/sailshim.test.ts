// The laravel sandbox image's Sail shim (OpenSpec laravel-sandbox-image), run through a symlink of each name the
// image gives it, against a stub `docker` and a fake `vendor/bin/sail` that print their arguments — and the Dockerfile
// lines the shim relies on: the four names, the user Sail runs its commands as, the plain image's tool list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = new URL('../snapshot/shims/sail-shim.sh', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const NAMES = ['php', 'composer', 'artisan', 'sail'];

/** A sandbox in miniature: `bin/` with the shim under its four names and a `docker` that prints its arguments, and
 *  a checkout `app/` — with a `vendor/bin/sail` that prints its own path and arguments when `vendor` is asked for. */
function box(o: { vendor?: boolean } = {}): { bin: string; app: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aven-shim-')));
  const bin = join(dir, 'bin');
  const app = join(dir, 'app');
  mkdirSync(bin);
  mkdirSync(join(app, 'app/Http'), { recursive: true });
  for (const n of NAMES) symlinkSync(SHIM, join(bin, n));
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' docker "$@"\n');
  chmodSync(join(bin, 'docker'), 0o755);
  if (o.vendor) {
    mkdirSync(join(app, 'vendor/bin'), { recursive: true });
    writeFileSync(join(app, 'vendor/bin/sail'), '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\n');
    chmodSync(join(app, 'vendor/bin/sail'), 0o755);
  }
  return { bin, app };
}

function run(b: { bin: string; app: string }, name: string, args: string[], cwd = b.app): { status: number | null; out: string[]; err: string } {
  const r = spawnSync(join(b.bin, name), args, { cwd, env: { PATH: `${b.bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.split('\n').filter(Boolean), err: r.stderr };
}

/** What the bootstrap hands `docker`, up to the composer arguments. */
const bootstrap = (cwd: string): string[] => [
  'docker', 'run', '--rm',
  '-u', `${process.getuid!()}:${process.getgid!()}`,
  '-v', `${cwd}:/var/www/html`,
  '-w', '/var/www/html',
  '-e', 'COMPOSER_IGNORE_PLATFORM_REQS=1',
  'composer:2',
  'composer',
];

test('composer before vendor/ exists: the Composer image, as the caller, platform requirements ignored — the arguments as typed', () => {
  const b = box();
  for (const args of [['install'], ['install', '--no-dev', '--no-interaction'], ['-d', 'shop', 'install'], ['require', 'acme/widgets'], ['create-project', 'laravel/laravel', 'shop'], ['--version'], []]) {
    const r = run(b, 'composer', args);
    assert.equal(r.status, 0, args.join(' '));
    assert.deepEqual(r.out, [...bootstrap(b.app), ...args], args.join(' '));
    assert.match(r.err, /^\[sail-shim\] no vendor\/ yet — bootstrapping composer in a throwaway container \(.*not the project's PHP.*\)\n$/, 'one line saying whose PHP this is');
  }
  // The mount is the directory composer was called in, nested or not.
  const nested = join(b.app, 'app/Http');
  assert.deepEqual(run(b, 'composer', ['install'], nested).out, [...bootstrap(nested), 'install']);
});

test('with vendor/bin/sail: php, composer and artisan forward as Sail commands, `sail` as typed — from any depth of the checkout', () => {
  const b = box({ vendor: true });
  const sail = join(b.app, 'vendor/bin/sail');
  for (const cwd of [b.app, join(b.app, 'app/Http')]) {
    assert.deepEqual(run(b, 'php', ['artisan', 'test', '--parallel'], cwd).out, [sail, 'php', 'artisan', 'test', '--parallel']);
    assert.deepEqual(run(b, 'artisan', ['migrate'], cwd).out, [sail, 'artisan', 'migrate']);
    // Inside Sail it is the project's own PHP: nothing is ignored, and no throwaway container runs.
    const c = run(b, 'composer', ['install'], cwd);
    assert.deepEqual(c.out, [sail, 'composer', 'install']);
    assert.equal(c.err, '');
    assert.deepEqual(run(b, 'sail', ['up', '-d'], cwd).out, [sail, 'up', '-d'], 'not `sail sail up -d`');
    assert.deepEqual(run(b, 'sail', ['npm', 'ci'], cwd).out, [sail, 'npm', 'ci']);
  }
});

test('without vendor/bin/sail: php, artisan and sail exit 127 and name the steps; nothing runs', () => {
  const b = box();
  for (const [name, args] of [['php', ['-v']], ['artisan', ['test']], ['sail', ['up', '-d']]] as const) {
    const r = run(b, name, [...args]);
    assert.equal(r.status, 127, name);
    assert.deepEqual(r.out, [], name);
    assert.match(r.err, new RegExp(`\\[sail-shim\\] '${name}': no vendor/bin/sail`), name);
    assert.match(r.err, /'composer install' .*then 'sail up -d'/, name);
  }
});

test('the laravel Dockerfile: the shim under its four names, Sail as the sandbox user, the plain image\'s tools', () => {
  const laravel = read('snapshot/Dockerfile');
  assert.match(laravel, new RegExp(`for c in ${NAMES.join(' ')}; do ln -sf /usr/local/bin/sail-shim /usr/local/bin/\\$c; done`));
  assert.match(laravel, /^ENV APP_USER=root$/m);
  // The plain image's list is the contract (OpenSpec sandbox-image); this image carries all of it.
  const apk = (dockerfile: string): string[] =>
    (dockerfile.match(/^RUN apk add --no-cache \\\n((?: +\S+(?: \\)?\n)+)/m)?.[1] ?? '').split('\n').map((l) => l.replace(/\\$/, '').trim()).filter(Boolean);
  const plain = apk(read('snapshot/plain/Dockerfile'));
  assert.ok(plain.includes('ripgrep') && plain.includes('python3'), 'the plain list parsed');
  assert.deepEqual(plain.filter((p) => !apk(laravel).includes(p)), []);
});
