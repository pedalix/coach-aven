// Secrets scrubber at the MODEL BOUNDARY. Everything a person types into Slack — a mention,
// a DM, a thread reply, a /aven question, an AskUserQuestion answer — becomes a prompt the
// Claude process sends to the API. People paste passwords, connection strings and tokens
// into chat ("here's the prod DB, have a look"); once that text has left the sandbox as API
// traffic it cannot be unsent. So the last hop before stdin (claudeSession.ts send()) runs
// this scrubber: deterministic, fail-closed (a stray [REDACTED] costs a clarifying question,
// a leaked DSN cannot be undone), no I/O, no randomness.
//
// Exact forms are replaced in place by `[REDACTED:<kind>:<hash6>]`; the hash is
// sha256(value)[0..6], so the same secret yields the same tag and the agent can still say
// "that's the same password as in the earlier message" without ever knowing it. A `likely`
// layer catches high-entropy strings sitting right after a credential keyword or inside a
// code block. Per-project opt-out: ProjectConfig.scrubSecrets = false.
//
// The same detectors serve the ingest side (src/sources/*): classifyMessage/scrubMessage decide
// whether a pulled mail or chat message is a credential CARRIER (body withheld, secrets filed in
// the age vault) or merely needs inline redaction. One module, one set of shapes.
import { createHash } from 'node:crypto';

export type Confidence = 'exact' | 'likely';

export interface Finding {
  kind: string;
  /** Character range in the ORIGINAL text that was replaced. */
  start: number;
  end: number;
  /** sha256(value) first 6 hex — correlation handle, not recoverable. */
  hash6: string;
  confidence: Confidence;
}

export interface ScrubOptions {
  /** Shannon-entropy threshold (bits/char) for the `likely` layer. Default 3.8. */
  entropyThreshold?: number;
  /** Disable the heuristic layer (exact forms only). Default false. */
  exactOnly?: boolean;
}

export interface ScrubResult {
  text: string;
  findings: Finding[];
}



// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

export interface AttachmentLike {
  name: string;
  size?: number;
}

/**
 * The minimal shape every puller record satisfies; extra fields pass through untouched. No index
 * signature on purpose: puller `MessageRecord` interfaces must be assignable as-is.
 */
export interface ScrubbableMessage {
  source: string;
  id: string;
  subject?: string;
  text: string;
  attachments?: AttachmentLike[];
}

export interface ScrubMeta {
  /** Body replaced by the withheld marker. */
  withheld: boolean;
  /** Distinct finding kinds, sorted — lets a reader see "this had a dsn" without the value. */
  kinds: string[];
  /** Number of redactions applied (0 when withheld — the body is gone wholesale). */
  redactions: number;
  /** Set when withheld: where vault.ts filed the raw secrets. */
  vault?: string;
}

export interface ExtractedSecret {
  kind: string;
  value: string;
  hash6: string;
  /** ±40 chars around the value, with the value itself replaced — for a human reading the vault entry. */
  context: string;
}

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

export function hash6(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 6);
}

