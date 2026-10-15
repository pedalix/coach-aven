// Who wrote an item — a person, an integration, a mass mailing or a role mailbox — decided once, deterministically.
// Two lists answer it today and disagree: the store's is_bot (bots.ts: KNOWN_BOT_NAMES + no-reply mail regexes) and
// the identity collector's isSystem (identities/normalise.ts: its own names + one regex over the whole address). Names
// only one side knows (gitlab, grafana, pagerduty vs wrike, fireflies, cloudflare …) and addresses only one side
// catches (support@, newsletter@, digest vs robot@, amazonses.com …) make 161 mails from 16 senders "system" to the
// collector but human in the store. senderClass() merges both lists (the exported constants below are the one list
// both should import) and answers with one of four classes:
//   human   a person, resolved or not
//   bot     an integration posting events: Slack/Teams apps and webhooks, CI, alerting, tool notifications (GitHub,
//           Jira, YouTrack, Sentry, Google Calendar …)
//   bulk    one-way mass mail — newsletters, marketing — never answered, never a person
//   system  a role or automated mailbox: noreply@, notifications@, info@, support@, billing@ … Never a person to
//           identify, but it may carry something to act on (a support reply, an overdue invoice), so it is not noise
// For the store, is_bot = (class ≠ human); for the collector, isSystem = the same. Precedence, first match wins:
//   1. no author at all                                                    → system
//   2. integration identity                                                → bot
//      a. chat/tracker items with the puller's flag (bot_id, users map). For MAIL the flag waits until step 5: the store
//         derives it from the very address regexes steps 3–4 refine, so it must not pre-empt them.
//      b. a Slack bot id (B…): the users map misses old bot ids (243 unflagged posts in one workspace)
//      c. a known integration name, or a bot/webhook word, as the author, the display name or the mailbox
//      d. mail from an integration relay (github.com, atlassian.net, youtrack.cloud, calendar/docs notifications …)
//   3. one-way bulk mail (mail only)                                       → bulk
//      not resolved to a person AND the subject never wrote in the thread AND a mass-mail marker: in the content
//      (unsubscribe, view in browser, newsletter, Abmelden, отписаться …), in the sender (newsletter@, news@,
//      marketing@ …, a marketing ESP or a news./email. subdomain) or the spam folder. Content markers beat a role
//      mailbox: a newsletter from noreply@ or info@ is bulk; noreply@ itself only makes a mail one-way.
//   4. role or automated mailbox, any source                               → system
//      unless the author resolves to a person: the tenant's people file listing support@ as Ana's wins, as in the
//      collector (mapped before isSystem)
//   5. mail carrying a bot flag we could not explain above                 → bot
//   6. everything else                                                     → human
// A resolved author is never bulk or system, but it can still be a bot: some tenants map their own bot to a
// pseudo-person. Pure; no I/O. Not wired yet: bots.ts and normalise.ts adopt it behind a rollout flag.

export type SenderClass = 'human' | 'bot' | 'bulk' | 'system';

export interface SenderInput {
  source: string; // slack | gmail | msgraph | youtrack | …
  author: string | null; // the raw author label/address (`Ana Berg | Acme <ana@acme.example>`, `Bluefin Alert Bot`, `B0…`)
  container?: string | null; // `#chan`, `dm:…`, `inbox`, `spam`, `chat:…` (Teams), `mailbox:…`
  isBotFlag?: boolean; // the puller's/store's bot flag
  subject?: string | null;
  text?: string;
  subjectWroteInThread?: boolean; // the tenant's subject wrote in this thread (unknown = no: most mail is one-way)
  authorResolved?: boolean; // the author resolves to a person of the people file
}

/** Integrations whose author label is the app name — the union of bots.ts KNOWN_BOT_NAMES and normalise.ts SYSTEM_NAMES, plus common ones. Lower-case. */
export const BOT_NAMES: ReadonlySet<string> = new Set([
  // bots.ts
  'intercom', 'intercom convert', 'monto-webhook', 'sentry', 'sentry quick analyzer', 'gleap', 'zapier', 'digitalocean',
  'github', 'gitlab', 'jira', 'jira cloud', 'youtrack', 'asana', 'google calendar', 'google drive', 'slackbot', 'grafana',
  'alertmanager', 'uptime robot', 'uptimerobot', 'stripe', 'vercel', 'netlify', 'datadog', 'pagerduty', 'coach-aven', 'coachaven',
  // identities/normalise.ts
  'amazon q', 'coach aven', 'confluence', 'microsoft teams', 'wrike', 'fireflies', 'granola', 'wispr', 'cloudflare',
  'instant google meet', 'google meet', 'devcoachaven', 'aven home',
  // common integrations neither list had
  'github actions', 'dependabot', 'renovate', 'bitbucket', 'circleci', 'jenkins', 'opsgenie', 'new relic', 'statuspage',
  'aws chatbot', 'trello', 'linear', 'notion', 'figma', 'loom', 'calendly', 'hubspot', 'workflow builder', 'workflows',
  'power automate', 'google sheets', 'google docs', 'giphy', 'snyk', 'codecov', 'sonarcloud',
]);

