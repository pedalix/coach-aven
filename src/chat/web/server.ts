// The web chat's HTTP server (OpenSpec web-chat-driver): pages, the live stream, the actions, the login —
// over Express on a loopback listener behind the installation's reverse proxy. What it does is the
// core's (src/chat/core/): a post becomes a ChatMessage or a ChatCommand, a click a ChatAction, a form a
// DialogSubmit; what it renders is pages.ts / webviews.ts over the history store (history.ts).
//
// Security baseline (design D3/D4): every page and endpoint needs a session (pages redirect to the login,
// endpoints answer 401); every POST needs the session's CSRF token in `x-csrf` (a form also carries it
// in `csrf`) and a same-origin fetch; a strict CSP with no inline script; `no-store` on everything but
// the assets; body limits; a per-person rate limit on posting. The login is OIDC with PKCE through
// auth.ts/oidc.ts, or a fixed local user: on a loopback listener with no check (`none`, config.ts), or for whoever
// opens the per-boot sign-in link from the boot log (`link`, the quickstart). Each route branches on `cfg.auth`
// by name — a missing OIDC client never means "let everyone in".

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { WebConfig } from '../../config.js';
import type { Store } from '../../state.js';
import { resolveBySlug, type ProjectConfig, type RegistryRef } from '../../projects.js';
import type { Interactions } from '../core/interactions.js';
import type { createMessages } from '../core/messages.js';
import type { createCommands } from '../core/commands.js';
import type { ChatAction, ChatMessage, DialogSubmit } from '../driver.js';
import { CMD, errText } from '../slack/blocks.js';
import { captureError } from '../../sentry.js';
import { log } from '../../log.js';
import { History, visibleFor, type FileMeta, type Message, type Stored } from './history.js';
import { newId, parseConv, privateConv, roomConv, userIdOf } from './keys.js';
import { attachmentDisposition, findUpload, mimeOf, storeUpload, toRef } from './files.js';
import { MAX_FILES, isSupported } from '../../attachments.js';
import { renderHomeView } from './webviews.js';
import { Html, h } from './webformat.js';
import { deniedPage, homePage, layout, linkLoginPage, loginPage, messageBody, messageHtml, privatePage, roomPage, signedOutPage, signingOutPage, threadCardHtml, threadPage, type Shell, type Viewer } from './pages.js';
import { LOGIN_COOKIE, LOGIN_MAX_AGE_MS, SESSION_COOKIE, SESSION_MAX_AGE_MS, checkCsrf, cookieHeader, csrfToken, isAllowed, open, openSession, parseCookies, seal, sealSession, type Oidc, type Session } from './auth.js';
import { pkce } from './oidc.js';
import { signButtons, verifyButton } from './buttons.js';
import type { WebChatDriver, WebCtx } from './driver.js';

export interface WebServerDeps {
  cfg: WebConfig;
  store: Store;
  reg: RegistryRef;
  history: History;
  driver: WebChatDriver;
  core: Interactions;
  messages: ReturnType<typeof createMessages>;
  commands: ReturnType<typeof createCommands>;
  /** The login round trip; absent under WEB_AUTH=none and WEB_AUTH=link. */
  oidc?: Oidc;
  /** WEB_AUTH=link: this boot's sign-in key (app.ts draws it and prints the link); `/login?key=` must carry it. */
  loginKey?: string;
  /** Fresh message ids (tests: sequential). */
  ids?: () => string;
  now?: () => number;
  /** Where uploads live (`<data dir>/web`, the history's root); files.ts lays them out per conversation. */
  filesRoot: string;
}

