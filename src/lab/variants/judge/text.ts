// Text helpers for J (the case judge, design §4): one fold for every comparison (cards, cite check, precedent
// similarity), so a span the model copied with different case, accents or spacing still matches what the card
// said. Pure.

import { fnv1a, rng } from '../../metrics.js';

/** Case-, accent- and width-insensitive form (NFKD, marks dropped, lower case). Cyrillic й/ё fold to и/е on both sides. */
export const fold = (s: string | null | undefined): string => (s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/** fold + whitespace collapsed: the form a "verbatim" span is compared in. */
export const squash = (s: string | null | undefined): string => fold(s).replace(/\s+/g, ' ').trim();

// EN/DE/RU/IT function words and chat filler: they make two unrelated records look alike.
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just me my no not of on or our ' +
    'she so than that the their them then there these they this to up us was we were what when where which who why will with would you your yes ok okay ' +
    'please thanks thank hi hello hey also about all any some more most only very here now today tomorrow yesterday re fwd fw aw wg ' +
    'der die das den dem des ein eine einen einem einer und oder aber nicht ist sind war mit von zu zum zur auf für fur im in an am als auch auch bei ' +
    'wie was wer wo wann ich du er sie es wir ihr uns euch mein dein sein ja nein bitte danke hallo noch schon nur mal dann doch ' +
    'и в во не на я он она оно мы вы они что как это то так но да нет по из за к ко у о об от до для же ли бы был была были быть ' +
    'мне меня тебе тебя его ее её их нам вам там тут здесь сейчас уже еще ещё или а если когда чтобы привет спасибо пожалуйста ' +
    'il lo la i gli le un una uno e ed o ma non di da in con su per tra fra che chi come dove quando sono sei è era io tu lui lei noi voi loro ' +
    'mi ti ci vi si del della dei delle al alla ai alle grazie ciao'
  )
    .split(/\s+/)
    .map((w) => fold(w)),
);

const WORD_G = /[\p{L}\p{N}]+/gu;

/** Folded word tokens of at least `min` characters, stopwords removed. */
export function tokens(s: string | null | undefined, min = 3): string[] {
  const out: string[] = [];
  for (const m of fold(s).matchAll(WORD_G)) if (m[0].length >= min && !STOPWORDS.has(m[0])) out.push(m[0]);
  return out;
}

/** Does `hay` contain `needle` as a whole word or phrase (folded; a boundary = not a letter or digit)? */
export function containsTerm(hay: string, needle: string): boolean {
  const h = squash(hay);
  const n = squash(needle);
  if (!n) return false;
  let i = h.indexOf(n);
  while (i >= 0) {
    const before = i === 0 ? '' : h[i - 1]!;
    const after = h[i + n.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    i = h.indexOf(n, i + 1);
  }
  return false;
}

// A URL is evidence through its host only (paths carry ids and scrub tags, design F9); tracker keys stay.
const SLACK_LINK_G = /<(https?:\/\/[^>|\s]+)(?:\|([^>]*))?>/g;
const URL_G = /\bhttps?:\/\/([^/\s<>"'`|)]+)[^\s<>"'`|)]*/g;

/** URLs → their host (a Slack `<url|label>` keeps its label). */
export function hostsOnly(text: string | null | undefined): string {
  return (text ?? '')
    .replace(SLACK_LINK_G, (_m, url: string, label?: string) => `${hostOf(url)}${label ? ` (${label})` : ''}`)
    .replace(URL_G, (_m, host: string) => host.toLowerCase());
}

const hostOf = (url: string): string => (/^https?:\/\/([^/\s?#]+)/i.exec(url)?.[1] ?? url).toLowerCase();

// Zero-width and soft-hyphen characters (newsletter padding, tracking) carry nothing and cost tokens.
const INVISIBLE_G = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;

/** Drop invisible characters, collapse runs of whitespace and cut to `n` characters (with an ellipsis when cut). */
export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(INVISIBLE_G, '').replace(/[ \t]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim();
  if (n <= 0) return '';
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/** One line: newlines become " / " (cards keep one record per line). */
export const oneLine = (s: string | null | undefined): string =>
  (s ?? '').replace(INVISIBLE_G, '').replace(/\s*\n+\s*/g, ' / ').replace(/\s+/g, ' ').replace(/( \/)+ ?$/, '').trim();

/** A deterministic shuffle: the same seed gives the same order on every run. */
export function seededShuffle<T>(xs: readonly T[], seed: string): T[] {
  const out = [...xs];
  const r = rng(fnv1a(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** "Tue 10-06 14:05" in the tenant's zone (cards speak local time; storage is UTC). */
export function localTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "14:05" in the tenant's zone. */
export const clock = (iso: string, tz: string): string => localTime(iso, tz).slice(-5);
