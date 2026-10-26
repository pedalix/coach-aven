// Login and session for the web surface, pure (OpenSpec web-chat-driver, design D3). The surface
// authenticates, the core authorizes: a login through the installation's OIDC issuer (oidc.ts) ends in
// an `Identity`; from it the server derives the core's user id (keys.ts) and seals a session cookie —
// HttpOnly, Secure on https, SameSite=Lax, signed with WEB_SESSION_SECRET, nothing of the identity
// provider's tokens in it. Every state-changing request carries a CSRF token bound to that session
// (double submit: the page embeds it, the client sends it in a header, the server recomputes it from the
// cookie). Who may enter is the allow-list of e-mails and groups; empty = everyone the issuer lets in.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a login yields: the identity provider's claims the surface needs. */
export interface Identity {
  sub: string;
  name?: string;
  email?: string;
  groups: string[];
}

/** The OIDC round trip (oidc.ts binds it to openid-client; tests to a fake). */
export interface Oidc {
  /** Where to send the browser: the authorization request with PKCE, state and nonce. */
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  /** The callback: exchange the code, verify state and nonce, read the claims. Throws on anything else. */
  callback(currentUrl: URL, checks: { redirectUri: string; state: string; nonce: string; codeVerifier: string }): Promise<Identity>;
}

export interface Session {
  user: string; // the core's user id (keys.ts userIdOf)
  name?: string;
  email?: string;
  iat: number; // issued, ms since epoch
}

export const SESSION_COOKIE = 'aven_web';
export const LOGIN_COOKIE = 'aven_login';
export const SESSION_MAX_AGE_MS = 12 * 60 * 60_000; // a working day; the login is one redirect away
export const LOGIN_MAX_AGE_MS = 10 * 60_000; // the authorization round trip

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url');
const sign = (secret: string, payload: string): string => createHmac('sha256', secret).update(payload).digest('base64url');
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A signed, tamper-evident cookie value: base64url(JSON).signature. */
export function seal(secret: string, value: unknown): string {
  const payload = b64(JSON.stringify(value));
  return `${payload}.${sign(secret, payload)}`;
}
/** The value of a sealed cookie, or undefined when the signature or shape is wrong. */
export function open<T>(secret: string, cookie: string | undefined): T | undefined {
  if (!cookie) return undefined;
  const i = cookie.lastIndexOf('.');
  if (i <= 0) return undefined;
  const payload = cookie.slice(0, i);
  const sig = cookie.slice(i + 1);
  if (!sig || !same(sig, sign(secret, payload))) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function sealSession(secret: string, s: Session): string {
  return seal(secret, s);
}
/** The session a cookie carries, if validly signed and not expired. */
export function openSession(secret: string, cookie: string | undefined, now = Date.now()): Session | undefined {
  const s = open<Session>(secret, cookie);
  if (!s || typeof s.user !== 'string' || !s.user || typeof s.iat !== 'number') return undefined;
  if (now - s.iat > SESSION_MAX_AGE_MS || s.iat > now + 60_000) return undefined;
  return s;
}

/** The CSRF token of a session: derived, never stored; the page embeds it, the client sends it back. */
export function csrfToken(secret: string, s: Session): string {
  return sign(secret, `csrf|${s.user}|${s.iat}`);
}
export function checkCsrf(secret: string, s: Session, token: string | undefined): boolean {
  return !!token && same(token, csrfToken(secret, s));
}

/** `Cookie:` header → name → value (first wins), without decoding beyond what cookies carry. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** A Set-Cookie value for the session or login cookie: HttpOnly, SameSite=Lax, Secure on https, path /. */
export function cookieHeader(name: string, value: string, opts: { secure: boolean; maxAgeMs?: number; clear?: boolean }): string {
  const parts = [`${name}=${opts.clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.clear) parts.push('Max-Age=0');
  else if (opts.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  return parts.join('; ');
}

/**
 * The allow-list (D6): entries are e-mail addresses (case-insensitive) or `group:<name>` (a value of the
 * groups claim). Empty = open mode: everyone the identity provider lets in may use the chat.
 */
export function isAllowed(allow: string[], id: Pick<Identity, 'email' | 'groups'>): boolean {
  if (!allow.length) return true;
  const email = id.email?.toLowerCase();
  for (const raw of allow) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.toLowerCase().startsWith('group:')) {
      if (id.groups.includes(entry.slice('group:'.length))) return true;
    } else if (email && entry.toLowerCase() === email) return true;
  }
  return false;
}

/** The operators (D6): OIDC subjects (= the core's user ids when plain) or e-mails, case-insensitive for e-mails. */
export function isOperatorOf(operators: string[], s: Pick<Session, 'user' | 'email'>): boolean {
  const email = s.email?.toLowerCase();
  return operators.some((o) => o === s.user || (!!email && o.toLowerCase() === email));
}
