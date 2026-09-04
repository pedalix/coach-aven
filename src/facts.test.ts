import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEPENDS_ON_REPOS, FactStore, projectSubject, type Fact } from './facts.js';

const fresh = (): { store: FactStore; base: string } => {
  const base = mkdtempSync(join(tmpdir(), 'aven-facts-'));
  return { store: new FactStore(base), base };
};

const depsFact = (slug: string, repos: string[], at = '2026-09-04T10:00:00.000Z'): Fact => ({
  subject: projectSubject(slug),
  predicate: DEPENDS_ON_REPOS,
  value: repos,
  sources: ['caldora-admin@d825c18e:composer.json'],
  observedAt: at,
});

test('put/get — one record per (subject, predicate); a new observation replaces the old', () => {
  const { store } = fresh();
  store.put('caldora', depsFact('caldora', ['BluefinOrg/mews']));
  store.put('caldora', depsFact('caldora', ['BluefinOrg/mews', 'BluefinOrg/laravel-apaleo'], '2026-09-04T11:00:00.000Z'));
  const all = store.read('caldora');
  assert.equal(all.length, 1);
  assert.deepEqual(store.dependsOnRepos('caldora'), ['BluefinOrg/mews', 'BluefinOrg/laravel-apaleo']);
  assert.equal(all[0].observedAt, '2026-09-04T11:00:00.000Z');
});

test('facts are per project and keep provenance', () => {
  const { store } = fresh();
  store.put('caldora', depsFact('caldora', ['BluefinOrg/mews']));
  store.put('lumora', depsFact('lumora', []));
  assert.deepEqual(store.dependsOnRepos('caldora'), ['BluefinOrg/mews']);
  assert.deepEqual(store.dependsOnRepos('lumora'), []);
  assert.deepEqual(store.get('caldora', 'project:caldora', DEPENDS_ON_REPOS)?.sources, [
    'caldora-admin@d825c18e:composer.json',
  ]);
});

test('other predicates on the same subject survive an upsert', () => {
  const { store } = fresh();
  store.put('caldora', depsFact('caldora', ['BluefinOrg/mews']));
  store.put('caldora', { ...depsFact('caldora', []), predicate: 'something_else', value: 42 });
  store.put('caldora', depsFact('caldora', ['BluefinOrg/bill-php-sdk']));
  assert.equal(store.read('caldora').length, 2);
  assert.equal(store.get('caldora', 'project:caldora', 'something_else')?.value, 42);
});

test('no file / corrupt file / wrong shape all read as "no facts" — a derived cache never crashes a turn', () => {
  const { store, base } = fresh();
  assert.deepEqual(store.read('nope'), []);
  assert.deepEqual(store.dependsOnRepos('nope'), []);
  writeFileSync(join(base, 'broken.json'), '{not json');
  assert.deepEqual(store.read('broken'), []);
  writeFileSync(join(base, 'shape.json'), JSON.stringify({ subject: 'x' }));
  assert.deepEqual(store.read('shape'), []);
  writeFileSync(join(base, 'val.json'), JSON.stringify([{ ...depsFact('val', []), value: 'not-a-list' }]));
  assert.deepEqual(store.dependsOnRepos('val'), []);
});

test('writes are atomic (no .tmp left behind) and an unsafe slug is refused, not sanitized', () => {
  const { store, base } = fresh();
  store.put('caldora', depsFact('caldora', []));
  assert.deepEqual(readdirSync(base), ['caldora.json']);
  assert.throws(() => store.put('../evil', depsFact('../evil', [])), /unsafe project slug/);
  assert.deepEqual(readdirSync(base), ['caldora.json']);
});
