// Stage 0, T2–T4: the pure text helpers (design notes/10-design.md §2.1 F9, §3.2). No I/O, no tenant, no model.
//   cuesOf(text)        the EN/DE/RU/IT cue lexicon: which of Q(uestion) R(equest) C(ommitment) I(ncident) a text
//                       fires. T4-kind exposes them (K keys on the sorted set, J's cite check reads them); never a
//                       decision alone.
//   isSmallTalk(text)   greetings, thanks, acknowledgements, emoji and mentions only — the strict small-talk rung
//   hostsApps(item)     hostnames (lowercase, port/path stripped, tool hosts dropped) and app tokens (deploy project,
//                       repo slug, alert target, bracketed project) — K's host/app keys and the family's token
//   alertIdentity(text) a monitor alert's rule + target with values kept — the re-fire edge
//   roleLike(raw)       shared/functional mailboxes sender.ts's lists miss (other languages, team lists, rooms)
//   exactKey / exactTokens   the value-preserving text (case, spacing, edge punctuation and scrub placeholders aside):
//                       the exact and bump edges. null when nothing but placeholders is left (F9: never matches)
//   normBody(text)      F9: URLs → host, addresses/hex/numbers → placeholders, punctuation gone — cross-posts, forwards
// JS `\b` is ASCII-only, so every word boundary here is Unicode-aware (letters and digits of any script).

import type { ItemUnit } from '../../types.js';

// --- cue lexicon -------------------------------------------------------------------------------------------

export type Cue = 'Q' | 'R' | 'C' | 'I';
export const CUES: readonly Cue[] = ['Q', 'R', 'C', 'I'];

