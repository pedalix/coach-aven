// The ship planner (OpenSpec ship-dispatcher, spec `ship`): stages, candidates, the stage rule, versions, the plan
// text, the journal, `where`, and the lock. The world is a linear main C1..C6 and three installations: home (stage 1,
// canary), pilot (stage 2, canary), prod (stage 3, release).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseOverlay, planShip, renderPlan, nextVersion, journalLine, journalSince, whereReport,
  type MainCommit, type Overlay, type Pin, type Pr, type ShipFacts, type Step,
} from './ship.js';
import { acquireShipLock } from './shiplock.js';

const C = (n: number) => n.toString(16).padStart(2, '0').repeat(20); // 40 hex
const ORDER = [1, 2, 3, 4, 5, 6].map(C);
const TAGS: Record<string, string> = { 'v0.47.0': C(1), 'v0.48.0': C(2) };
const PRS: Record<string, Pr> = {
  [C(3)]: { number: 101, title: 'Fix the thread reply', labels: ['fix'] },
  [C(4)]: { number: 102, title: 'Answers carry their sources', labels: ['feature'] },
  [C(5)]: { number: 103, title: 'Docs: the stage rule', labels: ['docs'] },
  [C(6)]: { number: 104, title: 'Fix the usage total', labels: ['fix'] },
};
const OVERLAYS: Overlay[] = [
  { slug: 'home', stage: 1, canary: true },
  { slug: 'pilot', stage: 2, canary: true },
  { slug: 'prod', stage: 3, canary: false },
];
const green = (n: number): MainCommit => ({ commit: C(n), ci: 'success', image: true });

function facts(o: { pins?: Record<string, Pin>; main?: MainCommit[]; tags?: Record<string, string>; overlays?: Overlay[]; isAncestor?: ShipFacts['isAncestor'] } = {}): ShipFacts {
  const tags = o.tags ?? TAGS;
  const at = (ref: string | undefined) => (ref === undefined ? -1 : ORDER.indexOf(tags[ref] ?? ref));
  return {
    overlays: o.overlays ?? OVERLAYS,
    pins: o.pins ?? {
      home: { version: `sha-${C(5)}`, commit: C(5) },
      pilot: { version: `sha-${C(3)}`, commit: C(3) },
      prod: { version: 'v0.48.0', commit: C(2) },
    },
    main: o.main ?? [6, 5, 4, 3, 2, 1].map(green),
    isAncestor: o.isAncestor ?? ((a, b) => ORDER.indexOf(a) <= ORDER.indexOf(b)),
    tagCommit: (t) => tags[t],
    tagsAt: (c) => Object.keys(tags).filter((t) => tags[t] === c),
    releaseTagsReachable: (c) => Object.keys(tags).filter((t) => ORDER.indexOf(tags[t]) <= ORDER.indexOf(c)),
    prsBetween: (from, to) => ORDER.slice(at(from) + 1, ORDER.indexOf(to) + 1).flatMap((c) => (PRS[c] ? [PRS[c]] : [])),
  };
}
const steps = (p: ReturnType<typeof planShip>): Step[] => {
  assert.ok(!('refusal' in p), 'refusal' in p ? p.refusal : '');
  return (p as { steps: Step[] }).steps;
};
const refusal = (p: ReturnType<typeof planShip>): string => {
  assert.ok('refusal' in p, 'expected a refusal');
  return (p as { refusal: string }).refusal;
};

test('parseOverlay: STAGE and CANARY as bash would source them — last assignment wins, comments are not assignments', () => {
  assert.deepEqual(parseOverlay('home', 'DEPLOY_HOST=localhost\nCANARY=1\nSTAGE=1\n'), { slug: 'home', stage: 1, canary: true });
  assert.deepEqual(parseOverlay('prod', '# STAGE=9\nSTAGE=2\nSTAGE="3"\n'), { slug: 'prod', stage: 3, canary: false });
  assert.deepEqual(parseOverlay('x', 'DEPLOY_HOST=h\n'), { slug: 'x', canary: false });
  assert.match(parseOverlay('x', 'STAGE=first\n').stageError!, /positive integer/);
});

