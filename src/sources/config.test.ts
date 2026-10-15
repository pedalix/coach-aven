import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSourcesConfig } from './config.js';

test('sources config: full valid block is normalised (lower-cased e-mails, trimmed)', () => {
  const out = validateSourcesConfig({
    google: { accounts: ['Owen@Home.example ', 'owen@side.example'], since: '2026-09-01', calendars: [], kinds: ['gmail', 'calendar'] },
    slack: { workspaces: ['T0000FAKE01'], since: '2026-10-06', threadWindowDays: 30, editWindowHours: 48 },
    msgraph: { tenant: '00000000-0000-4000-8000-000000000000', accounts: ['owen.hale@partner.example'], only: ['mail', 'chats'], calendars: [' AQMkShared '] },
    intervalMinutes: 15,
    people: 'projects.d/owen-ops.people.json',
  });
  assert.deepEqual(out.google?.accounts, ['owen@home.example', 'owen@side.example']);
  assert.equal(out.msgraph?.tenant, '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(out.msgraph?.only, ['mail', 'chats']);
  assert.deepEqual(out.msgraph?.calendars, ['AQMkShared']);
  assert.equal(validateSourcesConfig({ msgraph: { tenant: '00000000-0000-4000-8000-000000000000', accounts: ['a@b.co'] } }).msgraph?.calendars, undefined, 'absent stays absent (default: the default calendar only)');
  assert.equal(out.intervalMinutes, 15);
});

test('sources config: rejects unknown keys, bad dates, bad kinds, non-GUID tenant, empty block, "..", out-of-range ints', () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ gmail: {} }, /unknown key "gmail"/],
    [{ google: { accounts: ['a@b.co'], since: '2026-9-1' } }, /since.*YYYY-MM-DD/],
    [{ google: { accounts: ['a@b.co'], kinds: ['mail'] } }, /kinds.*unknown entries/],
    [{ google: { accounts: ['not-an-email'] } }, /not an e-mail/],
    [{ google: { accounts: [] } }, /at least one/],
    [{ msgraph: { tenant: 'contoso', accounts: ['a@b.co'] } }, /tenant.*GUID/],
    [{ msgraph: { tenant: '00000000-0000-4000-8000-000000000000', accounts: ['a@b.co'], only: ['teams'] } }, /only.*unknown/],
    [{ msgraph: { tenant: '00000000-0000-4000-8000-000000000000', accounts: ['a@b.co'], calendars: [''] } }, /calendars.*non-empty strings/],
    [{ slack: { workspaces: [], editWindowHours: -1 } }, /editWindowHours/],
    [{ slack: { workspaces: 'T1' } }, /workspaces.*array/],
    [{ intervalMinutes: 15 }, /declares no source/],
    [{ google: { accounts: ['a@b.co'] }, intervalMinutes: 0 }, /intervalMinutes/],
    [{ google: { accounts: ['a@b.co'] }, people: '../etc/passwd' }, /people/],
    [[], /must be an object/],
  ];
  for (const [input, re] of bad) assert.throws(() => validateSourcesConfig(input, 'projects.config.json: project "x" sources'), re, JSON.stringify(input));
});

test('sources config: slack with no workspaces means "every stored workspace"', () => {
  assert.deepEqual(validateSourcesConfig({ slack: { workspaces: [] } }).slack, { workspaces: [] });
});

test('sources config: slack.channels / slack.kinds — names lose their #, kinds are a subset, empty or hash-only lists are rejected, absent stays absent', () => {
  const s = validateSourcesConfig({ slack: { workspaces: ['T0000FAKE01'], channels: ['#bluefin-aven-caldora', ' C0BBX082QNQ'], kinds: ['channel', 'group'] } }).slack!;
  assert.deepEqual(s.channels, ['bluefin-aven-caldora', 'C0BBX082QNQ']);
  assert.deepEqual(s.kinds, ['channel', 'group']);
  assert.equal(validateSourcesConfig({ slack: { workspaces: [], joinPublic: true } }).slack!.joinPublic, true);
  assert.throws(() => validateSourcesConfig({ slack: { workspaces: [], joinPublic: 'yes' } }), /joinPublic/);
  assert.equal(validateSourcesConfig({ slack: { workspaces: [] } }).slack!.channels, undefined, 'no allow-list = every conversation, as before');
  for (const [input, re] of [
    [{ slack: { workspaces: [], channels: [] } }, /channels.*at least one/],
    [{ slack: { workspaces: [], channels: ['#'] } }, /channels.*names or conversation ids/],
    [{ slack: { workspaces: [], kinds: ['dm'] } }, /kinds.*unknown entries/],
    [{ slack: { workspaces: [], kinds: [] } }, /kinds.*at least one/],
  ] as Array<[unknown, RegExp]>) assert.throws(() => validateSourcesConfig(input), re, JSON.stringify(input));
});

