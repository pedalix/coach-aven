// senderClass: one answer for the store's is_bot and the collector's isSystem. Names and domains are fictional
// (*.example) except the public product relays the rules are about (github.com, google.com, amazonses.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_NAMES, isMachine, parseSender, senderClass, type SenderInput } from './sender.js';
import { isBotAuthor, KNOWN_BOT_NAMES } from './bots.js';
import { isSystem, parseIdentity } from './identities/normalise.js';

const slack = (author: string, extra: Partial<SenderInput> = {}): SenderInput => ({ source: 'slack', author, container: '#ops', ...extra });
const mail = (author: string, extra: Partial<SenderInput> = {}): SenderInput => ({ source: 'gmail', author, container: 'inbox', subject: 'Hello', text: 'Some text.', ...extra });

test('parseSender: display name, address, company suffix', () => {
  assert.deepEqual(parseSender('Ana Berg | Acme <Ana.Berg@Acme.example>'), { display: 'ana berg', email: 'ana.berg@acme.example', local: 'ana.berg', domain: 'acme.example' });
  assert.deepEqual(parseSender('Shop Alert Bot'), { display: 'shop alert bot', email: null, local: '', domain: '' });
  assert.equal(parseSender('"Acme News" <news@acme.example>').display, 'acme news');
});

test('human: people in chat and mail, resolved or not; a cold mail without bulk markers stays a person', () => {
  assert.equal(senderClass(slack('Ana Berg')), 'human');
  assert.equal(senderClass(slack('U0123ABCDE')), 'human', 'an unknown Slack Connect member is not a bot');
  assert.equal(senderClass(mail('Ana Berg <ana.berg@acme.example>', { authorResolved: true })), 'human');
  assert.equal(senderClass(mail('rui.rosa@newclient.example')), 'human', 'unresolved and one-way, but nothing says campaign');
  assert.equal(senderClass({ source: 'msgraph', author: 'Ana Berg | Acme <ana@acme.example>', container: 'chat:19:abc' }), 'human');
  assert.equal(senderClass(mail('Ana Berg <ana@acme.example>', { authorResolved: true, text: 'fwd below — unsubscribe link at the bottom' })), 'human', 'a colleague forwarding a newsletter');
  assert.equal(senderClass(mail('rui@newclient.example', { subjectWroteInThread: true, text: 'opt out of the call?' })), 'human', 'a two-way thread is never bulk');
});

test('bot: the puller flag, unflagged Slack bot ids, integration names and words, integration mail relays', () => {
  assert.equal(senderClass(slack('Ana Berg', { isBotFlag: true })), 'bot');
  assert.equal(senderClass(slack('B0123ABCD')), 'bot', 'old bot ids the users map does not cover');
  assert.equal(senderClass(slack('Shop Alert Bot')), 'bot');
  assert.equal(senderClass(slack('shop-webhook')), 'bot');
  assert.equal(senderClass(slack('dependabot[bot]')), 'bot');
  assert.equal(senderClass(slack('Sentry Quick Analyzer')), 'bot');
  assert.equal(senderClass(mail('Ana Berg <notifications@github.com>', { text: 'Reply to this email directly or unsubscribe.' })), 'bot', 'tool activity, not a campaign');
  assert.equal(senderClass(mail('jira@acme.atlassian.net')), 'bot');
  assert.equal(senderClass(mail('Google <calendar-notification@google.com>')), 'bot');
  assert.equal(senderClass(mail('build-bot@ci.example')), 'bot');
  assert.equal(senderClass(slack('CoachAven', { authorResolved: true })), 'bot', 'a bot mapped to a pseudo-person is still a bot');
  assert.equal(senderClass(mail('ops@acme.example', { isBotFlag: true })), 'bot', 'a mail flag nothing else explains');
  assert.equal(senderClass({ source: 'youtrack', author: 'YouTrack', container: 'youtrack:SHOP' }), 'bot');
});

test('bulk: one-way, unresolved mail with a campaign marker in the content, the sender or the folder', () => {
  assert.equal(senderClass(mail('Acme <news@acme.example>')), 'bulk', 'a campaign mailbox');
  assert.equal(senderClass(mail('Acme Newsletter <team@acme.example>')), 'bulk', 'the display name says it');
  assert.equal(senderClass(mail('hello@shop.example', { text: 'New arrivals! … Unsubscribe | Privacy' })), 'bulk', 'content beats a role mailbox');
  assert.equal(senderClass(mail('noreply@shop.example', { text: 'View this email in your browser' })), 'bulk', 'content beats an automated mailbox');
  assert.equal(senderClass(mail('Anna from Acme <anna@acme.example>', { text: 'Newsletter abbestellen' })), 'bulk');
  assert.equal(senderClass(mail('anna@acme.example', { text: 'Отписаться от рассылки' })), 'bulk');
  assert.equal(senderClass(mail('anna@acme.example', { text: 'Clicca qui per disiscriverti' })), 'bulk');
  assert.equal(senderClass(mail('deals@em.brand.example')), 'bulk', 'a campaign subdomain');
  assert.equal(senderClass(mail('anna=brand.example@mail.mcsv.net')), 'bulk', 'a marketing ESP');
  assert.equal(senderClass(mail('ana.berg@acme.example', { container: 'spam' })), 'bulk', 'the spam folder');
  assert.equal(senderClass(mail('news@acme.example', { isBotFlag: true })), 'bulk', 'a store flag does not pre-empt the mail rules');
  assert.equal(senderClass(mail('ana@mail.example')), 'human', 'a two-label mail provider is not a campaign subdomain');
});