/** Mail relays of integrations (domain or parent domain): their mail is tool activity, whoever the display name says. */
export const BOT_MAIL_DOMAINS: readonly string[] = [
  'github.com', 'gitlab.com', 'atlassian.net', 'youtrack.cloud', 'myjetbrains.com', 'getsentry.com', 'sentry.io', 'asana.com',
  'calendar.google.com', 'docs.google.com', 'trello.com', 'bitbucket.org', 'linear.app', 'circleci.com', 'wrike.com',
];
/** Google's notification mailboxes (calendar invites, Gemini notes, doc comments, drive shares) — bot on any domain. */
const BOT_MAIL_LOCAL = /^(?:calendar-notification|gemini-notes|comments-noreply|drive-shares-(?:dm-)?noreply|meetings-noreply)(?:[+._-].*)?$/;

/** Automated mailboxes: nobody reads replies. bots.ts BOT_MAIL_LOCAL plus a few; any local containing "noreply" too. */
export const AUTOMATED_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|notifier|alerts?|alerting|mailer-daemon|mailer|postmaster|bounces?|automated|automailer|system|robot|daemon|monitoring|info-noreply)(?:[+._-].*)?$|no[-_.]?reply|do[-_.]?not[-_.]?reply/;
/** Role mailboxes: a team or a function, not a person. */
export const ROLE_LOCAL = /^(?:info|information|support|help|helpdesk|service|services|customer[-_.]?(?:service|care|success|support)|care|billing|invoices?|invoicing|accounts?|accounting|payments?|receipts?|orders?|bookings?|reservations?|admin|administrator|office|contact|hello|hi|team|sales|security|privacy|legal|compliance|hr|jobs|careers|recruiting|talent|feedback|press|media|partners?|webmaster|hostmaster|abuse|shop|store|updates?|events?|community|catalog|tickets?)(?:[+._-].*)?$/;
/** Transactional relays and automated sending domains (bots.ts BOT_MAIL_DOMAIN minus the integrations and the marketing ESPs). */
export const SYSTEM_MAIL_DOMAINS: readonly string[] = ['accountprotection.microsoft.com', 'amazonses.com', 'sendgrid.net', 'mandrillapp.com', 'mailgun.org', 'mailgun.net', 'sparkpostmail.com', 'postmarkapp.com', 'mtasv.net'];
/** Subdomain labels only machines send from (`alerts.bank.example`). Needs 3+ labels: `mail.ru` is a mailbox provider. */
const SYSTEM_SUBDOMAIN = /^(?:alerts?|notifications?|notify|no-?reply|mailer|bounces?|system|auto|automated)\./;

/**
 * Mass-mail markers in the content — the footer and header phrases of campaigns, EN/DE/RU/IT/FR/ES. A bare
 * "newsletter" in a body is not one (a person may mention a newsletter); in the sender's name or mailbox it is.
 */
export const BULK_CONTENT = /unsubscribe|opt[\s-]?out\b|view (?:this (?:e-?mail|message|newsletter) |it )?(?:in (?:your |a )?browser|online|as a web ?page)|manage (?:your )?(?:e-?mail |subscription |notification |communication )?(?:preferences|subscriptions?)|e-?mail preferences|update your preferences|abmelden|abbestellen|abmeldung|im browser (?:anzeigen|ansehen|öffnen)|отпис|в браузере|disiscriv|annulla(?:re)? l['’]iscrizione|cancella(?:re)? (?:l['’])?iscrizione|visualizza nel browser|désabonner|désinscri|darse de baja|cancelar (?:la )?suscripci/i;
const BULK_DISPLAY = /\b(?:newsletters?|digest)\b/i;
/** Sender mailboxes that only ever send campaigns. */
export const BULK_LOCAL = /^(?:newsletters?|news|marketing|promo(?:tions?)?|offers?|deals|digest|mailing|campaigns?|bulk|subscribe|subscriptions?|subscribers?|announce(?:ments)?|webinars?|edm)(?:[+._-].*)?$/;
/** Marketing ESPs: mail sent through them is a campaign. (Transactional relays — SES, SendGrid, Mailgun — are system.) */
export const BULK_MAIL_DOMAINS: readonly string[] = [
  'mailchimp.com', 'mailchimpapp.com', 'mcsv.net', 'mcdlv.net', 'rsgsv.net', 'list-manage.com', 'klaviyomail.com', 'substack.com',
  'beehiiv.com', 'convertkit.com', 'ck.page', 'mailerlite.com', 'mlsend.com', 'sendinblue.com', 'brevo.com', 'constantcontact.com',
  'exacttarget.com', 'hubspotemail.net', 'getresponse.com', 'unisender.com', 'sendpulse.com', 'mailjet.com', 'campaign-archive.com',
];
const BULK_SUBDOMAIN = /^(?:news|newsletters?|marketing|promo|campaigns?|e|em|email|mailing|mkt)\./;
const BULK_FOLDER = /^(?:spam|junk|bulk|promotions)$/i;

