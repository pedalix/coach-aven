// The cue lexicon (design §3.2, shared with J's cite check): which kinds of speech act a message carries, in the four
// languages the tenants write (EN/DE/RU/IT). Deterministic and deliberately small — a cue is a weak signal that a `cue`
// key must still earn the right to use; it is not a classifier.
//
//   Q  a question: '?', the particle "ли", or an interrogative word opening a sentence
//   R  a request: please / could you / bitte / пожалуйста / per favore …
//   C  a commitment: I'll / ich werde / сделаю / farò …
//   I  an incident: down / error / outage / Fehler / не работает / errore …
//
// Word edges are Unicode-aware lookarounds: JS \b only knows ASCII letters, so "\bчто\b" never matches.

export type Cue = 'Q' | 'R' | 'C' | 'I';

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const Q_OPENER = new RegExp(`(?:^|[.!?\\n]\\s*)(?:what|when|how|can you|wann|wie|was|kannst|когда|как|что|можешь|quando|come|puoi)${E}`, 'iu');
const Q_ANY = new RegExp(`\\?|${B}ли${E}`, 'iu');
const R = new RegExp(`${B}(?:please|could you|bitte|könntest|пожалуйста|сделай|нужно|per favore|potresti)${E}`, 'iu');
const C = new RegExp(`${B}(?:i[’']ll|i will|ich mache|ich werde|сделаю|пришлю|farò|lo faccio)${E}`, 'iu');
const I = new RegExp(`${B}(?:down|errors?|outages?|not working|fehler\\p{L}*|ausfall|geht nicht|не работает|упал\\p{L}*|ошибк\\p{L}*|errore|errori|non funziona)${E}`, 'iu');

/** The cue classes a text fires, in Q R C I order. */
export function cuesOf(text: string | null | undefined): Cue[] {
  const s = (text ?? '').trim();
  if (!s) return [];
  const out: Cue[] = [];
  if (Q_ANY.test(s) || Q_OPENER.test(s)) out.push('Q');
  if (R.test(s)) out.push('R');
  if (C.test(s)) out.push('C');
  if (I.test(s)) out.push('I');
  return out;
}

const SLACK_MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>/;
const AT_NAME = /(?:^|[\s(])@[\p{L}\p{N}][\p{L}\p{N}._-]+/u;

/** Does the text name someone with an @-mention (a Slack user id or a plain @name)? */
export const hasMention = (text: string | null | undefined): boolean => SLACK_MENTION.test(text ?? '') || AT_NAME.test(text ?? '');
