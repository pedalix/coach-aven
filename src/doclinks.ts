// The docs' references to the repository (community plan, week 1): every relative markdown link
// and every backticked repository path in the public docs must exist, so a reader never follows a
// link into nothing and a renamed file cannot leave a stale pointer behind. Pure: the caller hands
// in the text and an `exists` check; doclinks.test.ts runs it over the repository's docs.

/** A reference that does not resolve: the doc, what kind it is, and the target as written. */
export interface BrokenRef {
  doc: string;
  kind: 'link' | 'path';
  target: string;
}

// Backticked paths under these roots are claims about this repository. Anything else in
// backticks (commands, other repositories, placeholders) is not checked.
const ROOTS = ['src', 'docs', 'scripts', 'snapshot', 'hub', 'infra', '.github', 'openspec'];
const PATH_RE = new RegExp('`((?:' + ROOTS.map((r) => r.replace('.', '\\.')).join('|') + ')/[A-Za-z0-9_./-]+)`', 'g');
const LINK_RE = /\]\(([^)\s]+)\)/g;

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** `a/b/../c` → `a/c`, against a repository-relative base; undefined when it climbs out of the repository. */
export function joinPath(base: string, rel: string): string | undefined {
  const out: string[] = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/**
 * The broken references of one doc (`doc` is its repository-relative path).
 * - Links: relative targets only (no scheme, no `#anchor`-only), outside fenced and inline code,
 *   resolved against the doc's directory; the `#fragment` is ignored.
 * - Paths: backticked repository paths, tried against the repository root and the doc's directory
 *   (a package's README names its own files); placeholders (`<slug>`, `*`) are skipped.
 * - `history: true` (a ledger that records the past) checks links but not paths: it names files
 *   that were removed on purpose.
 */
export function brokenRefs(doc: string, text: string, exists: (p: string) => boolean, o: { history?: boolean } = {}): BrokenRef[] {
  const out: BrokenRef[] = [];
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of prose.matchAll(LINK_RE)) {
    const target = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const file = target.split('#')[0]!;
    if (!file) continue;
    const resolved = joinPath(dirOf(doc), decodeURI(file));
    if (resolved === undefined || !exists(resolved)) out.push({ doc, kind: 'link', target });
  }
  if (o.history) return out;
  for (const m of text.matchAll(PATH_RE)) {
    const target = m[1]!.replace(/[/.]+$/, '');
    if (/[<>*]/.test(target)) continue;
    const local = joinPath(dirOf(doc), target);
    if (exists(target) || (local !== undefined && exists(local))) continue;
    out.push({ doc, kind: 'path', target });
  }
  return out;
}
