// The web chat's client (OpenSpec web-chat-driver, design D1): a few hundred lines, no framework. It
// listens to the page's live stream and swaps fragments in, posts the composer, forwards button clicks
// as actions and dialog forms as submissions — all to same-origin endpoints with the session's CSRF
// token. Nothing here renders agent text: the server sends finished, sanitized HTML.
(function () {
  'use strict';
  var meta = function (name) { var m = document.querySelector('meta[name="' + name + '"]'); return m ? m.getAttribute('content') : null; };
  var csrf = meta('csrf');
  var streamUrl = meta('stream');
  var main = document.getElementById('main');
  var section = main && main.querySelector('[data-conv]');
  var conv = section ? section.getAttribute('data-conv') : null;
  var thread = section ? section.getAttribute('data-thread') : null;
  var dlg = document.getElementById('dlg');
  var toastEl = document.getElementById('toast');

  function toast(text, ms) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, ms || 3000);
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf || '' }, body: JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('signed out'); }
        return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status)); return j; });
      });
  }

  // ── fragments ──
  function replaceOrAppend(containerId, elId, html) {
    var tmp = document.createElement('template');
    tmp.innerHTML = html.trim();
    var el = tmp.content.firstElementChild;
    if (!el) return;
    var cur = document.getElementById(elId);
    if (cur) { cur.replaceWith(el); return el; }
    var box = document.getElementById(containerId);
    if (!box) return;
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    if (containerId === 'threads') box.prepend(el); else box.appendChild(el);
    return el;
  }
  function nearBottom() { return (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 240); }
  function scrollBottom() { window.scrollTo(0, document.body.scrollHeight); }

  // ── the stream ──
  var unread = 0;
  var baseTitle = document.title;
  function onVisible() { if (!document.hidden) { unread = 0; document.title = baseTitle; } }
  document.addEventListener('visibilitychange', onVisible);
  function noteActivity() { if (document.hidden) { unread++; document.title = '(' + unread + ') ' + baseTitle; } }

  if (streamUrl && window.EventSource) {
    var es = new EventSource(streamUrl);
    es.addEventListener('msg', function (e) {
      var d = JSON.parse(e.data);
      var stick = nearBottom();
      replaceOrAppend('messages', 'msg-' + d.id, d.html);
      if (stick) scrollBottom();
      noteActivity();
    });
    es.addEventListener('thread', function (e) {
      var d = JSON.parse(e.data);
      var el = replaceOrAppend('threads', 'thread-' + d.id, d.html);
      // Fresh activity moves the thread to the top, as the server orders them.
      var box = document.getElementById('threads');
      if (el && box && box.firstElementChild !== el) box.prepend(el);
      noteActivity();
    });
    es.addEventListener('dialog', function (e) { showDialog(JSON.parse(e.data)); });
    es.onerror = function () { toast('Connection lost — reconnecting…', 2500); };
    es.onopen = function () { if (es.wasDown) toast('Reconnected', 1500); es.wasDown = true; };
  }

  // ── dialogs ──
  var openDialogId = null;
  function showDialog(d) {
    if (!dlg) return;
    if (openDialogId && openDialogId !== d.id && dlg.open) return; // one dialog at a time: a stale update does not replace a new one
    openDialogId = d.id;
    document.getElementById('dlg-title').textContent = d.title || '';
    document.getElementById('dlg-body').innerHTML = d.html || '';
    if (!dlg.open) dlg.showModal();
  }
  function closeDialog() { if (dlg && dlg.open) dlg.close(); openDialogId = null; }
  var closeBtn = document.getElementById('dlg-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  if (dlg) dlg.addEventListener('close', function () { openDialogId = null; });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.classList.contains('dialog-form')) {
      e.preventDefault();
      var multi = (form.getAttribute('data-multi') || '').split(',').filter(Boolean);
      var values = {};
      var fd = new FormData(form);
      fd.forEach(function (v, k) {
        if (typeof v !== 'string') return;
        if (multi.indexOf(k) >= 0 || form.querySelectorAll('[name="' + k + '"][type="checkbox"]').length) {
          if (!Array.isArray(values[k])) values[k] = [];
          values[k].push(v);
        } else values[k] = v;
      });
      multi.forEach(function (k) { if (!values[k]) values[k] = []; });
      post('/dialog', { id: form.getAttribute('data-dialog'), meta: form.getAttribute('data-meta') || '', values: values, conv: conv, thread: thread })
        .then(function () { closeDialog(); toast('Sent'); })
        .catch(function (err) { toast(err.message); });
      return;
    }
    if (form.id === 'composer') {
      e.preventDefault();
      send(form);
    }
  });

  // ── the composer ──
  function send(form) {
    var ta = form.querySelector('textarea');
    var text = ta.value.trim();
    if (!text || !conv) return;
    ta.disabled = true;
    post('/post', { conv: conv, thread: thread, text: text })
      .then(function (r) {
        ta.value = '';
        ta.disabled = false;
        ta.focus();
        // A top-level room post opens its thread: go there.
        if (!thread && conv.indexOf('room:') === 0 && r.thread) location.href = location.pathname.replace(/\/$/, '') + '/t/' + encodeURIComponent(r.thread);
        else scrollBottom();
      })
      .catch(function (err) { ta.disabled = false; toast(err.message); });
  }
  var composer = document.getElementById('composer');
  if (composer) {
    var ta = composer.querySelector('textarea');
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(composer); }
    });
    ta.focus();
  }

  // ── actions ──
  document.addEventListener('click', function (e) {
    var btn = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    e.preventDefault();
    if (btn.classList.contains('confirm') && !window.confirm('Are you sure? This cannot be undone.')) return;
    var article = btn.closest('article.msg');
    var body = { action: btn.getAttribute('data-action'), value: btn.getAttribute('data-value') || '', conv: conv, thread: thread || (article ? article.getAttribute('data-thread') : null), msg: article ? article.getAttribute('data-id') : null };
    // A click inside a dialog (a ticket's buttons) has no message element; the dialog is the context.
    btn.disabled = true;
    post('/action', body)
      .then(function () { btn.disabled = false; })
      .catch(function (err) { btn.disabled = false; toast(err.message); });
  });

  if (thread || (conv && conv.indexOf('pc:') === 0)) scrollBottom();
})();
