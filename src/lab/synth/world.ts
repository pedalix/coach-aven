// The bench-agency world as typed data: who exists and how each person is spelled in which raw field,
// which initiatives, channels, repos, hosts and apps exist, and what the GIVEN tenant knows about them.
// plan.ts turns this into a month of traffic; nothing here is random. Everything is fictional: invented
// people, *.example domains, no real company names.
//
// The window is 4 weeks (Mon 2026-09-07 → Sun 2026-10-04, Europe/Zurich, CEST throughout). Week numbers in
// comments are window weeks: W1 = 09-07…09-13, W2 = 09-14…, W3 = 09-21…, W4 = 09-28….

import type { Asset, BotSender, Channel, Company, Expected, FormKind, Lang, Person, Persona, Repo, Side, SurfaceForm, World, WorldInitiative } from './types.js';
import { SYNTH_VERSION } from './types.js';

export const SINCE = '2026-09-07';
export const UNTIL = '2026-10-04';
export const TZ = 'Europe/Zurich';
export const NOW = '2026-10-04T18:00:00.000Z'; // the loader's fixed clock (window end)
export const REBRAND_DAY = '2026-09-16'; // Velo Nord: velonord.example → velo-nord.example, Connect labels change
export const RENAME_DAY = '2026-09-23'; // Kieselfeder: initiative alias, channel, YouTrack key KT → KH, repo
export const RENAME_AT = '2026-09-23T07:30:00.000Z';
export const SUBJECT = 'mara-keller';

export const ACCOUNTS: World['accounts'] = {
  slackTeam: 'T0BENCH0001',
  slackUrl: 'https://brightwell-digital.slack.example/',
  selfSlackId: 'U0BWMARA001',
  work: 'mara.keller@brightwell.example',
  personal: 'mara.keller@mailbox.example',
  granola: 'mara.keller@brightwell.example',
  wispr: 'mara.keller@brightwell.example',
  youtrack: 'brightwell.youtrack.example',
  jira: 'medtrack.atlassian.example',
  host: 'mara-mbp',
};

// --- companies -----------------------------------------------------------------------------------

export const COMPANIES: Company[] = [
  { id: 'brightwell', name: 'Brightwell Digital', umbrella: 'brightwell', domains: ['brightwell.example'], side: 'us' },
  { id: 'alpenhof', name: 'Alpenhof Hotels', umbrella: 'alpenhof', domains: ['alpenhof-hotels.example'], side: 'client' },
  { id: 'velonord', name: 'Velo Nord', umbrella: 'velonord', domains: ['velonord.example', 'velo-nord.example'], side: 'client' },
  { id: 'swl', name: 'Stadtwerke Lindquell', umbrella: 'swl', domains: ['stadtwerke-lindquell.example'], side: 'client' },
  { id: 'medtrack', name: 'MedTrack', umbrella: 'medtrack', domains: ['medtrack.example'], side: 'client' },
  { id: 'klartext', name: 'Kieselfeder Verlag', umbrella: 'klartext', domains: ['kieselfeder-verlag.example'], side: 'client' },
  { id: 'treuhand', name: 'Treuhand Schmid', umbrella: null, domains: ['treuhand-schmid.example'], side: 'vendor' },
  { id: 'nordhost', name: 'Nordhost', umbrella: null, domains: ['nordhost.example'], side: 'vendor' },
  { id: 'kuehne', name: 'Kühne Versicherungen', umbrella: null, domains: ['kuehne-vers.example'], side: 'vendor' },
  { id: 'zermatt', name: 'Zermatt Alpine Resorts', umbrella: null, domains: ['zermatt-resorts.example'], side: 'prospect' },
  { id: 'freelance', name: 'Rossi Mobile (freelance)', umbrella: null, domains: ['rossi-mobile.example'], side: 'freelance' },
  { id: 'albergo-riva', name: 'Albergo Riva (Booker pilot hotel, Lakora)', umbrella: null, domains: ['albergo-riva.example'], side: 'client' },
  { id: 'candidates', name: 'Candidates', umbrella: null, domains: ['mailbox.example'], side: 'candidate' },
  { id: 'personal', name: 'Private contacts', umbrella: 'personal', domains: ['mailbox.example', 'zahnarzt-frei.example', 'zimmermann-immo.example'], side: 'personal' },
];

// --- initiatives (truth) -------------------------------------------------------------------------

const ini = (id: string, company: string, name: string, billing_code: string, extra: Partial<WorldInitiative> = {}): WorldInitiative => ({
  id,
  umbrella: id.startsWith('unregistered:') ? (extra.umbrella ?? company) : id.split('/')[0]!,
  company,
  name,
  status: 'active',
  billing_code,
  registered: !id.startsWith('unregistered:'),
  ...extra,
});

export const INITIATIVES: WorldInitiative[] = [
  ini('alpenhof/relaunch', 'alpenhof', 'Website relaunch (fixed price, go-live W3→W4)', 'ALP-RL'),
  ini('alpenhof/retainer', 'alpenhof', 'Hosting & support retainer (30 h/month)', 'ALP-RT'),
  ini('alpenhof/admin', 'alpenhof', 'Alpenhof admin (invoices, POs)', 'ALP-ADM', { admin: true }),
  ini('velonord/shop', 'velonord', 'Online shop', 'VN-SHOP'),
  ini('velonord/erp-sync', 'velonord', 'ERP stock-sync bridge', 'VN-ERP'),
  ini('velonord/admin', 'velonord', 'Velo Nord admin', 'VN-ADM', { admin: true }),
  ini('swl/portal', 'swl', 'Customer portal (60 h/month + SLA)', 'SWL-P'),
  ini('swl/admin', 'swl', 'SWL admin (SLA, POs, contract)', 'SWL-ADM', { admin: true }),
  ini('medtrack/app', 'medtrack', 'Patient app iOS/Android (T&M, half-days)', 'MT-APP'),
  ini('medtrack/admin', 'medtrack', 'MedTrack admin', 'MT-ADM', { admin: true }),
  ini('klartext/content-hub', 'klartext', 'Content hub (formerly CMS migration)', 'KT-HUB'),
  ini('klartext/admin', 'klartext', 'Kieselfeder admin', 'KT-ADM', { admin: true }),
  ini('brightwell/booker', 'brightwell', 'Booker — own booking SaaS (Alpenhof is the pilot)', 'BW-BKR'),
  ini('brightwell/booker-support', 'brightwell', 'Booker customer support', 'BW-SUP'),
  ini('brightwell/infra', 'brightwell', 'Internal infrastructure', 'BW-INF'),
  ini('brightwell/sales', 'brightwell', 'Sales & pitches', 'BW-SAL'),
  ini('brightwell/hiring', 'brightwell', 'Hiring', 'BW-HIR'),
  ini('brightwell/admin', 'brightwell', 'Agency admin (payroll, VAT, insurance, rent)', 'BW-ADM', { admin: true }),
  ini('personal/personal', 'personal', 'Private life of the subject', 'PRIVATE', { personal: true }),
  // Truth-only topics — absent from the GIVEN registry by design.
  ini('unregistered:zermatt-pitch', 'zermatt', 'Pitch for Zermatt Alpine Resorts', '', { umbrella: 'brightwell' }),
  ini('unregistered:velonord-b2b-portal', 'velonord', 'Velo Nord dealer (B2B) portal', '', { umbrella: 'velonord' }),
  ini('unregistered:hosting-migration', 'brightwell', 'Move of all hosting to Nordhost', '', { umbrella: 'brightwell' }),
];

/** Registry id → admin bucket of its umbrella. */
export const ADMIN_OF: Record<string, string> = {
  alpenhof: 'alpenhof/admin',
  velonord: 'velonord/admin',
  swl: 'swl/admin',
  medtrack: 'medtrack/admin',
  klartext: 'klartext/admin',
  brightwell: 'brightwell/admin',
};

// --- people ---------------------------------------------------------------------------------------

// A surface form as data: [raw, form kind, listed in the GIVEN people.json?, where it occurs, extra].
// `where` tags: slack (author/participant label) · mail (work mailbox address) · pmail (personal mailbox) ·
// cal (calendar attendee/organizer) · granola (attendee e-mail) · gmeet (an "Invited" chip) · wispr (attendee
// name) · yt (YouTrack reporter/assignee/comment author) · jira.
type F = [string, FormKind, 0 | 1, string, { from?: string; until?: string; w?: number; ambiguous?: string[] }?];

/** How often a form is used among the forms valid for the same where-tag (default 1). Key: `${person}|${raw}|${form}`. */
export const FORM_WEIGHT: Record<string, number> = {};

function expectedOf(form: FormKind, given: boolean, personGiven: boolean): Expected {
  if (given) return 'mapped';
  if (!personGiven) return 'question'; // a new person: someone must say who this is
  // An address or a full name that differs from a known identity only by spelling conventions is a safe merge.
  if (['email', 'alias_email', 'full_name', 'umlaut_variant', 'order_swapped', 'slack_label'].includes(form)) return 'merge';
  return 'question'; // nicknames, first names, typos, transliterations, logins, opaque ids, role mailboxes
}

