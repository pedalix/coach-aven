// Item mode, T2: duplicate edges, their confidences and the union-find (ported with the bench's stage-0 tests). Fictional items only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOf } from '../fingerprint.js';
import { Dedup, EDGE_CONF, isBump, SINGLE_CONF, SINGLE_FAMILY_CONF, type DedupFeat } from './items-dedup.js';
import { alertIdentity, exactKey, exactTokens, normBody } from './items-text.js';

const T0 = Date.parse('2026-10-15T08:00:00Z');
const min = (n: number) => T0 + n * 60_000;

/** A feature row the way t234.ts builds one, from a text and a few overrides. */
function feat(id: string, t: number, text: string, o: Partial<DedupFeat> & { mail?: boolean; subjectLine?: string } = {}): DedupFeat {
  const human = o.human ?? false;
  const mail = o.mail ?? false;
  return {
    id,
    t,
    human,
    task: false,
    medium: mail ? 'mail' : 'chat',
    sender: human ? 'lena-park' : 'shop alert bot',
    container: '#alerts',
    thread: `th:${id}`,
    reply: false,
    exact: exactKey({ subject: o.subjectLine ?? null, text }, mail),
    clipped: false,
    norm: normBody(text),
    words: exactTokens(text),
    subject: '',
    forward: false,
    alert: human ? null : alertOf(text),
    alertId: human ? '' : alertIdentity(text),
    targets: [],
    links: [],
    trackerKeys: [],
    trackerMail: false,
    trackerCreated: false,
    ownKey: '',
    callId: '',
    family: human ? '' : `fam:${text.split(' ')[0]}`,
    ...o,
  };
}

const run = (rows: DedupFeat[], opts = {}) => {
  const d = new Dedup(opts);
  for (const r of rows) d.add(r);
  return d;
};

test('exact: the same text from the same sender within 7 days, values kept; the cluster is named by its first member', () => {
  const d = run([
    feat('a', min(0), 'Nightly import finished for shop 12'),
    feat('b', min(60), 'nightly import finished for shop 12!'),
    feat('c', min(90), 'Nightly import finished for shop 13'),
    feat('d', min(8 * 1440 + 60), 'Nightly import finished for shop 12'),
  ]);
  assert.deepEqual(d.label('b'), { cluster: 'a', conf: EDGE_CONF.exact });
  assert.equal(d.label('c').cluster, 'c', 'another shop is another event');
  assert.equal(d.label('d').cluster, 'd', 'eight days later is outside the window');
  assert.equal(d.joined.get('b'), 'exact');
});

test('a person: the same chat container (not another one), 20+ chars; a short repeat only inside one reply thread within 10 minutes', () => {
  const p = (id: string, t: number, text: string, o: Partial<DedupFeat> = {}) => feat(id, t, text, { human: true, container: 'dm:@lena', ...o });
  const d = run([
    p('a', min(0), 'Can you send me the October numbers?'),
    p('b', min(30), 'Can you send me the October numbers?'),
    p('c', min(31), 'Can you send me the October numbers?', { container: '#finance' }),
    p('d', min(40), 'ok'),
    p('e', min(41), 'ok'),
    p('f', min(50), 'yes please', { thread: 'th:x', reply: true }),
    p('g', min(53), 'yes please.', { thread: 'th:x', reply: true }),
  ]);
  assert.equal(d.label('b').cluster, 'a');
  assert.equal(d.label('c').cluster, 'c', 'another container is a cross-post question, not an exact repeat (and under 40 chars)');
  assert.equal(d.label('e').cluster, 'e', '"ok" twice is two answers');
  assert.equal(d.label('g').cluster, 'f');
});

test('ticket comments repeat only inside one ticket; scrub placeholders never match', () => {
  const c = (id: string, t: number, text: string, thread: string) => feat(id, t, text, { human: true, medium: 'tracker', thread });
  const d = run([
    c('a', min(0), 'Live on production since this morning', 'ticket:1'),
    c('b', min(5), 'Live on production since this morning', 'ticket:2'),
    feat('w1', min(10), '[BODY WITHHELD: credential carrier]'),
    feat('w2', min(11), '[BODY WITHHELD: credential carrier]'),
  ]);
  assert.equal(d.label('b').cluster, 'b', 'the same note on another ticket is another ticket');
  assert.equal(d.label('w2').cluster, 'w2');
});

