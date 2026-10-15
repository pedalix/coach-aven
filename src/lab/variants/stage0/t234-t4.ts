// Stage 0, T4: the structural kind and addressee of an item (design notes/10-design.md §2.1 F11, §2.2). No kind exists
// today, and the addressee is message_people role='to' — every DM member, mention and mail recipient, Cc included.
//   kind       design: bot/bulk/system → noise .95, a person's small talk → noise .80, else abstain with the cue classes
//              (t234-text cuesOf) exposed for the learners. The real stores' silver labels forced four refinements —
//              an integration posts more than noise there: alert firings and error reports (incident), a support
//              tool relaying a customer's words, an agent answering a thread (info/request):
//                a resolved alert → noise .95 · a firing alert abstains (incident to the real silver, noise to the
//                synthetic truth: the tenant's call) · a bot post with an incident cue abstains ('incident' its
//                candidate) · a bot post with a question/request cue, a bot's thread reply or a relayed "*Name*: …"
//                abstains · any other bot post → noise .90 (89% on owen-ops: agents' own posts)
//                bulk → noise .95 unless it asks for something (request cue: cold outreach) · system (role mailbox,
//                which sender.ts itself says "may carry something to act on") → noise .85 unless it asks or reports
//                small talk is the STRICT lexicon (greetings, thanks, "ok", emoji: t234-text isSmallTalk) → noise .85;
//                substance.ts's "under 12 letters" also eats answers ("correct", "only hotels") and shared files,
//                which the labels call info (35% precision as noise)
//   addressee  design: explicit .95 (DM counterpart, mention, mail To not Cc, agent mention) · vocative .85 · implicit
//              .80 · none .70 (a vocative naming one roster person outside the container: .80; "Frau Berg" by surname).
//              Added: an integration addresses nobody → none .95 (the silver labels give [] to 99% of
//              machine items that ask for nothing), unless it is a mail asking for action (abstain, the subject its
//              candidate); small talk → none .80 first. The store keeps no To/Cc split, so a mail's "To" is only the
//              recipient right after the sender. Graded by what the stores measured — see addresseeOf.
// Labels: kind ∈ KINDS; addressee = setKey of person ids ('a|b', sorted) or 'none'. Pure: the caller resolves people.

import { setKey } from '../../metrics.js';
import { NONE } from '../../types.js';
import type { AlertState } from '../../../sources/fingerprint.js';
import type { SenderClass } from './index.js';
import type { Cue } from './t234-text.js';

export interface KindInput {
  cls: SenderClass;
  human: boolean; // cls === 'human' (meetings and tickets count as people's records)
  cues: Cue[];
  alert: AlertState | null;
  smallTalk: boolean; // t234-text isSmallTalk
  relay?: boolean; // a bot's thread reply or a relayed "*Name*: …" — somebody's words through an integration
}

export interface KindOut {
  label: string | null;
  conf: number;
  rung: string;
  candidates: string[];
  hint: string;
  cues: Cue[];
}

export function kindOf(i: KindInput): KindOut {
  const base = { cues: i.cues };
  const has = (c: Cue) => i.cues.includes(c);
  const abstain = (rung: string, candidates: string[] = [], hint = ''): KindOut => ({ label: null, conf: 0, rung, candidates, hint: hint || (i.cues.length ? `cues ${i.cues.join('')}` : ''), ...base });
  const noise = (conf: number, rung: string, hint: string): KindOut => ({ label: 'noise', conf, rung, candidates: ['noise'], hint, ...base });
  if (!i.human) {
    if (i.cls === 'bot' && i.alert?.state === 'resolved') return noise(0.95, 'auto:resolved', 'a resolved alert');
    if (i.cls === 'bot' || i.cls === 'system') {
      // A firing alert is an incident to the real stores' silver labels (49/50) and a routine notification (noise) to
      // the synthetic tenant's truth (38/38): a tenant's call, not the floor's — it asks, with 'incident' as its guess.
      if (i.cls === 'bot' && i.alert?.state === 'firing') return abstain('auto:firing', ['incident', 'noise'], 'a firing alert');
      if (has('I')) return abstain('auto:incident?', ['incident'], 'an error report');
      if (has('Q') || has('R')) return abstain('auto:asks');
      if (i.relay) return abstain('auto:relay', [], "somebody's words through an integration");
      return i.cls === 'bot' ? noise(0.9, 'sender:bot', 'bot sender') : noise(0.85, 'sender:system', 'role mailbox');
    }
    if (has('R')) return abstain('bulk:asks');
    return noise(0.95, `sender:${i.cls}`, `${i.cls} sender`);
  }
  if (i.smallTalk) return noise(0.85, 'smalltalk', 'small talk');
  return abstain('abstain');
}

export type ContainerKind = 'dm' | 'group' | 'channel' | 'mail' | 'tracker' | 'meeting' | 'other';