export interface WebServer {
  app: express.Express;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

// A local-only user when WEB_AUTH=none (the e2e harness and local development).
export const LOCAL_USER: Session = { user: 'local', name: 'Local user', iat: 0 };
/** A person's display name from the login records (state.json `webUsers`), resolved live so a later login with a better
 *  name reaches every page: the stored name unless it is just the id (a login that found no name once stored the subject
 *  itself), then the e-mail. */
export const webNameOf = (store: Store) => (id: string): string | undefined => {
  const u = store.getWebUser(id);
  if (!u) return undefined;
  return u.name && u.name !== id ? u.name : (u.email ?? u.name);
};
const POSTS_PER_MINUTE = 30;
const STREAMS_PER_PERSON = 10; // open pages (live streams) one person may hold at once
const MAX_TEXT = 20_000;
// The router's verbs (src/chat/core/commands.ts), for the composer's suggestions; `help` is the web's own: the Home
// cheat-sheet as a dialog (the router has no help verb — Slack has the App Home tab, Teams the Home card).
const VERBS = ['help', 'home', 'status', 'access', 'memory', 'prompt', 'schedule', 'routines', 'review', 'autofix', 'dream', 'housekeeping', 'users', 'usage', 'asks', 'reload'];
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const STATIC = new URL('./static/', import.meta.url).pathname;
// The Slack spelling of a command (`/aven status`) is accepted too, so a hint copied from an answer works.
const CMD_WORD = new RegExp(`^${CMD.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');

type Req = Request & { session?: Session };

/** WEB_AUTH=link: does the query's key equal this boot's? Hashes first, so the compare is constant-time whatever the lengths. */
export function keyMatches(key: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(key), digest(given));
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const { cfg, store, reg, history, driver, core, messages, commands } = deps;
  const ids = deps.ids ?? (() => newId('m'));
  const now = deps.now ?? Date.now;
  const secure = cfg.baseUrl.startsWith('https://');
  const nameOf = webNameOf(store);
  const rooms = (): ProjectConfig[] => reg.current.projects.filter((p) => p.webRoom !== false);
  const roomOf = (slug: string): ProjectConfig | undefined => {
    const p = resolveBySlug(reg.current, slug);
    return p && p.webRoom !== false ? p : undefined;
  };
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [name, type] of [
    ['app.js', 'text/javascript; charset=utf-8'],
    ['app.css', 'text/css; charset=utf-8'],
  ] as const) {
    assets.set(name, { body: readFileSync(`${STATIC}${name}`), type });
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The local modes (`none`, `link`) answer only to a loopback name or the base URL's host: a page elsewhere that
  // rebinds its own DNS name to 127.0.0.1 would otherwise reach the local session (the security review of
  // 2026-10-30). Behind the reverse proxy (`oidc`) the proxy decides the host.
  if (cfg.auth !== 'oidc') {
    const hosts = new Set(['localhost', '127.0.0.1', '[::1]', new URL(cfg.baseUrl).hostname]);
    app.use((req, res, next) => {
      const host = req.get('host') ?? '';
      let name = '';
      try {
        name = new URL(`http://${host}`).hostname;
      } catch {
        name = '';
      }
      if (!hosts.has(name)) return void res.status(421).type('text/plain').send('unknown host');
      next();
    });
  }

  // ── assets (no session: the login page needs its stylesheet) ──────────────────────────────────
  app.get('/assets/:name', (req, res) => {
    const a = assets.get(String(req.params.name));
    if (!a) return void res.status(404).type('text/plain').send('not found');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type(a.type).send(a.body);
  });

  // Browsers ask for it on every page; there is none (the console would log a 404 on each load).
  app.get('/favicon.ico', (_req, res) => void res.status(204).end());

  // ── login ───────────────────────────────────────────────────────────────────────────────────────
  const setSession = (res: Response, s: Session) => res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, sealSession(cfg.sessionSecret, s), { secure, maxAgeMs: SESSION_MAX_AGE_MS }));
  // A same-site path only: no `//host` and no backslash anywhere (browsers read `/\host` as `//host`).
  const safeNext = (raw: unknown): string => (typeof raw === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(raw) ? raw : '/');

  app.get('/login', async (req, res) => {
    const next = safeNext(req.query.next);
    const signInLocal = () => {
      store.putWebUser({ id: LOCAL_USER.user, name: LOCAL_USER.name, seenAt: new Date(now()).toISOString() });
      setSession(res, { ...LOCAL_USER, iat: now() });
      res.redirect(303, next);
    };
    if (cfg.auth === 'none') return signInLocal();
    if (cfg.auth === 'link') {
      // The key alone signs in (constant-time compare); without it, the page says where the link is. The key is never logged
      // (a tracing span would carry the URL with it — the quickstart sets no error tracker; an installation that adds one
      // with tracing on a `link` surface should know the request URL holds the key until the next restart).
      if (deps.loginKey && keyMatches(deps.loginKey, req.query.key)) return signInLocal();
      return void res.status(401).type('html').send(layout({ title: 'Sign in', projects: [] }, linkLoginPage()));
    }
    if (!deps.oidc) return void res.status(500).type('html').send(layout({ title: 'Sign in', projects: [] }, loginPage('No sign-in service is configured.')));
    try {
      const verifier = pkce.verifier();
      const state = pkce.state();
      const nonce = pkce.nonce();
      const url = await deps.oidc.authorizationUrl({ redirectUri: `${cfg.baseUrl}/auth/callback`, state, nonce, codeChallenge: await pkce.challenge(verifier) });
      res.setHeader('Set-Cookie', cookieHeader(LOGIN_COOKIE, seal(cfg.sessionSecret, { verifier, state, nonce, next, iat: now() }), { secure, maxAgeMs: LOGIN_MAX_AGE_MS }));
      res.redirect(303, url.toString());
    } catch (e) {
      log.error(`web login: ${e instanceof Error ? e.message : String(e)}`);
      captureError(e, { subsystem: 'web-login' });
      res.status(502).type('html').send(layout({ title: 'Sign in', projects: [] }, loginPage('The sign-in service did not answer. Try again in a moment.')));
    }
  });

  app.get('/auth/callback', async (req, res) => {
    if (cfg.auth !== 'oidc' || !deps.oidc) return void res.redirect(303, '/');
    const login = open<{ verifier: string; state: string; nonce: string; next: string; iat: number }>(cfg.sessionSecret, parseCookies(req.headers.cookie)[LOGIN_COOKIE]);
    res.setHeader('Set-Cookie', [cookieHeader(LOGIN_COOKIE, '', { secure, clear: true })]);
    if (!login || now() - login.iat > LOGIN_MAX_AGE_MS) return void res.status(400).type('html').send(layout({ title: 'Sign in', projects: [] }, loginPage('The sign-in took too long or started elsewhere — try again.')));
    try {
      const id = await deps.oidc.callback(new URL(req.originalUrl, cfg.baseUrl), { redirectUri: `${cfg.baseUrl}/auth/callback`, state: login.state, nonce: login.nonce, codeVerifier: login.verifier });
      if (!isAllowed(cfg.allow, id)) {
        log.warn(`web login: ${id.email ?? id.sub} is not on the allow-list`);
        return void res.status(403).type('html').send(layout({ title: 'No access', projects: [] }, deniedPage(id.email)));
      }
      const user = userIdOf(id.sub);
      const at = now();
      const loggedOutAt = store.getWebUser(user)?.loggedOutAt; // kept: a session issued before that sign-out stays dead
      store.putWebUser({ id: user, ...(id.name ? { name: id.name } : {}), ...(id.email ? { email: id.email } : {}), seenAt: new Date(at).toISOString(), ...(loggedOutAt ? { loggedOutAt } : {}) });
      const session: Session = { user, iat: at, ...(id.name ? { name: id.name } : {}), ...(id.email ? { email: id.email } : {}), ...(id.groups.length ? { groups: id.groups } : {}) };
      res.setHeader('Set-Cookie', [cookieHeader(LOGIN_COOKIE, '', { secure, clear: true }), cookieHeader(SESSION_COOKIE, sealSession(cfg.sessionSecret, session), { secure, maxAgeMs: SESSION_MAX_AGE_MS })]);
      log.info(`web login: ${id.email ?? user}`);
      res.redirect(303, safeNext(login.next));
    } catch (e) {
      log.error(`web login callback: ${e instanceof Error ? e.message : String(e)}`);
      captureError(e, { subsystem: 'web-login' });
      res.status(400).type('html').send(layout({ title: 'Sign in', projects: [] }, loginPage('The sign-in did not complete — try again.')));
    }
  });

  // Where the identity provider sends the browser after ending its session (a registered logout URL): a page
  // that needs no session and offers the way back in — never `/login` itself, which would start the next
  // sign-in before the person sees anything.
  app.get('/signed-out', (_req, res) => {
    res.type('html').send(layout({ title: 'Signed out', projects: [] }, signedOutPage()));
  });
  // The hand-off to the identity provider's end-session endpoint: a page of ours that refreshes to it. Chrome holds the
  // redirects of a form submission to `form-action 'self'`, so a 303 from POST /logout straight to the provider is
  // blocked ("Sending form data to … violates … form-action", the staging canary); a refresh from a page of ours is a
  // plain navigation. No session needed — the cookie is already gone, and the denied page sends people here to sign in
  // as someone else. Without an end-session endpoint it is the signed-out page.
  app.get('/signing-out', async (_req, res) => {
    let end: URL | undefined;
    if (cfg.auth === 'oidc' && deps.oidc) {
      try {
        end = await deps.oidc.endSessionUrl({ postLogoutRedirectUri: `${cfg.baseUrl}/signed-out` });
      } catch (e) {
        log.warn(`web logout: the end-session URL could not be built, signing out locally only — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!end) return void res.redirect(303, '/signed-out');
    res.type('html').send(layout({ title: 'Signing out', projects: [], refresh: end.toString() }, signingOutPage(end.toString())));
  });

  // ── the session gate ────────────────────────────────────────────────────────────────────────────
  const isApi = (req: Request) => req.path === '/stream' || req.path.startsWith('/post') || req.path === '/action' || req.path === '/dialog' || req.path === '/logout';
  // A session is revoked by a later sign-out of its person (every copy of the cookie, not only this browser's), and
  // the allow-list is checked on every request, so taking someone off it takes effect without waiting for the
  // cookie to expire (the security review of 2026-10-30).
  const revoked = (s: Session): boolean => {
    const out = store.getWebUser(s.user)?.loggedOutAt;
    return !!out && s.iat < Date.parse(out);
  };
  app.use((req: Req, res, next) => {
    const s = openSession(cfg.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE], now());
    if (!s || revoked(s)) {
      if (isApi(req)) return void res.status(401).json({ error: 'not signed in' });
      return void res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (cfg.auth === 'oidc' && !isAllowed(cfg.allow, { ...(s.email ? { email: s.email } : {}), groups: s.groups ?? [] })) {
      if (isApi(req)) return void res.status(403).json({ error: 'no access' });
      return void res.status(403).type('html').send(layout({ title: 'No access', projects: [] }, deniedPage(s.email)));
    }
    req.session = s;
    next();
  });
  // Every POST: the CSRF token (header or form field) bound to the session, and a same-origin fetch.
  app.use((req: Req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const token = (req.get('x-csrf') ?? (req.body as { csrf?: unknown } | undefined)?.csrf) as string | undefined;
    const site = req.get('sec-fetch-site');
    if (!checkCsrf(cfg.sessionSecret, req.session!, token) || (site && site !== 'same-origin' && site !== 'none')) {
      log.warn(`web: rejected a ${req.method} ${req.path} from ${req.session!.user} without a valid CSRF token`);
      return void res.status(403).json({ error: 'bad csrf' });
    }
    next();
  });

  // The header's name: the login records first (they follow the latest login), the cookie's as the fallback.
  const viewerOf = (s: Session): Viewer => {
    const name = nameOf(s.user) ?? s.name;
    return { user: s.user, ...(name ? { name } : {}), csrf: csrfToken(cfg.sessionSecret, s) };
  };
  // The sidebar's conversations and their last activity (the client marks what the viewer has not seen).
  const activityFor = (user: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of rooms()) {
      for (const conv of [roomConv(p.slug), privateConv(user, p.slug)]) {
        if (history.fileOf(conv) && !existsSync(history.fileOf(conv)!)) continue; // never opened: no file, no activity
        const last = history.conversation(conv).all().at(-1)?.updatedAt;
        if (last) out[conv] = last;
      }
    }
    return out;
  };
  const page = (req: Req, res: Response, shell: Omit<Shell, 'viewer' | 'projects'>, content: ReturnType<typeof homePage>, status = 200) =>
    res.status(status).type('html').send(signButtons(cfg.sessionSecret, layout({ ...shell, viewer: viewerOf(req.session!), projects: rooms(), activity: activityFor(req.session!.user), verbs: VERBS, maxFileMb: cfg.maxFileMb }, content)));
  const notFound = (req: Req, res: Response, what: string) => page(req, res, { title: 'Not found' }, homePage(h404(what)), 404);

  // Sign out: our cookie goes, and so does the identity provider's session when it offers an end-session
  // endpoint — without that, `/login` would sign the person straight back in on the provider's live session
  // (the first staging canary: "logout did not log me out"). The provider is reached through /signing-out (above),
  // never by a redirect from this POST, and returns the browser to /signed-out.
  app.post('/logout', (req: Req, res) => {
    const u = req.session!.user;
    const cur = store.getWebUser(u);
    store.putWebUser({ ...(cur ?? { id: u, seenAt: new Date(now()).toISOString() }), loggedOutAt: new Date(now()).toISOString() });
    res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', { secure, clear: true }));
    res.redirect(303, cfg.auth === 'oidc' && deps.oidc ? '/signing-out' : '/signed-out');
  });

  // ── pages ───────────────────────────────────────────────────────────────────────────────────────
  app.get('/', (req: Req, res) => {
    const mine = rooms();
    const home = renderHomeView(
      mine.length ? { kind: 'home', projects: mine, prefix: '', ...(reg.current.projects.some((p) => p.messaging !== undefined) ? { messaging: true } : {}) } : { kind: 'onboarding' },
      (slug) => `/r/${encodeURIComponent(slug)}`,
    );
    page(req, res, { title: 'Home' }, homePage(home));
  });

  app.get('/r/:slug', (req: Req, res) => {
    const project = roomOf(String(req.params.slug));
    if (!project) return notFound(req, res, 'room');
    const conv = history.conversation(roomConv(project.slug));
    const viewer = req.session!.user;
    const threads = conv
      .threads()
      .filter((t) => visibleFor(viewer, t.root.visibleTo))
      .map((summary) => ({ summary, last: lastVisible(conv.thread(summary.root.id), viewer) }));
    page(req, res, { title: `#${project.slug}`, active: { slug: project.slug, kind: 'room' }, stream: { conv: conv.conv } }, roomPage(project, threads, nameOf));
  });

  app.get('/r/:slug/t/:tid', (req: Req, res) => {
    const project = roomOf(String(req.params.slug));
    if (!project) return notFound(req, res, 'room');
    const conv = history.conversation(roomConv(project.slug));
    const root = conv.message(String(req.params.tid));
    if (!root || root.thread) return notFound(req, res, 'thread');
    const viewer = req.session!.user;
    const msgs = conv.thread(root.id).filter((m) => visibleFor(viewer, m.visibleTo));
    page(req, res, { title: `#${project.slug} · thread`, active: { slug: project.slug, kind: 'room' }, stream: { conv: conv.conv, thread: root.id } }, threadPage(project, root.id, msgs, nameOf));
  });

  app.get('/p/:slug', (req: Req, res) => {
    const project = roomOf(String(req.params.slug));
    if (!project) return notFound(req, res, 'room');
    const viewer = viewerOf(req.session!);
    const conv = history.conversation(privateConv(viewer.user, project.slug));
    page(req, res, { title: `${project.slug} · private`, active: { slug: project.slug, kind: 'private' }, stream: { conv: conv.conv } }, privatePage(project, viewer, conv.all().filter((m) => visibleFor(viewer.user, m.visibleTo)), nameOf));
  });

  // ── the live stream ─────────────────────────────────────────────────────────────────────────────
  // One Server-Sent Events connection per open page: the conversation's events after `Last-Event-ID`
  // (replayed on a reconnect), re-rendered for THIS viewer (a private reply reaches its person only),
  // and the person's own pushes (dialogs). A room page gets thread cards, a thread or private page
  // gets message elements.
  const streams = new Map<string, number>(); // person → open streams
  app.get('/stream', (req: Req, res) => {
    const conv = typeof req.query.conv === 'string' ? req.query.conv : '';
    const thread = typeof req.query.thread === 'string' ? req.query.thread : undefined;
    const parsed = parseConv(conv);
    const viewer = req.session!.user;
    if (!parsed || !roomOf(parsed.slug) || (parsed.kind === 'private' && parsed.user !== viewer)) return void res.status(404).json({ error: 'no such conversation' });
    if ((streams.get(viewer) ?? 0) >= STREAMS_PER_PERSON) return void res.status(429).json({ error: 'too many open pages' });
    streams.set(viewer, (streams.get(viewer) ?? 0) + 1);
    const c = history.conversation(conv);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: no proxy buffering on this response
    res.flushHeaders();
    const send = (event: string, id: number | undefined, data: unknown) => {
      const d = data && typeof data === 'object' && typeof (data as { html?: unknown }).html === 'string' ? { ...data, html: signButtons(cfg.sessionSecret, (data as { html: string }).html) } : data;
      res.write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(d)}\n\n`);
    };
    const frame = (ev: Stored) => {
      const m = c.message(ev.id);
      if (!m) return;
      const root = m.thread ?? m.id;
      if (parsed.kind === 'room' && !thread) {
        // The room list: the thread this event touched, re-rendered (a private root stays its person's).
        const rootMsg = c.message(root);
        if (!rootMsg || !visibleFor(viewer, rootMsg.visibleTo)) return send('noop', ev.seq, {});
        const summary = c.threads().find((t) => t.root.id === root);
        if (!summary) return send('noop', ev.seq, {});
        return send('thread', ev.seq, { id: root, html: threadCardHtml(parsed.slug, summary, lastVisible(c.thread(root), viewer), nameOf).html });
      }
      if (thread && root !== thread) return send('noop', ev.seq, {}); // another thread of the room
      if (!visibleFor(viewer, m.visibleTo)) return send('noop', ev.seq, {}); // someone else's private reply (the id still advances)
      // `text` and `own`: for the client's notification while the tab is hidden (a person's own post never notifies).
      send('msg', ev.seq, { id: m.id, thread: m.thread, html: messageHtml(m, nameOf, parsed.slug).html, text: messageBody(m, nameOf, parsed.slug).text, own: m.by?.id === viewer });
    };
    const last = Number(req.get('last-event-id') ?? req.query.since ?? NaN);
    if (Number.isFinite(last)) for (const ev of c.since(last)) frame(ev);
    else send('ready', c.seq, {});
    const offConv = c.subscribe(frame);
    const offUser = driver.onUser(viewer, (p) => send(p.kind, undefined, p));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      offConv();
      offUser();
      const n = (streams.get(viewer) ?? 1) - 1;
      if (n > 0) streams.set(viewer, n);
      else streams.delete(viewer);
    });
  });

  // ── posting, actions, dialogs ───────────────────────────────────────────────────────────────────
  const posts = new Map<string, number[]>(); // user → post times in the last minute
  const rateLimited = (user: string): boolean => {
    const t = now();
    const recent = (posts.get(user) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    posts.set(user, recent);
    return recent.length > POSTS_PER_MINUTE;
  };
  // A failure on the core's path is journaled (and reaches Sentry), and the conversation hears it.
  const reported = (what: string, conv: string, thread: string | undefined) => (e: unknown) => {
    const text = errText(e instanceof Error ? e : new Error(`${what}: ${String(e)}`));
    void driver.post({ conv, ...(thread ? { thread } : {}) }, { kind: 'text', text }).catch(() => {});
  };

  app.post('/post', (req: Req, res) => {
    const s = req.session!;
    const body = (req.body ?? {}) as { conv?: unknown; thread?: unknown; text?: unknown; files?: unknown };
    const conv = typeof body.conv === 'string' ? body.conv : '';
    const thread = typeof body.thread === 'string' && body.thread ? body.thread : undefined;
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
    const parsed = parseConv(conv);
    if (!parsed || !roomOf(parsed.slug)) return void res.status(404).json({ error: 'no such conversation' });
    if (parsed.kind === 'private' && parsed.user !== s.user) return void res.status(403).json({ error: 'not your conversation' });
    if (rateLimited(s.user)) return void res.status(429).json({ error: 'too many messages — wait a minute' });
    const c = history.conversation(conv);
    if (thread) {
      const root = c.message(thread);
      if (!root || root.thread || parsed.kind !== 'room') return void res.status(404).json({ error: 'no such thread' });
    }
    // The files attached: uploaded before the post (PUT /upload), named by id, each found in this conversation's
    // folder for this person — a stranger's id, another conversation's file or a private upload of someone else is
    // simply not there.
    const fileIds = Array.isArray(body.files) ? body.files.filter((x): x is string => typeof x === 'string') : [];
    if (fileIds.length > MAX_FILES) return void res.status(400).json({ error: `at most ${MAX_FILES} files per message` });
    const stored = fileIds.map((fid) => findUpload(deps.filesRoot, parsed.slug, fid, s.user));
    if (stored.some((f) => !f)) return void res.status(400).json({ error: 'an attached file is unknown — attach it again' });
    const files = stored as NonNullable<(typeof stored)[number]>[];
    if (!text && !files.length) return void res.status(400).json({ error: 'empty message' });
    const id = ids();
    const isCmd = text.startsWith('/');
    const meta: FileMeta[] = files.map((f) => ({ id: f.id, name: f.name, size: f.size }));
    c.append({ t: 'post', id, ...(thread ? { thread } : {}), by: { id: s.user, ...(s.name ? { name: s.name } : {}) }, text, ...(isCmd ? { cmd: true as const, visibleTo: s.user } : {}), ...(meta.length ? { files: meta } : {}) });
    const actor = { tenant: cfg.org, user: s.user };
    if (isCmd) {
      // A command typed at a room's top level is its own thread: the typed line is the root and the router's private
      // replies go into it — the page the client opens for the post (the first web canary saw the replies land in the
      // room's list as separate cards while the thread page stayed empty). In a thread or a private conversation the
      // replies stay where the command was typed.
      const replyThread = thread ?? (parsed.kind === 'room' ? id : undefined);
      const ctx: WebCtx = { conv, ...(replyThread ? { thread: replyThread } : {}), user: s.user };
      const line = text.slice(1).replace(CMD_WORD, '');
      // `/help`: the web's own — the Home cheat-sheet, as a dialog on this page (the router knows no help verb).
      if (/^help\b/i.test(line)) void core.home({ ...actor, user: s.user }, driver).catch(reported('help', conv, replyThread));
      else void commands.run({ text: line, conv, actor, ctx }, driver).catch(reported('command', conv, replyThread));
    } else {
      const msg: ChatMessage = {
        conv,
        id,
        ...(thread ? { thread } : {}),
        text,
        actor,
        direct: parsed.kind === 'private',
        hasFiles: files.length > 0,
        files: async () => (files.length ? { refs: files.map(toRef), bearer: '' } : undefined),
        claim: () => true,
      };
      // A top-level post in a room starts a thread (the core's mention path); a reply or a private line continues one.
      const run = parsed.kind === 'room' && !thread ? messages.onMention(msg, driver) : messages.onMessage(msg, driver);
      void run.catch(reported('message', conv, thread ?? (parsed.kind === 'room' ? id : undefined)));
    }
    res.json({ id, ...(parsed.kind === 'room' ? { thread: thread ?? id } : {}) });
  });

  // An upload: the bytes of ONE file, named in the query, into this person's conversation. The size cap is the
  // body parser's (413 names the file below); the type allow-list is the sandbox pipeline's (attachments.ts), applied
  // here already so a refused file is named before the message is sent, not skipped after.
  // An upload is the file's bytes as the body (one request per file, app.js), capped at the configured size — read
  // only here, after the session gate and the CSRF check, so a stranger's body is never buffered.
  app.put('/upload', express.raw({ type: () => true, limit: `${cfg.maxFileMb}mb` }), (req: Req, res) => {
    const s = req.session!;
    const conv = typeof req.query.conv === 'string' ? req.query.conv : '';
    const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : '';
    const parsed = parseConv(conv);
    if (!parsed || !roomOf(parsed.slug) || (parsed.kind === 'private' && parsed.user !== s.user)) return void res.status(404).json({ error: 'no such conversation' });
    if (!name) return void res.status(400).json({ error: 'the upload needs a file name' });
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.byteLength) return void res.status(400).json({ error: `${name} is empty` });
    if (!isSupported(mimeOf(name), name)) return void res.status(415).json({ error: `${name}: not a file type the agent can read (images, PDF, text, office documents)` });
    if (rateLimited(s.user)) return void res.status(429).json({ error: 'too many uploads — wait a minute' });
    const f = storeUpload(deps.filesRoot, conv, name, data);
    log.info(`web: ${s.user} uploaded ${f.name} (${f.size} bytes) to ${conv}`);
    res.json({ id: f.id, name: f.name, size: f.size });
  });

  // A download: the session, then the room's files or the viewer's own private ones (files.ts); served as an
  // attachment with the type its name says and no sniffing, never rendered in the page's origin.
  app.get('/files/:slug/:id', (req: Req, res) => {
    const slug = String(req.params.slug);
    if (!roomOf(slug)) return void res.status(404).json({ error: 'no such room' });
    const f = findUpload(deps.filesRoot, slug, String(req.params.id), req.session!.user);
    if (!f) return void res.status(404).json({ error: 'no such file' });
    res.setHeader('Content-Disposition', attachmentDisposition(f.name));
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(mimeOf(f.name));
    res.sendFile(f.path);
  });

  app.post('/action', (req: Req, res) => {
    const s = req.session!;
    const b = (req.body ?? {}) as { action?: unknown; value?: unknown; sig?: unknown; conv?: unknown; thread?: unknown; msg?: unknown };
    const action = typeof b.action === 'string' ? b.action : '';
    const h = core.actions[action];
    if (!h) return void res.status(400).json({ error: `unknown action ${action}` });
    const value = typeof b.value === 'string' ? b.value : '';
    // Only a button this server rendered (buttons.ts): the core's handlers trust the value as Slack's would.
    if (!verifyButton(cfg.sessionSecret, action, value, b.sig)) {
      log.warn(`web: rejected an unsigned ${action} from ${s.user}`);
      return void res.status(403).json({ error: 'unknown button — reload the page' });
    }
    const conv = typeof b.conv === 'string' ? b.conv : '';
    const parsed = parseConv(conv);
    if (!parsed || !roomOf(parsed.slug) || (parsed.kind === 'private' && parsed.user !== s.user)) return void res.status(404).json({ error: 'no such conversation' });
    const thread = typeof b.thread === 'string' && b.thread ? b.thread : undefined;
    const msgId = typeof b.msg === 'string' && b.msg ? b.msg : undefined;
    const msg = msgId ? history.conversation(conv).message(msgId) : undefined;
    const a: ChatAction = {
      id: action,
      value,
      actor: { tenant: cfg.org, user: s.user },
      where: { conv, ...(thread ? { thread } : {}) },
      ...(msgId ? { msg: { conv, id: msgId, ...(thread ? { thread } : {}) } } : {}),
      msgText: msg && visibleFor(s.user, msg.visibleTo) ? msg.text : undefined,
      canDialog: true,
      ctx: { conv, ...(thread ? { thread } : {}), user: s.user } satisfies WebCtx,
    };
    void h(a, driver).catch(reported(`action ${action}`, conv, thread));
    res.status(202).json({ ok: true });
  });

  app.post('/dialog', (req: Req, res) => {
    const s = req.session!;
    const b = (req.body ?? {}) as { dialog?: unknown; values?: unknown; conv?: unknown; thread?: unknown };
    // The dialog this driver opened for THIS person, and the form it holds: the handler and its metadata come from
    // the server, never from the browser (the security review of 2026-10-30).
    const dialogId = typeof b.dialog === 'string' ? b.dialog : '';
    const d = driver.dialogOf(dialogId);
    if (!d || d.user !== s.user || !d.submit) return void res.status(404).json({ error: 'this dialog has expired — open it again' });
    const id = d.submit.id;
    const h = core.submits[id];
    if (!h) return void res.status(400).json({ error: `unknown dialog ${id}` });
    const values: DialogSubmit['values'] = {};
    if (b.values && typeof b.values === 'object') {
      for (const [k, v] of Object.entries(b.values as Record<string, unknown>)) {
        if (typeof v === 'string') values[k] = v.slice(0, MAX_TEXT);
        else if (Array.isArray(v)) values[k] = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 1000));
      }
    }
    const sub: DialogSubmit = { id, meta: d.submit.meta, values, actor: { tenant: cfg.org, user: s.user } };
    driver.submitted(dialogId);
    // Where a failure is told: a conversation this person may see, or nowhere.
    const pc = typeof b.conv === 'string' ? parseConv(b.conv) : undefined;
    const conv = pc && roomOf(pc.slug) && (pc.kind === 'room' || pc.user === s.user) ? (b.conv as string) : undefined;
    void h(sub, driver).catch((e) => {
      log.error(`web dialog ${id}: ${e instanceof Error ? e.message : String(e)}`);
      captureError(e, { subsystem: 'web-dialog' });
      if (conv) void driver.postPrivate({ conv, ...(typeof b.thread === 'string' && b.thread ? { thread: b.thread } : {}) }, s.user, { kind: 'text', text: errText(e) }).catch(() => {});
    });
    res.status(202).json({ ok: true });
  });

  app.use((req: Req, res) => (isApi(req) ? res.status(404).json({ error: 'not found' }) : notFound(req, res, 'page')));
  app.use((err: unknown, req: Req, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 413 && req.path === '/upload') {
      const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : 'the file';
      return void res.status(413).json({ error: `${name} is too large (limit ${cfg.maxFileMb} MB)` });
    }
    if (status >= 500) {
      log.error(`web ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
      captureError(err, { subsystem: 'web' });
    }
    res.status(status).json({ error: status >= 500 ? 'server error' : (err instanceof Error ? err.message : 'bad request') });
  });

  let listener: Server | undefined;
  return {
    app,
    listen: () =>
      new Promise((resolve, reject) => {
        const l = app.listen(cfg.port, cfg.bind, () => {
          listener = l;
          const addr = l.address();
          resolve({ port: typeof addr === 'object' && addr ? addr.port : cfg.port });
        });
        l.once('error', reject);
      }),
    close: () => new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve())),
  };
}

function lastVisible(msgs: Message[], viewer: string): Message | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (visibleFor(viewer, msgs[i].visibleTo)) return msgs[i];
  return undefined;
}

const h404 = (what: string): Html => h`<h1>Not found</h1><p>No such ${what}.</p>`;
