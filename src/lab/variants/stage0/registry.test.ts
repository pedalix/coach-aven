import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normChannel, normHost, Reg, titleMatcher } from './registry.js';

// A fictional agency: two clients, an alias left by a rename, a split, and one channel two initiatives share.
const RAW = {
  companies: [
    { id: 'acme', umbrella: 'acme', name: 'Acme Hotels', notes: 'acme-hotels.example, acme.example; tracker acme.tracker.example' },
    { id: 'beta', umbrella: 'beta', name: 'Beta Bikes', domains: ['beta-bikes.example'] },
  ],
  initiatives: [
    {
      id: 'acme/shop',
      umbrella: 'acme',
      company: 'acme',
      name: 'Online shop',
      status: 'active',
      billing_code: 'AC-SHOP',
      sources: {
        repos: ['github.com/agency/acme-shop'],
        youtrack_prefixes: ['SHOP'],
        slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }, '#acme-dev'],
        calendar_title_patterns: ['Acme', 'ART'],
        hosts: ['https://shop.acme.example:443/health'],
        apps: ['acme-shop'],
      },
    },
    { id: 'acme/retainer', umbrella: 'acme', company: 'acme', name: 'Support retainer', status: 'done', sources: { slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }], calendar_title_patterns: ['Support call'] } },
    { id: 'acme/admin', umbrella: 'acme', name: 'Acme admin', status: 'active', sources: {} },
    { id: 'beta/portal', umbrella: 'beta', company: 'beta', name: 'Dealer portal', sources: { jira_keys: ['BP'], local_paths: ['/work/beta', '/work/beta/portal'], calendar_title_patterns: ['Портал'], slack_channels: ['Ana Berg'] } },
    { id: 'beta/old-name', umbrella: 'beta', name: 'Old name', status: 'alias', alias_of: 'beta/portal', sources: { calendar_title_patterns: ['Legacy portal'] } },
    { id: 'beta/onboarding', umbrella: 'beta', name: 'Onboarding', split_into: { 'acme/shop': 0.25, 'beta/portal': 0.75 }, sources: { calendar_title_patterns: ['onboarding'] } },
  ],
};

const reg = () => new Reg(RAW, new Set(['ana berg']));

test('reads either shape: {initiatives: [...]} and a bare array', () => {
  assert.equal(reg().list.length, 6);
  assert.equal(new Reg(RAW.initiatives).list.length, 6);
  assert.equal(new Reg({ nope: 1 }).list.length, 0);
  assert.equal(new Reg([{ name: 'no id' }, { id: 'x/y' }]).list.length, 1);
});

test('aliases resolve, splits expand by share, label ids hold neither', () => {
  const r = reg();
  assert.equal(r.resolve('beta/old-name'), 'beta/portal');
  assert.equal(r.resolve('beta/onboarding'), 'beta/onboarding'); // the split is the answer until expanded
  assert.deepEqual(r.labels('beta/onboarding'), ['beta/portal', 'acme/shop']);
  assert.equal(r.label('beta/onboarding'), 'beta/portal');
  assert.deepEqual(r.labelIds(), ['acme/shop', 'acme/retainer', 'acme/admin', 'beta/portal']);
  assert.equal(r.umbrellaOf('beta/old-name'), 'beta');
  assert.equal(r.get('acme/retainer')!.done, true);
  assert.equal(r.get('acme/shop')!.code, 'AC-SHOP');
});

test('F6: {id,name} channels match by id first (rename-proof), then by name; a shared channel gives two hits', () => {
  const r = reg();
  assert.deepEqual(r.routeChannel('#renamed-channel', 'C0SHOP0001').hits, ['acme/shop', 'acme/retainer']);
  assert.deepEqual(r.routeChannel('#ext-acme').hits, ['acme/shop', 'acme/retainer']);
  assert.deepEqual(r.routeChannel('#acme-dev').hits, ['acme/shop']);
  assert.equal(r.routeChannel('#acme-dev').via, 'acme-dev');
  assert.deepEqual(r.routeChannel('#unknown').hits, []);
  // a channel list naming a person is a marker, not a place
  assert.deepEqual(r.routeChannel('chat:@Ana Berg').hits, []);
  assert.equal(normChannel('chat:@Ana Berg | Acme'), 'ana berg');
});