export function tag(kind: string, value: string): string {
  return `[REDACTED:${kind}:${hash6(value)}]`;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Luhn check on a digit string. */
export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check. Input may contain spaces. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  // mod 97 on a big number, chunked to stay inside double precision.
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch; // A=10 … Z=35
    for (const d of v) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const HEX_ONLY = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Credential keywords, multilingual (EN/DE/RU). `\b` is ASCII-only in JS, so Cyrillic words use
// explicit letter-class lookarounds. Used by the kv layer, the entropy-context layer and the
// carrier classifier.
const KEYWORD_SRC =
  '(?:pass(?:word|wort|wd)?|pwd|secret|token|api[_\\s-]?key|client[_\\s-]?secret|private[_\\s-]?key|access[_\\s-]?key|auth[_\\s-]?token|' +
  'kennwort|passwort|zugangsdaten|anmeldedaten|пароль|парол[ья]|токен|секрет)';
const KEYWORD = new RegExp(`(?<![\\p{L}\\p{N}])${KEYWORD_SRC}(?![\\p{L}\\p{N}])`, 'giu');

// ---------------------------------------------------------------------------------------
// exact-form detectors — each pushes Findings with the ORIGINAL value for hashing
// ---------------------------------------------------------------------------------------

interface Hit {
  kind: string;
  start: number;
  end: number;
  value: string;
  confidence: Confidence;
}

type Detector = (text: string, out: Hit[]) => void;

function pushAll(text: string, re: RegExp, kind: string, out: Hit[], pick: (m: RegExpExecArray) => { start: number; end: number; value: string } | null): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = pick(m);
    if (p && p.end > p.start) out.push({ kind, ...p, confidence: 'exact' });
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** PEM private keys: the whole block, header to footer. */
const detectPem: Detector = (text, out) =>
  pushAll(text, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, 'pem', out, (m) => ({
    start: m.index,
    end: m.index + m[0].length,
    value: m[0],
  }));

/**
 * Connection strings with userinfo. Only the PASSWORD segment is replaced: user and host stay
 * readable so the agent can still tell *which* system a mail is about. The hash is of the password.
 */
const detectDsn: Detector = (text, out) =>
  pushAll(
    text,
    /\b(?:jdbc:)?(?:mysql2?|postgres(?:ql)?|pgsql|redis|rediss|mongodb(?:\+srv)?|amqps?|mssql|sqlserver|ssh|s?ftps?|https?|smtps?|imaps?|ldaps?):\/\/([^\s/:@'"<>]*):([^\s@'"<>]+)@[^\s'"<>]+/gi,
    'dsn',
    out,
    (m) => {
      const pass = m[2]!;
      const start = m.index + m[0].indexOf(`:${pass}@`) + 1;
      return { start, end: start + pass.length, value: pass };
    },
  );

/** `Authorization: Bearer …` and bare `Bearer <token>` (≥16 chars, token charset). */
const detectBearer: Detector = (text, out) =>
  pushAll(text, /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}=*)/g, 'bearer', out, (m) => {
    const v = m[1]!;
    const start = m.index + m[0].length - v.length;
    return { start, end: start + v.length, value: v };
  });

/** JWTs: three base64url segments, header starting with `eyJ` ("{"). */
const detectJwt: Detector = (text, out) =>
  pushAll(text, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt', out, (m) => ({
    start: m.index,
    end: m.index + m[0].length,
    value: m[0],
  }));

