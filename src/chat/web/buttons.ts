// Buttons the server issued (web-chat-driver, the security review of 2026-10-30). The core's action
// handlers were written for Slack, where the platform hands back the button value from the bot's own
// message; on the web the browser sends it, so a signed-in person could post any action with any value
// (another person's turn id, conversation key or question id) and act on their sessions. So every
// rendered button carries an HMAC of its action and value under the session secret, added on the way
// out of the server (signButtons, over the HTML a page or a stream frame carries), and /action takes a
// click only when the signature matches (verifyButton). A person can therefore only click what was
// shown to them: a private reply's buttons reach its person alone, a room's buttons its viewers.
//
// webviews.ts renders every button through one helper (`data-action="…" data-value="…"`, attributes
// escaped by `h`), so the signature is computed over the unescaped values — what the browser's
// getAttribute hands back.

import { createHmac, timingSafeEqual } from 'node:crypto';

const UNESC: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const unescapeAttr = (s: string): string => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (e) => UNESC[e]!);

export function buttonSig(secret: string, action: string, value: string): string {
  return createHmac('sha256', secret).update(`web-button\0${action}\0${value}`).digest('base64url');
}

/** Every button in `html` gets `data-sig` beside its action and value. */
export function signButtons(secret: string, html: string): string {
  return html.replace(/data-action="([^"]*)" data-value="([^"]*)"/g, (m, a: string, v: string) => `${m} data-sig="${buttonSig(secret, unescapeAttr(a), unescapeAttr(v))}"`);
}

/** Was this action and value rendered by this server? Constant-time; anything but a matching string is no. */
export function verifyButton(secret: string, action: string, value: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || !sig) return false;
  const want = Buffer.from(buttonSig(secret, action, value));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
