import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSourcesConfig } from './config.js';

test('sources config: full valid block is normalised (lower-cased e-mails, trimmed)', () => {
  const out = validateSourcesConfig({
    google: { accounts: ['Owen@example.com ', 'owen@example.com'], since: '2026-09-01', calendars: [], kinds: ['gmail', 'calendar'] },
    slack: { workspaces: ['T0000FAKE01'], since: '2026-10-06', threadWindowDays: 30, editWindowHours: 48 },
    msgraph: { tenant: '00000000-0000-4000-8000-000000000000', accounts: ['owen.hale@example.com'], only: ['mail', 'chats'] },
    intervalMinutes: 15,
    people: 'projects.d/owen-ops.people.json',
  });
  assert.deepEqual(out.google?.accounts, ['owen@example.com', 'owen@example.com']);
  assert.equal(out.msgraph?.tenant, '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(out.msgraph?.only, ['mail', 'chats']);
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
