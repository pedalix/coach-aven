// Item mode's text features (ported with the bench's stage-0 tests): keys, the cue lexicon, small talk, hosts/apps,
// exact keys, F9 normalisation, alert identities, vocatives, container kinds. Every name, host and company is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertIdentity, containerKind, cuesOf, exactKey, exactTokens, familyToken, hostOf, hostsApps, isSmallTalk, itemKeys, keyPrefixes, normBody, openingName, stripSubject } from './items-text.js';

test('itemKeys and keyPrefixes: tracker keys and links, the prefixes the registry routes', () => {
  assert.deepEqual(itemKeys('SHOP-12 broke, see <https://tracker.example/issue/SHOP-12|SHOP-12> and https://shop.example/a.'), ['SHOP-12', 'https://tracker.example/issue/SHOP-12', 'https://shop.example/a']);
  assert.deepEqual(keyPrefixes('fixes SHOP-12 and BP-3', null, 'see https://x.example/issue/SUP-9'), ['SHOP', 'BP', 'SUP']);
  assert.deepEqual(keyPrefixes('no keys here, utf-8'), []);
});

test('cuesOf: questions, requests, commitments and incidents in EN/DE/RU/IT', () => {
  assert.deepEqual(cuesOf('Is the export live on staging?'), ['Q']);
  assert.deepEqual(cuesOf('Wann ist das Meeting'), ['Q'], 'an interrogative first word, no question mark');
  assert.deepEqual(cuesOf('Где лежит дамп базы'), ['Q']);
  assert.deepEqual(cuesOf('Quando arriva il pacco'), ['Q']);
  assert.deepEqual(cuesOf("That's how we do it"), [], 'an interrogative mid-sentence is no question');
  assert.deepEqual(cuesOf('Please deploy the fix today'), ['R']);
  assert.deepEqual(cuesOf('Посмотри, пожалуйста, PR'), ['R']);
  assert.deepEqual(cuesOf('Könntest du die Rechnung schicken'), ['R']);
  assert.deepEqual(cuesOf("I'll send the draft by Friday"), ['C']);
  assert.deepEqual(cuesOf('Сделаю до вечера'), ['C']);
  assert.deepEqual(cuesOf('Lo faccio domani'), ['C']);
  assert.deepEqual(cuesOf('Checkout returns an error since 10:00'), ['I']);
  assert.deepEqual(cuesOf('[shop] TypeError: cannot read property of undefined'), ['I'], 'an error class name');
  assert.deepEqual(cuesOf('Die Seite geht nicht'), ['I']);
  assert.deepEqual(cuesOf('На проде упал деплой'), ['I']);
  assert.deepEqual(cuesOf('Il sito non funziona'), ['I']);
  assert.deepEqual(cuesOf('Can you check why the import failed?'), ['Q', 'R', 'I']);
  assert.deepEqual(cuesOf('see https://shop.example/a?b=1'), [], 'a question mark inside a link is no question');
  assert.deepEqual(cuesOf(''), []);
});

test('isSmallTalk: greetings, thanks, acknowledgements and emoji only — answers and pings are not', () => {
  for (const t of ['Thanks!', 'ok', 'Good morning', 'Hi Lena', 'Hi @Lena Park morning', ':tada:', '👍', 'Danke schön', 'Спасибо!', 'grazie mille @lena_park !', 'Gotcha thx!']) {
    assert.equal(isSmallTalk(t), true, t);
  }
  for (const t of ['yes', 'correct', 'only hotels', '@lena', '@admin FYI', 'thanks, the export works now', '[file: report.pdf]', 'see https://shop.example', '']) {
    assert.equal(isSmallTalk(t), false, t);
  }
});

test('hostsApps: hosts without ports or tool hosts; deploy projects, repos, bracketed projects and alert targets', () => {
  const a = hostsApps({ subject: null, keys: [], text: 'WARNING: SiteFlapping: *https://www.shop.example*: Domain https://www.shop.example is failing (probe)' });
  assert.deepEqual(a, { hosts: ['www.shop.example'], apps: [] });
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'CRITICAL: InstanceDown: *db-primary*: Instance db-primary down' }).apps, ['db-primary']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'CRITICAL: InstanceDown: *api.shop.example:443* down' }).hosts, ['api.shop.example']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'Shopfront: Deploy to *production* successful' }).apps, ['shopfront']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'Deployed shop-api v1.4.2 to production' }).apps, ['shop-api']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'Deploy to production succeeded' }).apps, [], 'no app named');
  assert.deepEqual(
    hostsApps({ subject: null, keys: [], text: ':white_check_mark: Deploy to production succeeded Project: shop-admin \n Job: https://github.com/acme-org/shop-admin/actions/runs/1' }),
    { hosts: [], apps: ['acme-org/shop-admin', 'shop-admin'] },
    'the code host is a tool; its repo is the app',
  );
  assert.deepEqual(hostsApps({ subject: '[acme-org/garden] Run failed: ci', keys: [], text: 'Repository: acme-org/garden' }).apps, ['acme-org/garden']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: '[shop] ReferenceError: x is not defined' }).apps, ['shop']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: '[RESOLVED] disk full' }).apps, [], 'a state in brackets is no project');
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'os.name: Mac, browser.name: Firefox, notes.md and deploy.sh' }).hosts, [], 'dotted keys and file names are no hosts');
  const wrapped = 'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fstatus.vendor.example%2Fx&data=1';
  assert.equal(hostOf(wrapped), 'status.vendor.example', 'a safelink gives the URL it wraps');
  assert.deepEqual(hostsApps({ subject: null, keys: [wrapped], text: '' }).hosts, ['status.vendor.example']);
  assert.deepEqual(hostsApps({ subject: null, keys: [], text: 'see https://acme.slack.com/archives/C1 and https://app.tracker.example/x' }).hosts, ['app.tracker.example']);
});