test('F2: patterns of ≤5 chars are whole words (Unicode-aware); longer ones stay substrings', () => {
  assert.equal(titleMatcher('ART')('Weekly ART sync'), true);
  assert.equal(titleMatcher('ART')('Karte und Plan'), false);
  assert.equal(titleMatcher('Mia')('Trip to Miami'), false);
  assert.equal(titleMatcher('Mia')('mia, kickoff'), true);
  assert.equal(titleMatcher('Обзор')('Обзор: портал'), true); // 5 letters, Cyrillic: whole word…
  assert.equal(titleMatcher('Обзор')('Обзоры дилеров'), false); // …not inside a longer word
  assert.equal(titleMatcher('Портал')('Порталы дилеров'), true); // 6 letters: a substring
  assert.equal(titleMatcher('ERP')('ЯERP'), false); // JS \b would match here (Я is not a \w); the Unicode boundary does not
  assert.equal(titleMatcher('ERP')('ERPs'), false);
  assert.equal(titleMatcher('ERP')('Обзор ERP-моста'), true);
  const r = reg();
  assert.deepEqual(r.routeTitle('Acme weekly').hits, ['acme/shop']);
  assert.equal(r.routeTitle('Acme weekly').via, 'acme');
  assert.deepEqual(r.routeTitle('Acme support call').hits, ['acme/shop', 'acme/retainer']);
  assert.deepEqual(r.routeTitle('Legacy portal review').hits, ['beta/portal']); // alias-resolved
  assert.deepEqual(r.routeTitle('Onboarding of the new dev').hits, ['beta/onboarding']);
  assert.deepEqual(r.routeTitle('').hits, []);
});

test('repos, paths (longest prefix), keys', () => {
  const r = reg();
  assert.deepEqual(r.routeRepo('git@github.com:agency/acme-shop.git').hits, ['acme/shop']);
  assert.equal(r.routeRepo('https://github.com/agency/acme-shop').via, 'agency/acme-shop');
  assert.deepEqual(r.routeRepo('github.com/agency/other').hits, []);
  assert.deepEqual(r.routePath('/work/beta/portal/src').hits, ['beta/portal']);
  assert.equal(r.routePath('/work/beta/portal/src').via, '/work/beta/portal');
  assert.deepEqual(r.routePath('/work/elsewhere').hits, []);
  assert.deepEqual(r.routeKeys(['bp']).hits, ['beta/portal']);
  assert.deepEqual(r.routeKeys(['XX', 'SHOP', 'BP']), { hits: ['acme/shop', 'beta/portal'], via: 'SHOP' });
});

test('hosts and apps route bot items; a closed channel and the companies of mail domains', () => {
  const r = reg();
  assert.equal(normHost('HTTPS://Shop.Acme.Example:8443/x?y'), 'shop.acme.example');
  assert.deepEqual(r.routeHost('shop.acme.example').hits, ['acme/shop']);
  assert.deepEqual(r.routeHost('api.shop.acme.example').hits, ['acme/shop']);
  assert.deepEqual(r.routeHost('www.acme.example').hits, []);
  assert.deepEqual(r.routeApp('ACME-SHOP').hits, ['acme/shop']);
  assert.equal(r.hasHostsOrApps(), true);
  const closed = new Reg({ initiatives: [{ id: 'x/ops', sources: { slack_channels: [{ id: 'C0OPS00001', name: '#ops', closed: true }] } }] });
  assert.equal(closed.closedChannel('#ops'), true);
  assert.equal(closed.closedChannel('#elsewhere', 'C0OPS00001'), true);
  assert.equal(reg().closedChannel('#ext-acme'), false);
  assert.equal(r.companyOfDomain('acme-hotels.example')?.id, 'acme');
  assert.equal(r.companyOfDomain('mail.acme.example')?.id, 'acme');
  assert.equal(r.companyOfDomain('beta-bikes.example')?.id, 'beta');
  assert.equal(r.companyOfDomain('gamma.example'), null);
  assert.deepEqual(r.initiativesOfCompany('acme', 'acme'), ['acme/shop', 'acme/retainer']);
});
