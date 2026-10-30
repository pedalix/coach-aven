// The configuration reference's coverage (docs/configuration.md): every environment variable the
// production code reads, and every ProjectConfig field, must be named on that page — so a setting
// added in code cannot ship undocumented, and the reference never quietly falls behind the code the
// way a hand-kept list does. Pure: the caller hands in file texts; configdocs.test.ts runs it over
// `src/` and the page.
//
// The scan is lexical, not a type analysis, on purpose: the ways this codebase reads a variable are
// few and regular, and each one is a pattern below. A new way to read one (a helper with another
// name, a constant holding a name) needs its pattern here — the test's own cases pin each pattern so
// a narrowed regex fails loudly instead of letting variables slip out of the scan.

/** One environment-variable read: the name, and the file it was found in (for the failure message). */
export interface EnvRead {
  name: string;
  file: string;
}

/**
 * A name pattern rather than a name: a template literal such as `GATEWAY_OAUTH_${s}_ID`. `prefix` and
 * `suffix` are the literal parts; the docs name the family with a placeholder (`GATEWAY_OAUTH_<SLUG>_ID`).
 */
export interface EnvFamily {
  prefix: string;
  suffix: string;
  file: string;
}

const NAME = '[A-Z][A-Z0-9_]*';

// The reads, by shape:
// - `process.env.X`, `env.X`, `env?.X` — the plain property reads (an injected `env` parameter is
//   the process environment in production; tests pass a fake);
// - `env['X']`, `process.env["X"]` — the indexed form;
// - the config helpers that take the name as a string: `req('X')`, `num('X', d)`, `list('X')`
//   (src/config.ts), `numFrom(env, 'X', d)`, and the CLI-only `need(arg, 'X')` (msgraph auth) and
//   `promptSecret(label, 'X')` (slack auth), whose name is the second argument.
const DIRECT: RegExp[] = [
  new RegExp(`\\benv\\??\\.(${NAME})\\b`, 'g'),
  new RegExp(`\\benv\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
  new RegExp(`\\b(?:req|num|list)\\(\\s*['"](${NAME})['"]`, 'g'),
  new RegExp(`\\b(?:numFrom|need|promptSecret)\\(\\s*(?:'[^'\\n]*'|"[^"\\n]*"|[\\w.]+)\\s*,\\s*['"](${NAME})['"]`, 'g'),
];

// Names held in a constant and read through it (`process.env[DAEMON_TOKEN_ENV]`): a constant whose
// name ends in `_ENV` or `_VAR` and holds one name (`= 'SOURCES_DAEMON_TOKEN'`) or an object of them
// (`= { id: 'GATEWAY_OAUTH_ID', secret: 'GATEWAY_OAUTH_SECRET' }`). A value with anything after the
// name (`'CLAUDE_CODE_OAUTH_TOKEN=$(cat …)'`, a shell assignment) is not a name and does not match.
const CONST_ONE = new RegExp(`\\b[A-Z][A-Z0-9_]*_(?:ENV|VAR)\\s*=\\s*['"](${NAME})['"]`, 'g');
const CONST_OBJ = /\b[A-Z][A-Z0-9_]*_(?:ENV|VAR)\s*=\s*\{([^}]*)\}/g;
const QUOTED_NAME = new RegExp(`['"](${NAME})['"]`, 'g');

// A family: an upper-case template literal with one interpolation (`LAB_OPT_${k}`). Every such literal
// in production code is reported, env or not — the allow-list in the test names the ones that are not
// variables, which keeps the rule simple and the exceptions visible.
const FAMILY = /`([A-Z][A-Z0-9]*_[A-Z0-9_]*)\$\{[^}`]+\}([A-Z0-9_]*)`/g;

/** The environment variables one source file reads, in order of first appearance, each once. */
export function envReads(file: string, text: string): EnvRead[] {
  const seen = new Set<string>();
  const out: EnvRead[] = [];
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, file });
  };
  for (const re of [...DIRECT, CONST_ONE]) for (const m of text.matchAll(re)) add(m[1]!);
  for (const m of text.matchAll(CONST_OBJ)) for (const q of m[1]!.matchAll(QUOTED_NAME)) add(q[1]!);
  return out;
}

/** The name families (template-literal names) one source file builds. */
export function envFamilies(file: string, text: string): EnvFamily[] {
  const out: EnvFamily[] = [];
  for (const m of text.matchAll(FAMILY)) {
    if (!out.some((f) => f.prefix === m[1] && f.suffix === m[2])) out.push({ prefix: m[1]!, suffix: m[2] ?? '', file });
  }
  return out;
}

/** The names a doc mentions as inline code (`` `X` ``): the reference's coverage is exactly these. */
export function documentedNames(doc: string): Set<string> {
  return new Set([...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()));
}

/** Whether a doc names a family: some inline-code span starting with its prefix and ending with its suffix. */
export function familyDocumented(family: Pick<EnvFamily, 'prefix' | 'suffix'>, documented: Set<string>): boolean {
  return [...documented].some((d) => d.length > family.prefix.length && d.startsWith(family.prefix) && d.endsWith(family.suffix));
}

/**
 * The field names of one exported interface, read from its source: top-level members only (a nested
 * object type's members are its own), comments skipped. Throws when the interface is not found, so a
 * rename cannot turn the coverage check into a check of nothing.
 */
export function interfaceFields(text: string, name: string): string[] {
  const start = text.search(new RegExp(`export interface ${name}\\b[^{]*\\{`));
  if (start < 0) throw new Error(`interface ${name} not found`);
  const body = text.slice(text.indexOf('{', start) + 1);
  const fields: string[] = [];
  let depth = 0;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    if (depth === 0) {
      if (/^\s*\}/.test(line)) break;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m) fields.push(m[1]!);
    }
    for (const ch of line) depth += ch === '{' || ch === '(' || ch === '[' ? 1 : ch === '}' || ch === ')' || ch === ']' ? -1 : 0;
    if (depth < 0) break;
  }
  return fields;
}

/** The reads whose name the doc does not mention and the allow-list does not excuse: "NAME (file)". */
export function undocumented(reads: EnvRead[], documented: Set<string>, allowed: ReadonlySet<string>): string[] {
  const missing = new Map<string, string[]>();
  for (const r of reads) {
    if (documented.has(r.name) || allowed.has(r.name)) continue;
    missing.set(r.name, [...(missing.get(r.name) ?? []), r.file]);
  }
  return [...missing].sort(([a], [b]) => a.localeCompare(b)).map(([n, files]) => `${n} (${files.join(', ')})`);
}