test('tracker blocks validate and normalise', () => {
  const c = validateSourcesConfig({
    youtrack: { url: 'https://bluefin-example.youtrack.cloud/', tokenEnv: 'YOUTRACK_TOKEN', projects: ['CG', 'CAR'], assignee: 'owen' },
    jira: { site: 'Contoso.Atlassian.net', fromNetrc: true, since: '2026-09-15' },
    asana: { workspace: '7520977444554', projects: ['1208573315693393'] },
  });
  assert.equal(c.youtrack!.url, 'https://bluefin-example.youtrack.cloud');
  assert.equal(c.jira!.site, 'contoso.atlassian.net');
  assert.equal(c.asana!.projects![0], '1208573315693393');
  assert.throws(() => validateSourcesConfig({ youtrack: { url: 'http://x', projects: ['A'] } }), /https/);
  assert.throws(() => validateSourcesConfig({ youtrack: { url: 'https://x.y', projects: ['A'], tokenEnv: 'bad name' } }), /environment variable/);
  assert.throws(() => validateSourcesConfig({ asana: { workspace: 'abc' } }), /numeric/);
  assert.throws(() => validateSourcesConfig({ jira: { site: 'not a host' } }), /host name/);
});

test('sources config: timezone is an IANA zone (presentation only; storage stays UTC)', () => {
  const base = { youtrack: { url: 'https://acme.youtrack.cloud', projects: ['AB'] } };
  assert.equal(validateSourcesConfig({ ...base, timezone: 'Europe/Zurich' }).timezone, 'Europe/Zurich');
  assert.equal(validateSourcesConfig(base).timezone, undefined, 'absent stays absent (the bot zone applies)');
  assert.throws(() => validateSourcesConfig({ ...base, timezone: 'Mars/Base' }), /"timezone" must be an IANA zone name/);
  assert.throws(() => validateSourcesConfig({ ...base, timezone: 3 }), /"timezone" must be an IANA zone name/);
});

test('sources config: `daemon` — an http(s) origin and the NAME of the token variable, nothing else', () => {
  const base = { youtrack: { url: 'https://yt.example', projects: ['AC'] } };
  assert.deepEqual(validateSourcesConfig({ ...base, daemon: { url: 'http://127.0.0.1:3416/', tokenEnv: 'SOURCES_DAEMON_TOKEN' } }).daemon, { url: 'http://127.0.0.1:3416', tokenEnv: 'SOURCES_DAEMON_TOKEN' });
  for (const [daemon, re] of [
    [{ url: 'ftp://x:1', tokenEnv: 'SOURCES_DAEMON_TOKEN' }, /"url" must be http/],
    [{ url: 'http://x:1/mcp', tokenEnv: 'SOURCES_DAEMON_TOKEN' }, /no path/],
    [{ url: 'http://user:pw@x:1', tokenEnv: 'SOURCES_DAEMON_TOKEN' }, /credentials/],
    [{ url: 'http://x:1', tokenEnv: 'the token itself' }, /NAME of an environment variable/],
    [{ url: 'http://x:1', tokenEnv: 'SOURCES_DAEMON_TOKEN', extra: 1 }, /unknown key "extra"/],
    ['http://x:1', /must be an object/],
  ] as Array<[unknown, RegExp]>) assert.throws(() => validateSourcesConfig({ ...base, daemon }), re, JSON.stringify(daemon));
});