test('Overlay without a stage: nothing is shipped, the message names STAGE and the file', () => {
  const r = refusal(planShip({ targets: ['pilot'] }, facts({ overlays: [OVERLAYS[0], { slug: 'pilot', canary: true }] })));
  assert.match(r, /infra\/pilot\/deploy\.env has no STAGE/);
});

test('an unknown installation is refused with the staged ones listed', () => {
  assert.match(refusal(planShip({ targets: ['nope'] }, facts())), /no installation "nope".*staged: home, pilot, prod/);
});

test('Order follows the stage, not the arguments', () => {
  const s = steps(planShip({ targets: ['pilot', 'home'] }, facts({ pins: { home: { version: `sha-${C(4)}`, commit: C(4) }, pilot: { version: `sha-${C(3)}`, commit: C(3) }, prod: { version: 'v0.48.0', commit: C(2) } } })));
  assert.deepEqual(s.map((x) => x.slug), ['home', 'pilot']);
});

test('The newest commit is still building: the lowest stage takes the newest green commit with an image and says what it skipped', () => {
  const main: MainCommit[] = [{ commit: C(6), ci: 'pending', image: false }, { commit: C(5), ci: 'success', image: false }, green(4), green(3)];
  const p = planShip({ targets: ['home'] }, facts({ main, pins: { home: { version: `sha-${C(3)}`, commit: C(3) } } }));
  const s = steps(p);
  assert.equal(s[0].commit, C(4));
  assert.equal(s[0].version, `sha-${C(4)}`);
  assert.deepEqual((p as { notes: string[] }).notes, ['skipped 0606060: CI is still running', 'skipped 0505050: its image is not published']);
});

test('no shippable main commit: refused naming the newest and why', () => {
  assert.match(refusal(planShip({ targets: ['home'] }, facts({ main: [{ commit: C(6), ci: 'failure', image: false }] }))), /0606060, CI failed/);
});

test('Home takes main\'s image: a canary at the lowest stage gets sha-<newest green commit>', () => {
  const s = steps(planShip({ targets: ['home'] }, facts()));
  assert.deepEqual([s[0].commit, s[0].version, s[0].createTag], [C(6), `sha-${C(6)}`, false]);
});

test('Promoting staging\'s commit to prod: prod gets what pilot runs, not the newest main, as a new patch tag after fixes only', () => {
  const [s] = steps(planShip({ targets: ['prod'] }, facts()));
  assert.equal(s.commit, C(3));
  assert.equal(s.version, 'v0.48.1');
  assert.equal(s.createTag, true);
  assert.deepEqual(s.from, { version: 'v0.48.0', commit: C(2) });
  assert.deepEqual(s.prs.map((p) => p.number), [101]);
});

test('A feature since the last tag: the next minor', () => {
  const pins = { home: { version: `sha-${C(5)}`, commit: C(5) }, pilot: { version: `sha-${C(4)}`, commit: C(4) }, prod: { version: 'v0.48.0', commit: C(2) } };
  assert.equal(steps(planShip({ targets: ['prod'] }, facts({ pins })))[0].version, 'v0.49.0');
  assert.equal(nextVersion('v0.48.0', [{ number: 1, title: '', labels: ['fix'] }, { number: 2, title: '', labels: ['docs'] }]), 'v0.48.1');
  assert.equal(nextVersion(undefined, []), 'v0.1.0');
});

test('Re-shipping a tagged commit: no tag is created, the existing one is deployed', () => {
  const [s] = steps(planShip({ targets: ['prod'] }, facts({ tags: { ...TAGS, 'v0.48.1': C(3) } })));
  assert.deepEqual([s.version, s.createTag], ['v0.48.1', false]);
});

