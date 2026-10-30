import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mirrorsPath, parseMirrors } from './mirrors.js';

test('parseMirrors: an array or {mirrors}, notes ignored; bad shapes fail with a path', () => {
  const one = { src: 'upstream-co/web-studio', dst: 'your-org/web-studio', srcTokenEnv: 'MIRROR_SRC_UPSTREAM_CO', note: 'why' };
  assert.deepEqual(parseMirrors([one]), [{ src: 'upstream-co/web-studio', dst: 'your-org/web-studio', srcTokenEnv: 'MIRROR_SRC_UPSTREAM_CO' }]);
  assert.deepEqual(parseMirrors({ mirrors: [one] }), parseMirrors([one]));
  assert.deepEqual(parseMirrors([]), []);
  assert.throws(() => parseMirrors({}), /expected an array/);
  assert.throws(() => parseMirrors([{ ...one, src: 'no-slash' }]), /\[0\]: "src" must be "owner\/repo"/);
  assert.throws(() => parseMirrors([{ ...one, srcTokenEnv: 'lower' }]), /"srcTokenEnv" must be/);
  assert.throws(() => parseMirrors([one, { ...one, src: 'other/x' }]), /mirrored twice/);
});

test('the shipped example parses', () => {
  const ex = parseMirrors(JSON.parse(readFileSync(new URL('../infra/deploy/ops.example/mirrors.example.json', import.meta.url), 'utf8')) as unknown);
  assert.ok(ex.length > 0);
});

test('mirrorsPath: MIRRORS_CONFIG, else mirrors.json — both against the installation directory, never the working directory', () => {
  assert.equal(mirrorsPath({}, '/srv/aven'), '/srv/aven/mirrors.json');
  assert.equal(mirrorsPath({ MIRRORS_CONFIG: 'conf/m.json' }, '/srv/aven'), '/srv/aven/conf/m.json');
  assert.equal(mirrorsPath({ MIRRORS_CONFIG: '/etc/m.json' }, '/srv/aven'), '/etc/m.json');
});

test('orch mirror is the one mirror job: src/cli.ts imports runMirror from src/mirrorjob.ts, and no second caller exists (container-deploy D7; the crontab caller retired with the systemd path)', () => {
  const cli = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /import \{ runMirror \} from '\.\/mirrorjob\.js';/);
  assert.match(cli, /\.command\('mirror'\)/);
  assert.equal(existsSync(new URL('../scripts/mirror.ts', import.meta.url)), false, 'the systemd crontab caller is gone: the compose crontab runs `bot mirror` from the image');
});
