// Text for the web, pure (OpenSpec web-chat-driver, design D4). The web is the first surface where WE
// turn the agent's output into HTML — Slack and Teams sanitize for us — and that output is untrusted
// (prompt injection can shape it). So: markdown with raw HTML off, links only to http(s) and mailto,
// images shown as links (the CSP allows no foreign image anyway), every attribute escaped by the
// renderer, and the page template escapes everything that is not marked as rendered HTML (`h`).
// The core writes two dialects (as for Teams): the agent's GitHub markdown (answers, memory files) and
// Slack mrkdwn in its own short texts (`*bold*`, `:emoji:`, `<url|label>`); `mrkdwnToTeams` turns the
// latter into markdown — generic despite its name — and both end here.

import MarkdownIt from 'markdown-it';
import { mrkdwnToTeams } from '../teams/format.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Rendered HTML the template may embed as is; everything else `h` escapes. */
export class Html {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}
export const raw = (html: string): Html => new Html(html);

/** A template tag that escapes interpolations: strings and numbers are text, `Html` is embedded, arrays are joined. */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += part(values[i]);
  });
  return new Html(out);
}
function part(v: unknown): string {
  if (v === undefined || v === null || v === false) return '';
  if (v instanceof Html) return v.html;
  if (Array.isArray(v)) return v.map(part).join('');
  return escapeHtml(String(v));
}

const ALLOWED_LINK = /^(https?:\/\/|mailto:)/i;

// `breaks`: a single newline is a line break, as Slack and Teams show it — the core's status line puts each recent
// step on its own line, and an agent's hard-wrapped answer keeps its lines (the first web canary showed the steps
// of a status line run together into one paragraph).
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
// Only http(s) and mailto survive; markdown-it then renders a refused link as its text and a refused
// image without a source (which the image rule below shows as a plain marker).
md.validateLink = (url) => ALLOWED_LINK.test(url.trim());
// Every link opens in a new tab without a referrer and without a handle on this window.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};
// An image is a link to it, never an <img>: nothing loads from a third party when a thread is opened.
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx];
  const src = t.attrGet('src') ?? '';
  const alt = t.content || 'image';
  return src ? `<a class="img-link" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">🖼 ${escapeHtml(alt)}</a>` : `<span class="img-link">🖼 ${escapeHtml(alt)}</span>`;
};

const MENTION = /<@([^>|\s]+)(?:\|[^>]*)?>/g;
/** `<@id>` → `@Name` (or `@id` for a person never seen), before the markdown pass. */
export function mentionsToText(text: string, nameOf: (id: string) => string | undefined = () => undefined): string {
  return text.replace(MENTION, (_m, id: string) => `@${nameOf(id) ?? id}`);
}

/** The agent's GitHub markdown → safe HTML. */
export function markdownToHtml(markdown: string, nameOf?: (id: string) => string | undefined): Html {
  return new Html(md.render(mentionsToText(markdown, nameOf)));
}

/** The core's own Slack-mrkdwn texts (`info()`, status lines, notices) → safe HTML. */
export function mrkdwnToHtml(text: string, nameOf?: (id: string) => string | undefined): Html {
  return markdownToHtml(mrkdwnToTeams(text), nameOf);
}

/** One line of plain text for a notification, a thread card, a page title: markup stripped, whitespace collapsed, cut. */
export function plainText(text: string, max = 160): string {
  const t = mrkdwnToTeams(mentionsToText(text))
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|[*_~])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