interface PersonIn {
  id: string;
  name: string;
  company: string;
  side: Side;
  role: string;
  langs: Lang[];
  persona: Persona;
  email: string | null;
  slack?: Person['slack'];
  marker?: Person['marker'];
  given: boolean;
}

function person(p: PersonIn, forms: F[]): Person {
  const out: SurfaceForm[] = forms.map(([raw, form, given, where, x]) => {
    if (x?.w !== undefined) FORM_WEIGHT[`${p.id}|${raw}|${form}`] = x.w;
    return {
      raw,
      form,
      given: given === 1,
      expected: expectedOf(form, given === 1, p.given),
      ...(x?.from ? { from: x.from } : {}),
      ...(x?.until ? { until: x.until } : {}),
      where: where.split(' '),
      ...(x?.ambiguous ? { ambiguous: x.ambiguous } : {}),
    };
  });
  return { id: p.id, name: p.name, company: p.company, side: p.side, role: p.role, langs: p.langs, persona: p.persona, email: p.email, ...(p.slack ? { slack: p.slack } : {}), forms: out, given: p.given, marker: p.marker ?? null };
}

const RB = { until: '2026-09-15' }; // before the Velo Nord rebrand
const AB = { from: REBRAND_DAY }; // after it
const sl = (id: string, handle: string, label: string, extra: Partial<NonNullable<Person['slack']>> = {}) => ({ id, handle, label, inDirectory: true, ...extra });

