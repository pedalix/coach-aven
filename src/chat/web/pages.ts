// The web chat's pages, pure (OpenSpec web-chat-driver, design D1): one layout with the rooms in a
// sidebar, and the content of Home, a room (its threads), a thread, a person's private conversation,
// the login and the denied page. Messages are rendered to the same fragment on a page load and on the
// live stream (`messageHtml`, `threadCardHtml`), so what a viewer sees never depends on how it arrived.
// Every value goes through the `h` template; agent and core text through webformat.ts.

import type { ProjectConfig } from '../../projects.js';
import { Html, h, markdownToHtml, plainText, raw } from './webformat.js';
import { fromStored, type Message, type ThreadSummary } from './history.js';
import { renderMessageView, renderPrivateView, type NameOf, type Rendered } from './webviews.js';
import { privateConv, roomConv } from './keys.js';
import { fmtSize } from './files.js';
import type { Mark } from '../driver.js';

export interface Viewer {
  user: string;
  name?: string;
  csrf: string;
}

export interface Shell {
  title: string;
  viewer?: Viewer;
  projects: ProjectConfig[]; // the rooms to list (webRoom !== false)
  active?: { slug: string; kind: 'room' | 'private' };
  /** The stream this page listens to, when it shows a live conversation. */
  stream?: { conv: string; thread?: string };
  /** The last activity (ISO) per conversation the sidebar lists — the client marks the ones it has not seen. */
  activity?: Record<string, string>;
  /** The command verbs the composer suggests after `/`. */
  verbs?: string[];
  /** The per-file upload limit, for the client's check before an upload. */
  maxFileMb?: number;
}

const MARK_LABEL: Record<Mark, string> = { working: '👀 seen', done: '✅ done', failed: '❌ failed', note: '🤫 note' };

const time = (iso: string): Html => h`<time datetime="${iso}" title="${iso}">${iso.slice(11, 16)}</time>`;

/** A person's text: escaped, line breaks kept, a command shown as code. */
function personText(m: Message): Html {
  const text = m.text ?? '';
  if (m.cmd) return h`<p><code>${text}</code></p>`;
  return markdownToHtml(text);
}

/** The files a person attached: download links (the session is checked on the way, server.ts). */
function filesHtml(slug: string, m: Message): Html {
  if (!m.files?.length) return raw('');
  return h`<ul class="files">${m.files.map((f) => h`<li><a href="/files/${encodeURIComponent(slug)}/${encodeURIComponent(f.id)}">📎 ${f.name}</a> <span class="meta">${fmtSize(f.size)}</span></li>`)}</ul>`;
}

/** The body of a stored message: a person's post, the bot's view, or a private reply. */
export function messageBody(m: Message, nameOf: NameOf, slug = ''): Rendered {
  if (m.by) return { html: h`${personText(m)}${filesHtml(slug, m)}`, text: plainText(m.text ?? '') || (m.files?.length ? `📎 ${m.files.map((f) => f.name).join(', ')}` : '') };
  if (m.priv) return renderPrivateView(m.priv, { nameOf });
  if (m.view) return renderMessageView(fromStored(m.view), { nameOf, tally: m.tally });
  return { html: h`<p class="meta">(empty)</p>`, text: '' };
}

/** The whole message element — swapped in place by the client on an update. */
export function messageHtml(m: Message, nameOf: NameOf, slug = ''): Html {
  const body = messageBody(m, nameOf, slug);
  const who = m.by ? (m.by.name ?? nameOf(m.by.id) ?? m.by.id) : 'Aven';
  const cls = ['msg', m.by ? 'person' : 'bot', m.visibleTo ? 'private' : '', m.by?.id].filter(Boolean).join(' ');
  return h`<article class="${cls}" id="msg-${m.id}" data-id="${m.id}"${m.thread ? h` data-thread="${m.thread}"` : ''}><header><span class="who">${who}</span> ${time(m.at)}${m.visibleTo ? h` <span class="tag">only you</span>` : ''}${m.marks.length ? h` <span class="marks">${m.marks.map((k) => h`<span class="mark mark-${k}">${MARK_LABEL[k]}</span>`)}</span>` : ''}</header><div class="body">${body.html}</div></article>`;
}

/** A thread in the room list: the root post, who, when, how many replies, the latest line. */
export function threadCardHtml(slug: string, t: ThreadSummary, last: Message | undefined, nameOf: NameOf): Html {
  const root = t.root;
  const who = root.by ? (root.by.name ?? nameOf(root.by.id) ?? root.by.id) : 'Aven';
  const title = root.by ? plainText(root.text ?? '', 140) || messageBody(root, nameOf, slug).text : messageBody(root, nameOf, slug).text || 'Aven';
  const latest = last && last.id !== root.id ? messageBody(last, nameOf, slug).text : '';
  return h`<a class="thread-card" id="thread-${root.id}" href="/r/${encodeURIComponent(slug)}/t/${encodeURIComponent(root.id)}"><div class="title">${title || '(empty)'}</div><div class="meta"><span class="who">${who}</span> · ${time(root.at)} · ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'}${latest ? h` · <span class="latest">${latest.slice(0, 120)}</span>` : ''}</div></a>`;
}

// The composer: the text, the files picked (or dropped / pasted — app.js), the send button; `/` opens the verb
// suggestions. `required` is off because a file alone is a message (the core's FILES_ONLY).
const composer = (placeholder: string, hint: Html): Html =>
  h`<form class="composer" id="composer" autocomplete="off"><textarea name="text" rows="2" maxlength="20000" placeholder="${placeholder}"></textarea><ul class="suggest" id="suggest" hidden></ul><ul class="pending-files" id="pending" hidden></ul><div class="composer-row"><span class="hint">${hint}</span><span class="composer-tools"><label class="btn small">📎 Attach<input type="file" id="file-input" multiple hidden></label><button type="submit" class="btn primary">Send</button></span></div></form>`;