/** What kind of place an item sits in, from the container labels the pullers write. */
export function containerKind(source: string, container: string | null, mail: boolean, type: string): ContainerKind {
  const c = container ?? '';
  if (type === 'meeting' || type === 'event') return 'meeting';
  if (type === 'task' || type === 'comment') return 'tracker';
  if (mail) return 'mail';
  if (/^dm:/i.test(c) || /^chat:@/i.test(c)) return 'dm';
  if (/^mpim:/i.test(c) || /^chat:group:/i.test(c)) return 'group';
  if (/^#|^team:|^chat:meeting:|^channel:/i.test(c)) return 'channel';
  return source === 'slack' ? 'channel' : 'other';
}

export interface AddresseeInput {
  human: boolean;
  type: string; // ItemUnit.type
  author: string | null; // the author's person id
  subject: string | null; // the dataset's subject (the account owner)
  where: ContainerKind;
  asks: boolean; // a request cue (R): a machine mail that asks somebody to act ("Action required", "Assigned to you")
  mentions: { pid: string; conf: number }[]; // @mentioned people, resolved
  members: string[]; // people of the conversation: DM/chat members, or mail recipients in header order ('' = unresolved)
  assignee: string | null; // a ticket's assignee
  vocative: { pid: string; conf: number } | null; // the person a leading "Ana, …" names (.85 a container member, .80 roster-wide)
  parent: string | null; // the person whose message this one answers
  smallTalk: boolean;
}

export interface AddresseeOut {
  label: string | null;
  conf: number;
  rung: string;
  candidates: string[];
  hint: string;
}

const out = (ids: string[], conf: number, rung: string, hint = ''): AddresseeOut => {
  const label = setKey(ids) || NONE;
  return { label, conf, rung, candidates: ids, hint };
};

// The confidences are the design's (§2.2) where the real stores' silver labels agree with them, and lower where they
// measured lower (owen-ops / bluefin-ops): a DM line is often small talk or an FYI the labels address to nobody (92%), a
// ticket's assignee is not always who a ticket turns to (71% bluefin-ops), a reply answers its thread more often than
// its last author (57–64%), and a "personal" mail from an unknown sender is mostly a campaign without a footer (38%).
export function addresseeOf(i: AddresseeInput): AddresseeOut {
  if (!i.human) {
    // A machine mail that asks for action (assigned to you, verify, action required) is the account owner's to-do.
    if (i.asks && i.where === 'mail' && i.subject) return { label: null, conf: 0, rung: 'auto:asks', candidates: [i.subject], hint: 'a notification asking for action' };
    return out([], 0.95, 'auto:none', 'integration');
  }
  if (i.smallTalk) return out([], 0.8, 'smalltalk', 'small talk');
  const notMe = (p: string) => !!p && p !== i.author;
  // explicit
  const ments = i.mentions.filter((m) => notMe(m.pid));
  if (ments.length) return out([...new Set(ments.map((m) => m.pid))], Math.min(...ments.map((m) => m.conf)), 'explicit:mention');
  if (i.where === 'dm' || i.where === 'group') {
    if (i.subject && i.author !== i.subject && i.members.includes(i.subject)) return out([i.subject], i.where === 'dm' ? 0.9 : 0.6, `explicit:${i.where}`);
    const others = [...new Set(i.members.filter(notMe))];
    if (!i.subject && others.length && (i.where === 'dm' || others.length <= 3)) return out(others, i.where === 'dm' ? 0.9 : 0.85, `explicit:${i.where}`);
  }
  if (i.where === 'mail' && i.subject && i.author !== i.subject) {
    const pos = i.members.indexOf(i.subject);
    if (pos === 0) return out([i.subject], 0.6, 'explicit:to', 'first To recipient');
    if (pos > 0) return out([i.subject], 0.55, 'explicit:to?', 'To or Cc');
  }
  if (i.type === 'task' && i.assignee && notMe(i.assignee)) return out([i.assignee], 0.8, 'explicit:assignee');
  // vocative
  if (i.vocative && notMe(i.vocative.pid)) return out([i.vocative.pid], i.vocative.conf, i.vocative.conf >= 0.85 ? 'vocative' : 'vocative~');
  // implicit
  if (i.parent && notMe(i.parent)) return out([i.parent], 0.65, 'implicit');
  return out([], 0.7, 'none');
}

// --- vocatives ---------------------------------------------------------------------------------------------

const GREETING = new Set(['hi', 'hello', 'hey', 'dear', 'hallo', 'servus', 'moin', 'hoi', 'liebe', 'lieber', 'ciao', 'salve', 'buongiorno', 'buonasera', 'gentile', 'caro', 'cara', 'привет', 'здравствуй', 'здравствуйте', 'добрый', 'день', 'утро', 'вечер', 'доброе', 'good', 'morning', 'guten', 'morgen', 'tag', 'thanks', 'danke', 'grazie', 'спасибо', 'yo']);
const HONORIFIC = new Set(['herr', 'frau', 'mr', 'mrs', 'ms', 'dr', 'signor', 'signora', 'sig', 'monsieur', 'madame']);

/**
 * The person a message opens with ("Ana, can you …", "Hi Ana —", "Ciao Ana", "Guten Tag Frau Berg"): up to two
 * greeting words, then a name; after an honorific it is a surname.
 */
export function openingName(text: string | null | undefined): { word: string; surname: boolean } | null {
  const raw = (text ?? '').replace(/^\s*(?:<@[^>]+>|@\S+)\s*/u, '');
  const words = raw
    .split(/\s+/)
    .slice(0, 5)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter(Boolean);
  let i = 0;
  while (i < Math.min(2, words.length) && GREETING.has(words[i]!.toLowerCase())) i++;
  let surname = false;
  if (words[i] && HONORIFIC.has(words[i]!.toLowerCase().replace(/\.$/, ''))) {
    surname = true;
    i++;
  }
  const w = words[i];
  if (!w || !/^\p{Lu}/u.test(w) || GREETING.has(w.toLowerCase())) return null;
  // The name must END the greeting: "Ana, …" / "Hi Ana" / "Hi Ana!" — not "Ana said yesterday".
  const at = raw.indexOf(w);
  const after = raw.slice(at + w.length, at + w.length + 2);
  return i > 0 || /^\s*[,!:—–-]/.test(after) || after === '' ? { word: w, surname } : null;
}