test('Skipping a stage: an explicit commit no lower stage runs is refused, naming the lower stages', () => {
  const r = refusal(planShip({ targets: ['prod'], commit: C(6) }, facts()));
  assert.match(r, /prod \(stage 3\) only takes a commit a lower stage already runs/);
  assert.match(r, /home \(stage 1\): sha-.*, pilot \(stage 2\): sha-/);
});

test('Rollback passes the check: an earlier release is deployed as is', () => {
  const [s] = steps(planShip({ targets: ['prod'], version: 'v0.47.0' }, facts()));
  assert.deepEqual([s.commit, s.version, s.createTag], [C(1), 'v0.47.0', false]);
});

test('a release installation never takes a sha- version; a malformed version is refused', () => {
  assert.match(refusal(planShip({ targets: ['prod'], version: `sha-${C(2)}` }, facts())), /release installation: it takes vX\.Y\.Z/);
  assert.match(refusal(planShip({ targets: ['home'], version: 'latest' }, facts())), /not a version/);
});

test('a chain promotes through the stages in one run and tags once', () => {
  const s = steps(planShip({ targets: ['prod', 'home', 'pilot'] }, facts()));
  assert.deepEqual(s.map((x) => [x.slug, x.commit, x.version, x.createTag]), [
    ['home', C(6), `sha-${C(6)}`, false],
    ['pilot', C(6), `sha-${C(6)}`, false],
    ['prod', C(6), 'v0.49.0', true],
  ]);
});

test('an installation already on the version is skipped with a note', () => {
  const p = planShip({ targets: ['home'] }, facts({ pins: { home: { version: `sha-${C(6)}`, commit: C(6) } } }));
  assert.deepEqual(steps(p), []);
  assert.deepEqual((p as { notes: string[] }).notes, ['home already runs sha-' + C(6)]);
});

test('an unreachable lower stage: prod is refused, naming it', () => {
  const r = refusal(planShip({ targets: ['prod'] }, facts({ pins: { home: { version: `sha-${C(5)}`, commit: C(5) }, pilot: { unreachable: 'ssh: timeout' }, prod: { version: 'v0.48.0', commit: C(2) } } })));
  assert.match(r, /cannot read what pilot \(stage 2\) runs: ssh: timeout/);
});

test('two installations at the stage below: the oldest commit; diverging histories are refused', () => {
  const overlays = [...OVERLAYS, { slug: 'pilot-b', stage: 2, canary: true }];
  const pins = { home: { version: `sha-${C(5)}`, commit: C(5) }, pilot: { version: `sha-${C(4)}`, commit: C(4) }, 'pilot-b': { version: `sha-${C(3)}`, commit: C(3) }, prod: { version: 'v0.48.0', commit: C(2) } };
  assert.equal(steps(planShip({ targets: ['prod'] }, facts({ overlays, pins })))[0].commit, C(3));
  const r = refusal(planShip({ targets: ['prod'] }, facts({ overlays, pins, isAncestor: (a, b) => a === b })));
  assert.match(r, /stage 2 runs diverging commits/);
});

test('renderPlan: the three-stage plan the operator reads', () => {
  const p = planShip({ targets: ['home', 'pilot', 'prod'] }, facts({ main: [{ commit: C(6), ci: 'pending', image: false }, ...[5, 4, 3, 2, 1].map(green)], pins: { home: { version: `sha-${C(4)}`, commit: C(4) }, pilot: { version: `sha-${C(3)}`, commit: C(3) }, prod: { version: 'v0.48.0', commit: C(2) } } }));
  assert.ok(!('refusal' in p));
  assert.equal(renderPlan(p), [
    'home (stage 1, canary): sha-0404040 → sha-0505050',
    '  1 PR:',
    '    #103 Docs: the stage rule [docs]',
    'pilot (stage 2, canary): sha-0303030 → sha-0505050',
    '  2 PRs:',
    '    #102 Answers carry their sources [feature]',
    '    #103 Docs: the stage rule [docs]',
    'prod (stage 3, release): v0.48.0 → v0.49.0 (new tag on 0505050)',
    '  3 PRs:',
    '    #101 Fix the thread reply [fix]',
    '    #102 Answers carry their sources [feature]',
    '    #103 Docs: the stage rule [docs]',
    'note: skipped 0606060: CI is still running',
  ].join('\n'));
});