/** Vendor token prefixes. Each pattern is anchored by a prefix that no prose produces by accident. */
const TOKEN_PREFIXES: Array<[string, RegExp]> = [
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github', /\b(?:gh[poasur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['slack', /\bxox[abpers]-[A-Za-z0-9-]{10,}\b/g],
  ['slack', /\bxapp-[A-Za-z0-9-]{10,}\b/g],
  ['granola', /\bgrn_[A-Za-z0-9_-]{10,}\b/g],
  ['openai', /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g],
  ['google', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['google', /\bya29\.[0-9A-Za-z_-]{20,}\b/g],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['npm', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['sendgrid', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
];
const detectTokens: Detector = (text, out) => {
  for (const [kind, re] of TOKEN_PREFIXES) {
    pushAll(text, re, kind, out, (m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
  }
};

/**
 * `key: value` / `key=value` / `key is value` pairs. The value runs to whitespace, quote or newline
 * (quoted values keep their inner text). Guard against prose ("the token expired"): with an explicit
 * separator any value ≥ 6 chars is taken (fail-closed: "password: changed" gets redacted, fine);
 * with whitespace alone the value must look like a secret (a digit or a symbol in it) and must not
 * be a URL without userinfo (those are handled — or deliberately not — by detectDsn).
 */
const KV = new RegExp(
  `(?<![\\p{L}\\p{N}])(${KEYWORD_SRC})(?![\\p{L}\\p{N}])\\s*(?:(:=|->|:|=|\\bis\\b|\\bist\\b)\\s*|(\\s+))(["'\`]?)([^\\s"'\`]{6,})`,
  'giu',
);
const detectKv: Detector = (text, out) =>
  pushAll(text, KV, 'kv', out, (m) => {
    const sepExplicit = m[2] !== undefined; // groups: 1 keyword, 2 explicit sep, 3 whitespace sep, 4 quote, 5 value
    const value = m[5]!;
    if (!sepExplicit && !/[\d^\p{P}\p{S}]/u.test(value)) return null; // whitespace-only: needs a digit/symbol
    if (/^https?:\/\/[^@]+$/i.test(value)) return null; // plain URL, no userinfo
    if (/^\[REDACTED:/.test(value)) return null;
    // Values ending in sentence punctuation: trim it (the regex is greedy up to whitespace).
    const trimmed = value.replace(/[.,;:!?)]+$/u, '');
    if (trimmed.length < 6) return null;
    const start = m.index + m[0].length - value.length;
    return { start, end: start + trimmed.length, value: trimmed };
  });

/** IBANs — regex candidate, then mod-97 so account-number-looking noise does not match. */
const detectIban: Detector = (text, out) =>
  pushAll(text, /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g, 'iban', out, (m) =>
    ibanValid(m[0]) ? { start: m.index, end: m.index + m[0].length, value: m[0].replace(/\s+/g, '') } : null,
  );

/** Card numbers — 13–19 digits with optional space/dash separators, Luhn-validated. */
const detectCard: Detector = (text, out) =>
  pushAll(text, /\b\d(?:[ -]?\d){12,18}\b/g, 'card', out, (m) => {
    const digits = m[0].replace(/[ -]/g, '');
    // Tail of an IBAN-shaped token (`DE89 3704 …`): even when the IBAN check fails, this is an
    // account number, not a card — the IBAN detector owns that shape.
    if (/[A-Z]{2}\d{2}\s?$/.test(text.slice(Math.max(0, m.index - 6), m.index))) return null;
    if (!luhn(digits)) return null;
    if (/^(\d)\1+$/.test(digits)) return null; // 0000… passes Luhn
    return { start: m.index, end: m.index + m[0].length, value: digits };
  });

/**
 * `.env` / shell-export shape: `SOME_KEY=value`, `export DB_PASSWORD="value"`. Catches keys the
 * multilingual keyword list does not (STRIPE_KEY, SENTRY_DSN) by their SUFFIX. `*_URL` is included
 * only when the value carries userinfo — plain `APP_URL=https://…` is configuration, not a secret.
 */
const detectEnv: Detector = (text, out) =>
  pushAll(text, /^[ \t]*(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PASSWD|PWD|CREDENTIALS?|DSN|URL|URI))\s*=\s*(["']?)([^\s"']{6,})/gm, 'env', out, (m) => {
    const key = m[1]!;
    const value = m[3]!;
    if (/(?:URL|URI)$/.test(key) && !/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@/i.test(value)) return null;
    if (/^\[REDACTED:/.test(value)) return null;
    const start = m.index + m[0].length - value.length;
    return { start, end: start + value.length, value };
  });

const EXACT_DETECTORS: Detector[] = [detectPem, detectDsn, detectBearer, detectJwt, detectTokens, detectEnv, detectKv, detectIban, detectCard];

// ---------------------------------------------------------------------------------------
// `likely` layer — high-entropy strings in a credential context
// ---------------------------------------------------------------------------------------

/** [start,end) ranges of fenced ``` blocks and 4-space-indented lines. */
function codeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  const indented = /(?:^|\n)((?: {4}|\t).*)/g;
  while ((m = indented.exec(text)) !== null) {
    const start = m.index + m[0].length - m[1]!.length;
    ranges.push([start, start + m[1]!.length]);
  }
  return ranges;
}

function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

/**
 * Candidates: runs of token characters ≥ 20 long with entropy ≥ threshold, either within 40 chars
 * after a credential keyword or inside a code block. Deliberately NOT flagged: hex-only strings
 * (git SHAs, hashes — entropy ≤ 4 but more importantly they are identifiers, not secrets), UUIDs,
 * and base64 that directly follows `base64,` (inline images). A keyword in front overrides all
 * three exclusions: "password: 3f2a…" is a password however it looks.
 */
const detectEntropy = (text: string, out: Hit[], threshold: number): void => {
  const blocks = codeBlockRanges(text);
  const keywordEnds: number[] = [];
  KEYWORD.lastIndex = 0;
  let k: RegExpExecArray | null;
  while ((k = KEYWORD.exec(text)) !== null) keywordEnds.push(k.index + k[0].length);

  // `=` is excluded on purpose: `KEY=value` must split into key and value (the env detector owns
  // the pair), and a trailing base64 `==` left behind is harmless.
  const cand = /[A-Za-z0-9+/_\-]{8,}/g;
  let m: RegExpExecArray | null;
  while ((m = cand.exec(text)) !== null) {
    const v = m[0];
    const afterKeyword = keywordEnds.some((e) => m!.index >= e && m!.index - e <= 40);
    const inCode = inRanges(m.index, blocks);
    if (!afterKeyword && !inCode) continue;
    if (afterKeyword) {
      // Short-form rule for "пароль от стейджинга: Stag1ng-009": ≥ 8 chars, letters AND digits,
      // modest entropy. Plain words after "password" ("reset", "changed") have no digits → skipped.
      if (v.length < 20) {
        if (!/\d/.test(v) || !/[A-Za-z]/.test(v) || entropy(v) < 3.0) continue;
        out.push({ kind: 'entropy', start: m.index, end: m.index + v.length, value: v, confidence: 'likely' });
        continue;
      }
    } else {
      if (v.length < 20) continue;
      if (HEX_ONLY.test(v) || UUID.test(v)) continue;
      if (/base64,$/.test(text.slice(Math.max(0, m.index - 7), m.index))) continue;
    }
    if (entropy(v) < threshold) continue;
    out.push({ kind: 'entropy', start: m.index, end: m.index + v.length, value: v, confidence: 'likely' });
  }
};

// ---------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------

/** Overlapping hits: keep the earlier-starting, then the longer one. Exact beats likely on ties. */
function resolveOverlaps(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end || (a.confidence === 'exact' ? -1 : 1));
  const out: Hit[] = [];
  let lastEnd = -1;
  for (const h of sorted) {
    if (h.start < lastEnd) continue;
    out.push(h);
    lastEnd = h.end;
  }
  return out;
}

function collectHits(text: string, opts: ScrubOptions): Hit[] {
  const hits: Hit[] = [];
  for (const d of EXACT_DETECTORS) d(text, hits);
  if (!opts.exactOnly) detectEntropy(text, hits, opts.entropyThreshold ?? 3.8);
  return resolveOverlaps(hits);
}

export function scrubText(text: string, opts: ScrubOptions = {}): ScrubResult {
  if (!text) return { text, findings: [] };
  const hits = collectHits(text, opts);
  if (!hits.length) return { text, findings: [] };
  let out = '';
  let cursor = 0;
  const findings: Finding[] = [];
  for (const h of hits) {
    out += text.slice(cursor, h.start) + tag(h.kind, h.value);
    cursor = h.end;
    findings.push({ kind: h.kind, start: h.start, end: h.end, hash6: hash6(h.value), confidence: h.confidence });
  }
  out += text.slice(cursor);
  return { text: out, findings };
}


// What the operator log line needs: the kinds (sorted, deduped) and the count — never a value.
export function scrubSummary(findings: Finding[]): { kinds: string[]; count: number } {
  return { kinds: [...new Set(findings.map((f) => f.kind))].sort(), count: findings.length };
}

// ── Puller side: message classification, withholding, vault extraction ──────────────
// Used by src/sources/* on the BOT HOST only (extractSecrets returns raw values). The sandbox
// never imports this module; the model boundary above is what it gets.

/**
 * Subject-level carrier phrases — STRONG forms only. A mail titled "Zugangsdaten VPN" or "your
 * login details" delivers credentials even before a password shows up in the body. Generic words
 * (access, account, login, keys, vpn, password on its own) are NOT here: the first live pull showed
 * they withhold Dependabot digests, "[Action required] Migrate your legacy user API keys" and
 * Asana's "You have 1 overdue task" — 75 of 605 bodies — while contributing nothing: a body with a
 * real secret is caught by the exact detectors anyway.
 */
const CARRIER_SUBJECT = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:credentials?|zugangsdaten|anmeldedaten|access\\s+data|login\\s+(?:details|data|information)|' +
    'your\\s+(?:new\\s+|temporary\\s+|initial\\s+)?password|password\\s+for\\b|' +
    'vpn\\s+(?:config(?:uration)?|zugang|access|credentials|profile|login)|' +
    'учетные\\s+данные|учётные\\s+данные|данные\\s+для\\s+(?:входа|доступа)|логин\\s+и\\s+пароль|пароль\\s+(?:от|для|к)\\b)(?![\\p{L}\\p{N}])',
  'iu',
);
/**
 * Finding kinds whose single presence makes the message a carrier: a DSN, a private key, an
 * `.env` line, a JWT, a Bearer token or a vendor token never appear in a mail *about* something —
 * they ARE the payload. `kv`, `card`, `iban`, `entropy` alone are inline-redacted instead: one
 * "password: changed" or one Luhn-valid order number must not cost the whole body.
 */
const STRONG_KINDS = new Set(['dsn', 'pem', 'env', 'jwt', 'bearer', 'aws', 'github', 'slack', 'granola', 'openai', 'google', 'gitlab', 'npm', 'sendgrid']);
/** A `Password: …` line next to a login/username line is a credential bundle (the Contoso-account mail shape). */
const PASSWORD_KEY = /(?:pass(?:word|wort|wd)?|pwd|kennwort|пароль)\s*(?::=|->|:|=|\bis\b|\bist\b)\s*$/iu;
const LOGIN_WORD = /(?<![\p{L}\p{N}])(?:login|log-in|username|user\s?name|benutzer(?:name)?|anmeldename|логин|пользователь|user)(?![\p{L}\p{N}])\s*[:=]/iu;
const CARRIER_ATTACHMENT = /(?:^|[\\/.])env(?:\.[a-z0-9]+)?$|\.(?:pem|key|p12|pfx|kdbx|ppk|jks|ovpn|asc|gpg)$|credential|password|passwort|zugangsdaten|secret|\bkeys?\b/i;

export interface Classification {
  carrier: boolean;
  reasons: string[];
}

export function classifyMessage(msg: { subject?: string; text: string; attachments?: AttachmentLike[] }, opts: ScrubOptions = {}): Classification {
  const reasons: string[] = [];
  const text = msg.text ?? '';
  const exact = collectHits(text, { ...opts, exactOnly: true });
  const kinds = [...new Set(exact.map((h) => h.kind))].sort();
  const strong = kinds.filter((k) => STRONG_KINDS.has(k));
  // Two findings make a carrier only when they are not just card/IBAN numbers: Luhn-valid task
  // ids and invoice references appear in pairs in perfectly ordinary notification mail.
  const nonFinancial = exact.filter((h) => h.kind !== 'card' && h.kind !== 'iban');
  if (strong.length) reasons.push(`exact:${strong.join(',')}`);
  else if (nonFinancial.length >= 2) reasons.push(`exact:${kinds.join(',')}`);
  else if (exact.length === 1 && exact[0]!.kind === 'kv') {
    const before = text.slice(Math.max(0, exact[0]!.start - 40), exact[0]!.start);
    if (PASSWORD_KEY.test(before) && LOGIN_WORD.test(text)) reasons.push('exact:kv+login');
  }
  if (msg.subject && CARRIER_SUBJECT.test(msg.subject)) reasons.push('subject');
  for (const a of msg.attachments ?? []) {
    if (CARRIER_ATTACHMENT.test(a.name)) {
      reasons.push(`attachment:${a.name}`);
      break;
    }
  }
  return { carrier: reasons.length > 0, reasons };
}

/** Deterministic vault key for a message: sha256("<source>:<id>")[0..12]. */
export function vaultId(source: string, id: string): string {
  return createHash('sha256').update(`${source}:${id}`, 'utf8').digest('hex').slice(0, 12);
}

export function withheldMarker(vault: string): string {
  return `[BODY WITHHELD: credential carrier — see vault ${vault}]`;
}

/**
 * The one call every puller makes before writing a message record. Returns a copy; the input is
 * not mutated (pullers may still need the raw text for `extractSecrets` → vault).
 */
export function scrubMessage<T extends ScrubbableMessage>(msg: T, opts: ScrubOptions = {}): T & { scrub: ScrubMeta } {
  const cls = classifyMessage(msg, opts);
  const attachments = msg.attachments?.map((a) => ({ name: a.name, size: a.size }));
  if (cls.carrier) {
    const vault = vaultId(msg.source, msg.id);
    // Meta lists every exact kind present, not just the one that tripped the carrier rule.
    const kinds = [...new Set(collectHits(msg.text ?? '', { ...opts, exactOnly: true }).map((h) => h.kind))].sort();
    const scrub: ScrubMeta = { withheld: true, kinds, redactions: 0, vault };
    return { ...msg, text: withheldMarker(vault), ...(attachments ? { attachments } : {}), scrub };
  }
  const { text, findings } = scrubText(msg.text ?? '', opts);
  const scrub: ScrubMeta = { withheld: false, kinds: [...new Set(findings.map((f) => f.kind))].sort(), redactions: findings.length };
  return { ...msg, text, ...(attachments ? { attachments } : {}), scrub };
}

/**
 * RAW VALUES. Token-host only — feeds vault.ts. Never import from anything that runs in the sandbox.
 * Returns every exact finding (and `likely` ones, flagged by kind) with a redacted context window
 * so a human opening the vault entry knows what the secret unlocks.
 */
export function extractSecrets(msg: { subject?: string; text: string }, opts: ScrubOptions = {}): ExtractedSecret[] {
  const text = msg.text ?? '';
  const hits = collectHits(text, opts);
  return hits.map((h) => {
    const before = text.slice(Math.max(0, h.start - 40), h.start);
    const after = text.slice(h.end, h.end + 40);
    return { kind: h.kind, value: h.value, hash6: hash6(h.value), context: `${before}«${h.kind}»${after}`.replace(/\s+/g, ' ') };
  });
}
