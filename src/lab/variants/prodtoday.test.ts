import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatasetMeta, DayCtx, FragmentUnit } from '../types.js';
import { modelDecisions, prodToday } from './prodtoday.js';

// A fictional agency tenant whose ledger history holds the review agent's decisions, some of them overridden
// later by the owner, a rule, or a person of the team.
const L = (id: string, initiative: string | null, decided_by: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, kind: 'thread', refs: [], attributions: initiative ? [{ initiative, share: 1 }] : [], decided_by, status: 'decided', decided_at: '2026-01-05T18:00:00Z', ...extra });

const LEDGER = [
  L('f-overridden', 'acme/app', 'model'),
  L('f-overridden', 'acme/web', 'owner'), // the owner corrected the agent: still the agent's decision to score
  L('f-model', 'acme/legacy', 'model'), // an alias: read the way gold is read
  L('f-twice', 'acme/app', 'model'),
  L('f-twice', 'acme/web', 'model'), // the agent's later decision wins
  L('f-ruled', 'acme/app', 'model'),
  L('f-ruled', 'acme/web', 'rule', { rule_id: 'r-1' }),
  L('f-person', 'acme/app', 'human:mara'), // a person of the team, not the agent
  L('f-owner', 'acme/web', 'owner'),
  L('f-escalated', null, 'model', { status: 'escalated' }),
  '{"id": "f-torn", "attri',
].join('\n');

test('modelDecisions — the last model line per fragment from the raw history, overridden ones included', () => {
  const m = modelDecisions(LEDGER);
  assert.deepEqual(
    [...m].map(([id, a]) => [id, a.map((x) => x.initiative)]),
    [
      ['f-overridden', ['acme/app']],
      ['f-model', ['acme/legacy']],
      ['f-twice', ['acme/web']],
      ['f-ruled', ['acme/app']],
    ],
  );
});

test('modelDecisions — a tenant\'s own owner literal (ownerDecider) is the owner\'s line, never the agent\'s', () => {
  const ledger = [L('f-a', 'acme/app', 'model'), L('f-a', 'acme/web', 'olga'), L('f-b', 'acme/web', 'olga')].join('\n');
  assert.deepEqual([...modelDecisions(ledger, { ownerDecider: 'olga' }).keys()], ['f-a'], 'the agent\'s overridden line still scores; the owner\'s own line does not');
  assert.deepEqual([...modelDecisions(ledger).keys()], ['f-a', 'f-b'], 'without the alias an unknown literal parses as model — why the tenant must declare it');
});

test('prod-today — the ladder first, then the agent’s own decision at .75, overridden or not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-prodtoday-'));
  mkdirSync(join(dir, 'tenant', 'annotations'), { recursive: true });
  writeFileSync(
    join(dir, 'tenant', 'initiatives.json'),
    JSON.stringify({ initiatives: [{ id: 'acme/web', umbrella: 'acme', sources: {} }, { id: 'acme/app', umbrella: 'acme', sources: {} }, { id: 'acme/legacy', alias_of: 'acme/web', sources: {} }] }),
  );
  writeFileSync(join(dir, 'tenant', 'annotations', 'fragments.jsonl'), `${LEDGER}\n`);
  const meta: DatasetMeta = { name: 'agency', kind: 'synthetic', tenant: 'agency', tz: 'UTC', since: '2026-01-05', until: '2026-01-05', subject: 'olive', createdAt: '2026-01-06T00:00:00Z', sourceStore: 'test', labelSpace: { initiatives: ['acme/web', 'acme/app'], umbrellas: {}, people: [] }, counts: {} };
  const ctx: DayCtx = { dataset: meta, dir, day: '2026-01-05', pool: [], memory: [], state: new Map(), llm: null, log: () => {} };
  const frag = (id: string, ladder?: FragmentUnit['ladder']): FragmentUnit => ({
    id, day: '2026-01-05', kind: 'thread', start: '2026-01-05T10:00:00Z', end: '2026-01-05T10:30:00Z', minutes: 30, title: 'sync', source: 'slack', container: '#acme', participants: [], projectKeys: [], repo: null, weight: 1, refs: [], text: '', ...(ladder ? { ladder } : {}),
  });
  const out = await prodToday.decide('t1-fragment', [frag('f-overridden'), frag('f-model'), frag('f-twice'), frag('f-ruled', { state: 'rule', initiative: 'acme/app', rule: 'r-1' }), frag('f-person'), frag('f-owner'), frag('f-escalated')], ctx);
  assert.deepEqual(
    out.map((p) => [p.id, p.label, p.conf, p.rung]),
    [
      ['f-overridden', 'acme/app', 0.75, 'model:review'],
      ['f-model', 'acme/web', 0.75, 'model:review'],
      ['f-twice', 'acme/web', 0.75, 'model:review'],
      ['f-ruled', 'acme/app', 1, 'rule:r-1'], // the ladder decides before the agent
      ['f-person', null, 0, 'abstain'],
      ['f-owner', null, 0, 'abstain'],
      ['f-escalated', null, 0, 'abstain'],
    ],
  );
});