test('journal: one line per step; journalSince finds the last ok for a slug and version', () => {
  const s: Step = { slug: 'prod', stage: 3, canary: false, commit: C(3), version: 'v0.48.1', createTag: true, prs: [] };
  const line = journalLine(new Date('2026-10-31T12:03:04.567Z'), s, 'ok');
  assert.equal(line, `2026-10-31T12:03:04Z prod v0.48.1 ${C(3).slice(0, 12)} ok\n`);
  const j = `2026-10-30T09:00:00Z prod v0.48.1 x failed\n${line}`;
  assert.equal(journalSince(j, 'prod', 'v0.48.1'), '2026-10-31T12:03:04Z');
  assert.equal(journalSince(j, 'home', 'v0.48.1'), undefined);
});

test('where: Is my PR live? ✓ where the commit is contained, ✗ where not; an unreachable box fails the report', () => {
  const pins: Record<string, Pin> = { home: { version: `sha-${C(5)}`, commit: C(5) }, pilot: { unreachable: 'ssh: timeout' }, prod: { version: 'v0.48.0', commit: C(2) } };
  const o = { isAncestor: (a: string, b: string) => ORDER.indexOf(a) <= ORDER.indexOf(b), behind: (c: string) => 5 - ORDER.indexOf(c), since: (s: string) => (s === 'home' ? '2026-10-31T12:03:04Z' : undefined) };
  const r = whereReport(OVERLAYS, pins, { ...o, target: { label: '#103', commit: C(5) } });
  assert.equal(r.text, ['#103 (0505050):', '  home ✓ sha-0505050, since 2026-10-31T12:03:04Z', '  pilot: unreachable (ssh: timeout)', '  prod ✗ v0.48.0 (0202020)'].join('\n'));
  assert.equal(r.ok, false);
  const all = whereReport(OVERLAYS, { ...pins, pilot: { version: `sha-${C(6)}`, commit: C(6) } }, o);
  assert.match(all.text, /^  pilot \(stage 2\): sha-0606060 — at main$/m);
  assert.match(all.text, /^  prod \(stage 3\): v0\.48\.0 \(0202020\) — 4 commits behind main$/m);
  assert.equal(all.ok, true);
});

test('lock: a second ship is refused naming the first; a dead holder is cleared; release removes the file', () => {
  const path = `${mkdtempSync(`${tmpdir()}/ship-lock-`)}/.ship.lock`;
  const a = acquireShipLock(path, ['home'], { pid: 111, host: 'box', now: new Date('2026-10-31T12:00:00Z'), isAlive: () => true });
  assert.ok(a.ok);
  const b = acquireShipLock(path, ['home'], { pid: 222, host: 'box', isAlive: () => true });
  assert.ok(!b.ok);
  assert.match((b as { message: string }).message, /another ship is running: home since 2026-10-31T12:00:00\.000Z \(pid 111 on box\)/);
  const c = acquireShipLock(path, ['prod'], { pid: 333, host: 'box', isAlive: (pid) => pid !== 111 });
  assert.ok(c.ok);
  assert.match((c as { note?: string }).note!, /cleared a stale lock: home/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 333);
  (c as { release: () => void }).release();
  assert.equal(existsSync(path), false);
  writeFileSync(path, '{"pid":1,"host":"other","slugs":["x"],"startedAt":"t"}');
  assert.ok(!acquireShipLock(path, ['y'], { pid: 2, host: 'box', isAlive: () => false }).ok, 'a holder on another host is never judged stale from here');
});
