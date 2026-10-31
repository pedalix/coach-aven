import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { documentedNames, envFamilies, envReads, familyDocumented, interfaceFields, undocumented } from './configdocs.js';

const ROOT = new URL('..', import.meta.url).pathname;
const DOC = 'docs/configuration.md';

// Read by production code, but not settings anyone configures — so not on the configuration page.
// Each entry says why; anything else the code reads must be documented there.
const NOT_SETTINGS: ReadonlyMap<string, string> = new Map([
  ['HOME', "the user's home: where the dev-box credit fallback finds ~/.claude (src/config.ts resolveCredit)"],
  ['PREVIEW_ENV', "where `npm run preview` finds the operator's preview.env (src/previewcli.ts): a path for the preview tool, read by no installation"],
  ['NODE_TEST_CONTEXT', "set by node --test in every test process: keeps the installation's .env out of tests (src/config.ts)"],
]);

// Upper-case template literals in production code that build something other than a variable name.
const NOT_FAMILIES: ReadonlyMap<string, string> = new Map([
  ['UBOT_', "the Slack twin's made-up bot user id (src/chat/slack/twin.ts), not an environment variable"],
]);

// Production sources: src/**/*.ts without the tests, the recorded fixtures, and this scanner's own
// module, whose comments name the patterns it looks for.
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(ROOT + dir)) {
      const rel = `${dir}/${e}`;
      if (statSync(ROOT + rel).isDirectory()) {
        if (e !== 'fixtures') walk(rel);
      } else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && rel !== 'src/configdocs.ts') out.push(rel);
    }
  };
  walk('src');
  return out;
}

test('envReads — every way the code reads a variable', () => {
  const text = [
    "const a = process.env.ALPHA_ONE; const b = env.BRAVO; const c = env?.CHARLIE;",
    "const d = env['DELTA']; const e = process.env[\"ECHO\"];",
    "req('FOXTROT'); num('GOLF', 3); list('HOTEL'); numFrom(env, 'INDIA', 1);",
    "need('tenant', 'JULIET'); promptSecret('Token (xoxb-…)', 'KILO');",
    "export const DAEMON_TOKEN_ENV = 'LIMA'; const TOKEN_VAR = 'MIKE';",
    "export const PAIR_ENV = { id: 'NOVEMBER', secret: 'OSCAR' } as const;",
    "const CC_TOKEN_ENV = 'PAPA=$(cat /x)'; env.lower; process.env.ALPHA_ONE;",
  ].join('\n');
  assert.deepEqual(
    envReads('src/x.ts', text).map((r) => r.name),
    ['ALPHA_ONE', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR'],
  );
});

test('envFamilies and familyDocumented — a templated name is documented by a placeholder', () => {
  const fams = envFamilies('src/x.ts', 'const n = `GATEWAY_OAUTH_${s}_ID`; const o = process.env[`LAB_OPT_${k}`];');
  assert.deepEqual(fams.map((f) => [f.prefix, f.suffix]), [['GATEWAY_OAUTH_', '_ID'], ['LAB_OPT_', '']]);
  const doc = documentedNames('`GATEWAY_OAUTH_<SLUG>_ID`, `LAB_OPT_<KEY>`');
  assert.ok(fams.every((f) => familyDocumented(f, doc)));
  assert.equal(familyDocumented({ prefix: 'GATEWAY_OAUTH_', suffix: '_SECRET' }, doc), false);
});

test('interfaceFields — top-level members only, comments skipped, a missing interface throws', () => {
  const text = [
    'export interface Thing {',
    '  slug: string; // the id: { not a block }',
    '  // note: a comment line',
    '  sandbox?: { privileged?: boolean;',
    '    nested: string };',
    '  list?: string[];',
    '}',
    'export interface Other { zzz: number }',
  ].join('\n');
  assert.deepEqual(interfaceFields(text, 'Thing'), ['slug', 'sandbox', 'list']);
  assert.throws(() => interfaceFields(text, 'Missing'), /Missing not found/);
});

test('undocumented — names the variable and every file that reads it', () => {
  const reads = [
    { name: 'B_VAR', file: 'src/b.ts' },
    { name: 'A_VAR', file: 'src/a.ts' },
    { name: 'B_VAR', file: 'src/c.ts' },
    { name: 'OK_VAR', file: 'src/a.ts' },
    { name: 'HOME', file: 'src/a.ts' },
  ];
  assert.deepEqual(undocumented(reads, new Set(['OK_VAR']), new Set(['HOME'])), ['A_VAR (src/a.ts)', 'B_VAR (src/b.ts, src/c.ts)']);
});

test('docs/configuration.md names every environment variable the production code reads', () => {
  const documented = documentedNames(readFileSync(ROOT + DOC, 'utf8'));
  const sources = productionSources().map((f) => ({ file: f, text: readFileSync(ROOT + f, 'utf8') }));
  const reads = sources.flatMap((s) => envReads(s.file, s.text));
  assert.ok(reads.length > 50, `the scan found only ${reads.length} reads — has a pattern stopped matching?`);
  assert.deepEqual(undocumented(reads, documented, new Set(NOT_SETTINGS.keys())), [], `add these to ${DOC} (or, if they are not settings, to NOT_SETTINGS with the reason)`);
  const families = sources.flatMap((s) => envFamilies(s.file, s.text)).filter((f) => !NOT_FAMILIES.has(f.prefix));
  assert.deepEqual(
    families.filter((f) => !familyDocumented(f, documented)).map((f) => `${f.prefix}<…>${f.suffix} (${f.file})`),
    [],
    `document these name families in ${DOC} with a placeholder, e.g. \`PREFIX_<NAME>\``,
  );
  // An allow-list entry the code no longer reads is a stale exception: drop it.
  const read = new Set(reads.map((r) => r.name));
  assert.deepEqual([...NOT_SETTINGS.keys()].filter((n) => !read.has(n)), []);
});

test('docs/configuration.md names every ProjectConfig field and the workspaces block', () => {
  const documented = documentedNames(readFileSync(ROOT + DOC, 'utf8'));
  const projects = readFileSync(ROOT + 'src/projects.ts', 'utf8');
  const fields = interfaceFields(projects, 'ProjectConfig');
  assert.ok(fields.includes('slug') && fields.includes('repos'), 'the ProjectConfig parse lost its required fields');
  const registry = interfaceFields(projects, 'ProjectsRegistry');
  assert.deepEqual([...fields, ...registry].filter((f) => !documented.has(f)), [], `add these projects.config.json fields to ${DOC}`);
});
