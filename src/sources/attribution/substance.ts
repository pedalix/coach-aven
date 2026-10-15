// Substance threshold: message runs like "Morning", "give me 10 min", "do we do a call today?" carry no
// topic, so they are not work to attribute — a low-substance run is attached to the adjacent call with
// the same counterpart or dropped (fragment.ts settleLowSubstance). Likewise a recording with almost
// nothing in it is not a call. Ported from the owen-ops CLI unchanged: strip greetings and logistics
// (EN/RU/DE), mentions, links, emoji and punctuation; under a dozen letters left → no substance.

/** Whole-word alternation that works for Cyrillic and umlauts too (JS `\b` is ASCII-only). */
const w = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'gu');

const PHRASES: RegExp[] = [
  // EN
  w('(good\\s+)?(morning|afternoon|evening|night)'), w('hi|hello|hey|yo|hiya'),
  w('ok(ay)?|k|kk|sure|yes|yep|yeah|no|nope|np|cool|great|perfect|nice|fine|done|noted|got it|sounds good'),
  w('thanks?( you)?|thx|ty|cheers|welcome'), w('bye|ciao|see you|later|cu'),
  w('(give me|in|after|wait)\\s+(a\\s+)?\\d*\\s*(min(ute)?s?|sec(ond)?s?|moment)'), w('(one|a)\\s+(sec|second|moment|min(ute)?)'),
  w('(do|shall|can|could)\\s+we\\s+(do\\s+|have\\s+)?(a\\s+)?(quick\\s+)?(call|talk|chat|sync)(\\s+(today|now|later|tomorrow))?'),
  w('(are you|r u|you)\\s+(still\\s+)?(there|around|free|available)'), w('(maybe|still)\\s+(still\\s+)?around|maybe|still'), w('brb|omw|on my way|joining|coming|here|ready'),
  w('call|ping|me|you|now|today|tomorrow|please|pls'),
  // RU
  w('доброе\\s+утро|добрый\\s+(день|вечер)|привет|здравствуй(те)?|хай'),
  w('ок|окей|ага|угу|да|нет|хорошо|понял(а)?|принято|отлично|супер|норм'),
  w('спасибо|спс|благодарю|пожалуйста|пока|до\\s+связи|на\\s+связи'),
  w('через\\s+\\d*\\s*(мин(ут[уы]?)?|сек(унд[уы]?)?)|минутку|секунду|сейчас|щас'),
  w('созвон(имся)?|звоню|позвони|наберу|можем\\s+созвониться'),
  // DE
  w('(guten\\s+)?(morgen|tag|abend)'), w('hallo|servus|grüß\\s*gott|moin'), w('ja|nein|passt|gerne|alles klar|klar'),
  w('danke( schön)?|bitte'), w('bis\\s+(gleich|später|morgen)|tschüss'), w('moment|kurz|gleich'),
];

export const MIN_SUBSTANCE_LETTERS = 12;

/** Letters left after removing greetings/logistics, mentions, links, emoji and punctuation. */
export function substance(text: string): string {
  let t = (text ?? '').toLowerCase();
  t = t.replace(/<@[^>]+>|@\w[\w.-]*/g, ' ').replace(/https?:\/\/\S+/g, ' link ').replace(/:[a-z0-9_+-]+:/g, ' ');
  t = t.replace(/\[file:[^\]]*\]/g, ' ');
  for (const re of PHRASES) t = t.replace(re, ' ');
  return t.replace(/[^\p{L}]+/gu, '');
}

/** A run of messages whose combined substance is under the threshold carries no topic. */
export function isLowSubstance(texts: string[], min = MIN_SUBSTANCE_LETTERS): boolean {
  return substance(texts.join(' ')).length < min;
}

export const MIN_MEETING_CHARS = 120;
export const THIN_SUMMARY_CHARS = 60;
export const THIN_TRANSCRIPT_CHARS = 600;

/** Under 120 chars of summary + transcript, or a near-empty summary over a transcript of a few lines, is not a call. */
export function isGarbledMeeting(summary: string, transcriptChars: number, min = MIN_MEETING_CHARS): boolean {
  const s = (summary ?? '').trim().length;
  const t = Math.max(0, transcriptChars);
  return s + t < min || (s < THIN_SUMMARY_CHARS && t < THIN_TRANSCRIPT_CHARS);
}