test('flap: firing → resolve .95 within 30 min, .90 within 4 h; resolve → firing only within 30 min; another host never', () => {
  const line = (state: string, host = 'www.shop.example') => `${state}: SiteFlapping: *https://${host}*: Domain https://${host} is failing intermittently (blackbox)`;
  const d = run([
    feat('w', min(0), `${line('WARNING')}\nuptime 96%`),
    feat('r', min(10), `${line('RESOLVED')}\nuptime 98%`),
    feat('o', min(11), `${line('RESOLVED', 'www.other.example')}\nuptime 98%`),
    feat('w2', min(25), `${line('WARNING')}\nuptime 95%`),
    feat('r2', min(25 + 150), `${line('RESOLVED')}\nuptime 99%`),
    feat('w3', min(25 + 150 + 120), `${line('WARNING')}\nuptime 97%`),
  ]);
  assert.equal(d.joined.get('r'), 'flap');
  assert.equal(d.joined.get('w2'), 'flap', 're-opened within 30 min: flapping');
  assert.equal(d.joined.get('r2'), 'flap-late', 'a long incident closes after 2.5 h');
  assert.deepEqual(d.label('r2'), { cluster: 'w', conf: EDGE_CONF['flap-late'] }, 'the component is as weak as its weakest edge');
  assert.equal(d.label('o').cluster, 'o');
  assert.equal(d.label('w3').cluster, 'w3', 'two quiet hours after the resolve: the next episode');
});

test('alerts are events: a resolve worded differently still meets its firing on rule + target; identical alerts meet only inside an episode', () => {
  const at = (id: string, t: number, text: string, targets = ['api.shop.example']) => feat(id, t, text, { targets });
  const d = run([
    at('w1', min(0), '[WARNING] CPU load above 90% for 5 min on api.shop.example'),
    at('w2', min(5), '[WARNING] CPU load above 90% for 5 min on api.shop.example'),
    at('r1', min(20), '[RESOLVED] CPU load back to normal on api.shop.example (after 20 min)'),
    at('d1', min(25), '[RESOLVED] Disk usage back to normal on api.shop.example'),
    at('w3', min(2 * 1440), '[WARNING] CPU load above 90% for 5 min on api.shop.example'),
  ]);
  assert.equal(d.label('w2').cluster, 'w1');
  assert.deepEqual([d.label('r1').cluster, d.joined.get('r1')], ['w1', 'flap']);
  assert.equal(d.label('d1').cluster, 'd1', 'another rule on the same host');
  assert.equal(d.label('w3').cluster, 'w3', 'two days later: a new episode');
});

test('refire keeps values and links: another order or another deploy run is another event (inside one episode)', () => {
  const d = run([
    feat('a', min(0), 'ERROR: Payment failed for order 1001'),
    feat('b', min(5), 'ERROR: Payment failed for order 1002'),
    feat('c', min(9), 'ERROR: Payment failed for order 1001\nattempt 2'),
    feat('k1', min(20), 'CRITICAL: QueueStuck: *worker-1* queue stalled', { links: ['https://ci.example/run/1'] }),
    feat('k2', min(80), 'CRITICAL: QueueStuck: *worker-1* queue stalled', { links: ['https://ci.example/run/2'], exact: null }),
  ]);
  assert.equal(d.label('b').cluster, 'b');
  assert.equal(d.label('c').cluster, 'a');
  assert.equal(d.label('k2').cluster, 'k2', 'another run link');
});

test('recorder copies of one call; companions; cross-posts; forwards', () => {
  const d = run([
    feat('m1', min(0), 'Weekly sync notes', { human: true, medium: 'meeting', callId: 'call-1', exact: null }),
    feat('m2', min(1), 'Weekly sync summary', { human: true, medium: 'meeting', callId: 'call-1', exact: null }),
    feat('alert', min(10), 'New issue SH-12 in checkout', { links: ['https://errors.example/i/77'] }),
    feat('analysis', min(11), 'Analysis of the issue: a null cart', { sender: 'analyzer bot', links: ['https://errors.example/i/77'] }),
    feat('late', min(20), 'Analysis of another issue', { sender: 'analyzer bot', links: ['https://errors.example/i/77'] }),
    feat('x1', min(30), 'The staging database will be down for maintenance tonight from 22:00', { human: true, container: '#dev' }),
    feat('x2', min(31), 'The staging database will be down for maintenance tonight from 22:00', { human: true, container: '#ops' }),
    feat('o1', min(40), 'Your contract renewal: please find the signed agreement attached for this year', { mail: true, human: true, medium: 'mail', subject: 'contract renewal', subjectLine: 'Contract renewal' }),
    feat('o2', min(100), 'FYI ---------- Forwarded message --------- Your contract renewal: please find the signed agreement attached for this year', {
      mail: true, human: true, medium: 'mail', subject: 'contract renewal', subjectLine: 'Fwd: Contract renewal', forward: true, sender: 'omar-haddad',
    }),
  ]);
  assert.equal(d.label('m2').cluster, 'm1');
  assert.equal(d.joined.get('m2'), 'recorder');
  assert.equal(d.label('analysis').cluster, 'alert');
  assert.equal(d.joined.get('analysis'), 'companion');
  assert.equal(d.label('late').cluster, 'late', 'outside 120 s');
  assert.equal(d.label('x2').cluster, 'x1');
  assert.equal(d.joined.get('x2'), 'crosspost');
  assert.equal(d.label('o2').cluster, 'o1');
  assert.equal(d.joined.get('o2'), 'forward');
});