export function roomPage(project: ProjectConfig, threads: { summary: ThreadSummary; last?: Message }[], nameOf: NameOf): Html {
  return h`<section class="room" data-conv="${roomConv(project.slug)}"><header class="page-head"><h1>${project.slug}</h1><p class="meta">${project.repos.join(', ')}</p></header>${composer('Start a new thread — a task for the agent, or a note beginning with !', h`A top-level post starts a thread; <code>!</code> for a note; <code>/help</code> for commands.`)}<div class="threads" id="threads">${threads.length ? threads.map((t) => threadCardHtml(project.slug, t.summary, t.last, nameOf)) : h`<p class="meta empty">No threads yet.</p>`}</div></section>`;
}

export function threadPage(project: ProjectConfig, rootId: string, messages: Message[], nameOf: NameOf): Html {
  return h`<section class="thread" data-conv="${roomConv(project.slug)}" data-thread="${rootId}"><header class="page-head"><p class="crumbs"><a href="/r/${encodeURIComponent(project.slug)}">${project.slug}</a> › thread</p></header><div class="messages" id="messages">${messages.map((m) => messageHtml(m, nameOf, project.slug))}</div>${composer('Reply in this thread…', h`Replies continue the agent's session. <code>/help</code> for commands.`)}</section>`;
}

export function privatePage(project: ProjectConfig, viewer: Viewer, messages: Message[], nameOf: NameOf): Html {
  return h`<section class="private" data-conv="${privateConv(viewer.user, project.slug)}"><header class="page-head"><h1>${project.slug} <span class="tag">private</span></h1><p class="meta">Only you see this conversation. ${project.repos.join(', ')}</p></header><div class="messages" id="messages">${messages.length ? messages.map((m) => messageHtml(m, nameOf, project.slug)) : h`<p class="meta empty">Ask the agent something — nobody else sees this conversation.</p>`}</div>${composer('Ask the agent privately…', h`<code>/help</code> for commands.`)}</section>`;
}

export function homePage(content: Html): Html {
  return h`<section class="home">${content}</section>`;
}

export function loginPage(error?: string): Html {
  return h`<section class="login"><h1>Aven</h1><p>Sign in to reach your projects' agent.</p>${error ? h`<p class="error">${error}</p>` : ''}<p><a class="btn primary" href="/login">Sign in</a></p></section>`;
}

export function deniedPage(email: string | undefined): Html {
  return h`<section class="denied"><h1>No access</h1><p>${email ? h`<strong>${email}</strong> is signed in but not on this installation's list.` : 'Your account is not on this installation\'s list.'} Ask the operator to add you.</p><form method="post" action="/logout"><button type="submit" class="btn">Sign out</button></form></section>`;
}

/** The page shell: sidebar with rooms and private conversations, header with the person, the content, the dialog host. */
export function layout(shell: Shell, content: Html): string {
  const v = shell.viewer;
  const nav = v
    ? h`<nav class="side"><a class="brand" href="/">Aven</a><h2>Rooms</h2><ul>${shell.projects.map((p) => h`<li><a href="/r/${encodeURIComponent(p.slug)}" data-conv="${roomConv(p.slug)}" data-last="${shell.activity?.[roomConv(p.slug)] ?? ''}"${shell.active?.slug === p.slug && shell.active.kind === 'room' ? ' class="active"' : ''}>#${p.slug}</a></li>`)}</ul><h2>Private</h2><ul>${shell.projects.map((p) => h`<li><a href="/p/${encodeURIComponent(p.slug)}" data-conv="${privateConv(v.user, p.slug)}" data-last="${shell.activity?.[privateConv(v.user, p.slug)] ?? ''}"${shell.active?.slug === p.slug && shell.active.kind === 'private' ? ' class="active"' : ''}>🔒 ${p.slug}</a></li>`)}</ul></nav>`
    : raw('');
  const head = v
    ? h`<header class="top"><button type="button" class="btn small" id="notify" title="Browser notifications for answers while this tab is in the background">🔔 Notify</button><span class="viewer">${v.name ?? v.user}</span><form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${v.csrf}"><button type="submit" class="btn small">Sign out</button></form></header>`
    : raw('');
  const streamUrl = shell.stream ? `/stream?conv=${encodeURIComponent(shell.stream.conv)}${shell.stream.thread ? `&thread=${encodeURIComponent(shell.stream.thread)}` : ''}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h`${shell.title}`.html} · Aven</title>
${v ? h`<meta name="csrf" content="${v.csrf}">`.html : ''}
${streamUrl ? h`<meta name="stream" content="${streamUrl}">`.html : ''}
${shell.verbs?.length ? h`<meta name="verbs" content="${shell.verbs.join(' ')}">`.html : ''}
${shell.maxFileMb ? h`<meta name="max-file-mb" content="${shell.maxFileMb}">`.html : ''}
<link rel="stylesheet" href="/assets/app.css">
</head>
<body class="${v ? 'in' : 'out'}">
${nav.html}
<div class="main">${head.html}<main id="main">${content.html}</main></div>
<dialog id="dlg"><div class="dlg-head"><h2 id="dlg-title"></h2><button type="button" class="btn small" id="dlg-close">Close</button></div><div id="dlg-body"></div></dialog>
<div id="toast" hidden></div>
<script src="/assets/app.js" defer></script>
</body>
</html>
`;
}
