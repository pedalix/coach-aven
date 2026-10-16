import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbiterPrompt, listPrompt, promptVersion, readLabels, readT4, reaskPrompt, t1Prompt, t1System, t3System, t4System } from './prompt.js';

const IDS = ['acme/web', 'acme/app', 'acme/admin', 'none', 'unregistered'];
const canon = (l: string): string | null => IDS.find((x) => x.toLowerCase() === l.toLowerCase()) ?? null;

test('the system text carries the closed list and the rules; prompt_v is its hash', () => {
  const sys = t1System('acme/web | acme | Acme Website\nacme/app | acme | Acme App');
  assert.match(sys, /acme\/web \| acme \| Acme Website/);
  assert.match(sys, /Do not force a fit/);
  assert.match(sys, /verbatim span of at most 60 characters/);
  assert.equal(promptVersion(sys), promptVersion(sys));
  assert.notEqual(promptVersion(sys), promptVersion(`${sys} `));
  assert.match(promptVersion(sys), /^[0-9a-f]{10}$/);
});

test('the user prompt: cards, precedents per case (or "none yet"), the tags to answer', () => {
  const p = t1Prompt([
    { card: 'CARD-ONE u1 …', precedents: ['[acme/web] (2026-01-05) Checkout — promo'], tags: ['u1'] },
    { card: 'CARD-TWO u2 … u3 …', precedents: [], tags: ['u2', 'u3'] },
  ]);
  assert.match(p, /^2 cases follow\. Label every unit: u1, u2, u3\./);
  assert.match(p, /### Case 1\nCARD-ONE[\s\S]*- \[acme\/web\] \(2026-01-05\) Checkout — promo/);
  assert.match(p, /### Case 2\nCARD-TWO[\s\S]*- \(none yet\)/);
  assert.match(p, /Answer with the JSON array for u1, u2, u3\.$/);
  const a = arbiterPrompt([{ card: 'CARD', disputes: [{ tag: 'u4', options: ['acme/web', 'acme/app'] }] }]);
  assert.match(a, /u4: option 1 = acme\/web · option 2 = acme\/app/);
  assert.match(listPrompt(['u1 · x'], ['u1'], 'messages'), /^1 messages follow\./);
  assert.match(t4System(['noise', 'request'], ['mara | Mara Quill | acme']), /- noise: [\s\S]*- request: [\s\S]*mara \| Mara Quill/);
  assert.match(t3System(['mara | Mara Quill | acme | mara@acme.example']), /person:<id>\+<id>/);
});

test('readLabels: fenced JSON, case-insensitive ids, alt, a split takes its largest share', () => {
  const text = 'Here you go:\n```json\n[{"unit":"u1","label":"ACME/WEB","cite":{"field":"title","span":"Acme"},"alt":"acme/app"},' + '{"unit":"u2","label":"acme/web","split":[{"label":"acme/web","share":0.4},{"label":"acme/app","share":0.6}],"cite":"checkout"}]\n```';
  const r = readLabels(text, ['u1', 'u2'], canon);
  assert.equal(r.bad.size, 0);
  assert.deepEqual(r.ok.get('u1'), { unit: 'u1', label: 'acme/web', cite: { field: 'title', span: 'Acme' }, alt: 'acme/app' });
  assert.equal(r.ok.get('u2')!.label, 'acme/app');
  assert.deepEqual(r.ok.get('u2')!.split, [
    { label: 'acme/app', share: 0.6 },
    { label: 'acme/web', share: 0.4 },
  ]);
});

test('readLabels: a label off the list, a missing unit, no JSON at all — each named for the re-ask', () => {
  const r = readLabels('{"units":[{"unit":"u1","label":"acme/shop"},{"unit":"u9","label":"acme/web"}]}', ['u1', 'u2'], canon);
  assert.equal(r.ok.size, 0);
  assert.deepEqual([...r.bad.entries()], [
    ['u1', '"acme/shop" is not in the list'],
    ['u2', 'missing'],
  ]);
  const re = reaskPrompt('ORIGINAL', r.bad);
  assert.match(re, /^ORIGINAL\n\nYour previous answer had problems:\n- u1: "acme\/shop" is not in the list\n- u2: missing\nAnswer again with the JSON array for u1, u2 only\.$/);
  assert.deepEqual([...readLabels('I cannot decide.', ['u1'], canon).bad.values()], ['no JSON answer']);
  // a malformed split falls back to the label
  const s = readLabels('[{"unit":"u1","label":"acme/web","split":[{"label":"acme/web","share":0.9},{"label":"acme/app","share":0.9}]}]', ['u1'], canon);
  assert.equal(s.ok.get('u1')!.label, 'acme/web');
  assert.equal(s.ok.get('u1')!.split, undefined);
});

test('readT4: kinds from the closed set, addressees from the roster or none — validated for the task at hand', () => {
  const roster = new Set(['mara', 'owner']);
  const text =
    '[{"unit":"u1","kind":"Request","addressee":["owner","mara","owner"],"cue":"could you"},{"unit":"u2","kind":"info","addressee":"none"},{"unit":"u3","kind":"gossip","addressee":"none"},' +
    '{"unit":"u4","kind":"question","addressee":["zed"]},{"unit":"u5","kind":"noise","addressee":["none"]},{"unit":"u6","kind":"info","addressee":[]}]';
  const tags = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const k = readT4(text, tags, roster, 'kind');
  assert.deepEqual(k.ok.get('u1'), { unit: 'u1', label: 'request', cite: { field: '', span: 'could you' }, alt: null, addressee: ['mara', 'owner'] });
  assert.equal(k.ok.get('u2')!.addressee, 'none');
  assert.match(k.bad.get('u3')!, /^kind "gossip" is not one of/);
  assert.equal(k.ok.get('u4')!.label, 'question'); // a stray addressee does not void the kind
  assert.equal(k.ok.get('u5')!.addressee, 'none'); // ["none"] is no addressee, not a person called "none"
  assert.equal(k.ok.get('u6')!.addressee, 'none');
  const a = readT4(text, tags, roster, 'addressee');
  assert.equal(a.bad.get('u4'), 'addressee "zed" is not on the roster');
  assert.equal(a.ok.get('u3')!.addressee, 'none'); // the kind does not matter to the addressee task
  assert.equal(a.ok.get('u5')!.addressee, 'none');
});