/** Whole-word alternation for any script: `(?<![\p{L}\p{N}])(?:alts)(?![\p{L}\p{N}])`. */
const word = (alts: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu');

// The design lists (§3.2), plus the obvious missing forms of the same words (why/where/who, warum/wo, почему/где,
// perché/dove; failed/crash; I'm going to …). An interrogative counts only as the FIRST word of a sentence:
// "how" inside a sentence is not a question ("that's how we do it").
const INTERROGATIVE = new Set([
  'what', 'when', 'where', 'who', 'why', 'how', 'which', // EN (+ "can you", below)
  'wann', 'wie', 'was', 'wo', 'wer', 'warum', 'welche', 'welcher', 'welches', 'kannst', 'können', 'könnt', // DE
  'когда', 'как', 'что', 'где', 'кто', 'почему', 'зачем', 'какой', 'какая', 'какие', 'можешь', 'можете', 'можно', // RU
  'quando', 'come', 'cosa', 'dove', 'chi', 'perché', 'perche', 'quale', 'puoi', 'potete', // IT
]);
const Q_PHRASE = word('can you|could you|do you|are you|is there|ли|gibt es|hast du|haben sie|c[\'’]è|ci sono');
const R_RE = word(
  'please|pls|plz|kindly|could you|would you|can you|bitte|könntest|könnten sie|kannst du|пожалуйста|сделай(?:те)?|нужно|надо|прошу|посмотри(?:те)?|per favore|potresti|potreste|puoi',
);
const C_RE = word(
  "i['’]ll|i will|i['’]m going to|will do|on it|ich mache|mache ich|ich werde|ich kümmere|kümmere mich|сделаю|пришлю|посмотрю|отправлю|займусь|farò|faro|lo faccio|ci penso io|me ne occupo",
);
// An error class name counts too ("ReferenceError", "ApiException"): the lookbehind stops at the word's start only.
const I_RE = word(
  'down|\\p{L}*error(?:s)?|\\p{L}*exception|outage|not working|doesn[\'’]t work|fail(?:ed|ing|ure|s)?|broken|crash(?:ed|es)?|timeout|bad gateway|needs your attention|fehler|ausfall|geht nicht|funktioniert nicht|kaputt|не работает|упал(?:а|о|и)?|ошибк(?:а|и|у|ой)|падает|сломал(?:ся|ось|ась)?|errore|errori|non funziona|guasto|bloccato',
);

const URL_ANY_G = /<(?:https?|mailto):[^>\s]*>|\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;

/** The cue classes a text fires, in Q R C I order. URLs are blanked first (a `?` in a query string is no question). */
export function cuesOf(text: string | null | undefined): Cue[] {
  const t = (text ?? '').replace(URL_ANY_G, ' ');
  const out = new Set<Cue>();
  if (t.includes('?') || t.includes('？') || Q_PHRASE.test(t)) out.add('Q');
  else {
    for (const sentence of t.split(/[.!?\n;:]+/)) {
      const first = /[\p{L}]+/u.exec(sentence.replace(/^\s*(?:@\S+\s*)+/u, ''))?.[0]?.toLowerCase();
      if (first && INTERROGATIVE.has(first)) {
        out.add('Q');
        break;
      }
    }
  }
  if (R_RE.test(t)) out.add('R');
  if (C_RE.test(t)) out.add('C');
  if (I_RE.test(t)) out.add('I');
  return CUES.filter((c) => out.has(c));
}

// --- small talk ---------------------------------------------------------------------------------------------

// Greetings, thanks, acknowledgements and goodbyes (EN/DE/RU/IT): what a text may consist of and still be small talk.
// Answers are NOT here — "yes", "correct", "done", "sure" answer something (info), "ok"/"thanks" only acknowledge.
const SMALL_TALK_G = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    'good (?:morning|afternoon|evening|night)', 'morning', 'hi+', 'hello', 'hey(?:hey)?', 'hiya', 'yo', 'gm',
    'guten (?:morgen|tag|abend)', 'moin', 'servus', 'hallo', 'grüezi', 'привет(?:ик)?', 'доброе утро', 'добрый (?:день|вечер)', 'здравствуй(?:те)?',
    'buongiorno', 'buonasera', 'salve', 'ciao', 'hola',
    'thanks? a lot', 'thanks?(?: you)?(?: so much)?', 'many thanks', 'thx(?: a lot)?', 'ty', 'tnx', 'cheers', 'danke(?: schön| sehr)?', 'vielen dank', 'merci',
    'спасибо(?: большое)?', 'спс', 'благодарю', 'grazie(?: mille)?',
    'ok(?:ay)?', 'kk?', 'ок', 'окей', 'ага', 'угу', 'super', 'супер', 'great', 'cool', 'nice', 'perfect', 'perfetto', 'gotcha', 'got it', 'noted', 'no problem', 'np',
    'alles klar', 'passt', 'va bene', 'отлично', 'понял(?:а)?', 'принято', 'lol', 'haha+', 'хаха+', 'a lot',
    'bye', 'see you', 'cu', 'tschüss', 'пока', 'до связи',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);
