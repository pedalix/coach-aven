// The web chat's HTTP server (OpenSpec web-chat-driver): pages, the live stream, the actions, the login —
// over Express on a loopback listener behind the installation's reverse proxy. What it does is the
// core's (src/chat/core/): a post becomes a ChatMessage or a ChatCommand, a click a ChatAction, a form a
// DialogSubmit; what it renders is pages.ts / webviews.ts over the history store (history.ts).
//
// Security baseline (design D3/D4): every page and endpoint needs a session (pages redirect to the login,
// endpoints answer 401); every POST needs the session's CSRF token in `x-csrf` (a form also carries it
// in `csrf`) and a same-origin fetch; a strict CSP with no inline script; `no-store` on everything but
// the assets; body limits; a per-person rate limit on posting. The login is OIDC with PKCE through
// auth.ts/oidc.ts, or — on a loopback listener only, config.ts — a fixed local user.

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
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
import { deniedPage, homePage, layout, loginPage, messageBody, messageHtml, privatePage, roomPage, signedOutPage, threadCardHtml, threadPage, type Shell, type Viewer } from './pages.js';
import { LOGIN_COOKIE, LOGIN_MAX_AGE_MS, SESSION_COOKIE, SESSION_MAX_AGE_MS, checkCsrf, cookieHeader, csrfToken, isAllowed, open, openSession, parseCookies, seal, sealSession, type Oidc, type Session } from './auth.js';
import { pkce } from './oidc.js';
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
  /** The login round trip; absent under WEB_AUTH=none. */
  oidc?: Oidc;
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
const POSTS_PER_MINUTE = 30;
const MAX_TEXT = 20_000;
// The router's verbs (src/chat/core/commands.ts), for the composer's suggestions; `help` is the web's own: the Home
// cheat-sheet as a dialog (the router has no help verb — Slack has the App Home tab, Teams the Home card).
const VERBS = ['help', 'home', 'status', 'access', 'memory', 'prompt', 'schedule', 'routines', 'review', 'autofix', 'dream', 'housekeeping', 'users', 'usage', 'asks', 'reload'];
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const STATIC = new URL('./static/', import.meta.url).pathname;
// The Slack spelling of a command (`/aven status`) is accepted too, so a hint copied from an answer works.
const CMD_WORD = new RegExp(`^${CMD.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');

type Req = Request & { session?: Session };

export function createWebServer(deps: WebServerDeps): WebServer {
  const { cfg, store, reg, history, driver, core, messages, commands } = deps;
  const ids = deps.ids ?? (() => newId('m'));
  const now = deps.now ?? Date.now;
  const secure = cfg.baseUrl.startsWith('https://');
  const nameOf = (id: string) => store.getWebUser(id)?.name;
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
  // An upload is the file's bytes as the body (one request per file, app.js), capped at the configured size.
  app.use('/upload', express.raw({ type: () => true, limit: `${cfg.maxFileMb}mb` }));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

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
  const safeNext = (raw: unknown): string => (typeof raw === 'string' && /^\/(?!\/)[^\s]*$/.test(raw) ? raw : '/');

  app.get('/login', async (req, res) => {
    const next = safeNext(req.query.next);
    if (cfg.auth === 'none' || !deps.oidc) {
      store.putWebUser({ id: LOCAL_USER.user, name: LOCAL_USER.name, seenAt: new Date(now()).toISOString() });
      setSession(res, { ...LOCAL_USER, iat: now() });
      return void res.redirect(303, next);
    }
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
    if (cfg.auth === 'none' || !deps.oidc) return void res.redirect(303, '/');
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
      store.putWebUser({ id: user, ...(id.name ? { name: id.name } : {}), ...(id.email ? { email: id.email } : {}), seenAt: new Date(at).toISOString() });
      const session: Session = { user, iat: at, ...(id.name ? { name: id.name } : {}), ...(id.email ? { email: id.email } : {}) };
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

  // ── the session gate ────────────────────────────────────────────────────────────────────────────
  const isApi = (req: Request) => req.path === '/stream' || req.path.startsWith('/post') || req.path === '/action' || req.path === '/dialog' || req.path === '/logout';
  app.use((req: Req, res, next) => {
    const s = openSession(cfg.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE], now());
    if (!s) {
      if (isApi(req)) return void res.status(401).json({ error: 'not signed in' });
      return void res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
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

  const viewerOf = (s: Session): Viewer => ({ user: s.user, ...(s.name ? { name: s.name } : {}), csrf: csrfToken(cfg.sessionSecret, s) });
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
    res.status(status).type('html').send(layout({ ...shell, viewer: viewerOf(req.session!), projects: rooms(), activity: activityFor(req.session!.user), verbs: VERBS, maxFileMb: cfg.maxFileMb }, content));
  const notFound = (req: Req, res: Response, what: string) => page(req, res, { title: 'Not found' }, homePage(h404(what)), 404);

  // Sign out: our cookie goes, and so does the identity provider's session when it offers an end-session
  // endpoint — without that, `/login` would sign the person straight back in on the provider's live session
  // (the first staging canary: "logout did not log me out"). The provider returns the browser to /signed-out.
  app.post('/logout', async (_req, res) => {
    res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', { secure, clear: true }));
    let to = '/signed-out';
    if (cfg.auth === 'oidc' && deps.oidc) {
      try {
        const end = await deps.oidc.endSessionUrl({ postLogoutRedirectUri: `${cfg.baseUrl}/signed-out` });
        if (end) to = end.toString();
      } catch (e) {
        log.warn(`web logout: the end-session URL could not be built, signing out locally only — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    res.redirect(303, to);
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
    page(req, res, { title: `${project.slug} · private`, active: { slug: project.slug, kind: 'private' }, stream: { conv: conv.conv } }, privatePage(project, viewer, conv.all(), nameOf));
  });

  // ── the live stream ─────────────────────────────────────────────────────────────────────────────
  // One Server-Sent Events connection per open page: the conversation's events after `Last-Event-ID`
  // (replayed on a reconnect), re-rendered for THIS viewer (a private reply reaches its person only),
  // and the person's own pushes (dialogs). A room page gets thread cards, a thread or private page
  // gets message elements.
  app.get('/stream', (req: Req, res) => {
    const conv = typeof req.query.conv === 'string' ? req.query.conv : '';
    const thread = typeof req.query.thread === 'string' ? req.query.thread : undefined;
    const parsed = parseConv(conv);
    const viewer = req.session!.user;
    if (!parsed || !roomOf(parsed.slug) || (parsed.kind === 'private' && parsed.user !== viewer)) return void res.status(404).json({ error: 'no such conversation' });
    const c = history.conversation(conv);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: no proxy buffering on this response
    res.flushHeaders();
    const send = (event: string, id: number | undefined, data: unknown) => {
      res.write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
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
  app.put('/upload', (req: Req, res) => {
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
    const b = (req.body ?? {}) as { action?: unknown; value?: unknown; conv?: unknown; thread?: unknown; msg?: unknown };
    const action = typeof b.action === 'string' ? b.action : '';
    const h = core.actions[action];
    if (!h) return void res.status(400).json({ error: `unknown action ${action}` });
    const conv = typeof b.conv === 'string' ? b.conv : '';
    const parsed = parseConv(conv);
    if (!parsed || !roomOf(parsed.slug) || (parsed.kind === 'private' && parsed.user !== s.user)) return void res.status(404).json({ error: 'no such conversation' });
    const thread = typeof b.thread === 'string' && b.thread ? b.thread : undefined;
    const msgId = typeof b.msg === 'string' && b.msg ? b.msg : undefined;
    const a: ChatAction = {
      id: action,
      value: typeof b.value === 'string' ? b.value : '',
      actor: { tenant: cfg.org, user: s.user },
      where: { conv, ...(thread ? { thread } : {}) },
      ...(msgId ? { msg: { conv, id: msgId, ...(thread ? { thread } : {}) } } : {}),
      msgText: msgId ? history.conversation(conv).message(msgId)?.text : undefined,
      canDialog: true,
      ctx: { conv, ...(thread ? { thread } : {}), user: s.user } satisfies WebCtx,
    };
    void h(a, driver).catch(reported(`action ${action}`, conv, thread));
    res.status(202).json({ ok: true });
  });

  app.post('/dialog', (req: Req, res) => {
    const s = req.session!;
    const b = (req.body ?? {}) as { id?: unknown; meta?: unknown; values?: unknown; conv?: unknown; thread?: unknown };
    const id = typeof b.id === 'string' ? b.id : '';
    const h = core.submits[id];
    if (!h) return void res.status(400).json({ error: `unknown dialog ${id}` });
    const values: DialogSubmit['values'] = {};
    if (b.values && typeof b.values === 'object') {
      for (const [k, v] of Object.entries(b.values as Record<string, unknown>)) {
        if (typeof v === 'string') values[k] = v.slice(0, MAX_TEXT);
        else if (Array.isArray(v)) values[k] = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 1000));
      }
    }
    const sub: DialogSubmit = { id, meta: typeof b.meta === 'string' ? b.meta : '', values, actor: { tenant: cfg.org, user: s.user } };
    const conv = typeof b.conv === 'string' && parseConv(b.conv) ? b.conv : undefined;
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
