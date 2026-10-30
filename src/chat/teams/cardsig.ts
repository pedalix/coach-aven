// Card controls the bot issued (teams-chat-driver; the web chat's security review of 2026-10-30, task
// web-chat-driver 6.7). The core's action and dialog handlers were written for Slack, where the platform
// hands back a button's value and a modal's metadata from the bot's own message. Teams sends back the
// `data` of the card the bot posted — but the client builds that invoke, so a modified client could send
// any action with any value (another person's turn id, conversation key or question id) or a dialog
// submit with metadata of its choosing. So every control leaves the bot signed:
//   - a button (Action.Execute / Action.Submit with `data.action`) carries `sig` = HMAC(action, value);
//   - a dialog form (Action.Submit with `data.dialog`) carries `msig` = HMAC(dialog, meta, person), bound to
//     the person the dialog was opened for;
// and an invoke is taken only when its signature matches (events.ts normalizeAction / normalizeSubmit).
// The key is derived from the bot's app secret (no new setting); rotating the secret retires the controls
// of every card posted before, which then answer "out of date".

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The signing key of an installation's card controls, derived from its Teams app secret. */
export const cardKeyOf = (appPassword: string): string => createHmac('sha256', appPassword).update('coach-aven teams card controls').digest('hex');

const mac = (key: string, ...parts: string[]): string => createHmac('sha256', key).update(parts.join('\0')).digest('base64url');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const actionSig = (key: string, action: string, value: string): string => mac(key, 'action', action, value);
export const dialogSig = (key: string, dialog: string, meta: string, user: string): string => mac(key, 'dialog', dialog, meta, user);

const same = (a: string, b: unknown): boolean => {
  if (typeof b !== 'string' || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Was this control's `{ action, value }` rendered by this bot? */
export const verifyAction = (key: string, data: Record<string, unknown> | undefined): boolean =>
  !!data && typeof data.action === 'string' && same(actionSig(key, data.action, str(data.value)), data.sig);

/** Is this dialog form's `{ dialog, meta }` the one the bot opened for `user`? */
export const verifyDialog = (key: string, data: Record<string, unknown> | undefined, user: string): boolean =>
  !!data && typeof data.dialog === 'string' && same(dialogSig(key, data.dialog, str(data.meta), user), data.msig);

/** A copy of `card` whose controls carry their signatures; a dialog form is bound to `user` (none → not signed). */
export function signCard<T>(key: string, card: T, user?: string): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    const data = o.data as Record<string, unknown> | undefined;
    if ((o.type === 'Action.Execute' || o.type === 'Action.Submit') && data && typeof data === 'object') {
      const d = { ...data };
      if (typeof d.action === 'string') d.sig = actionSig(key, d.action, str(d.value));
      if (typeof d.dialog === 'string' && user) d.msig = dialogSig(key, d.dialog, str(d.meta), user);
      o.data = d;
    }
    return o;
  };
  return walk(card) as T;
}

const ADAPTIVE = 'application/vnd.microsoft.card.adaptive';

/** An outgoing activity whose Adaptive Card attachments carry signed controls. */
export function signActivity<T>(key: string, activity: T): T {
  const a = activity as { attachments?: { contentType?: string; content?: unknown }[] };
  if (!a || !Array.isArray(a.attachments) || !a.attachments.some((x) => x?.contentType === ADAPTIVE)) return activity;
  return { ...activity, attachments: a.attachments.map((x) => (x?.contentType === ADAPTIVE ? { ...x, content: signCard(key, x.content) } : x)) } as T;
}