test('system: role and automated mailboxes, transactional relays — unless the tenant mapped the address to a person', () => {
  assert.equal(senderClass(mail('noreply@bank.example', { text: 'Your statement is ready.' })), 'system');
  assert.equal(senderClass(mail('notifications@tool.example')), 'system');
  assert.equal(senderClass(mail('Vendor Support <support@vendor.example>', { subjectWroteInThread: true, text: 'Could you send us the logs?' })), 'system', 'a support reply is a role, even in a two-way thread');
  assert.equal(senderClass(mail('billing@vendor.example')), 'system');
  assert.equal(senderClass(mail('info@vendor.example')), 'system');
  assert.equal(senderClass(mail('account-security-noreply@accountprotection.microsoft.com')), 'system');
  assert.equal(senderClass({ source: 'msgraph', author: 'IT Desk <support@acme.example>', container: 'chat:19:xyz', text: 'unsubscribe' }), 'system', 'chat is never bulk');
  assert.equal(senderClass(mail('')), 'system', 'no sender at all');
  assert.equal(senderClass({ source: 'gmail', author: null }), 'system');
  assert.equal(senderClass(mail('support@acme.example', { authorResolved: true })), 'human', 'the people file wins over the role list, as in the collector');
  assert.equal(isMachine('system') && isMachine('bulk') && isMachine('bot') && !isMachine('human'), true);
});

test('the merged list covers both old lists', () => {
  for (const n of KNOWN_BOT_NAMES) assert.ok(BOT_NAMES.has(n), `bots.ts: ${n}`);
  // normalise.ts SYSTEM_NAMES (not exported) — every one of them is a system name there and a bot here.
  for (const n of ['intercom', 'intercom convert', 'gleap', 'sentry', 'sentry quick analyzer', 'digitalocean', 'zapier', 'amazon q', 'asana', 'coachaven', 'coach aven', 'slackbot', 'github', 'youtrack', 'jira', 'confluence', 'google calendar', 'microsoft teams', 'wrike', 'fireflies', 'granola', 'wispr', 'cloudflare', 'stripe', 'vercel', 'instant google meet', 'google meet', 'devcoachaven', 'aven home']) {
    assert.ok(isSystem(parseIdentity(n)), `normalise.ts: ${n}`);
    assert.ok(BOT_NAMES.has(n), `merged: ${n}`);
    assert.equal(senderClass(slack(n)), 'bot', n);
  }
});

// The disagreements 03 §4 found between the store (isBotAuthor) and the collector (isSystem), one fictional case per
// kind, with what each says today and the single answer now.
test('disagreements between bots.ts and normalise.ts resolve to one class', () => {
  const dir = new Map();
  const cases: { input: SenderInput; store: boolean; collector: boolean; now: string }[] = [
    { input: slack('GitLab'), store: true, collector: false, now: 'bot' },
    { input: slack('Grafana'), store: true, collector: false, now: 'bot' },
    { input: slack('PagerDuty'), store: true, collector: false, now: 'bot' },
    { input: slack('Google Drive'), store: true, collector: false, now: 'bot' },
    { input: slack('Wrike'), store: false, collector: true, now: 'bot' },
    { input: slack('Fireflies'), store: false, collector: true, now: 'bot' },
    { input: slack('Cloudflare'), store: false, collector: true, now: 'bot' },
    { input: mail('support@vendor.example'), store: false, collector: true, now: 'system' },
    { input: mail('service@vendor.example'), store: false, collector: true, now: 'system' },
    { input: mail('newsletter@brand.example'), store: false, collector: true, now: 'bulk' },
    { input: mail('Weekly <digest@brand.example>'), store: false, collector: true, now: 'bulk' },
    { input: mail('ana@alerts.bank.example'), store: false, collector: true, now: 'system' },
    { input: mail('robot@ci.example'), store: true, collector: false, now: 'system' },
    { input: mail('relay@amazonses.com'), store: true, collector: false, now: 'system' },
  ];
  for (const c of cases) {
    const author = c.input.author!;
    assert.equal(isBotAuthor(c.input.source, author, dir), c.store, `store today: ${author}`);
    assert.equal(isSystem(parseIdentity(author)), c.collector, `collector today: ${author}`);
    assert.equal(senderClass(c.input), c.now, `now: ${author}`);
  }
  // Both call an unflagged Slack bot id a person today.
  assert.equal(isBotAuthor('slack', 'B0123ABCD', dir), false);
  assert.equal(isSystem(parseIdentity('B0123ABCD')), false);
  assert.equal(senderClass(slack('B0123ABCD')), 'bot');
});