const SLACK_BOT_ID = /^B[A-Z0-9]{6,}$/;
const BOT_WORD = /(?:^|[\s._+\-[(])(?:bot|webhook)(?:$|[\s._+\-\])])/i;
const MAIL_SOURCES = /^(?:gmail|msgraph|outlook|imap|mail|email|exchange)$/i;
const CHAT_CONTAINER = /^(?:chat:|teams:|channel:)/i;

export interface ParsedSender {
  display: string; // the display name, lower-case, '| Company' and quotes stripped ('' when there is none)
  email: string | null;
  local: string;
  domain: string;
}

const ADDRESS_G = /[A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** `Ana Berg | Acme <ana@acme.example>` / `ana@acme.example` / `Bluefin Alert Bot` → its parts (the last address wins). */
export function parseSender(author: string): ParsedSender {
  const a = author.trim();
  const all = a.match(ADDRESS_G);
  const email = all ? all[all.length - 1]!.toLowerCase() : null;
  const display = a
    .replace(ADDRESS_G, ' ')
    .replace(/\bmailto:/gi, ' ')
    .replace(/\s*\|.*$/, '')
    .replace(/[<>()[\]"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const [local = '', domain = ''] = email ? email.split('@') : [];
  return { display, email, local, domain };
}

const underDomain = (domain: string, list: readonly string[]): boolean => list.some((d) => domain === d || domain.endsWith(`.${d}`));
const subdomainHit = (domain: string, re: RegExp): boolean => domain.split('.').length >= 3 && re.test(domain);
const compact = (s: string): string => s.replace(/[\s._-]+/g, '');
const BOT_COMPACT = new Set([...BOT_NAMES].map(compact));

/** Is this author an integration by name (step 2c)? The display name, the label, or a mailbox named after the tool. */
function botByName(p: ParsedSender): boolean {
  if (p.display && (BOT_NAMES.has(p.display) || BOT_WORD.test(p.display))) return true;
  if (p.local && (BOT_COMPACT.has(compact(p.local.replace(/\+.*$/, ''))) || BOT_WORD.test(p.local))) return true;
  return false;
}

/** Mail (an inbox every sender writes to) as opposed to chat (a channel or DM, where bots react to each other). */
export const isMailItem = (source: string, container: string | null | undefined): boolean => MAIL_SOURCES.test(source) && !CHAT_CONTAINER.test(container ?? '');

export function senderClass(input: SenderInput): SenderClass {
  const author = (input.author ?? '').trim();
  if (!author) return 'system';
  const p = parseSender(author);
  const mail = isMailItem(input.source, input.container);
  // 2. integration identity
  if (input.isBotFlag && !mail) return 'bot';
  if (SLACK_BOT_ID.test(author)) return 'bot';
  if (botByName(p)) return 'bot';
  if (p.email && (underDomain(p.domain, BOT_MAIL_DOMAINS) || BOT_MAIL_LOCAL.test(p.local))) return 'bot';
  if (!input.authorResolved) {
    // 3. one-way bulk mail
    if (mail && input.subjectWroteInThread !== true) {
      const marker =
        BULK_FOLDER.test(input.container ?? '') ||
        BULK_DISPLAY.test(p.display) ||
        (!!p.email && (BULK_LOCAL.test(p.local) || underDomain(p.domain, BULK_MAIL_DOMAINS) || subdomainHit(p.domain, BULK_SUBDOMAIN))) ||
        BULK_CONTENT.test(input.subject ?? '') ||
        BULK_CONTENT.test(input.text ?? '');
      if (marker) return 'bulk';
    }
    // 4. role or automated mailbox
    if (p.email && (AUTOMATED_LOCAL.test(p.local) || ROLE_LOCAL.test(p.local) || underDomain(p.domain, SYSTEM_MAIL_DOMAINS) || subdomainHit(p.domain, SYSTEM_SUBDOMAIN))) return 'system';
  }
  // 5. a flag we could not explain
  if (input.isBotFlag) return 'bot';
  return 'human';
}

/** The store's is_bot and the collector's isSystem, from the one answer. */
export const isMachine = (c: SenderClass): boolean => c !== 'human';
