// Identity strings arrive in many shapes: `ana.berg@acme.example`, `Ana Berg | Acme <ana.berg@acme.example>`
// (Graph), `slack:Ana`, `Ana`, `jira:557058:…`, a bare Slack user id. Everything downstream compares the
// normalised email and the normalised full name, so this is the single place that parses them. Ported from the
// owen-ops identity collector (2026-10-15) — the platform now proposes identity merges for every tenant.

export interface ParsedIdentity {
  raw: string;
  email: string | null;
  name: string | null;
  kind: 'email' | 'name' | 'opaque';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function normaliseName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*\|.*$/, '') // "Ana Berg | Acme" → the company suffix is not part of the name
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseIdentity(raw: string): ParsedIdentity {
  const s = (raw ?? '').trim();
  const body = s.replace(/^(slack|teams|msgraph|jira|youtrack|asana):/i, '');
  const m = body.match(EMAIL_RE);
  const email = m ? m[0].toLowerCase() : null;
  const nameSrc = m ? body.replace(/<[^>]*>/, '').replace(EMAIL_RE, '') : body;
  // Opaque ids: Slack user/bot ids, Jira account ids, numbers — never compared by name.
  if (!email && (/^[UBW][A-Z0-9]{8,}$/.test(body) || /^\d+(:[0-9a-f-]+)?$/i.test(body) || /^[0-9a-f-]{20,}$/i.test(body))) {
    return { raw: s, email: null, name: null, kind: 'opaque' };
  }
  const name = normaliseName(nameSrc) || null;
  return { raw: s, email, name, kind: email ? 'email' : name ? 'name' : 'opaque' };
}

/** A full name has at least two words — single first names are too weak to merge on. */
export function isFullName(n: string | null): boolean {
  return !!n && n.split(' ').filter((w) => w.length > 1).length >= 2;
}

const SYSTEM_RE = /\b(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounce|alerts?|bot|webhook|digest|newsletter|support@|service@|calendar-notification|gemini-notes|comments-noreply)\b/i;
const SYSTEM_NAMES = /^(intercom( convert)?|gleap|sentry( quick analyzer)?|digitalocean|zapier|amazon q|asana|coachaven|coach aven|slackbot|github|youtrack|jira|confluence|google calendar|microsoft teams|wrike|fireflies|granola|wispr|cloudflare|stripe|vercel|instant google meet|google meet|devcoachaven|aven home)$/i;

/** System senders never become people and never trigger questions. */
export function isSystem(p: ParsedIdentity): boolean {
  if (p.email && SYSTEM_RE.test(p.email)) return true;
  if (p.name && (SYSTEM_NAMES.test(p.name) || /\b(bot|webhook)\b/i.test(p.name))) return true;
  return false;
}