const GREETING_NAME = /^\s*((?:good\s+)?(?:morning|hi+|hello|hey(?:hey)?|hallo|ciao|привет|moin|servus|buongiorno)[\s,!]+)\p{Lu}[\p{L}'-]+/iu;

/** A text made of greetings, thanks, acknowledgements, emoji and mentions only ("Thanks!", "ok", "Hi Ana", ":tada:"). */
export function isSmallTalk(text: string | null | undefined): boolean {
  const raw = (text ?? '').trim();
  if (!raw || /\[file:|https?:\/\//i.test(raw)) return false; // a shared file or link is something
  // Mentions go first ("@Ana Berg" is one mention: a capitalised surname rides along, an all-caps "FYI" does not).
  const unmentioned = raw.replace(GREETING_NAME, '$1').replace(/<@[^>]+>|@[\p{L}\p{N}_.-]+(?:\s\p{Lu}\p{Ll}[\p{L}'-]*)?/gu, ' ');
  if (!unmentioned.trim()) return false; // a bare ping ("@ana") asks for attention
  const t = unmentioned
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, ' ')
    .replace(SMALL_TALK_G, ' ');
  return !/[\p{L}\p{N}]/u.test(t);
}

// --- hosts and apps ----------------------------------------------------------------------------------------

/** Hosts of the tools themselves: the same for every item of a sender, so they key nothing (an app slug is read instead). */
const PLATFORM = [
  'slack.com', 'slack-edge.com', 'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'atlassian.com',
  'youtrack.cloud', 'myjetbrains.com', 'sentry.io', 'getsentry.com', 'google.com', 'googleusercontent.com', 'goo.gl', 'gstatic.com',
  'outlook.com', 'office.com', 'office365.com', 'microsoft.com', 'live.com', 'sharepoint.com', 'teams.microsoft.com', 'asana.com',
  'zoom.us', 'notion.so', 'notion.site', 'figma.com', 'linear.app', 'intercom.com', 'intercom.io', 'intercomcdn.com', 'loom.com',
  'calendly.com', 'trello.com', 'gleap.io', 'aws.amazon.com', 'amazonaws.com', 'cloudflare.com', 'digitalocean.com', 'vercel.com',
  'netlify.com', 'stripe.com', 'zapier.com', 'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com', 'apple.com',
];
const underAny = (host: string, list: readonly string[]): boolean => list.some((d) => host === d || host.endsWith(`.${d}`));

/** File-name endings that look like a TLD in a bare word ("deploy.sh", "notes.md"): never a host. */
const NOT_TLD = new Set(['js', 'ts', 'py', 'md', 'rb', 'go', 'sh', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'csv', 'xml', 'json', 'yml', 'yaml', 'php', 'html', 'htm', 'css', 'vue', 'jsx', 'tsx', 'log', 'zip', 'gz', 'tar', 'mov', 'mp4', 'mp3', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'svg', 'sql', 'lock', 'env', 'ini', 'conf', 'cfg', 'bak', 'tmp', 'old', 'new', 'min', 'map', 'exe', 'dll', 'so', 'ico', 'webp', 'heic', 'dmg', 'apk', 'ipa', 'rs', 'kt', 'java', 'cs', 'cpp', 'h', 'c', 'swift', 'scss', 'less', 'twig', 'blade', 'tf', 'toml']);
const GTLD = new Set(['example', 'test', 'com', 'net', 'org', 'io', 'ai', 'app', 'dev', 'cloud', 'tech', 'info', 'biz', 'online', 'site', 'store', 'shop', 'xyz', 'agency', 'digital', 'email', 'live', 'media', 'studio', 'design', 'systems', 'software', 'services', 'solutions', 'network', 'host', 'hosting', 'website', 'travel', 'swiss', 'berlin', 'wien', 'tirol', 'bayern', 'eu', 'asia', 'pro', 'gmbh', 'ag', 'team', 'tools', 'works', 'company', 'group', 'global', 'world', 'one', 'today', 'news', 'blog']);
const BARE_HOST_G = /(?<![\p{L}\p{N}@.\/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{2,5})?(?![\p{L}\p{N}@-])/giu;
const URL_G = /\bhttps?:\/\/[^\s<>"'`|)\]*]+/gi;
// Repo paths on the code hosts that are not repos.
const NOT_ORG = new Set(['user-attachments', 'orgs', 'settings', 'notifications', 'marketplace', 'apps', 'sponsors', 'login', 'features', 'about', 'pricing', 'topics', 'search', 'explore', 'users', 'issues', 'pulls', 'dashboard', 'organizations']);
const ALERT_STATE = new Set(['resolved', 'firing', 'warning', 'critical', 'alert', 'ok', 'error', 'info', 'bot', 'fyi', 'external', 'no preview available']);

export const slugOf = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_`~]+/g, '')
    .trim()
    .replace(/\s+/g, '-');

/** A URL's host, lowercase, without port or trailing dot; Outlook safelinks give the URL they wrap. '' when unparseable. */
export function hostOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.endsWith('safelinks.protection.outlook.com')) {
    const inner = u.searchParams.get('url');
    return inner ? hostOf(inner) : '';
  }
  return host;
}

/** `org/repo` of a code-host URL (github.com/org/repo/…), lowercase; '' when the path names no repo. */
function repoOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (!['github.com', 'gitlab.com', 'bitbucket.org'].includes(host)) return '';
  const [org, repo] = u.pathname.split('/').filter(Boolean);
  if (!org || !repo || NOT_ORG.has(org.toLowerCase())) return '';
  return `${org}/${repo.replace(/\.git$/, '')}`.toLowerCase();
}

/**
 * Hosts and apps an item names. Hosts: every URL's host plus bare hostnames ("api.shop.example:443") in the text,
 * keys and subject, minus the tools' own hosts. Apps: a deploy notice's project ("Shopfront: Deploy to *production*",
 * "Project: shop-admin"), a code-host repo ("[acme/shop] Run failed", github.com/acme/shop/…, "(acme/shop#12)"), a
 * bracketed project at the head of a bot post ("[shop] TypeError …"), an alert's target when it is not a host
 * ("*db-primary*"), the counterpart of a support tool ("… with_ _Shop Team (https://…"). All lowercase, deduplicated.
 */
export function hostsApps(u: Pick<ItemUnit, 'text' | 'subject' | 'keys'>): { hosts: string[]; apps: string[] } {
  const text = `${u.subject ?? ''}\n${u.text ?? ''}`;
  const blob = `${text}\n${(u.keys ?? []).join('\n')}`;
  const hosts = new Set<string>();
  const apps = new Set<string>();
  const addHost = (h: string) => {
    const host = h.toLowerCase().replace(/\.$/, '');
    if (!host || underAny(host, PLATFORM) || /^\d+(?:\.\d+)+$/.test(host)) return;
    hosts.add(host);
  };
  // Slack's <url|label> and Outlook's <url> — the URL part only.
  const urls = [...blob.matchAll(URL_G)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  for (const url of urls) {
    const repo = repoOf(url);
    if (repo) apps.add(repo);
    addHost(hostOf(url));
  }
  const noUrls = blob.replace(URL_G, ' ');
  for (const m of noUrls.matchAll(BARE_HOST_G)) {
    const tld = m[2]!.toLowerCase();
    // A bare dotted word is a host only under a country code or a common generic TLD: "os.name" and "user.id" are keys.
    if (NOT_TLD.has(tld) || (tld.length > 2 && !GTLD.has(tld))) continue;
    addHost(m[1]!);
  }
  // Apps.
  const deploy = /(?:^|\n)\s*(?::[a-z_]+:\s*)?\*?([A-Za-z][\w .-]{0,40}?)\*?\s*:\s*deploy(?:ment)?\s+(?:to|on|of)\b/i.exec(text);
  if (deploy) apps.add(slugOf(deploy[1]!));
  // "Deployed shop-api v1.2 to production", "Deploy of checkout-web to staging"
  const deployed = /\bdeploy(?:ed|ing|ment)?\s+(?:of\s+)?\*?([a-z][\w.-]{1,40})\*?\s+(?:v?\d[\w.-]*\s+)?(?:to|on)\s+\*?(?:prod|production|staging|stage|dev|development|preview|qa|test|live)\b/i.exec(text);
  if (deployed && !/^(?:to|on|of|the|a|an|for|new|latest)$/i.test(deployed[1]!)) apps.add(slugOf(deployed[1]!));
  for (const m of text.matchAll(/\bproject:\s*\*?([\w][\w.-]{0,60})/gi)) apps.add(slugOf(m[1]!));
  for (const m of text.matchAll(/\[([\w.-]+\/[\w.-]+)\]/g)) apps.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\(([\w.-]+\/[\w.-]+)#\d+\)/g)) apps.add(m[1]!.toLowerCase());
  const head = /^\s*\[([a-z][\w.-]{1,40})\]\s/i.exec(u.text ?? '');
  if (head && !ALERT_STATE.has(head[1]!.toLowerCase()) && !/^firing:\d+$/i.test(head[1]!)) apps.add(head[1]!.toLowerCase());
  // An alert's target between asterisks that is not a URL or host: an instance or job name.
  const target = /^\s*(?::[a-z_]+:\s*)?(?:[A-Z]+:\s*)?[\w.-]+:\s*\*([^*\s]{2,60})\*/.exec(u.text ?? '');
  if (target && !/^https?:/i.test(target[1]!) && !target[1]!.includes('.')) apps.add(target[1]!.toLowerCase());
  const counterpart = /\bwith_?\s+_?([A-Z][\w .'-]{1,40}?)_?\s*\((?:https?:|<)/.exec(u.text ?? '');
  if (counterpart) apps.add(slugOf(counterpart[1]!));
  return { hosts: [...hosts].sort(), apps: [...apps].filter(Boolean).sort() };
}

// --- alert identity (values kept) ---------------------------------------------------------------------------

// fingerprint.ts alertOf's state words: an alert's state is not part of its identity.
const STATE_WORDS = new Set(['warning', 'warn', 'critical', 'crit', 'error', 'alert', 'alarm', 'firing', 'triggered', 'problem', 'down', 'failing', 'failed', 'failure', 'high', 'major', 'severe', 'emergency', 'disaster', 'incident', 'resolved', 'recovered', 'recovery', 'ok', 'okay', 'cleared', 'normal', 'up', 'fixed']);
const EDGE_PUNCT_ALERT = /^[*_`~[\](){}<>:;,.|"'!?]+|[*_`~[\](){}<>:;,.|"'!?]+$/g;

/**
 * An alert's identity with its values KEPT: the first line's first 8 tokens, state words among the first three
 * dropped; '' when no state WORD opens the line. fingerprint.ts alertOf turns numbers into <n> so that a firing and
 * its resolve meet across changed figures; a re-fire must not meet another order's or account's alert, so here
 * "order 123" ≠ "order 124".
 */
export function alertIdentity(text: string | null | undefined): string {
  const line = ((text ?? '').replace(/<((?:https?|mailto):[^>|\s]+)(?:\|[^>]*)?>/g, '$1').split('\n').find((l) => l.trim()) ?? '').trim();
  const toks = line
    .split(/\s+/)
    .filter((w) => !/^:[a-z0-9_+-]+:$/i.test(w))
    .map((w) => w.toLowerCase().replace(EDGE_PUNCT_ALERT, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  let stated = false;
  for (let i = 0; i < Math.min(3, toks.length); ) {
    if (STATE_WORDS.has(toks[i]!.replace(/:\d+$/, ''))) {
      toks.splice(i, 1);
      stated = true;
    } else i++;
  }
  // Only a monitor's own state word ("WARNING:", "[RESOLVED]") makes a re-firable alert: a ✅/❌ emoji also heads deploy
  // notices and bot replies, whose repeats are other deploys and other answers.
  return stated ? toks.slice(0, 8).join(' ') : '';
}

// --- role mailboxes beyond sender.ts ---------------------------------------------------------------------------

// Shared and functional mailboxes sender.ts's English lists miss: other languages (serwis@, kundendienst@, assistenza@),
// team lists (dev@, all-staff@), rooms and resources, and notices named after their topic (upcoming-invoice@,
// azure-deprecation@). Weaker than sender.ts (a person may be called "dev"): a .90 guess, never a decision at τ.
const ROLE_EXTRA_LOCAL = /^(?:all|everyone|staff|team|dev|devs|developers|ops|it|marketing|partners?|success|website|web|room|rooms|meetingroom|resources?|serwis|pomoc|kontakt|biuro|partnerzy|sklep|obsluga|zamowienia|faktury|rechnung(?:en)?|buchhaltung|kundenservice|kundendienst|vertrieb|verkauf|zentrale|empfang|assistenza|servizio|ufficio|amministrazione|fatture|ordini|prenotazioni)(?:[+._-].*)?$/i;
const ROLE_EXTRA_TOKEN = /(?:^|[._-])(?:invoices?|billing|deprecation|quota|notices?|reminders?|room|calendar|scheduler|reports?|digest|alerts?)(?:$|[._-])/i;
const ROLE_EXTRA_DISPLAY = /^(?:all\s|everyone\b|(?:meeting|conference|board)\s?room\b|room\s)|\b(?:logger|integration|automation|notifier)\b|^u?slack$/i;

/** A shared, functional or automated sender sender.ts does not know: `Display <local@domain>`, a bare address or a label. */
export function roleLike(raw: string): boolean {
  const s = (raw ?? '').trim();
  const addr = /[A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(s)?.[0]?.toLowerCase() ?? '';
  const local = addr.split('@')[0] ?? '';
  const display = s.replace(/<[^>]*>/g, ' ').replace(/[A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  return (!!local && (ROLE_EXTRA_LOCAL.test(local) || ROLE_EXTRA_TOKEN.test(local))) || (!!display && ROLE_EXTRA_DISPLAY.test(display));
}

// --- duplicate keys ----------------------------------------------------------------------------------------

const WITHHELD_G = /\[body withheld[^\]]*\]/gi; // scrub.ts: a whole body replaced
const REDACTED_G = /\[redacted:[^\]\s]*\]/gi; // scrub.ts: [REDACTED:<kind>:<hash6>]
const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|antw|sv|vs|tr|rif|ответ|отв|пересл)\s*(?:\[\d+\])?\s*:\s*)+/i;
export const FORWARD_PREFIX = /^\s*(?:re\s*:\s*)*(?:fw|fwd|wg|tr|rif|пересл)\s*(?:\[\d+\])?\s*:/i;
const EDGE_PUNCT_G = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** A mail subject without its reply/forward prefixes ('' for none). */
export const stripSubject = (s: string | null | undefined): string => (s ?? '').replace(REPLY_PREFIX, '').trim();

/** Scrub placeholders out; '' when nothing else is left. */
export const unscrubbed = (s: string | null | undefined): string => (s ?? '').replace(WITHHELD_G, ' ').replace(REDACTED_G, ' ');

/** Lowercase NFKC tokens with their edge punctuation stripped — URLs and numbers kept as they are. */
export function exactTokens(s: string | null | undefined): string[] {
  return unscrubbed(s)
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCT_G, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/**
 * The value-preserving key of an item: (a mail's subject without prefixes) + its body tokens. Values stay — another
 * order number or issue link is another event — only case, spacing, edge punctuation and scrub placeholders go
 * ("ESET-12: Login broken" = "ESET-12 – login broken"). null when the body is placeholders only (F9: never matches).
 */
export function exactKey(u: Pick<ItemUnit, 'subject' | 'text'>, mail: boolean): { key: string; chars: number } | null {
  const body = exactTokens(u.text);
  if (!body.length) return null;
  const subject = mail ? exactTokens(stripSubject(u.subject)) : [];
  const b = body.join(' ');
  const sub = subject.join(' ');
  return { key: sub ? `${sub}\n${b}` : b, chars: b.length + sub.length };
}

const URL_HOST_G = /<((?:https?):[^>|\s]+)(?:\|[^>]*)?>|\bhttps?:\/\/[^\s<>"'`]+/gi;
const EMAIL_G = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu;

/** F9 normalisation: URLs → their host, addresses/hex/numbers → placeholders, punctuation gone, scrub placeholders out. */
export function normBody(s: string | null | undefined): string {
  return unscrubbed(s)
    .normalize('NFKC')
    .replace(URL_HOST_G, (m, inner) => ` ${hostOf(inner ?? m) || 'url'} `)
    .toLowerCase()
    .replace(EMAIL_G, ' <email> ')
    .replace(/(?<![\p{L}\p{N}])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}(?![\p{L}\p{N}])/gu, ' <hex> ')
    .replace(/\d+(?:[.,:/-]\d+)*/g, '<n>')
    .replace(/[^\p{L}\p{M}\p{N}<>.\s-]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])[.-]+|[.-]+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
