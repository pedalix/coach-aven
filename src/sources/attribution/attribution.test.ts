// Ported from the owen-ops CLI's review tests (names anonymised for the public repo): the same fragment ids,
// ladder order and proposal rules — the parity the attribution layer promises — plus the platform's own
// additions (ledger coverage by overlapping refs, the tenant config, admin buckets as data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerPeople, dedupeMeetings, hash, meetingFragments, messageFragments, settleLowSubstance, topics, workFragments, type FragmentDraft, type MeetingIn, type MsgIn, type WorkBlock } from './fragment.js';
import { attribute, isAdminText, type LadderCtx, type MarkedPerson } from './ladder.js';
import { planFragments, proposeRules, type LedgerRecord } from './plan.js';
import { parseRegistry, Registry, normaliseRepo, repoMatches } from './registry.js';
import { isGarbledMeeting, isLowSubstance, substance } from './substance.js';
import { parseAttributionConfig } from './config.js';
import { parsePins, pinsToAdd, rulesVersion, unpinLines, type Pin } from './pins.js';

const reg = new Registry(parseRegistry({
  initiatives: [
    { id: 'acme/p1', umbrella: 'acme', status: 'active', sources: { calendar_title_patterns: ['Northwind'], teams_channels: ['Theo Brandt'] } },
    { id: 'acme/p5', umbrella: 'acme', status: 'active', sources: { repos: ['github.com/acme-tools/platform'], local_paths: ['/home/me/acme/p5'] } },
    { id: 'globex/shop', umbrella: 'globex', status: 'active', sources: { slack_channels: ['#shop'], youtrack_prefixes: ['SH'] } },
    { id: 'initech/a', umbrella: 'initech', status: 'active', sources: {} },
    { id: 'initech/b', umbrella: 'initech', status: 'active', sources: {} },
  ],
}));
const P = (person_id: string, name: string, type: MarkedPerson['marker']['type'], initiatives: string[]): MarkedPerson => ({ person_id, name, marker: { type, initiatives } });
const people = new Map([P('owner', 'Olga', 'broad', []), P('hana', 'Hana', 'exclusive', ['acme/p5']), P('rui', 'Rui', 'narrow', ['initech/a', 'initech/b']), P('theo', 'Theo Brandt', 'broad', ['acme/p1'])].map((p) => [p.person_id, p]));
const ctx = (rules: LadderCtx['rules'] = [], admin?: Record<string, string>): LadderCtx => ({ rules, people, reg, self: 'owner', ...(admin ? { admin } : {}) });
const draft = (over: Partial<FragmentDraft>): FragmentDraft => ({ id: 'f1', kind: 'thread', start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:30:00Z', refs: ['r1'], title: 't', source: 'slack', container: null, participants: [], projectKeys: [], repo: null, weight: 1, ...over });
const rec = (id: string, ini: string, over: Partial<LedgerRecord> = {}): LedgerRecord => ({ id, kind: 'thread', refs: [], attributions: [{ initiative: ini, share: 1 }], decided_by: 'model', rule_id: null, rationale: '', status: 'decided', ...over });

test('ids: the CLI\'s FNV-1a hash and id shapes', () => {
  assert.equal(hash(''), (0x811c9dc5).toString(36));
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  const call = meetingFragments({ source: 'granola', id: 'n1', title: 'Call', start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z', attendees: [], summary: 'plain text '.repeat(20), participants: [] });
  assert.equal(call[0]!.id, `frag-2026-10-08-call-granola-${hash('n1')}`);
  const run = messageFragments([{ ref: 'slack:T/C/1', source: 'slack', container: '#c', thread_id: 't', ts: '2026-10-08T10:00:00Z', subject: '', participants: [] }]);
  assert.equal(run[0]!.id, `frag-2026-10-08-thread-${hash('#c|slack:T/C/1')}`);
});

test('topics skip structural headings; meeting splits with weights summing to ~1 and one shared refs array', () => {
  const summary = '# Platform\n' + 'a'.repeat(300) + '\n# Infra\n' + 'b'.repeat(100) + '\n# Next Steps\n- x\n';
  assert.deepEqual(topics(summary).map((t) => t.heading), ['Platform', 'Infra']);
  const fs = meetingFragments({ source: 'granola', id: 'n1', title: 'Call', start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z', attendees: [], summary, participants: ['hana'] });
  assert.equal(fs.length, 2);
  assert.deepEqual(fs.map((f) => f.weight), [0.75, 0.25]);
  assert.ok(fs[0]!.id.endsWith('#1'));
  assert.equal(fs[0]!.refs[0], 'meeting:granola:n1');
  assert.equal(fs[0]!.refs, fs[1]!.refs, 'topics share the call\'s refs (a greeting run attached to the call belongs to every topic)');
  assert.equal(meetingFragments({ source: 'g', id: 'n2', title: 'One', start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z', attendees: [], summary: 'plain text '.repeat(20), participants: [] }).length, 1);
  assert.deepEqual(meetingFragments({ source: 'g', id: 'n3', title: 'Empty', start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z', attendees: [], summary: 'hi', transcriptChars: 40, participants: [] }), [], 'a garbled recording is not a call');
});

test('message runs split on gaps > 45 min, per container, stable ids; keys from text too', () => {
  const m = (ref: string, container: string, ts: string): MsgIn => ({ ref, source: 'slack', container, thread_id: 't', ts, subject: ref === 'a' ? 'SH-12 bug' : '', participants: ['rui'] });
  const msgs = [m('a', '#c', '2026-10-08T10:00:00Z'), m('b', '#c', '2026-10-08T10:40:00Z'), m('c', '#c', '2026-10-08T11:30:00Z'), m('d', '#d', '2026-10-08T10:05:00Z')];
  const fs = messageFragments(msgs);
  assert.equal(fs.length, 3);
  const first = fs.find((f) => f.refs.includes('a'))!;
  assert.deepEqual(first.refs, ['a', 'b']);
  assert.deepEqual(first.projectKeys, ['SH']);
  assert.deepEqual(messageFragments(msgs).map((f) => f.id), fs.map((f) => f.id));
  assert.equal(messageFragments(msgs, 60).length, 2, 'the gap is configurable');
  const fromText: MsgIn[] = [{ ref: 'm1', source: 'slack', container: '#x', thread_id: 't', ts: '2026-10-08T10:00:00Z', subject: '', text: 'see SH-50 please', participants: [] }];
  assert.deepEqual(messageFragments(fromText)[0]!.projectKeys, ['SH']);
});

test('work fragments get unique ids per block of the same session', () => {
  const ev = (start: string): WorkBlock => ({ start, end: start, title: 's', ref: 'activity:claude:x', workKey: '/home/me/acme/p5', route: { initiative: 'acme/p5', confidence: 'exact', candidates: ['acme/p5'], reason: 'path' } });
  const fs = workFragments([ev('2026-10-08T10:00:00Z'), ev('2026-10-08T14:00:00Z'), ev('2026-10-08T14:00:00Z')]);
  assert.equal(fs.length, 2);
  assert.notEqual(fs[0]!.id, fs[1]!.id);
  assert.equal(fs[0]!.id, `frag-2026-10-08-work-${hash('activity:claude:x@2026-10-08T10:00:00Z')}`);
});

test('substance: greeting runs attach to the adjacent call with the same counterpart, else drop', () => {
  assert.equal(isLowSubstance(['Morning! give me 10 min']), true);
  assert.equal(isLowSubstance(['Доброе утро, созвонимся?']), true);
  assert.equal(isLowSubstance(['The import job failed on the staging database again']), false);
  assert.equal(substance('<@U1> hi https://x.y :wave:'), 'link');
  assert.equal(isGarbledMeeting('', 50), true);
  assert.equal(isGarbledMeeting('a'.repeat(200), 0), false);
  const call: FragmentDraft = draft({ id: 'frag-c#1', kind: 'call', title: 'Sync with Rui', start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:30:00Z', refs: ['meeting:g:1'], participants: ['owner', 'rui'] });
  const hi = draft({ id: 'hi', start: '2026-10-08T09:50:00Z', end: '2026-10-08T09:51:00Z', refs: ['m-hi'], participants: ['owner', 'rui'], text: 'Morning, call?' });
  const lonely = draft({ id: 'lonely', start: '2026-10-08T15:00:00Z', end: '2026-10-08T15:00:00Z', refs: ['m-x'], participants: ['owner', 'hana'], text: 'ok thanks' });
  const s = settleLowSubstance([call, hi, lonely], 'owner');
  assert.deepEqual(s.kept.map((d) => d.id), ['frag-c#1']);
  assert.deepEqual(s.attached, [{ from: 'hi', to: 'frag-c#1' }]);
  assert.deepEqual(call.refs, ['meeting:g:1', 'm-hi']);
  assert.deepEqual(s.dropped.map((d) => d.id), ['lonely']);
});

test('ladder: rule beats marker; exclusive marker decides; registry channel, key and title decide', () => {
  const rules = [{ id: 'r1', when: { container: '#ops' }, then: { initiative: 'globex/shop' } }];
  assert.equal(attribute(draft({ container: '#ops', participants: ['hana'] }), ctx(rules)).decided!.rule_id, 'r1');
  const ex = attribute(draft({ participants: ['owner', 'hana'], weight: 0.4 }), ctx());
  assert.deepEqual(ex.decided!.attributions, [{ initiative: 'acme/p5', share: 0.4 }]);
  assert.equal(attribute(draft({ container: '#shop' }), ctx()).decided!.attributions[0]!.initiative, 'globex/shop');
  assert.equal(attribute(draft({ projectKeys: ['SH'] }), ctx()).decided!.attributions[0]!.initiative, 'globex/shop');
  assert.equal(attribute(draft({ kind: 'call', title: 'Northwind platform — Topic' }), ctx()).decided!.attributions[0]!.initiative, 'acme/p1');
  const work = attribute(draft({ kind: 'work', route: reg.routePath('/home/me/acme/p5/sub') }), ctx());
  assert.equal(work.decided!.attributions[0]!.initiative, 'acme/p5');
});

test('ladder: people listed as channels are markers, not places; narrow and broad only suggest', () => {
  const t = attribute(draft({ container: 'chat:@Theo Brandt | Initrode', participants: ['theo'] }), ctx());
  assert.equal(t.decided, null);
  assert.deepEqual(t.candidates, ['acme/p1']);
  const r = attribute(draft({ participants: ['rui'] }), ctx());
  assert.equal(r.decided, null);
  assert.deepEqual(r.candidates, ['initech/a', 'initech/b']);
  assert.match(r.hint, /^narrow:initech/);
  assert.deepEqual(attribute(draft({}), ctx()), { decided: null, candidates: [], hint: 'no signals' });
});

test('ladder: a candidates rule narrows and stops; the admin rung exists only with a tenant map', () => {
  const rules: LadderCtx['rules'] = [
    { id: 'r-cand', when: { container: '#aven-shop' }, then: { candidates: ['globex/shop', 'acme/p1'] } },
    { id: 'r-dec', when: { container: '#shop' }, then: { initiative: 'globex/shop' } },
  ];
  const narrowed = attribute(draft({ container: '#aven-shop', participants: ['hana'] }), ctx(rules));
  assert.equal(narrowed.decided, null);
  assert.deepEqual(narrowed.candidates, ['globex/shop', 'acme/p1']);
  assert.match(narrowed.hint, /rule r-cand/);
  assert.equal(attribute(draft({ container: '#shop' }), ctx(rules)).decided?.rule_id, 'r-dec');
  assert.equal(isAdminText('Please send the invoice for September'), true);
  const invoice = draft({ participants: ['owner', 'theo'], text: 'Please send the invoice for September' });
  assert.equal(attribute(invoice, ctx()).decided, null, 'no admin map → no admin decision');
  // the rationale names the word that fired (an admin decision is a guess worth auditing); conf = the rung's grade (F12)
  assert.deepEqual(attribute(invoice, ctx([], { acme: 'acme/admin' })).decided, { attributions: [{ initiative: 'acme/admin', share: 1 }], rule_id: 'admin', rationale: 'admin chatter ("invoice") with Theo Brandt', conf: 0.75 });
});

test('plan: the ledger wins by id and, for runs, by overlapping refs; the ladder decides or leaves open the rest', () => {
  const byRule = draft({ id: 'f-rule', container: '#shop', refs: ['m1'] });
  const judged = draft({ id: 'f-judged', container: '#shop', refs: ['m2'] });
  const covered = draft({ id: 'f-other-window', refs: ['m3', 'm4'], participants: ['rui'] });
  const open = draft({ id: 'f-open', refs: ['m5'], participants: ['rui'] });
  const asked = draft({ id: 'f-asked', refs: ['m6'] });
  const gone = draft({ id: 'f-gone', container: '#shop', refs: ['m7'] });
  const ledger = new Map<string, LedgerRecord>([
    ['f-judged', rec('f-judged', 'acme/p1', { refs: ['m2'] })],
    ['f-cut-elsewhere', rec('f-cut-elsewhere', 'initech/a', { refs: ['m4'] })],
    ['f-asked', rec('f-asked', 'acme/p1', { status: 'escalated', attributions: [] })],
    ['f-gone', rec('f-gone', 'acme/p1', { status: 'superseded' })],
  ]);
  const plan = planFragments([byRule, judged, covered, open, asked, gone], ledger, ctx());
  assert.deepEqual(plan.map((p) => [p.draft.id, p.state, p.ledger_id]), [
    ['f-rule', 'rule', null],
    ['f-judged', 'decided', 'f-judged'],
    ['f-other-window', 'decided', 'f-cut-elsewhere'],
    ['f-open', 'open', null],
    ['f-asked', 'escalated', 'f-asked'],
    ['f-gone', 'rule', null],
  ]);
  assert.deepEqual(plan[1]!.attributions, [{ initiative: 'acme/p1', share: 1 }], 'the recorded judgment, not the channel rule');
  assert.deepEqual(plan[3]!.candidates, ['initech/a', 'initech/b']);
});

test('proposeRules: three identical judgments in a DM propose a container rule; broad people never; an existing rule blocks', () => {
  const ds = [1, 2, 3].map((i) => draft({ id: `f${i}`, container: 'dm:@theo', participants: ['owner', 'theo'] }));
  const existing = new Map(['f1', 'f2', 'f3'].map((id) => [id, rec(id, 'acme/p1')]));
  const out = proposeRules(ds, existing, ctx());
  assert.equal(out.length, 1, 'broad Theo gives no person proposal; the DM container does');
  assert.match(out[0]!.question, /dm:@theo.*acme\/p1/);
  assert.equal(proposeRules(ds, existing, ctx([{ id: 'x', when: { container: 'dm:@theo' }, then: { initiative: 'acme/p1' } }])).length, 0);
  const broad = [1, 2, 3, 4].map((i) => draft({ id: `b${i}`, participants: ['owner', 'theo'] }));
  assert.equal(proposeRules(broad, new Map(broad.map((d) => [d.id, rec(d.id, 'acme/p1')])), ctx()).length, 0);
});

test('proposeRules: a narrow person with mixed initiatives is not a pattern; a pure one is; aliases resolve first', () => {
  const mixed = [1, 2, 3, 4, 5].map((i) => draft({ id: `m${i}`, participants: ['owner', 'rui'] }));
  assert.equal(proposeRules(mixed, new Map(mixed.map((d, i) => [d.id, rec(d.id, i < 3 ? 'initech/a' : 'initech/b')])), ctx()).length, 0, 'a competitor with 2 blocks it');
  const pure = proposeRules(mixed, new Map(mixed.map((d) => [d.id, rec(d.id, 'initech/a')])), ctx());
  assert.equal(pure.length, 1);
  assert.match(pure[0]!.question, /^5 of 5 fragments with Rui were initech\/a/);
  const many = Array.from({ length: 11 }, (_, i) => draft({ id: `n${i}`, participants: ['owner', 'rui'] }));
  assert.equal(proposeRules(many, new Map(many.map((d, i) => [d.id, rec(d.id, i === 0 ? 'initech/b' : 'initech/a')])), ctx()).length, 1, '10 of 11 is pure enough');
  const reg2 = new Registry(parseRegistry([
    { id: 'acme/p5', umbrella: 'acme', sources: {} },
    { id: 'acme/zoo', umbrella: 'acme', alias_of: 'acme/p5', sources: {} },
  ]));
  const ds = [1, 2, 3, 4].map((i) => draft({ id: `a${i}`, container: '#zoo' }));
  const out = proposeRules(ds, new Map(ds.map((d, i) => [d.id, rec(d.id, i % 2 ? 'acme/zoo' : 'acme/p5')])), { rules: [], people, reg: reg2, self: 'owner' });
  assert.equal(out.length, 1);
  assert.match(out[0]!.question, /4 of 4 .* acme\/p5/);
});

test('registry: repos with or without host and globs; longest path wins; titles; bad files fail loudly', () => {
  assert.equal(normaliseRepo('git@github.com:Acme-Tools/Platform.git'), 'github.com/acme-tools/platform');
  assert.equal(repoMatches('github.com/acme-tools/plat*', 'github.com/acme-tools/platform'), true, 'a host-qualified glob compares the org/repo tail');
  assert.equal(repoMatches('acme-tools/plat*', 'github.com/other/platform'), false);
  assert.equal(repoMatches('acme-tools/*', 'github.com/acme-tools/platform'), true);
  assert.equal(reg.routeRepo('https://github.com/acme-tools/platform.git').initiative, 'acme/p5');
  assert.equal(reg.routeRepo('https://github.com/other/thing').confidence, 'none');
  assert.equal(reg.routeTitle('Weekly Northwind sync').initiative, 'acme/p1');
  assert.throws(() => parseRegistry({ nope: [] }), /expected an array of initiatives/);
  assert.throws(() => parseRegistry([{ sources: {} }]), /needs an "id"/);
});

test('containers and meeting dedupe', () => {
  assert.deepEqual(containerPeople('chat:group:A B | X+C D | Y'), ['A B | X', 'slack:A B | X', 'C D | Y', 'slack:C D | Y']);
  assert.deepEqual(containerPeople('dm:U02HT0SDRB4'), []);
  assert.deepEqual(containerPeople('mpim:@ana.berg+@rui'), ['ana.berg', 'slack:ana.berg', 'rui', 'slack:rui'], 'a Slack group DM names its members');
  const m = (start: string, end: string, summary = '') => ({ source: 's', id: start, title: 't', start, end, attendees: [], summary, participants: [] as string[] });
  assert.equal(dedupeMeetings([m('2026-10-08T10:00:00Z', '2026-10-08T11:00:00Z'), m('2026-10-08T10:05:00Z', '2026-10-08T10:55:00Z', 'x')]).length, 1);
});

test('F3: recorder copies of one call (the store\'s call id) are one call, named by the first copy in copy order', () => {
  const copy = (source: string, id: string, start: string, end: string, callId?: string, participants: string[] = []): MeetingIn => ({ source, id, title: 'Sync', start, end, attendees: [], summary: 'plain text '.repeat(20), participants, ...(callId ? { callId } : {}) });
  // A Gemini doc has no end (zero-length window): overlap alone never merged it with the Granola copy of the same call.
  const gmeet = copy('gmeet', 'doc1', '2026-10-08T10:00:00Z', '2026-10-08T10:00:00Z', 'call:a', ['rui']);
  const granola = copy('granola', 'n1', '2026-10-08T10:02:00Z', '2026-10-08T10:40:00Z', 'call:a', ['owner']);
  assert.equal(dedupeMeetings([{ ...gmeet, callId: undefined }, { ...granola, callId: undefined }]).length, 2, 'without call ids: two calls, as before');
  const [call, ...rest] = dedupeMeetings([granola, gmeet]);
  assert.equal(rest.length, 0);
  assert.deepEqual([call!.source, call!.id, call!.start, call!.end], ['granola', 'n1', '2026-10-08T10:02:00Z', '2026-10-08T10:40:00Z'], 'the copy with a window names it, though the Gemini doc (cut to the minute) starts earlier');
  assert.deepEqual([call!.participants, call!.twins, call!.twinBases], [['owner', 'rui'], ['meeting:gmeet:doc1'], [`frag-2026-10-08-call-gmeet-${hash('doc1')}`]]);
  assert.deepEqual(dedupeMeetings([gmeet, granola]), dedupeMeetings([granola, gmeet]), 'input order (rowid) does not matter');
  assert.deepEqual([gmeet.twins, granola.twins], [undefined, undefined], 'the inputs are not mutated');
  const frag = meetingFragments(call!)[0]!;
  assert.equal(frag.id, `frag-2026-10-08-call-granola-${hash('n1')}`);
  assert.deepEqual(frag.refs, ['meeting:granola:n1', 'meeting:gmeet:doc1'], 'refs[0] is the call; its twin is indexed with it');
  assert.deepEqual(frag.aliases, [`frag-2026-10-08-call-gmeet-${hash('doc1')}`], 'the id the twin would have given it');
  assert.equal(meetingFragments(granola)[0]!.aliases, undefined, 'a one-copy call has none');
  // timed copies by start (as main read them), the call lasting until the last copy ends; a zero-length copy comes last
  const three = dedupeMeetings([copy('gmeet', 'g', '2026-10-08T09:59:00Z', '2026-10-08T09:59:00Z', 'call:b'), copy('granola', 'z', '2026-10-08T10:01:00Z', '2026-10-08T10:45:00Z', 'call:b'), copy('wispr', 'w', '2026-10-08T10:00:00Z', '2026-10-08T10:30:00Z', 'call:b')]);
  assert.deepEqual(three.map((x) => [x.source, x.start, x.end, x.twins]), [['wispr', '2026-10-08T10:00:00Z', '2026-10-08T10:45:00Z', ['meeting:granola:z', 'meeting:gmeet:g']]]);
  // the same start: recorder priority (granola < wispr < gmeet), then id
  const same = dedupeMeetings([copy('wispr', 'w', '2026-10-08T10:00:00Z', '2026-10-08T10:30:00Z', 'call:e'), copy('granola', 'z', '2026-10-08T10:00:00Z', '2026-10-08T10:30:00Z', 'call:e')]);
  assert.deepEqual(same.map((x) => [x.source, x.twins]), [['granola', ['meeting:wispr:w']]]);
  // only zero-length copies (Gemini alone, twice): start order among them
  assert.deepEqual(dedupeMeetings([copy('gmeet', 'b', '2026-10-08T10:01:00Z', '2026-10-08T10:01:00Z', 'call:f'), copy('gmeet', 'a', '2026-10-08T10:00:00Z', '2026-10-08T10:00:00Z', 'call:f')]).map((x) => x.id), ['a']);
  // copies the store put in different calls stay apart, however much they overlap
  assert.equal(dedupeMeetings([copy('granola', 'n1', '2026-10-08T10:00:00Z', '2026-10-08T11:00:00Z', 'call:c'), copy('granola', 'n2', '2026-10-08T10:05:00Z', '2026-10-08T10:55:00Z', 'call:d')]).length, 2);
});

test('F3: a late Gemini copy keeps the Granola copy\'s topics and keys; each topic answers to the twin\'s id with its suffix', () => {
  const summary = '## Shop checkout (SHOP-41)\n' + 'Totals were off for coupons; fixed the rounding and the tax line. '.repeat(3) + '\n## Hosting\n' + 'Moved the staging box and renewed the certificate. '.repeat(3);
  const granola: MeetingIn = { source: 'granola', id: 'g-1', title: 'Weekly', start: '2026-10-14T09:00:52Z', end: '2026-10-14T09:40:00Z', attendees: [], summary, participants: [], callId: 'call:x' };
  const gmeet: MeetingIn = { source: 'gmeet', id: 'doc-9', title: 'Weekly', start: '2026-10-14T09:00:00Z', end: '2026-10-14T09:00:00Z', attendees: [], summary: 'Plain notes without headings. '.repeat(10), participants: [], callId: 'call:x' };
  const alone = meetingFragments(granola);
  const merged = dedupeMeetings([gmeet, granola]).flatMap(meetingFragments);
  assert.deepEqual(merged.map((f) => [f.id, f.weight, f.projectKeys]), alone.map((f) => [f.id, f.weight, f.projectKeys]), 'what Granola alone gave: the same ids, topics and keys');
  assert.deepEqual(merged.map((f) => f.aliases), [[`frag-2026-10-14-call-gmeet-${hash('doc-9')}#1`], [`frag-2026-10-14-call-gmeet-${hash('doc-9')}#2`]]);
});

test('plan: a call answers to its own id, then to its copies\' ids — a judgment or pin under either stays attached; the ledger before a pin', () => {
  const call = draft({ id: 'frag-c-granola', kind: 'call', refs: ['meeting:granola:n1', 'meeting:gmeet:d1'], participants: ['owner', 'hana'], aliases: ['frag-c-gmeet'] });
  const pin = (id: string, ini: string): Pin => ({ id, attributions: [{ initiative: ini, share: 1 }], rule_id: 'marker:hana', rationale: 'pinned', rules_version: 'v1', pinned_at: '2026-10-14T00:00:00.000Z' });
  const plan = (ledger: LedgerRecord[], pins: Pin[] = []) => planFragments([call], new Map(ledger.map((r) => [r.id, r])), ctx(), new Map(pins.map((p) => [p.id, p])))[0]!;
  assert.deepEqual([plan([]).state, plan([]).attributions[0]!.initiative], ['rule', 'acme/p5'], 'nothing recorded: the ladder (Hana is exclusive)');
  const judged = plan([rec('frag-c-gmeet', 'initech/a', { kind: 'call', decided_by: 'owner' })]);
  assert.deepEqual([judged.state, judged.decided_by, judged.ledger_id, judged.attributions[0]!.initiative], ['decided', 'owner', 'frag-c-gmeet', 'initech/a'], 'judged under the twin\'s id');
  assert.equal(plan([rec('frag-c-gmeet', 'initech/a', { kind: 'call' }), rec('frag-c-granola', 'initech/b', { kind: 'call' })]).ledger_id, 'frag-c-granola', 'its own id first');
  assert.equal(plan([rec('frag-c-gmeet', 'initech/a', { kind: 'call', status: 'superseded' })]).state, 'rule', 'a superseded line is no decision');
  const pinned = plan([], [pin('frag-c-gmeet', 'globex/shop')]);
  assert.deepEqual([pinned.state, pinned.pinned_at, pinned.attributions[0]!.initiative], ['decided', '2026-10-14T00:00:00.000Z', 'globex/shop'], 'pinned under the twin\'s id');
  assert.deepEqual(plan([], [pin('frag-c-gmeet', 'globex/shop'), pin('frag-c-granola', 'initech/b')]).attributions[0]!.initiative, 'initech/b', 'its own pin first');
  assert.equal(plan([rec('frag-c-gmeet', 'initech/a', { kind: 'call' })], [pin('frag-c-granola', 'initech/b')]).ledger_id, 'frag-c-gmeet', 'a judgment under any copy\'s id beats a pin');
  // only calls have aliases; a run never matches by them
  assert.equal(planFragments([draft({ id: 'frag-t', aliases: ['frag-x'] })], new Map([['frag-x', rec('frag-x', 'initech/a')]]), ctx())[0]!.state, 'open');
});

test('config: subject required; defaults; bad values fail with the file named', () => {
  assert.deepEqual(parseAttributionConfig({ subject: 'owner' }), { subject: 'owner', threadGapMinutes: 45, substance: true, pinAfterDays: 1, parallelSessions: 'sum' });
  assert.deepEqual(parseAttributionConfig({ subject: 'owner', since: '2026-10-01', threadGapMinutes: 30, substance: false, pinAfterDays: 0, parallelSessions: 'wallclock', admin: { acme: 'acme/admin' } }), { subject: 'owner', since: '2026-10-01', threadGapMinutes: 30, substance: false, pinAfterDays: 0, parallelSessions: 'wallclock', admin: { acme: 'acme/admin' } });
  assert.throws(() => parseAttributionConfig({ subject: 'owner', pinAfterDays: -1 }), /"pinAfterDays" must be an integer/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', parallelSessions: 'max' }), /"parallelSessions" must be/);
  assert.equal(parseAttributionConfig({ subject: 'owner', ownerDecider: 'olga' }).ownerDecider, 'olga');
  for (const bad of ['owner', 'model', 'rule', 'human:olga', 'Olga', '', 7]) assert.throws(() => parseAttributionConfig({ subject: 'owner', ownerDecider: bad }), /"ownerDecider" must be/);
  const budgets = [{ umbrella: 'acme', unit: 'half_day', perMonth: 24, by: 'billing_code' }, { umbrella: 'globex', unit: 'hour', perMonth: 100, overrides: { '2026-10': 70 } }, { umbrella: 'initech', unit: 'hour' }];
  assert.deepEqual(parseAttributionConfig({ subject: 'owner', budgets }).budgets, budgets);
  for (const [b, re] of [
    [{ umbrella: 'acme', unit: 'day' }, /"unit" must be/],
    [{ unit: 'hour' }, /"umbrella" is required/],
    [{ umbrella: 'acme', unit: 'hour', perMonth: -1 }, /"perMonth" must be a non-negative number/],
    [{ umbrella: 'acme', unit: 'hour', unitMinutes: 0 }, /"unitMinutes" must be positive/],
    [{ umbrella: 'acme', unit: 'hour', overrides: { october: 70 } }, /"overrides" must map YYYY-MM/],
    [{ umbrella: 'acme', unit: 'hour', by: 'person' }, /"by" must be/],
  ] as Array<[Record<string, unknown>, RegExp]>) assert.throws(() => parseAttributionConfig({ subject: 'owner', budgets: [b] }), re, JSON.stringify(b));
  assert.throws(() => parseAttributionConfig({}), /"subject" must be a person id/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', timezone: 'Europe/Zurich' }), /moved to the project's sources\.timezone/, 'one zone per tenant');
  assert.throws(() => parseAttributionConfig({ subject: 'owner', since: '15.10.2026' }), /YYYY-MM-DD/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', admin: { acme: 1 } }), /"admin" must map/);
});

test('pins: last line per id wins, an unpin line releases; closed days only; the ledger still wins over a pin', () => {
  const pin = (id: string, ini: string, at = '2026-10-14T00:00:00.000Z'): Pin => ({ id, attributions: [{ initiative: ini, share: 1 }], rule_id: 'r1', rationale: 'rule r1', rules_version: 'abc123def456', pinned_at: at });
  const text = [JSON.stringify(pin('a', 'acme/p1')), '{broken', JSON.stringify(pin('b', 'acme/p1')), JSON.stringify({ id: 'b', unpinned_at: 'x' }), JSON.stringify(pin('a', 'globex/shop', 'later'))].join('\n');
  const pins = parsePins(text);
  assert.deepEqual([...pins.keys()], ['a']);
  assert.equal(pins.get('a')!.attributions[0]!.initiative, 'globex/shop', 'the last line wins');
  assert.match(rulesVersion('rules', 'registry'), /^[0-9a-f]{12}$/);
  assert.notEqual(rulesVersion('rules', 'registry'), rulesVersion('rules2', 'registry'));
  // which rule decisions to pin: days before the cutoff only
  const planned = planFragments([draft({ id: 'old', container: '#shop', start: '2026-10-12T10:00:00Z' }), draft({ id: 'new', container: '#shop', start: '2026-10-14T10:00:00Z' }), draft({ id: 'open-old', start: '2026-10-12T11:00:00Z', participants: ['rui'] })], new Map(), ctx());
  const fresh = pinsToAdd(planned, (iso) => iso.slice(0, 10), '2026-10-14', 'v1', 'now');
  assert.deepEqual(fresh.map((p) => [p.id, p.attributions[0]!.initiative, p.rule_id, p.rules_version]), [['old', 'globex/shop', 'registry:channel', 'v1']], 'open fragments are never pinned; the cutoff day is still live');
  // precedence: ledger > pin > ladder — a pin decides even when the rules would now decide otherwise
  const pinned = new Map([['old', { ...fresh[0]!, attributions: [{ initiative: 'acme/p1', share: 1 }] }]]);
  const again = planFragments([draft({ id: 'old', container: '#shop', start: '2026-10-12T10:00:00Z' })], new Map(), ctx(), pinned);
  assert.deepEqual([again[0]!.state, again[0]!.decided_by, again[0]!.attributions[0]!.initiative, again[0]!.pinned_at], ['decided', 'rule', 'acme/p1', 'now']);
  const judged = planFragments([draft({ id: 'old', container: '#shop', start: '2026-10-12T10:00:00Z' })], new Map([['old', rec('old', 'initech/a')]]), ctx(), pinned);
  assert.deepEqual([judged[0]!.decided_by, judged[0]!.attributions[0]!.initiative, judged[0]!.pinned_at], ['model', 'initech/a', undefined], 'a judgment beats the pin');
  assert.deepEqual(unpinLines(pinned, ['old', 'never-pinned', 'old'], 't').map((l) => l.id), ['old']);
});