test('tracker: the notice announcing a ticket joins it, once — comment notices never meet through the ticket', () => {
  const mail = (id: string, t: number, text: string, created: boolean) => feat(id, t, text, { mail: true, medium: 'mail', trackerMail: true, trackerCreated: created, trackerKeys: ['SH-12'], sender: 'tracker@tracker.example' });
  const d = run([
    mail('n2', min(-5), '[Tracker] SH-12 commented: looking into it', false),
    mail('n1', min(0), '[Tracker] SH-12 created: checkout fails', true),
    mail('n3', min(30), '[Tracker] SH-12 created: checkout fails (resent)', true),
    feat('task', min(60), 'SH-12 checkout fails', { human: true, task: true, medium: 'tracker', ownKey: 'SH-12', thread: 'ticket:SH-12' }),
  ]);
  assert.equal(d.label('task').cluster, 'n1');
  assert.equal(d.joined.get('task'), 'tracker');
  assert.equal(d.label('n2').cluster, 'n2', 'a comment notice is another event of the ticket');
  assert.equal(d.label('n3').cluster, 'n3', 'one announcement per ticket');
});

test('a person’s item never joins an integration’s component', () => {
  const d = run([
    feat('bot', min(0), 'The staging database will be down for maintenance tonight from 22:00', { container: '#dev' }),
    feat('human', min(1), 'The staging database will be down for maintenance tonight from 22:00', { human: true, container: '#ops' }),
  ]);
  assert.equal(d.label('human').cluster, 'human');
});

test('bump: the same sender re-sending with ≤ 3 new words; a changed value is never a bump', () => {
  const words = (s: string) => new Set(exactTokens(s));
  assert.equal(isBump(words('please summarise what this task was about'), words('please summarise what this task was about, any update')), true);
  assert.equal(isBump(words('please summarise what this task was about'), words('please summarise what this task was about https://tracker.example/SH-12')), true, 'a link may be added');
  assert.equal(isBump(words('SH-12: checkout broken on staging, please check'), words('SH-12 checkout broken on staging')), true, 'a shortened copy');
  assert.equal(isBump(words('deploy to staging done'), words('deploy to production done')), false, 'a substitution');
  assert.equal(isBump(words('pushed 3 commits a1b2c3d'), words('pushed 3 commits e4f5a6b')), false, 'another commit');
  assert.equal(isBump(words('screenshot 13.38.png'), words('screenshot 15.10.png')), false);
  assert.equal(isBump(words('Perfect, many thanks, Ms Park.'), words('Perfect, many thanks.')), false, 'two thank-yous');
  const d = run([
    feat('a', min(0), 'please summarise what this task was about', { human: true, container: '#dev' }),
    feat('b', min(10), 'please summarise what this task was about, any update', { human: true, container: '#dev' }),
  ]);
  assert.deepEqual(d.label('b'), { cluster: 'a', conf: EDGE_CONF.bump });
});

test('confidence: an item alone is .97, .90 when its family recurred unmatched; a parallel weak edge costs nothing; minConf drops weak edges', () => {
  const d = run([feat('a', min(0), 'Signup from shop 1'), feat('b', min(5), 'Signup from shop 2'), feat('c', min(6), 'Other 3')]);
  assert.equal(d.label('a').conf, SINGLE_CONF);
  assert.equal(d.label('b').conf, SINGLE_FAMILY_CONF);
  assert.equal(d.label('nobody').conf, SINGLE_CONF);
  const p = (id: string, t: number, text: string) => feat(id, t, text, { human: true, container: '#dev', thread: 'th:1' });
  const e = run([p('a', min(0), 'please check the import for the October batch'), p('b', min(5), 'please check the import for the October batch')]);
  assert.deepEqual(e.label('b'), { cluster: 'a', conf: EDGE_CONF.exact }, 'exact joined first; the bump between the same two adds nothing');
  const strict = run([feat('w', min(0), 'WARNING: Disk: *db1* full'), feat('r', min(100), 'RESOLVED: Disk: *db1* full')], { minConf: 0.95 });
  assert.equal(strict.label('r').cluster, 'r', 'a .90 flap is below the floor');
});

test('across days: a later member takes the earlier cluster name, so yesterday’s label still holds', () => {
  const d = new Dedup();
  d.add(feat('mon', Date.parse('2026-10-12T09:00:00Z'), 'Weekly report is ready'));
  const monday = d.label('mon');
  d.add(feat('tue', Date.parse('2026-10-13T09:00:00Z'), 'Weekly report is ready'));
  assert.equal(d.label('tue').cluster, monday.cluster);
  d.add(feat('tue', Date.parse('2026-10-13T09:00:00Z'), 'Weekly report is ready'));
  assert.equal(d.label('tue').cluster, 'mon', 'adding an item twice changes nothing');
});
