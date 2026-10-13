// Validation of a project's `sources:` block (projects.config.json). Pure — called from
// loadProjects() at boot so a typo fails there, and from `orch sources` so the CLI explains
// the same way. Permissive where the data is: e-mails and ids are checked for shape, not
// existence (that is what `orch sources auth … check` is for).
import { SOURCE_KINDS, type GoogleKind, type MeetingsSourcesConfig, type MsgraphKind, type SourcesConfig } from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_KINDS: readonly GoogleKind[] = ['gmail', 'drive', 'calendar'];
const MSGRAPH_KINDS: readonly MsgraphKind[] = ['mail', 'calendar', 'chats', 'channels', 'files'];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`);
}

function strings(where: string, v: unknown, field: string, { nonEmpty = true } = {}): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) fail(where, `"${field}" must be an array of non-empty strings`);
  if (nonEmpty && v.length === 0) fail(where, `"${field}" must list at least one entry`);
  return (v as string[]).map((s) => s.trim());
}

function date(where: string, v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) fail(where, `"${field}" must be YYYY-MM-DD`);
  return v;
}

function subset<T extends string>(where: string, v: unknown, field: string, allowed: readonly T[]): T[] | undefined {
  if (v === undefined) return undefined;
  const got = strings(where, v, field);
  const bad = got.filter((x) => !(allowed as readonly string[]).includes(x));
  if (bad.length) fail(where, `"${field}" has unknown entries ${JSON.stringify(bad)} (allowed: ${allowed.join(', ')})`);
  return got as T[];
}

function int(where: string, v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(where, `"${field}" must be an integer in [${min}, ${max}]`);
  return v;
}

/** Returns a normalised copy (trimmed, lower-cased e-mails); throws with a path-prefixed message. */
export function validateSourcesConfig(raw: unknown, where = 'sources'): SourcesConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(where, 'must be an object');
  const r = raw as Record<string, unknown>;
  const known = new Set<string>([...SOURCE_KINDS, 'intervalMinutes', 'people', 'tenant']);
  for (const k of Object.keys(r)) if (!known.has(k)) fail(where, `unknown key "${k}" (allowed: ${[...known].join(', ')})`);
  const out: SourcesConfig = {};
  if (r.google !== undefined) {
    const g = (typeof r.google === 'object' && r.google && !Array.isArray(r.google) ? r.google : fail(`${where}.google`, 'must be an object')) as Record<string, unknown>;
    out.google = {
      accounts: strings(`${where}.google`, g.accounts, 'accounts').map((a) => a.toLowerCase()),
      ...(date(`${where}.google`, g.since, 'since') ? { since: g.since as string } : {}),
      ...(g.calendars !== undefined ? { calendars: strings(`${where}.google`, g.calendars, 'calendars', { nonEmpty: false }) } : {}),
      ...(subset(`${where}.google`, g.kinds, 'kinds', GOOGLE_KINDS) ? { kinds: g.kinds as GoogleKind[] } : {}),
    };
    for (const a of out.google.accounts) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) fail(`${where}.google`, `"${a}" is not an e-mail address`);
  }
  if (r.slack !== undefined) {
    const s = (typeof r.slack === 'object' && r.slack && !Array.isArray(r.slack) ? r.slack : fail(`${where}.slack`, 'must be an object')) as Record<string, unknown>;
    out.slack = {
      workspaces: strings(`${where}.slack`, s.workspaces, 'workspaces', { nonEmpty: false }),
      ...(date(`${where}.slack`, s.since, 'since') ? { since: s.since as string } : {}),
      ...(int(`${where}.slack`, s.threadWindowDays, 'threadWindowDays', 0, 3650) !== undefined ? { threadWindowDays: s.threadWindowDays as number } : {}),
      ...(int(`${where}.slack`, s.editWindowHours, 'editWindowHours', 0, 24 * 30) !== undefined ? { editWindowHours: s.editWindowHours as number } : {}),
    };
  }
  if (r.msgraph !== undefined) {
    const m = (typeof r.msgraph === 'object' && r.msgraph && !Array.isArray(r.msgraph) ? r.msgraph : fail(`${where}.msgraph`, 'must be an object')) as Record<string, unknown>;
    if (typeof m.tenant !== 'string' || !GUID_RE.test(m.tenant)) fail(`${where}.msgraph`, '"tenant" must be the Entra tenant GUID');
    out.msgraph = {
      tenant: m.tenant.toLowerCase(),
      accounts: strings(`${where}.msgraph`, m.accounts, 'accounts').map((a) => a.toLowerCase()),
      ...(date(`${where}.msgraph`, m.since, 'since') ? { since: m.since as string } : {}),
      ...(subset(`${where}.msgraph`, m.only, 'only', MSGRAPH_KINDS) ? { only: m.only as MsgraphKind[] } : {}),
      ...(m.calendars !== undefined ? { calendars: strings(`${where}.msgraph`, m.calendars, 'calendars', { nonEmpty: false }) } : {}),
    };
  }
  const obj = (k: string): Record<string, unknown> => (typeof r[k] === 'object' && r[k] && !Array.isArray(r[k]) ? r[k] : fail(`${where}.${k}`, 'must be an object')) as Record<string, unknown>;
  const optStr = (w: string, v: unknown, field: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim()) fail(w, `"${field}" must be a non-empty string`);
    return v.trim();
  };
  if (r.youtrack !== undefined) {
    const w = `${where}.youtrack`;
    const y = obj('youtrack');
    if (typeof y.url !== 'string' || !/^https:\/\/[^\s/]+/.test(y.url)) fail(w, '"url" must be an https:// base URL');
    const tokenEnv = optStr(w, y.tokenEnv, 'tokenEnv');
    if (tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) fail(w, '"tokenEnv" must be an environment variable name');
    const assignee = optStr(w, y.assignee, 'assignee');
    out.youtrack = {
      url: y.url.replace(/\/+$/, ''),
      projects: strings(w, y.projects, 'projects'),
      ...(tokenEnv ? { tokenEnv } : {}),
      ...(assignee ? { assignee } : {}),
      ...(date(w, y.since, 'since') ? { since: y.since as string } : {}),
    };
  }
  if (r.jira !== undefined) {
    const w = `${where}.jira`;
    const j = obj('jira');
    if (typeof j.site !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(j.site.trim())) fail(w, '"site" must be a host name like acme.atlassian.net');
    const email = optStr(w, j.email, 'email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(w, `"${email}" is not an e-mail address`);
    if (j.fromNetrc !== undefined && typeof j.fromNetrc !== 'boolean') fail(w, '"fromNetrc" must be true or false');
    const jql = optStr(w, j.jql, 'jql');
    out.jira = {
      site: j.site.trim().toLowerCase(),
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(j.fromNetrc ? { fromNetrc: true } : {}),
      ...(jql ? { jql } : {}),
      ...(date(w, j.since, 'since') ? { since: j.since as string } : {}),
    };
  }
  if (r.asana !== undefined) {
    const w = `${where}.asana`;
    const a = obj('asana');
    if (typeof a.workspace !== 'string' || !/^\d+$/.test(a.workspace)) fail(w, '"workspace" must be the numeric workspace gid');
    const assignee = optStr(w, a.assignee, 'assignee');
    out.asana = {
      workspace: a.workspace,
      ...(assignee ? { assignee } : {}),
      ...(a.projects !== undefined ? { projects: strings(w, a.projects, 'projects', { nonEmpty: false }) } : {}),
      ...(date(w, a.since, 'since') ? { since: a.since as string } : {}),
    };
    for (const pr of out.asana.projects ?? []) if (!/^\d+$/.test(pr)) fail(w, `project "${pr}" must be a numeric gid`);
  }
  if (r.meetings !== undefined) {
    const w = `${where}.meetings`;
    const m = obj('meetings');
    for (const k of Object.keys(m)) if (!['granola', 'gmeet', 'wispr'].includes(k)) fail(w, `unknown provider "${k}" (allowed: granola, gmeet, wispr)`);
    const sub = (k: string): Record<string, unknown> => (typeof m[k] === 'object' && m[k] && !Array.isArray(m[k]) ? m[k] : fail(`${w}.${k}`, 'must be an object')) as Record<string, unknown>;
    const mt: MeetingsSourcesConfig = {};
    if (m.granola !== undefined) {
      const g = sub('granola');
      mt.granola = date(`${w}.granola`, g.since, 'since') ? { since: g.since as string } : {};
    }
    if (m.gmeet !== undefined) {
      const g = sub('gmeet');
      mt.gmeet = { accounts: strings(`${w}.gmeet`, g.accounts, 'accounts').map((a) => a.toLowerCase()), ...(date(`${w}.gmeet`, g.since, 'since') ? { since: g.since as string } : {}) };
    }
    if (m.wispr !== undefined) {
      const g = sub('wispr');
      mt.wispr = date(`${w}.wispr`, g.since, 'since') ? { since: g.since as string } : {};
    }
    if (!mt.granola && !mt.gmeet && !mt.wispr) fail(w, 'declares no provider (granola, gmeet, wispr)');
    out.meetings = mt;
  }
  if (r.local !== undefined) {
    const w = `${where}.local`;
    const l = obj('local');
    const roots = strings(w, l.roots, 'roots');
    for (const p of roots) if (!p.startsWith('/') || p.includes('..')) fail(w, `root "${p}" must be an absolute path without ".."`);
    const authors = strings(w, l.authors, 'authors');
    const cpd = optStr(w, l.claudeProjectsDir, 'claudeProjectsDir');
    if (cpd && (!cpd.startsWith('/') || cpd.includes('..'))) fail(w, '"claudeProjectsDir" must be an absolute path without ".."');
    out.local = { roots, authors, ...(cpd ? { claudeProjectsDir: cpd } : {}), ...(date(w, l.since, 'since') ? { since: l.since as string } : {}) };
  }
  if (r.tenant !== undefined) {
    const w = `${where}.tenant`;
    const t = obj('tenant');
    if (typeof t.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo)) fail(w, '"repo" must be owner/name');
    const ref = optStr(w, t.ref, 'ref');
    if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) fail(w, '"ref" must be a branch name');
    const path = optStr(w, t.path, 'path');
    if (path && (path.includes('..') || path.startsWith('/'))) fail(w, '"path" must be relative without ".."');
    out.tenant = { repo: t.repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
  }
  const interval = int(where, r.intervalMinutes, 'intervalMinutes', 1, 24 * 60);
  if (interval !== undefined) out.intervalMinutes = interval;
  if (r.people !== undefined) {
    if (typeof r.people !== 'string' || !r.people.trim() || r.people.includes('..')) fail(where, '"people" must be a relative file path without ".."');
    out.people = r.people;
  }
  if (!SOURCE_KINDS.some((k) => out[k])) fail(where, `declares no source (expected at least one of ${SOURCE_KINDS.join(', ')})`);
  return out;
}