export const PEOPLE: Person[] = [
  // ── Brightwell Digital (the agency, 14 staff) ───────────────────────────────────────────────
  person(
    { id: 'mara-keller', name: 'Mara Keller', company: 'brightwell', side: 'us', role: 'co-founder and CTO; the subject (owner of this tenant)', langs: ['de', 'en', 'ru'],
      persona: { register: 'neutral', typoRate: 0.04, emoji: 'rare', greeting: 'Hi', signature: 'Mara Keller\nCTO · Brightwell Digital\nbrightwell.example', notes: 'precise, short paragraphs; grew up bilingual DE/RU' },
      email: 'mara.keller@brightwell.example', slack: sl('U0BWMARA001', 'mara', 'Mara Keller'), given: true },
    [
      ['mara.keller@brightwell.example', 'email', 1, 'mail cal granola yt jira'],
      ['m.keller@brightwell.example', 'alias_email', 0, 'mail', { w: 0.15 }],
      ['mara.keller@mailbox.example', 'email', 1, 'pmail'],
      ['Mara Keller', 'slack_label', 1, 'slack'],
      ['Mara Keller', 'full_name', 1, 'gmeet wispr'],
      ['youtrack:mkeller', 'login', 0, 'yt', { w: 0.2 }],
    ],
  ),
  person(
    { id: 'jonas-brandt', name: 'Jonas Brandt', company: 'brightwell', side: 'us', role: 'co-founder and CEO, runs sales', langs: ['de', 'en', 'fr'],
      persona: { register: 'casual', typoRate: 0.1, emoji: 'often', greeting: 'Hoi', swiss: true, signature: 'Jonas\n—\nJonas Brandt · CEO · Brightwell Digital', notes: 'fast, many topics in one message, Swiss German flavour' },
      email: 'jonas.brandt@brightwell.example', slack: sl('U0BWJONA001', 'jonas', 'Jonas Brandt'), marker: { type: 'broad', initiatives: ['brightwell/sales'] }, given: true },
    [
      ['jonas.brandt@brightwell.example', 'email', 1, 'mail cal granola'],
      ['jonas@brightwell.example', 'alias_email', 0, 'mail', { w: 0.3 }],
      ['Jonas Brandt', 'slack_label', 1, 'slack'],
      ['JB', 'nickname', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'lea-vogt', name: 'Lea Vogt', company: 'brightwell', side: 'us', role: 'project manager for Alpenhof and Booker', langs: ['de', 'en'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'rare', greeting: 'Hallo', signature: 'Lea Vogt\nProject Manager · Brightwell Digital', notes: 'structured, numbered lists, always gives dates' },
      email: 'lea.vogt@brightwell.example', slack: sl('U0BWLEAV001', 'lea', 'Lea Vogt'), marker: { type: 'narrow', initiatives: ['alpenhof/relaunch', 'alpenhof/retainer', 'brightwell/booker'] }, given: true },
    [
      ['lea.vogt@brightwell.example', 'email', 1, 'mail cal granola yt'],
      ['Lea Vogt', 'slack_label', 1, 'slack'],
      ['Lea Vogt', 'full_name', 1, 'gmeet wispr'],
    ],
  ),
  person(
    { id: 'tobias-hofer', name: 'Tobias Hofer', company: 'brightwell', side: 'us', role: 'project manager for Stadtwerke Lindquell and Kieselfeder', langs: ['de', 'en', 'it'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', greeting: 'Guten Tag', swiss: true, signature: 'Freundliche Grüsse\nTobias Hofer\nProjektleiter · Brightwell Digital', notes: 'formal with clients, references ticket keys' },
      email: 'tobias.hofer@brightwell.example', slack: sl('U0BWTOBI001', 'tobias', 'Tobias Hofer'), marker: { type: 'narrow', initiatives: ['swl/portal', 'klartext/content-hub'] }, given: true },
    [
      ['tobias.hofer@brightwell.example', 'email', 1, 'mail cal granola yt'],
      ['Tobias Hofer', 'slack_label', 1, 'slack'],
      ['Tobias Hofer', 'full_name', 1, 'gmeet'],
      ['Tobais Hofer', 'typo', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'dmitry-sokolov', name: 'Dmitry Sokolov', company: 'brightwell', side: 'us', role: 'backend developer (Booker, MedTrack API, SWL portal)', langs: ['ru', 'en'],
      persona: { register: 'terse', typoRate: 0.12, emoji: 'none', translit: 0.3, notes: 'terse, lowercase, code in backticks' },
      email: 'dmitry.sokolov@brightwell.example', slack: sl('U0BWDIMA001', 'dima', 'Dmitry Sokolov'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['dmitry.sokolov@brightwell.example', 'email', 1, 'mail cal granola jira'],
      ['Dmitry Sokolov', 'slack_label', 1, 'slack'],
      ['youtrack:dsokolov', 'login', 0, 'yt'],
      ['Дмитрий Соколов', 'transliteration', 0, 'gmeet'],
      ['Dmitrii Sokolov', 'transliteration', 0, 'wispr'],
      ['Dima S.', 'nickname', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'olga-ivanova', name: 'Olga Ivanova', company: 'brightwell', side: 'us', role: 'frontend developer (Kieselfeder, MedTrack web)', langs: ['ru', 'en', 'de'],
      persona: { register: 'casual', typoRate: 0.06, emoji: 'often', translit: 0.2, notes: 'friendly, emoji, switches to German with clients' },
      email: 'olga.ivanova@brightwell.example', slack: sl('U0BWOLGA001', 'olga', 'Olga Ivanova'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['olga.ivanova@brightwell.example', 'email', 1, 'mail cal granola yt'],
      ['Olga Ivanova', 'slack_label', 1, 'slack'],
      ['Ольга Иванова', 'transliteration', 0, 'gmeet'],
      ['Olga I.', 'nickname', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'aleksandr-petrov', name: 'Aleksandr Petrov', company: 'brightwell', side: 'us', role: 'devops; runs hosting, CI and the Nordhost move', langs: ['ru', 'en'],
      persona: { register: 'terse', typoRate: 0.08, emoji: 'rare', translit: 0.25, notes: 'short status lines, numbers and hostnames' },
      email: 'aleksandr.petrov@brightwell.example', slack: sl('U0BWSASH001', 'sasha', 'Aleksandr Petrov'), marker: { type: 'broad', initiatives: ['brightwell/infra'] }, given: true },
    [
      ['aleksandr.petrov@brightwell.example', 'email', 1, 'mail cal granola yt'],
      ['a.petrov@brightwell.example', 'alias_email', 0, 'mail cal', { w: 0.4 }],
      ['Aleksandr Petrov', 'slack_label', 1, 'slack'],
      ['Sasha', 'nickname', 0, 'wispr'],
      ['Alexander Petrov', 'transliteration', 0, 'gmeet wispr'],
    ],
  ),
  person(
    { id: 'nina-brunner', name: 'Nina Brunner', company: 'brightwell', side: 'us', role: 'UI/UX designer', langs: ['de', 'en'],
      persona: { register: 'casual', typoRate: 0.04, emoji: 'often', swiss: true, notes: 'visual, links Figma-like boards (no brand names)' },
      email: 'nina.brunner@brightwell.example', slack: sl('U0BWNINA001', 'nina', 'Nina Brunner'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['nina.brunner@brightwell.example', 'email', 1, 'mail cal granola'],
      ['Nina Brunner', 'slack_label', 1, 'slack'],
      ['Nina Brunner', 'full_name', 1, 'wispr'],
    ],
  ),
  person(
    { id: 'sebastian-kraus', name: 'Sebastian Kraus', company: 'brightwell', side: 'us', role: 'support lead for Booker hotels', langs: ['de', 'en', 'it'],
      persona: { register: 'neutral', typoRate: 0.05, emoji: 'rare', notes: 'polite, quotes the hotel verbatim' },
      email: 'sebastian.kraus@brightwell.example', slack: sl('U0BWSEBA001', 'sebastian', 'Sebastian Kraus'), marker: { type: 'broad', initiatives: ['brightwell/booker-support'] }, given: true },
    [
      ['sebastian.kraus@brightwell.example', 'email', 1, 'mail cal yt'],
      ['support@brightwell.example', 'role_mailbox', 0, 'mail'],
      ['Sebastian Kraus', 'slack_label', 1, 'slack'],
      ['Sebastain Kraus', 'typo', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'hanna-lindqvist', name: 'Hanna Lindqvist', company: 'brightwell', side: 'us', role: 'QA engineer', langs: ['en', 'de'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'rare', notes: 'reproduction steps, device names' },
      email: 'hanna.lindqvist@brightwell.example', slack: sl('U0BWHANN001', 'hanna', 'Hanna Lindqvist'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['hanna.lindqvist@brightwell.example', 'email', 1, 'mail cal granola jira'],
      ['Hanna Lindqvist', 'slack_label', 1, 'slack'],
    ],
  ),
  person(
    { id: 'felix-wagner', name: 'Felix Wagner', company: 'brightwell', side: 'us', role: 'full-stack developer, Velo Nord lead dev', langs: ['de', 'en'],
      persona: { register: 'casual', typoRate: 0.07, emoji: 'rare', notes: 'pragmatic, proposes quick fixes' },
      email: 'felix.wagner@brightwell.example', slack: sl('U0BWFELI001', 'felix', 'Felix Wagner'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['felix.wagner@brightwell.example', 'email', 1, 'mail cal granola'],
      ['youtrack:fwagner', 'login', 0, 'yt'],
      ['Felix Wagner', 'slack_label', 1, 'slack'],
    ],
  ),
  person(
    { id: 'chiara-romano', name: 'Chiara Romano', company: 'brightwell', side: 'us', role: 'developer on the Booker widget', langs: ['it', 'en', 'de'],
      persona: { register: 'neutral', typoRate: 0.06, emoji: 'rare', notes: 'writes English with Italian phrases now and then' },
      email: 'chiara.romano@brightwell.example', slack: sl('U0BWCHIA001', 'chiara', 'Chiara Romano'), marker: { type: 'broad', initiatives: [] }, given: true },
    [
      ['chiara.romano@brightwell.example', 'email', 1, 'mail cal granola yt'],
      ['Chiara Romano', 'slack_label', 1, 'slack'],
    ],
  ),
  person(
    { id: 'ivo-meier', name: 'Ivo Meier', company: 'brightwell', side: 'us', role: 'apprentice developer, started in W1 (not yet in the tenant people file)', langs: ['de'],
      persona: { register: 'casual', typoRate: 0.12, emoji: 'often', swiss: true, notes: 'new, asks many small questions' },
      email: 'ivo.meier@brightwell.example', slack: sl('U0BWIVOM001', 'ivo', 'Ivo Meier'), given: false },
    [
      ['ivo.meier@brightwell.example', 'email', 0, 'mail cal'],
      ['Ivo Meier', 'slack_label', 0, 'slack'],
    ],
  ),
  person(
    { id: 'sophie-laurent', name: 'Sophie Laurent', company: 'brightwell', side: 'us', role: 'office and finance assistant', langs: ['fr', 'de', 'en'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', signature: 'Sophie Laurent\nOffice & Finance · Brightwell Digital', notes: 'French native, formal German' },
      email: 'sophie.laurent@brightwell.example', slack: sl('U0BWSOPH001', 'sophie', 'Sophie Laurent'), marker: { type: 'broad', initiatives: ['brightwell/admin'] }, given: true },
    [
      ['sophie.laurent@brightwell.example', 'email', 1, 'mail cal'],
      ['office@brightwell.example', 'role_mailbox', 0, 'mail'],
      ['Sophie Laurent', 'slack_label', 1, 'slack'],
    ],
  ),
  // ── freelance + vendor on our side ─────────────────────────────────────────────────────────
  person(
    { id: 'marco-rossi', name: 'Marco Rossi', company: 'freelance', side: 'freelance', role: 'freelance iOS developer on MedTrack (Slack Connect guest)', langs: ['en', 'it'],
      persona: { register: 'casual', typoRate: 0.08, emoji: 'often', notes: 'English with Italian sign-offs ("ciao", "a dopo")' },
      email: 'marco@rossi-mobile.example', slack: sl('U0BWMRSGST1', 'marco.rossi', 'Marco Rossi', { guest: true, inDirectory: false }), marker: { type: 'broad', initiatives: ['medtrack/app'] }, given: true },
    [
      ['marco@rossi-mobile.example', 'email', 1, 'mail cal granola jira'],
      ['Marco Rossi', 'slack_label', 1, 'slack', { w: 0.7 }],
      ['U0BWMRSGST1', 'opaque_id', 0, 'slack', { w: 0.3 }],
    ],
  ),
  person(
    { id: 'petra-schmid', name: 'Petra Schmid', company: 'treuhand', side: 'vendor', role: 'external bookkeeper (Treuhand Schmid)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.01, emoji: 'none', swiss: true, signature: 'Freundliche Grüsse\nPetra Schmid\nTreuhand Schmid', notes: 'admin mail only: VAT, payroll, accounts' },
      email: 'petra.schmid@treuhand-schmid.example', marker: { type: 'exclusive', initiatives: ['brightwell/admin'] }, given: true },
    [['petra.schmid@treuhand-schmid.example', 'email', 1, 'mail']],
  ),
  // ── Alpenhof Hotels ───────────────────────────────────────────────────────────────────────
  person(
    { id: 'juerg-mueller', name: 'Jürg Müller', company: 'alpenhof', side: 'client', role: 'IT lead at Alpenhof Hotels (servers, DNS, mail)', langs: ['de'],
      persona: { register: 'neutral', typoRate: 0.05, emoji: 'none', greeting: 'Grüezi', swiss: true, signature: 'Gruss\nJürg Müller\nLeiter IT · Alpenhof Hotels', notes: 'technical, short, Swiss spelling' },
      email: 'juerg.mueller@alpenhof-hotels.example', slack: sl('U0BWJUER001', 'juerg.mueller', 'Jürg Müller | Alpenhof'), marker: { type: 'exclusive', initiatives: ['alpenhof/retainer'] }, given: true },
    [
      ['juerg.mueller@alpenhof-hotels.example', 'email', 1, 'mail cal granola'],
      ['Jürg Müller | Alpenhof', 'slack_label', 1, 'slack'],
      ['Juerg Mueller', 'umlaut_variant', 0, 'gmeet'],
      // A directory-imported YouTrack user without a visible e-mail or login: the tracker gives "Last, First".
      ['Müller, Jürg', 'order_swapped', 0, 'gmeet yt'],
    ],
  ),
  person(
    { id: 'claudia-steiner', name: 'Claudia Steiner', company: 'alpenhof', side: 'client', role: 'head of marketing at Alpenhof Hotels; owns the relaunch', langs: ['de', 'en'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'rare', greeting: 'Liebe Mara', swiss: true, signature: 'Herzliche Grüsse\nClaudia Steiner\nLeiterin Marketing · Alpenhof Hotels', notes: 'friendly but pushes on dates' },
      email: 'claudia.steiner@alpenhof-hotels.example', slack: sl('U0BWCLAU001', 'claudia.steiner', 'Claudia Steiner | Alpenhof'), marker: { type: 'narrow', initiatives: ['alpenhof/relaunch', 'alpenhof/retainer'] }, given: true },
    [
      ['claudia.steiner@alpenhof-hotels.example', 'email', 1, 'mail cal granola'],
      ['Claudia Steiner | Alpenhof', 'slack_label', 1, 'slack'],
      ['Claudia Steiner', 'full_name', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'remo-gerber', name: 'Remo Gerber', company: 'alpenhof', side: 'client', role: 'CFO at Alpenhof Hotels (invoices, purchase orders)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.01, emoji: 'none', swiss: true, signature: 'Freundliche Grüsse\nReto Gerber\nCFO · Alpenhof Hotels', notes: 'formal, numbers' },
      email: 'remo.gerber@alpenhof-hotels.example', marker: { type: 'broad', initiatives: ['alpenhof/admin'] }, given: true },
    [['remo.gerber@alpenhof-hotels.example', 'email', 1, 'mail cal']],
  ),
  // ── Velo Nord (domain rebrand in W2) ─────────────────────────────────────────────────────────
  person(
    { id: 'kai-lund', name: 'Kai Lund', company: 'velonord', side: 'client', role: 'e-commerce manager at Velo Nord', langs: ['en', 'de'],
      persona: { register: 'casual', typoRate: 0.05, emoji: 'rare', greeting: 'Hi Mara', signature: 'Kai Lund\nE-Commerce · Velo Nord', notes: 'Danish, writes English' },
      email: 'kai.lund@velonord.example', slack: sl('U0BWKAIL001', 'kai.lund', 'Kai Lund | VELO-NORD'), marker: { type: 'narrow', initiatives: ['velonord/shop', 'velonord/erp-sync'] }, given: true },
    [
      ['kai.lund@velonord.example', 'email', 1, 'mail cal granola', RB],
      ['kai.lund@velo-nord.example', 'alias_email', 0, 'mail cal granola', AB],
      ['Kai Lund | Velo Nord', 'slack_label', 1, 'slack', RB],
      ['Kai Lund | VELO-NORD', 'slack_label', 0, 'slack', AB],
    ],
  ),
  person(
    { id: 'mette-hansen', name: 'Mette Hansen', company: 'velonord', side: 'client', role: 'operations and ERP at Velo Nord', langs: ['en'],
      persona: { register: 'neutral', typoRate: 0.04, emoji: 'none', signature: 'Mette Hansen\nOperations · Velo Nord', notes: 'factual, numbers of articles affected' },
      email: 'mette.hansen@velonord.example', slack: sl('U0BWMETT001', 'mette.hansen', 'Mette Hansen | VELO-NORD'), marker: { type: 'exclusive', initiatives: ['velonord/erp-sync'] }, given: true },
    [
      ['mette.hansen@velonord.example', 'email', 1, 'mail cal granola', RB],
      ['mette.hansen@velo-nord.example', 'alias_email', 0, 'mail cal granola', AB],
      ['Mette Hansen | Velo Nord', 'slack_label', 1, 'slack', RB],
      ['Mette Hansen | VELO-NORD', 'slack_label', 0, 'slack', AB],
      ['Mette Hansen', 'full_name', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'jan-peters', name: 'Jan Peters', company: 'velonord', side: 'client', role: 'managing director at Velo Nord; wants a dealer portal', langs: ['de', 'en'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', signature: 'Jan Peters\nGeschäftsführer · Velo Nord', notes: 'big-picture, budget questions' },
      email: 'jan.peters@velo-nord.example', given: false },
    [['jan.peters@velo-nord.example', 'email', 0, 'mail cal granola', AB]],
  ),
  // ── Stadtwerke Lindquell ────────────────────────────────────────────────────────────────────
  person(
    { id: 'marco-bernasconi', name: 'Marco Bernasconi', company: 'swl', side: 'client', role: 'head of IT at Stadtwerke Lindquell (the second "Marco")', langs: ['de', 'it'],
      persona: { register: 'neutral', typoRate: 0.04, emoji: 'none', signature: 'Marco Bernasconi\nLeiter IT · Stadtwerke Lindquell', notes: 'Lakora-born, German with occasional Italian' },
      email: 'marco.bernasconi@stadtwerke-lindquell.example', slack: sl('U0BWMBER001', 'marco.bernasconi', 'Marco Bernasconi | SWL'), marker: { type: 'narrow', initiatives: ['swl/portal'] }, given: true },
    [
      ['marco.bernasconi@stadtwerke-lindquell.example', 'email', 1, 'mail cal granola'],
      ['Marco Bernasconi | SWL', 'slack_label', 1, 'slack'],
      ['youtrack:mbernasconi@SWL', 'login_org_suffix', 0, 'yt'],
      ['Marco', 'first_name', 0, 'wispr', { ambiguous: ['marco-bernasconi', 'marco-rossi'] }],
    ],
  ),
  person(
    { id: 'andrea-fischer', name: 'Andrea Fischer', company: 'swl', side: 'client', role: 'procurement at Stadtwerke Lindquell (SLA penalty, purchase orders)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.01, emoji: 'none', signature: 'Freundliche Grüsse\nAndrea Fischer\nEinkauf · Stadtwerke Lindquell', notes: 'contract language, clause numbers' },
      email: 'andrea.fischer@stadtwerke-lindquell.example', given: false },
    [
      ['andrea.fischer@stadtwerke-lindquell.example', 'email', 0, 'mail cal'],
      ['einkauf@stadtwerke-lindquell.example', 'role_mailbox', 0, 'mail', { w: 0.5 }],
    ],
  ),
  person(
    { id: 'tobin-berger', name: 'Tobin Berger', company: 'swl', side: 'client', role: 'customer-service lead at Stadtwerke Lindquell; reports portal issues', langs: ['de'],
      persona: { register: 'neutral', typoRate: 0.06, emoji: 'none', notes: 'relays what customers report' },
      email: 'tobin.berger@stadtwerke-lindquell.example', slack: sl('U0BWTBER001', 'tobin.berger', 'Tobin Berger | SWL'), marker: { type: 'broad', initiatives: ['swl/portal'] }, given: true },
    [
      ['tobin.berger@stadtwerke-lindquell.example', 'email', 1, 'mail cal granola'],
      ['Tobin Berger | SWL', 'slack_label', 1, 'slack'],
      ['youtrack:tberger@SWL', 'login_org_suffix', 0, 'yt'],
      ['Tobin Berger', 'full_name', 0, 'wispr'],
    ],
  ),
  // ── MedTrack (client-owned Jira) ────────────────────────────────────────────────────────────
  person(
    { id: 'yulia-kuznetsova', name: 'Yulia Kuznetsova', company: 'medtrack', side: 'client', role: 'product owner of the MedTrack app', langs: ['en', 'ru', 'de'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'rare', signature: 'Yulia Kuznetsova\nProduct Owner · MedTrack', notes: 'sprint language, priorities' },
      email: 'yulia.kuznetsova@medtrack.example', slack: sl('U0BWYULI001', 'yulia.k', 'Yulia Kuznetsova | MedTrack'), marker: { type: 'narrow', initiatives: ['medtrack/app'] }, given: true },
    [
      ['yulia.kuznetsova@medtrack.example', 'email', 1, 'mail cal granola jira'],
      ['Yulia Kuznetsova | MedTrack', 'slack_label', 1, 'slack'],
      ['Юлия Кузнецова', 'transliteration', 0, 'gmeet'],
      ['Iuliia Kuznetsova', 'transliteration', 0, 'gmeet'],
      ['Julia Kusnezowa', 'transliteration', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'daniel-weber', name: 'Daniel Weber', company: 'medtrack', side: 'client', role: 'CTO of MedTrack', langs: ['de', 'en'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'none', notes: 'technical, asks about root causes' },
      email: 'daniel.weber@medtrack.example', slack: sl('U0BWDWEB001', 'daniel.weber', 'Daniel Weber | MedTrack'), marker: { type: 'narrow', initiatives: ['medtrack/app'] }, given: true },
    [
      ['daniel.weber@medtrack.example', 'email', 1, 'mail cal granola jira'],
      ['Daniel Weber | MedTrack', 'slack_label', 1, 'slack'],
      ['Daniel Weber', 'full_name', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'priya-nair', name: 'Priya Nair', company: 'medtrack', side: 'client', role: 'Android developer and QA at MedTrack', langs: ['en'],
      persona: { register: 'neutral', typoRate: 0.04, emoji: 'rare', notes: 'logs, device models, Android versions' },
      email: 'priya.nair@medtrack.example', given: false },
    [
      ['priya.nair@medtrack.example', 'email', 0, 'mail cal'],
      ['jira:712020:5c3d9a7e-8b1f-4e2a-9c6d-2f4b8e1a7c3d', 'login', 0, 'jira'],
    ],
  ),
  // ── Kieselfeder Verlag (rename in W3) ───────────────────────────────────────────────────────
  person(
    { id: 'paul-keller', name: 'Paul Keller', company: 'klartext', side: 'client', role: 'editor-in-chief at Kieselfeder Verlag; owns the content hub (surname collision with Mara)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', signature: 'Mit freundlichen Grüssen\nPaul Keller\nChefredaktor · Kieselfeder Verlag', notes: 'editorial vocabulary' },
      email: 'paul.keller@kieselfeder-verlag.example', slack: sl('U0BWPKEL001', 'paul.keller', 'Paul Keller | Kieselfeder'), marker: { type: 'narrow', initiatives: ['klartext/content-hub'] }, given: true },
    [
      ['paul.keller@kieselfeder-verlag.example', 'email', 1, 'mail cal granola'],
      ['Paul Keller | Kieselfeder', 'slack_label', 1, 'slack'],
      ['Paul Keller', 'full_name', 0, 'gmeet'],
    ],
  ),
  person(
    { id: 'ines-wolf', name: 'Ines Wolf', company: 'klartext', side: 'client', role: 'content manager at Kieselfeder Verlag', langs: ['de'],
      persona: { register: 'neutral', typoRate: 0.04, emoji: 'rare', notes: 'lists of articles, editorial workflow' },
      email: 'ines.wolf@kieselfeder-verlag.example', slack: sl('U0BWINES001', 'ines.wolf', 'Ines Wolf | Kieselfeder'), marker: { type: 'broad', initiatives: ['klartext/content-hub'] }, given: true },
    [
      ['ines.wolf@kieselfeder-verlag.example', 'email', 1, 'mail cal granola'],
      ['Ines Wolf | Kieselfeder', 'slack_label', 1, 'slack'],
      ['youtrack:iwolf@KLARTEXT', 'login_org_suffix', 0, 'yt'],
    ],
  ),
  // ── prospect, candidates, vendors, private contacts (none of them in the GIVEN people file) ─────
  person(
    { id: 'giulia-ferri', name: 'Giulia Ferri', company: 'albergo-riva', side: 'client', role: 'front-office manager of a Booker pilot hotel in Lakora; writes to support in Italian', langs: ['it', 'en'],
      persona: { register: 'neutral', typoRate: 0.05, emoji: 'rare', greeting: 'Buongiorno', signature: 'Giulia Ferri\nFront Office · Albergo Riva', notes: 'Italian, polite, concrete booking numbers' },
      email: 'giulia.ferri@albergo-riva.example', given: false },
    [['giulia.ferri@albergo-riva.example', 'email', 0, 'mail yt']],
  ),
  person(
    { id: 'laura-imhof', name: 'Laura Imhof', company: 'zermatt', side: 'prospect', role: 'head of digital at Zermatt Alpine Resorts (pitch lead)', langs: ['de', 'fr', 'en'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', signature: 'Laura Imhof\nHead of Digital · Zermatt Alpine Resorts', notes: 'decisive, asks for references' },
      email: 'laura.imhof@zermatt-resorts.example', given: false },
    [
      ['laura.imhof@zermatt-resorts.example', 'email', 0, 'mail cal'],
      ['Laura Imhof', 'full_name', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'tim-novak', name: 'Tim Novak', company: 'candidates', side: 'candidate', role: 'backend developer candidate', langs: ['en', 'de'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', notes: 'applicant tone' },
      email: 'tim.novak@mailbox.example', given: false },
    [['tim.novak@mailbox.example', 'email', 0, 'mail cal granola']],
  ),
  person(
    { id: 'elena-popescu', name: 'Elena Popescu', company: 'candidates', side: 'candidate', role: 'frontend developer candidate', langs: ['en'],
      persona: { register: 'formal', typoRate: 0.03, emoji: 'none', notes: 'applicant tone' },
      email: 'elena.popescu@mailbox.example', given: false },
    [['elena.popescu@mailbox.example', 'email', 0, 'mail cal granola']],
  ),
  person(
    { id: 'lars-eriksen', name: 'Lars Eriksen', company: 'nordhost', side: 'vendor', role: 'account manager at Nordhost (the new hosting provider)', langs: ['en'],
      persona: { register: 'neutral', typoRate: 0.03, emoji: 'none', signature: 'Lars Eriksen\nAccount Manager · Nordhost', notes: 'sales-y, offers calls' },
      email: 'lars.eriksen@nordhost.example', given: false },
    [
      ['lars.eriksen@nordhost.example', 'email', 0, 'mail cal'],
      ['Lars Eriksen', 'full_name', 0, 'wispr'],
    ],
  ),
  person(
    { id: 'martin-kuehne', name: 'Martin Kühne', company: 'kuehne', side: 'vendor', role: 'insurance broker (agency liability insurance)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.02, emoji: 'none', swiss: true, signature: 'Freundliche Grüsse\nMartin Kühne\nKühne Versicherungen', notes: 'insurance jargon' },
      email: 'martin.kuehne@kuehne-vers.example', given: false },
    [['martin.kuehne@kuehne-vers.example', 'email', 0, 'mail']],
  ),
  person(
    { id: 'anna-frei', name: 'Anna Frei', company: 'personal', side: 'personal', role: "the subject's dentist (practice mailbox)", langs: ['de'],
      persona: { register: 'formal', typoRate: 0.01, emoji: 'none', swiss: true, signature: 'Zahnarztpraxis Dr. A. Frei', notes: 'appointment logistics' },
      email: 'praxis@zahnarzt-frei.example', given: false },
    [['praxis@zahnarzt-frei.example', 'role_mailbox', 0, 'pmail']],
  ),
  person(
    { id: 'stefan-keller', name: 'Stefan Keller', company: 'personal', side: 'personal', role: "the subject's husband", langs: ['de', 'en'],
      persona: { register: 'casual', typoRate: 0.08, emoji: 'often', notes: 'family logistics, short' },
      email: 'stefan.keller@mailbox.example', given: false },
    [['stefan.keller@mailbox.example', 'email', 0, 'pmail cal']],
  ),
  person(
    { id: 'beat-zimmermann', name: 'Beat Zimmermann', company: 'personal', side: 'personal', role: 'real-estate agent (apartment viewing)', langs: ['de'],
      persona: { register: 'formal', typoRate: 0.03, emoji: 'none', swiss: true, signature: 'Beat Zimmermann\nZimmermann Immobilien', notes: 'viewing slots, documents needed' },
      email: 'beat.zimmermann@zimmermann-immo.example', given: false },
    [['beat.zimmermann@zimmermann-immo.example', 'email', 0, 'pmail']],
  ),
];

export const PERSON = new Map(PEOPLE.map((p) => [p.id, p]));
export const personOf = (id: string): Person => {
  const p = PERSON.get(id);
  if (!p) throw new Error(`unknown person ${id}`);
  return p;
};

// --- Slack ------------------------------------------------------------------------------------------

const ch = (id: string, name: string, kind: Channel['kind'], members: string[], initiative: string | null, extra: Partial<Channel> = {}): Channel => ({
  id,
  name,
  kind,
  container: kind === 'dm' || kind === 'mpim' ? name : `#${name}`,
  members,
  initiative,
  ...extra,
});
const STAFF = ['mara-keller', 'jonas-brandt', 'lea-vogt', 'tobias-hofer', 'dmitry-sokolov', 'olga-ivanova', 'aleksandr-petrov', 'nina-brunner', 'sebastian-kraus', 'hanna-lindqvist', 'felix-wagner', 'chiara-romano', 'ivo-meier', 'sophie-laurent'];

export const CHANNELS: Channel[] = [
  ch('C0BENCHGEN1', 'general', 'public', STAFF, null),
  ch('C0BENCHRND1', 'random', 'public', STAFF, null),
  ch('C0BENCHDEV1', 'dev', 'public', ['dmitry-sokolov', 'olga-ivanova', 'aleksandr-petrov', 'felix-wagner', 'chiara-romano', 'ivo-meier', 'hanna-lindqvist', 'mara-keller', 'nina-brunner'], null),
  ch('C0BENCHBKR1', 'booker', 'public', ['lea-vogt', 'chiara-romano', 'dmitry-sokolov', 'sebastian-kraus', 'hanna-lindqvist', 'mara-keller', 'felix-wagner'], 'brightwell/booker'),
  ch('C0BENCHSLS1', 'sales', 'public', ['jonas-brandt', 'mara-keller', 'nina-brunner', 'lea-vogt'], 'brightwell/sales'),
  ch('C0BENCHHIR1', 'hiring', 'private', ['jonas-brandt', 'mara-keller', 'nina-brunner', 'sophie-laurent'], 'brightwell/hiring'),
  ch('C0BENCHOPS1', 'ops-alerts', 'public', [], null),
  ch('C0BENCHDPL1', 'deploys', 'public', [], null),
  ch('C0BENCHALP1', 'ext-alpenhof', 'connect', ['claudia-steiner', 'juerg-mueller', 'lea-vogt', 'mara-keller', 'dmitry-sokolov', 'chiara-romano', 'nina-brunner'], null),
  ch('C0BENCHVNO1', 'ext-velonord', 'connect', ['kai-lund', 'mette-hansen', 'felix-wagner', 'mara-keller', 'aleksandr-petrov'], null),
  ch('C0BENCHSWL1', 'ext-swl', 'connect', ['tobin-berger', 'marco-bernasconi', 'tobias-hofer', 'aleksandr-petrov', 'dmitry-sokolov', 'mara-keller'], 'swl/portal'),
  ch('C0BENCHMED1', 'ext-medtrack', 'connect', ['yulia-kuznetsova', 'daniel-weber', 'marco-rossi', 'dmitry-sokolov', 'olga-ivanova', 'mara-keller', 'hanna-lindqvist'], 'medtrack/app'),
  ch('C0BENCHKLT1', 'ext-klartext-cms', 'connect', ['paul-keller', 'ines-wolf', 'tobias-hofer', 'olga-ivanova', 'felix-wagner', 'mara-keller'], 'klartext/content-hub', {
    renamed: { at: RENAME_AT, name: 'ext-klartext-hub', container: '#ext-klartext-hub' },
  }),
  ch('D0BENCHJON1', 'dm:@jonas', 'dm', ['mara-keller', 'jonas-brandt'], null),
  ch('D0BENCHLEA1', 'dm:@lea', 'dm', ['mara-keller', 'lea-vogt'], null),
  ch('D0BENCHDIM1', 'dm:@dima', 'dm', ['mara-keller', 'dmitry-sokolov'], null),
  ch('D0BENCHSAS1', 'dm:@sasha', 'dm', ['mara-keller', 'aleksandr-petrov'], null),
  // The guest's id is not in the users map → the puller (and the store) can only print the raw id.
  ch('D0BENCHMRS1', 'dm:U0BWMRSGST1', 'dm', ['mara-keller', 'marco-rossi'], 'medtrack/app'),
  ch('G0BENCHMP01', 'mpim:@lea+@tobias', 'mpim', ['mara-keller', 'lea-vogt', 'tobias-hofer'], null),
  ch('G0BENCHMP02', 'mpim:@dima+@olga', 'mpim', ['mara-keller', 'dmitry-sokolov', 'olga-ivanova'], null),
];
export const CHANNEL = new Map(CHANNELS.map((c) => [c.name, c]));

// --- places: repos, hosts, apps ---------------------------------------------------------------------

export const REPOS: Repo[] = [
  { container: 'git.brightwell.example/brightwell/alpenhof-web', initiative: 'alpenhof/relaunch' },
  { container: 'git.brightwell.example/brightwell/velonord-shop', initiative: 'velonord/shop' },
  { container: 'git.brightwell.example/brightwell/velonord-erp-bridge', initiative: 'velonord/erp-sync' },
  { container: 'git.brightwell.example/brightwell/swl-portal', initiative: 'swl/portal' },
  { container: 'git.brightwell.example/brightwell/booker', initiative: 'brightwell/booker' },
  { container: 'git.brightwell.example/brightwell/infra', initiative: 'brightwell/infra' },
  { container: 'git.brightwell.example/brightwell/klartext-cms', initiative: 'klartext/content-hub', renamed: { at: RENAME_AT, container: 'git.brightwell.example/brightwell/klartext-hub' } },
  { container: 'git.brightwell.example/medtrack/app', initiative: 'medtrack/app' },
  { container: 'git.brightwell.example/brightwell/nordhost-migration', initiative: 'unregistered:hosting-migration' },
];

export const ASSETS: Asset[] = [
  { name: 'www.alpenhof-hotels.example', kind: 'host', initiative: 'alpenhof/retainer' },
  { name: 'staging.alpenhof-hotels.example', kind: 'host', initiative: 'alpenhof/relaunch' },
  { name: 'shop.velo-nord.example', kind: 'host', initiative: 'velonord/shop' },
  { name: 'shop.velonord.example', kind: 'host', initiative: 'velonord/shop' }, // the same shop before its domain switch
  { name: 'erp-bridge.brightwell.example', kind: 'host', initiative: 'velonord/erp-sync' },
  { name: 'portal.stadtwerke-lindquell.example', kind: 'host', initiative: 'swl/portal' },
  { name: 'api.medtrack.example', kind: 'host', initiative: 'medtrack/app' },
  { name: 'hub.kieselfeder-verlag.example', kind: 'host', initiative: 'klartext/content-hub' },
  { name: 'booker.brightwell.example', kind: 'host', initiative: 'brightwell/booker' },
  { name: 'widget.brightwell.example', kind: 'host', initiative: 'brightwell/booker' },
  { name: 'ci.brightwell.example', kind: 'host', initiative: 'brightwell/infra' },
  { name: 'vpn.brightwell.example', kind: 'host', initiative: 'brightwell/infra' },
  { name: 'nh-k8s-01.nordhost.example', kind: 'host', initiative: 'unregistered:hosting-migration' },
  { name: 'alpenhof-web', kind: 'app', initiative: 'alpenhof/relaunch' },
  { name: 'velonord-shop', kind: 'app', initiative: 'velonord/shop' },
  { name: 'erp-bridge', kind: 'app', initiative: 'velonord/erp-sync' },
  { name: 'swl-portal', kind: 'app', initiative: 'swl/portal' },
  { name: 'booker-api', kind: 'app', initiative: 'brightwell/booker' },
  { name: 'booker-widget', kind: 'app', initiative: 'brightwell/booker' },
  { name: 'klartext-hub', kind: 'app', initiative: 'klartext/content-hub' },
  { name: 'medtrack-api', kind: 'app', initiative: 'medtrack/app' },
  { name: 'status-page', kind: 'app', initiative: 'brightwell/infra' },
  { name: 'pitch-demo', kind: 'app', initiative: 'unregistered:zermatt-pitch' },
];
export const ASSET = new Map(ASSETS.map((a) => [a.name, a]));

// --- machine senders ----------------------------------------------------------------------------------

export const BOTS: BotSender[] = [
  // Slack integrations
  { id: 'uptime', kind: 'slack_bot', label: 'UptimeRobot', slackBotId: 'B0BENCHUPT1' },
  { id: 'sentry', kind: 'slack_bot', label: 'Sentry', slackBotId: 'B0BENCHSEN1' },
  { id: 'sentry-qa', kind: 'slack_bot', label: 'Sentry Quick Analyzer', slackBotId: 'B0BENCHSQA1' },
  { id: 'github', kind: 'slack_bot', label: 'GitHub', slackBotId: 'B0BENCHGIT1' },
  { id: 'youtrack-bot', kind: 'slack_bot', label: 'YouTrack', slackBotId: 'B0BENCHYTR1' },
  { id: 'deploybot', kind: 'slack_bot', label: 'Deploybot', slackBotId: 'B0BENCHDPL1' },
  { id: 'deploy-hook', kind: 'slack_bot', label: 'B0BENCHHOOK1', slackBotId: 'B0BENCHHOOK1', unflagged: true },
  { id: 'aven', kind: 'slack_bot', label: 'Aven', slackBotId: 'B0BENCHAVN1' },
  // mail: notifications (several escape the bot-mail regexes on purpose: youtrack@, jira@, feedback@)
  { id: 'yt-mail', kind: 'notification', label: 'YouTrack', address: 'youtrack@brightwell.youtrack.example' },
  { id: 'jira-mail', kind: 'notification', label: 'Jira', address: 'jira@medtrack.atlassian.example' },
  { id: 'gh-mail', kind: 'notification', label: 'GitHub', address: 'notifications@github.example' },
  { id: 'docs-mail', kind: 'notification', label: 'Docs', address: 'comments-noreply@docs.workspace.example' },
  { id: 'sentry-mail', kind: 'notification', label: 'Sentry', address: 'noreply@sentry.example' },
  { id: 'uptime-mail', kind: 'notification', label: 'UptimeRobot', address: 'alert@uptimerobot.example' },
  { id: 'slack-mail', kind: 'notification', label: 'Slack', address: 'feedback@slack.example' },
  { id: 'cal-mail', kind: 'notification', label: 'Calendar', address: 'calendar-notification@workspace.example' },
  // newsletters (two overlap client vocabulary: booking widgets, hotel tech)
  { id: 'nl-webweekly', kind: 'newsletter', label: 'Web Weekly', address: 'news@webweekly.example' },
  { id: 'nl-frontend', kind: 'newsletter', label: 'Frontend Focus', address: 'digest@frontend-focus.example' },
  { id: 'nl-saas', kind: 'newsletter', label: 'SaaS Growth Notes', address: 'hello@saas-growth.example' },
  { id: 'nl-hoteltech', kind: 'newsletter', label: 'Hotel Tech Insider', address: 'newsletter@hotel-tech.example' },
  { id: 'nl-bookingtools', kind: 'newsletter', label: 'BookingTools Blog', address: 'team@bookingtools.example' },
  { id: 'nl-swissdigital', kind: 'newsletter', label: 'Swiss Digital', address: 'info@swiss-digital.example' },
  { id: 'nl-devops', kind: 'newsletter', label: 'DevOps Digest', address: 'updates@devops-digest.example' },
  { id: 'nl-cms', kind: 'newsletter', label: 'CMS Insider', address: 'news@cms-insider.example' },
  { id: 'nl-ecom', kind: 'newsletter', label: 'E-Commerce Daily', address: 'newsletter@ecommerce-daily.example' },
  { id: 'nl-ux', kind: 'newsletter', label: 'UX Notes', address: 'news@ux-notes.example' },
  // receipts and statements
  { id: 'rc-cloudhost', kind: 'receipt', label: 'CloudHost Billing', address: 'billing@cloudhost.example' },
  { id: 'rc-design', kind: 'receipt', label: 'DesignBoard', address: 'invoices@designboard.example' },
  { id: 'rc-workspace', kind: 'receipt', label: 'Workspace', address: 'receipts@workspace.example' },
  { id: 'rc-nordhost', kind: 'receipt', label: 'Nordhost Billing', address: 'billing@nordhost.example' },
  { id: 'rc-rail', kind: 'receipt', label: 'Rail Tickets', address: 'no-reply@rail-tickets.example' },
  // digest series
  { id: 'dg-analytics', kind: 'digest', label: 'Site Analytics', address: 'reports@analytics.example' },
  { id: 'dg-booker', kind: 'digest', label: 'Booker KPIs', address: 'kpi@booker.brightwell.example' },
  { id: 'dg-sentry', kind: 'digest', label: 'Sentry', address: 'noreply@sentry.example' },
  { id: 'dg-bank', kind: 'digest', label: 'Bank Zürichsee', address: 'statements@bank-zsee.example' },
  { id: 'dg-timesheet', kind: 'digest', label: 'Timesheets', address: 'reminder@timesheets.example' },
  { id: 'dg-yt', kind: 'digest', label: 'YouTrack', address: 'youtrack@brightwell.youtrack.example' },
  { id: 'dg-uptime', kind: 'digest', label: 'UptimeRobot', address: 'alert@uptimerobot.example' },
  // personal mailbox senders
  { id: 'p-bank', kind: 'notification', label: 'Bank Zürichsee', address: 'notices@bank-zsee.example' },
  { id: 'p-shop', kind: 'receipt', label: 'Bergsport Shop', address: 'orders@bergsport-shop.example' },
  { id: 'p-post', kind: 'notification', label: 'Paketdienst', address: 'versand@paket-post.example' },
  { id: 'p-school', kind: 'notification', label: 'Schule Wolkenhain', address: 'sekretariat@schule-wolkenhain.example' },
  { id: 'p-nl-running', kind: 'newsletter', label: 'Running Club', address: 'news@laufclub-zh.example' },
  { id: 'p-nl-kultur', kind: 'newsletter', label: 'Kulturagenda', address: 'newsletter@kulturagenda.example' },
  // lists (system addresses in participants)
  { id: 'list-team', kind: 'notification', label: 'Team list', address: 'team@brightwell.example' },
];
export const BOT = new Map(BOTS.map((b) => [b.id, b]));

// --- GIVEN registry sources (what the tenant's initiatives.json lists, imperfect on purpose) ----------
// - ALP is listed under relaunch AND retainer → a key alone cannot decide (the 70 % tag decides by content);
// - VN is listed under shop only and #ext-velonord routes to shop → erp-sync / dealer-portal items misroute;
// - Kieselfeder: the content hub still lists the PRE-rename channel; the old key, repo and id live on the alias;
// - erp-sync carries the over-broad title pattern "sync" (fires on "Weekly sync", "Booker sync" …);
// - "Pitch" routes every pitch to sales and "Hosting" every hosting call to infra (the unregistered topics hide there).
export interface GivenSources {
  repos: string[];
  youtrack_prefixes: string[];
  jira_keys: string[];
  slack_channels: string[];
  calendar_title_patterns: string[];
}
const src = (s: Partial<GivenSources>): GivenSources => ({ repos: [], youtrack_prefixes: [], jira_keys: [], slack_channels: [], calendar_title_patterns: [], ...s });

export const GIVEN_SOURCES: Record<string, GivenSources> = {
  'alpenhof/relaunch': src({ repos: ['brightwell/alpenhof-web'], youtrack_prefixes: ['ALP'], slack_channels: ['#ext-alpenhof'], calendar_title_patterns: ['Alpenhof', 'Relaunch', 'Go-Live'] }),
  'alpenhof/retainer': src({ youtrack_prefixes: ['ALP'], slack_channels: ['#ext-alpenhof'], calendar_title_patterns: ['Alpenhof Support'] }),
  'alpenhof/admin': src({}),
  'velonord/shop': src({ repos: ['brightwell/velonord-shop'], youtrack_prefixes: ['VN'], slack_channels: ['#ext-velonord'], calendar_title_patterns: ['Velo Nord'] }),
  'velonord/erp-sync': src({ repos: ['brightwell/velonord-erp-bridge'], calendar_title_patterns: ['ERP', 'sync'] }),
  'velonord/admin': src({}),
  'swl/portal': src({ repos: ['brightwell/swl-portal'], youtrack_prefixes: ['SWL'], slack_channels: ['#ext-swl'], calendar_title_patterns: ['SWL', 'Stadtwerke'] }),
  'swl/admin': src({}),
  'medtrack/app': src({ repos: ['medtrack/app'], jira_keys: ['MT'], slack_channels: ['#ext-medtrack'], calendar_title_patterns: ['MedTrack', 'Sprint Review'] }),
  'medtrack/admin': src({}),
  'klartext/content-hub': src({ repos: ['brightwell/klartext-hub'], youtrack_prefixes: ['KH'], slack_channels: ['#ext-klartext-cms'], calendar_title_patterns: ['Kieselfeder'] }),
  'klartext/cms-migration': src({ repos: ['brightwell/klartext-cms'], youtrack_prefixes: ['KT'], calendar_title_patterns: ['CMS'] }),
  'klartext/admin': src({}),
  'brightwell/booker': src({ repos: ['brightwell/booker'], youtrack_prefixes: ['BKR'], slack_channels: ['#booker'], calendar_title_patterns: ['Booker'] }),
  'brightwell/booker-support': src({}),
  'brightwell/infra': src({ repos: ['brightwell/infra'], youtrack_prefixes: ['OPS'], slack_channels: ['#ops-alerts'], calendar_title_patterns: ['Infra', 'Hosting'] }),
  'brightwell/sales': src({ slack_channels: ['#sales'], calendar_title_patterns: ['Pitch', 'Akquise'] }),
  'brightwell/hiring': src({ slack_channels: ['#hiring'], calendar_title_patterns: ['Interview', 'Bewerbung'] }),
  'brightwell/admin': src({}),
  'personal/personal': src({}),
};

// --- topic banks (what work is about, per initiative) — the background traffic's subjects ----------------

export const TOPICS: Record<string, string[]> = {
  'alpenhof/relaunch': ['the new room overview page', 'the image carousel on the start page', 'the DE/EN language switch', 'the redirect list from the old site', 'the cookie banner texts', 'the restaurant menu upload', 'the go-live checklist', 'the newsletter sign-up form', 'the spa page layout', 'the mobile navigation', 'the content freeze', 'the photo licences for the gallery'],
  'alpenhof/retainer': ['the SSL certificate renewal', 'the monthly backup check', 'a CMS editor account for the front desk', 'the PHP update on the old site', 'the uptime report for August', 'spam through the contact form', 'disk space on the web server', 'the mail forwarding for the reservations address'],
  'velonord/shop': ['the product filter by frame size', 'shipping costs to Norway', 'the gift card feature', 'the product image zoom', 'the shop domain switch', 'the size guide page', 'the discount code for the autumn sale', 'the bike configurator'],
  'velonord/erp-sync': ['the stock sync job', 'the article export from the ERP', 'the nightly price import', 'the sync queue backlog', 'special characters in article names', 'the warehouse mapping table', 'the delta sync interval'],
  'unregistered:velonord-b2b-portal': ['the dealer portal idea', 'dealer price lists', 'the dealer login concept', 'bulk ordering for dealers', 'the dealer portal requirements'],
  'swl/portal': ['the login page', 'the password reset mail', 'the meter reading form', 'the invoice download', 'the session timeout', 'the address change form', 'the single sign-on with the customer database', 'the outage banner'],
  'swl/admin': ['the SLA penalty for the login outage', 'the purchase order for Q4', 'the retainer hours report', 'the framework contract annex'],
  'medtrack/app': ['the Android push notifications', 'the iOS badge count', 'the medication reminder screen', 'release 2.4', 'the TestFlight build', 'a crash on Android 14', 'the onboarding flow', 'the push service configuration', 'the dark mode colours'],
  'klartext/content-hub': ['the article import from the old CMS', 'the author profiles', 'the image rights field', 'the URL structure', 'the editorial workflow', 'the search index', 'the paywall teaser', 'the newsletter export', 'the content model for dossiers'],
  'brightwell/booker': ['the booking widget pricing', 'the availability calendar', 'the payment provider integration', 'the multi-property setup', 'the widget embed code', 'the iCal export', 'Booker release 1.9', 'the API rate limits', 'the room-type mapping'],
  'brightwell/booker-support': ['a hotel asking for a refund export', 'a double booking reported by a hotel', 'the support FAQ', 'the widget not loading for one hotel', 'a password reset for a hotel admin'],
  'brightwell/infra': ['the CI runners', 'the VPN certificates', 'the backup retention', 'the staging servers', 'the monitoring dashboards', 'the status page', 'the secrets rotation'],
  'unregistered:hosting-migration': ['the move to Nordhost', 'the new Kubernetes cluster at Nordhost', 'the DNS TTL before the move', 'the database migration dry run', 'the cutover weekend plan', 'storage costs at Nordhost'],
  'brightwell/sales': ['the proposal for a ski school website', 'the pricing sheet', 'the Alpenhof case study', 'a lead from the trade fair', 'the portfolio page on our website'],
  'unregistered:zermatt-pitch': ['the Zermatt pitch deck', 'the demo for the Zermatt pitch', 'the moodboard for Zermatt', 'the budget estimate for Zermatt', 'the pitch appointment in Zermatt'],
  'brightwell/hiring': ['the backend developer opening', 'the interview with the backend candidate', 'the frontend candidate', 'the job ad text', 'the trial day', 'the salary range'],
  'brightwell/admin': ['the VAT return for Q3', 'the September payroll', 'the liability insurance renewal', 'the office rent', 'the expense reports', 'the annual accounts'],
  'personal/personal': ['the dentist appointment', 'the parents evening at school', 'the apartment viewing', 'the replacement bank card', 'dinner plans'],
};

// Ticket titles per tracker project (language of the people who file them). Each title is used once.
export const TICKET_TITLES: Record<string, { title: string; ini: string; tag?: string }[]> = {
  ALP: [
    { title: 'Relaunch: 301-Weiterleitungen der alten URLs', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'Startseite: Bildkarussell lädt auf Mobile langsam', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'Zimmerübersicht: Filter nach Kategorie', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'Cookie-Banner Texte DE/EN finalisieren', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'Go-Live-Checkliste abarbeiten', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'Spa-Seite: Layout gemäss Entwurf', ini: 'alpenhof/relaunch' },
    { title: 'Restaurant-Menü als PDF hochladen können', ini: 'alpenhof/relaunch', tag: 'relaunch' },
    { title: 'SSL-Zertifikat www verlängern', ini: 'alpenhof/retainer', tag: 'retainer' },
    { title: 'CMS-Zugang für die Rezeption', ini: 'alpenhof/retainer', tag: 'retainer' },
    { title: 'Kontaktformular: Spam-Schutz', ini: 'alpenhof/retainer' },
    { title: 'Monatlicher Backup-Check September', ini: 'alpenhof/retainer', tag: 'retainer' },
    { title: 'Weiterleitung reservation@ funktioniert nicht', ini: 'alpenhof/retainer', tag: 'retainer' },
  ],
  VN: [
    { title: 'Product filter by frame size', ini: 'velonord/shop' },
    { title: 'Shipping costs for Norway are wrong in checkout', ini: 'velonord/shop' },
    { title: 'Switch shop domain to shop.velo-nord.example', ini: 'velonord/shop' },
    { title: 'Gift cards: redeem in checkout', ini: 'velonord/shop' },
    { title: 'Stock sync lags behind by more than 30 minutes', ini: 'velonord/erp-sync', tag: 'erp' },
    { title: 'Articles shown as available although sold out', ini: 'velonord/erp-sync', tag: 'erp' },
    { title: 'ERP export fails on special characters', ini: 'velonord/erp-sync', tag: 'erp' },
    { title: 'Dealer portal: collect requirements', ini: 'unregistered:velonord-b2b-portal' },
  ],
  SWL: [
    { title: 'Login-Timeout im Kundenportal', ini: 'swl/portal' },
    { title: 'Passwort-Reset-Mail kommt nicht an', ini: 'swl/portal' },
    { title: 'Session läuft nach 5 Minuten ab', ini: 'swl/portal' },
    { title: 'Zählerstand-Formular: Validierung Dezimalstellen', ini: 'swl/portal' },
    { title: 'Rechnungs-PDF Download bricht ab', ini: 'swl/portal' },
    { title: 'Störungsbanner auf der Startseite', ini: 'swl/portal' },
    { title: 'Adressänderung: Hausnummer-Zusatz', ini: 'swl/portal' },
  ],
  KT: [
    { title: 'Artikelimport aus Alt-CMS: Umlaute', ini: 'klartext/content-hub' },
    { title: 'Autorenprofile migrieren', ini: 'klartext/content-hub' },
    { title: 'Bildrechte-Feld im Content-Modell', ini: 'klartext/content-hub' },
    { title: 'URL-Struktur für Dossiers', ini: 'klartext/content-hub' },
    { title: 'Redaktions-Workflow: Freigabe-Stufe', ini: 'klartext/content-hub' },
    { title: 'Suchindex neu aufbauen', ini: 'klartext/content-hub' },
    { title: 'Paywall-Teaser im Hub', ini: 'klartext/content-hub' },
  ],
  BKR: [
    { title: 'Widget shows prices without CHF rounding', ini: 'brightwell/booker' },
    { title: 'Availability calendar: blocked dates not synced', ini: 'brightwell/booker' },
    { title: 'Multi-property: shared rate plans', ini: 'brightwell/booker' },
    { title: 'iCal export includes cancelled bookings', ini: 'brightwell/booker' },
    { title: 'Release 1.9: changelog and migration notes', ini: 'brightwell/booker' },
    { title: 'Hotel Sonnegg: refund export for August', ini: 'brightwell/booker-support', tag: 'support' },
    { title: 'Hotel Bergblick: double booking on 12 Sep', ini: 'brightwell/booker-support', tag: 'support' },
    { title: 'Widget not loading on hotel site (CSP)', ini: 'brightwell/booker-support', tag: 'support' },
  ],
  OPS: [
    { title: 'CI runners: upgrade to new image', ini: 'brightwell/infra' },
    { title: 'Rotate VPN certificates', ini: 'brightwell/infra' },
    { title: 'Nordhost: set up the staging cluster', ini: 'unregistered:hosting-migration' },
    { title: 'Lower DNS TTLs before the move', ini: 'unregistered:hosting-migration' },
    { title: 'Database migration dry run at Nordhost', ini: 'unregistered:hosting-migration' },
  ],
  MT: [
    { title: 'Android: push notifications not delivered after app update', ini: 'medtrack/app' },
    { title: 'iOS: badge count wrong after reading a reminder', ini: 'medtrack/app' },
    { title: 'Reminder screen: time picker in 12h format', ini: 'medtrack/app' },
    { title: 'Crash on Android 14 when opening the diary', ini: 'medtrack/app' },
    { title: 'Release 2.4: store texts and screenshots', ini: 'medtrack/app' },
    { title: 'Onboarding: skip button not visible on small screens', ini: 'medtrack/app' },
    { title: 'Dark mode: contrast of secondary buttons', ini: 'medtrack/app' },
    { title: 'Push service: rotate server key', ini: 'medtrack/app' },
    { title: 'Android: push notifications missing after update (again)', ini: 'medtrack/app' },
    { title: 'TestFlight build 2.4.0 (112) feedback', ini: 'medtrack/app' },
  ],
};

// --- the world ------------------------------------------------------------------------------------------

export function slackUsers(): World['slackUsers'] {
  const human = PEOPLE.filter((p) => p.slack && p.slack.inDirectory).map((p) => ({
    id: p.slack!.id,
    name: p.slack!.handle,
    real_name: p.name,
    is_bot: false,
    is_app_user: false,
    deleted: false,
    profile: { display_name: p.slack!.label, real_name: p.name },
  }));
  // Bot users of the integrations that post as users (the project agent, the deploy bot). Integrations that post
  // through bot_profile (UptimeRobot, Sentry, GitHub, YouTrack) have no user — and the legacy hook B-id is absent.
  const bots = [
    { id: 'U0BWAVEN001', name: 'aven', label: 'Aven' },
    { id: 'U0BWDPLY001', name: 'deploybot', label: 'Deploybot' },
  ].map((b) => ({ id: b.id, name: b.name, real_name: b.label, is_bot: true, is_app_user: false, deleted: false, profile: { display_name: b.label, real_name: b.label } }));
  return [...human, ...bots];
}

export function buildWorld(): World {
  return {
    version: SYNTH_VERSION,
    slug: 'bench-agency',
    tz: TZ,
    since: SINCE,
    until: UNTIL,
    now: NOW,
    subject: SUBJECT,
    agency: 'brightwell',
    accounts: ACCOUNTS,
    companies: COMPANIES,
    people: PEOPLE,
    initiatives: INITIATIVES,
    channels: CHANNELS,
    repos: REPOS,
    assets: ASSETS,
    bots: BOTS,
    renames: [
      { kind: 'domain', from: 'velonord.example', to: 'velo-nord.example', at: REBRAND_DAY },
      { kind: 'initiative', from: 'klartext/cms-migration', to: 'klartext/content-hub', at: RENAME_DAY },
      { kind: 'channel', from: '#ext-klartext-cms', to: '#ext-klartext-hub', at: RENAME_DAY },
      { kind: 'tracker_key', from: 'KT', to: 'KH', at: RENAME_DAY },
      { kind: 'repo', from: 'git.brightwell.example/brightwell/klartext-cms', to: 'git.brightwell.example/brightwell/klartext-hub', at: RENAME_DAY },
    ],
    slackUsers: slackUsers(),
  };
}
