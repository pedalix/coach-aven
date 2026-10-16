// The registry's stage-0 fixes (F2 short title patterns, F6 channels/hosts/apps) on a fictional agency tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelIdOf, normHost, parseRegistry, Registry, titleMatcher } from './registry.js';

const reg = new Registry(parseRegistry({
  initiatives: [
    {
      id: 'acme/shop',
      umbrella: 'acme',
      sources: {
        slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }, '#acme-dev'],
        calendar_title_patterns: ['Acme', 'ART'],
        hosts: ['https://shop.acme.example:443/health', 'acme.example'],
        apps: ['acme-shop'],
      },
    },
    { id: 'acme/retainer', umbrella: 'acme', sources: { slack_channels: ['#ext-acme'], calendar_title_patterns: ['Support call'], hosts: ['acme.example'] } },
    { id: 'acme/legacy', umbrella: 'acme', alias_of: 'acme/shop', sources: { slack_channels: ['#acme-dev'] } },
    { id: 'globex/portal', umbrella: 'globex', sources: { teams_channels: ['Theo Brandt', { id: 'C0OPS00001', name: 'ops', closed: true }, 'G0PRIV0001'], calendar_title_patterns: ['Обзор', 'Портал'] } },
  ],
}));
const people = new Set(['theo brandt']);

test('F6: {id, name} channels route by id first — a renamed channel keeps routing — then by the normalised name', () => {
  const byId = reg.routeChannel('#renamed-since', 'C0SHOP0001');
  assert.deepEqual([byId.initiative, byId.confidence], ['acme/shop', 'default'], 'only the shop lists the id');
  assert.equal(reg.routeChannel('#ext-acme', 'C0UNKNOWN01').confidence, 'ambiguous', 'an unknown id falls back to the name');
  assert.equal(reg.routeChannel('#nowhere', 'C0UNKNOWN01').confidence, 'none');
  assert.equal(reg.routeChannel('channel:Ops').initiative, 'globex/portal', 'an object entry routes by its name too');
  assert.equal(reg.routeChannel('#private', 'G0PRIV0001').initiative, 'globex/portal', 'an id-shaped string is an id');
  assert.equal(reg.routeChannel('g0priv0001').initiative, 'globex/portal', '…and still the name it always was');
});

test('F6: a channel several initiatives list gives them as candidates; an alias listing its target\'s channel is one initiative', () => {
  const shared = reg.routeChannel('#ext-acme');
  assert.deepEqual([shared.initiative, shared.confidence, shared.candidates], [null, 'ambiguous', ['acme/shop', 'acme/retainer']]);
  assert.match(shared.reason, /matches several/);
  const alias = reg.routeChannel('#acme-dev');
  assert.deepEqual([alias.initiative, alias.candidates], ['acme/shop', ['acme/shop']]);
});

test('F6: a name-only entry naming a person is a marker, not a place; an entry with an id always is a place', () => {
  assert.equal(reg.routeChannel('chat:@Theo Brandt | Initrode', null, people).confidence, 'none');
  assert.equal(reg.routeChannel('chat:@Theo Brandt | Initrode').initiative, 'globex/portal', 'without the people the entry is a name like any other');
  assert.equal(reg.routeChannel('#x', 'C0OPS00001', new Set(['ops'])).initiative, 'globex/portal');
});

test('F6: closed channels, hosts (a subdomain matches; the longest listed host wins), apps', () => {
  assert.equal(reg.closedChannel('#ops'), true);
  assert.equal(reg.closedChannel('#renamed', 'C0OPS00001'), true);
  assert.equal(reg.closedChannel('#ext-acme', 'C0SHOP0001'), false);
  assert.equal(normHost('HTTPS://Shop.Acme.Example:8443/x?y'), 'shop.acme.example');
  assert.equal(reg.routeHost('api.shop.acme.example').initiative, 'acme/shop', 'shop.acme.example is longer than acme.example');
  const parent = reg.routeHost('www.acme.example');
  assert.deepEqual([parent.confidence, parent.candidates], ['ambiguous', ['acme/shop', 'acme/retainer']]);
  assert.equal(reg.routeHost('db.globex.example').confidence, 'none');
  assert.equal(reg.routeHost('').reason, 'no host');
  assert.equal(reg.routeApp(' ACME-SHOP ').initiative, 'acme/shop');
  assert.equal(reg.routeApp('acme').confidence, 'none', 'apps match whole tokens');
});

test('channelIdOf: the Slack channel inside a message ref; other refs have none', () => {
  assert.equal(channelIdOf('slack:T0TEAM0001:C0SHOP0001:1760000000.000100'), 'C0SHOP0001');
  assert.equal(channelIdOf('slack:T0TEAM0001:#shop:1'), null);
  assert.equal(channelIdOf('msgraph:me@acme.example:AAMkAD'), null);
  assert.equal(channelIdOf(undefined), null);
});

test('F2: title patterns of ≤ 5 characters are whole words (Unicode-aware); longer ones stay substrings', () => {
  assert.equal(titleMatcher('ART')('Weekly ART sync'), true);
  assert.equal(titleMatcher('ART')('Karte und Plan'), false);
  assert.equal(titleMatcher('Mia')('Trip to Miami'), false);
  assert.equal(titleMatcher('Mia')('mia, kickoff'), true);
  assert.equal(titleMatcher('ERP')('ЯERP'), false, 'JS \\b would see an edge after Я; a letter is a letter');
  assert.equal(titleMatcher('ERP')('Обзор ERP-моста'), true);
  assert.equal(titleMatcher('Обзор')('Обзор: портал'), true);
  assert.equal(titleMatcher('Обзор')('Обзоры дилеров'), false);
  assert.equal(titleMatcher('Портал')('Порталы дилеров'), true, '6 letters: a substring, as before');
  assert.equal(reg.routeTitle('Karte und Plan').confidence, 'none');
  assert.equal(reg.routeTitle('ART weekly').initiative, 'acme/shop');
  assert.deepEqual(reg.routeTitle('Acme support call').candidates, ['acme/shop', 'acme/retainer']);
  assert.equal(reg.routeTitle('   ').reason, 'empty title');
});

test('F2: a short pattern padded or punctuated the way the substring rule needed still matches — word edges only at its letters', () => {
  assert.equal(titleMatcher(' ST ')('Weekly ST sync'), true, 'padding is trimmed');
  assert.equal(titleMatcher(' ST ')('ST Weekly'), true);
  assert.equal(titleMatcher('ST ')('ST Weekly'), true);
  assert.equal(titleMatcher(' ST ')('Strategy'), false, 'still a word');
  assert.equal(titleMatcher('HCG:')('HCG:Weekly'), true, 'no edge needed after the colon');
  assert.equal(titleMatcher('HCG:')('XLHS:Weekly'), false, '…but before the L');
  assert.equal(titleMatcher('[ST]')('[ST]Weekly'), true);
  assert.equal(titleMatcher('[ST]')('Sync [st] notes'), true);
  assert.equal(titleMatcher('   ')('Any title at all'), false, 'a blank pattern names nothing');
});
