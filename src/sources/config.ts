// Validation of a project's `sources:` block (projects.config.json). Pure — called from
// loadProjects() at boot so a typo fails there, and from `orch sources` so the CLI explains
// the same way. Permissive where the data is: e-mails and ids are checked for shape, not
// existence (that is what `orch sources auth … check` is for).
import { SOURCE_KINDS, type GoogleKind, type MsgraphKind, type SourcesConfig } from './types.js';

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
  const known = new Set<string>([...SOURCE_KINDS, 'intervalMinutes', 'people']);
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
    };
  }
  const interval = int(where, r.intervalMinutes, 'intervalMinutes', 1, 24 * 60);
  if (interval !== undefined) out.intervalMinutes = interval;
  if (r.people !== undefined) {
    if (typeof r.people !== 'string' || !r.people.trim() || r.people.includes('..')) fail(where, '"people" must be a relative file path without ".."');
    out.people = r.people;
  }
  if (!out.google && !out.slack && !out.msgraph) fail(where, 'declares no source (expected at least one of google, slack, msgraph)');
  return out;
}