test('exactKey: values kept, case/spacing/edge punctuation and scrub placeholders gone; placeholders alone never match', () => {
  assert.equal(exactKey({ subject: null, text: 'SH-12: Login broken!' }, false)!.key, exactKey({ subject: null, text: 'sh-12   login BROKEN' }, false)!.key);
  assert.notEqual(exactKey({ subject: null, text: 'Order 1001 shipped' }, false)!.key, exactKey({ subject: null, text: 'Order 1002 shipped' }, false)!.key);
  assert.equal(exactKey({ subject: null, text: '[BODY WITHHELD: credential carrier]' }, false), null);
  assert.equal(exactKey({ subject: null, text: 'key [REDACTED:api_key:a1b2c3]' }, false)!.key, 'key');
  assert.equal(exactKey({ subject: 'Re: Fwd: Invoice', text: 'Hello' }, true)!.key, 'invoice\nhello', 'a mail keys on its subject too');
  assert.equal(exactKey({ subject: 'Invoice', text: 'Hello' }, false)!.key, 'hello', 'a chat subject (the parent excerpt) is not part of it');
  assert.equal(stripSubject('AW: WG: Angebot'), 'Angebot');
  assert.deepEqual(exactTokens('Deploy v1.2.3 — done.'), ['deploy', 'v1.2.3', 'done']);
});

test('normBody: F9 — URLs become hosts, addresses/hex/numbers placeholders, punctuation goes', () => {
  assert.equal(normBody('Order #1001 for ana@shop.example: see https://shop.example/o/1001?x=1'), 'order <n> for <email> see shop.example');
  assert.equal(normBody('commit 3f9a2c1d pushed'), 'commit <hex> pushed');
  assert.equal(normBody('[BODY WITHHELD: x]'), '');
});

test('alertIdentity: a monitor state word is required; values stay, state words go', () => {
  assert.equal(alertIdentity('RESOLVED: DiskFull: *db1.shop.example* disk is 91% full'), alertIdentity('WARNING: DiskFull: *db1.shop.example* disk is 91% full'));
  assert.notEqual(alertIdentity('ERROR: Payment failed for order 1001'), alertIdentity('ERROR: Payment failed for order 1002'), 'another order is another alert');
  assert.equal(alertIdentity(':white_check_mark: Deploy to production succeeded'), '', 'an emoji alone does not make an alert');
  assert.equal(alertIdentity('A user signed up'), '');
});

test('openingName: the name a message opens with, after up to two greeting words; a surname after an honorific', () => {
  assert.deepEqual(openingName('Lena, can you check the import?'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Hi Lena — the import failed again'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Ciao Nina!'), { word: 'Nina', surname: false });
  assert.deepEqual(openingName('@omar Lena: please look'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Guten Tag Frau Park, wann ist es fertig?'), { word: 'Park', surname: true });
  assert.equal(openingName('Lena said yesterday it works'), null, 'a name used as a subject is no vocative');
  assert.equal(openingName('the import failed'), null);
});

test('containerKind: DMs, group chats (Slack mpim: too), channels, mail, trackers, meetings', () => {
  assert.equal(containerKind('slack', 'dm:@lena', false, 'message'), 'dm');
  assert.equal(containerKind('msgraph', 'chat:@Lena Park', false, 'message'), 'dm');
  assert.equal(containerKind('slack', 'mpim:@lena+@omar', false, 'message'), 'group');
  assert.equal(containerKind('msgraph', 'chat:group:Launch', false, 'message'), 'group');
  assert.equal(containerKind('slack', '#general', false, 'message'), 'channel');
  assert.equal(containerKind('msgraph', 'chat:meeting:Weekly', false, 'message'), 'channel');
  assert.equal(containerKind('gmail', 'inbox', true, 'message'), 'mail');
  assert.equal(containerKind('youtrack', 'SH', false, 'comment'), 'tracker');
  assert.equal(containerKind('granola', null, false, 'meeting'), 'meeting');
});

test('familyToken: what an item is about — an alert\'s target, else the first host in text order; never a dashboard', () => {
  const tok = (text: string, alert = false) => {
    const u = { text, subject: null, keys: itemKeys(text) };
    return familyToken(u, hostsApps(u), alert);
  };
  // The dashboard link sorts first ("acme.grafana.net" < "www.…"): two sites' alerts must not share it.
  const down = (site: string) => `CRITICAL: SiteDown: *https://${site}*: Domain https://${site} is down (probe) details https://acme.grafana.net/d/uptime`;
  assert.deepEqual([tok(down('www.shop-a.example'), true), tok(down('www.portal-b.example'), true)], ['www.shop-a.example', 'www.portal-b.example']);
  assert.equal(tok('Deploy finished: https://zz.shop.example then https://aa.portal.example'), 'zz.shop.example', 'text order, not sorted');
  assert.equal(tok('Uptime report https://stats.uptimerobot.com/x https://grafana.acme.example/d/1'), '', 'monitoring and dashboard hosts only: nothing');
  assert.equal(tok('WARNING: DiskFull: *db-primary* see https://wiki.acme.example/disk', true), 'db-primary', "an alert's target beats any other host");
  assert.equal(tok('WARNING: DiskFull: *db-primary* see https://wiki.acme.example/disk'), 'wiki.acme.example', 'not an alert: the first host');
  assert.equal(tok('FIRING: High load on https://node7.acme.example\nGraph: https://acme.grafana.net/d/2 Runbook: https://wiki.acme.example/load', true), 'node7.acme.example', 'no *target*: the first host of the first line');
  assert.equal(tok('[shop] build failed'), 'shop', 'no host: the first app');
});
