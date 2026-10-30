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
  var verbs = (meta('verbs') || '').split(' ').filter(Boolean);
  var maxFileMb = Number(meta('max-file-mb') || '20');

  // ── seen / unread (per browser, localStorage): the sidebar marks conversations with activity this browser has not opened ──
  var SEEN_KEY = 'aven.seen';
  function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) { return {}; } }
  function markSeen(c) { if (!c) return; try { var m = seenMap(); m[c] = new Date().toISOString(); localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {} paintUnread(); }
  function paintUnread() {
    var m = seenMap();
    document.querySelectorAll('nav.side a[data-conv]').forEach(function (a) {
      var last = a.getAttribute('data-last') || '';
      var seen = m[a.getAttribute('data-conv')] || '';
      a.classList.toggle('unread', !!last && last > seen && a.getAttribute('data-conv') !== conv);
    });
  }
  paintUnread();
  if (conv) markSeen(conv);

  // ── browser notifications while the tab is hidden (opt-in: the 🔔 button asks for the permission) ──
  var notifyBtn = document.getElementById('notify');
  function paintNotify() { if (!notifyBtn) return; var on = window.Notification && Notification.permission === 'granted'; notifyBtn.classList.toggle('on', !!on); notifyBtn.textContent = on ? '🔔 On' : '🔔 Notify'; }
  if (notifyBtn) {
    if (!window.Notification) notifyBtn.hidden = true;
    else notifyBtn.addEventListener('click', function () { Notification.requestPermission().then(paintNotify); });
    paintNotify();
  }
  function notify(text) {
    if (!window.Notification || Notification.permission !== 'granted' || !document.hidden || !text) return;
    try { var n = new Notification('CoachAven', { body: text.slice(0, 160), tag: 'aven-' + (conv || 'home') }); n.onclick = function () { window.focus(); n.close(); }; } catch (e) {}
  }

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
  function onVisible() { if (!document.hidden) { unread = 0; document.title = baseTitle; markSeen(conv); } }
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
      if (!d.own) notify(d.text);
      if (!document.hidden) markSeen(conv);
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
      post('/dialog', { dialog: openDialogId, values: values, conv: conv, thread: thread })
        .then(function () { closeDialog(); toast('Sent'); })
        .catch(function (err) { toast(err.message); });
      return;
    }
    if (form.id === 'composer') {
      e.preventDefault();
      send(form);
    }
  });

  // ── the composer: text, files (picked, dropped or pasted), `/` suggestions ──
  var pending = []; // files picked but not sent yet
  var pendingEl = document.getElementById('pending');
  function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
  function paintPending() {
    if (!pendingEl) return;
    pendingEl.innerHTML = '';
    pending.forEach(function (f, i) {
      var li = document.createElement('li');
      li.textContent = '📎 ' + f.name + ' · ' + fmtSize(f.size) + ' ';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'btn small'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', function () { pending.splice(i, 1); paintPending(); });
      li.appendChild(x);
      pendingEl.appendChild(li);
    });
    pendingEl.hidden = !pending.length;
  }
  // The limit is checked here, before any byte leaves the browser: the post is not sent and the file is named.
  function addFiles(list) {
    Array.prototype.forEach.call(list, function (f) {
      if (!f || !f.name) return;
      if (f.size > maxFileMb * 1048576) { toast(f.name + ' is too large (limit ' + maxFileMb + ' MB)', 5000); return; }
      if (pending.length >= 10) { toast('At most 10 files per message', 4000); return; }
      pending.push(f);
    });
    paintPending();
  }
  function upload(f) {
    return fetch('/upload?conv=' + encodeURIComponent(conv) + '&name=' + encodeURIComponent(f.name), { method: 'PUT', headers: { 'content-type': f.type || 'application/octet-stream', 'x-csrf': csrf || '' }, body: f, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status)); return j.id; }); });
  }
  function send(form) {
    var ta = form.querySelector('textarea');
    var text = ta.value.trim();
    if ((!text && !pending.length) || !conv) return;
    ta.disabled = true;
    var files = pending.slice();
    var ids = [];
    var chain = Promise.resolve();
    files.forEach(function (f, i) {
      chain = chain.then(function () { toast('Uploading ' + (i + 1) + '/' + files.length + ': ' + f.name, 60000); return upload(f).then(function (id) { ids.push(id); }); });
    });
    chain
      .then(function () { return post('/post', { conv: conv, thread: thread, text: text, files: ids }); })
      .then(function (r) {
        ta.value = '';
        ta.disabled = false;
        pending = []; paintPending();
        if (toastEl) toastEl.hidden = true;
        ta.focus();
        // A top-level room post opens its thread: go there.
        if (!thread && conv.indexOf('room:') === 0 && r.thread) location.href = location.pathname.replace(/\/$/, '') + '/t/' + encodeURIComponent(r.thread);
        else scrollBottom();
      })
      .catch(function (err) { ta.disabled = false; toast(err.message, 5000); });
  }
  // `/verb` suggestions: a list under the textarea while the text is a lone slash-word; click or Tab completes.
  var suggestEl = document.getElementById('suggest');
  function paintSuggest(ta) {
    if (!suggestEl) return;
    var m = /^\/([a-z]*)$/i.exec(ta.value);
    if (!m) { suggestEl.hidden = true; return; }
    var hits = verbs.filter(function (v) { return v.indexOf(m[1].toLowerCase()) === 0; });
    suggestEl.innerHTML = '';
    hits.forEach(function (v) {
      var li = document.createElement('li');
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = '/' + v;
      b.addEventListener('click', function () { ta.value = '/' + v + ' '; suggestEl.hidden = true; ta.focus(); });
      li.appendChild(b); suggestEl.appendChild(li);
    });
    suggestEl.hidden = !hits.length;
  }
  var composer = document.getElementById('composer');
  if (composer) {
    var ta = composer.querySelector('textarea');
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && suggestEl && !suggestEl.hidden) { var first = suggestEl.querySelector('button'); if (first) { e.preventDefault(); first.click(); return; } }
      if (e.key === 'Escape' && suggestEl) suggestEl.hidden = true;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(composer); }
    });
    ta.addEventListener('input', function () { paintSuggest(ta); });
    ta.addEventListener('paste', function (e) { var items = e.clipboardData && e.clipboardData.files; if (items && items.length) { e.preventDefault(); addFiles(items); } });
    var input = document.getElementById('file-input');
    if (input) input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    composer.addEventListener('dragover', function (e) { e.preventDefault(); composer.classList.add('drop'); });
    composer.addEventListener('dragleave', function () { composer.classList.remove('drop'); });
    composer.addEventListener('drop', function (e) { e.preventDefault(); composer.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
    ta.focus();
  }

  // ── actions ──
  document.addEventListener('click', function (e) {
    var btn = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    e.preventDefault();
    if (btn.classList.contains('confirm') && !window.confirm('Are you sure? This cannot be undone.')) return;
    var article = btn.closest('article.msg');
    var body = { action: btn.getAttribute('data-action'), value: btn.getAttribute('data-value') || '', sig: btn.getAttribute('data-sig') || '', conv: conv, thread: thread || (article ? article.getAttribute('data-thread') : null), msg: article ? article.getAttribute('data-id') : null };
    // A click inside a dialog (a ticket's buttons) has no message element; the dialog is the context.
    btn.disabled = true;
    post('/action', body)
      .then(function () { btn.disabled = false; })
      .catch(function (err) { btn.disabled = false; toast(err.message); });
  });

  if (thread || (conv && conv.indexOf('pc:') === 0)) scrollBottom();
})();
