// The hostile-input suite (web-chat-driver D4): what an answer may carry and what reaches the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, h, markdownToHtml, mentionsToText, mrkdwnToHtml, plainText, raw } from './webformat.js';

test('raw HTML in an answer is text: script tags, event handlers, iframes, svg', () => {
  const out = markdownToHtml('hi <script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src="https://e.example"></iframe> <svg onload=alert(1)>').html;
  assert.ok(!/<script|<img|<iframe|<svg/.test(out), out);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('links: http, https and mailto render; javascript:, data:, vbscript:, file: become text; every link opens in a new tab without a referrer', () => {
  const ok = markdownToHtml('[a](https://x.example/p?q=1&r=2) [b](http://x.example) [c](mailto:ann@corp.example)').html;
  assert.equal((ok.match(/<a /g) ?? []).length, 3);
  assert.match(ok, /href="https:\/\/x\.example\/p\?q=1&amp;r=2" target="_blank" rel="noopener noreferrer"/);
  // A refused link stays the text the agent wrote — visible, inert: no anchor, no href.
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd']) {
    const out = markdownToHtml(`[click](${bad})`).html;
    assert.ok(!out.includes('<a ') && !out.includes('href'), `${bad} → ${out}`);
  }
  // A javascript: autolink is text too.
  assert.ok(!markdownToHtml('<javascript:alert(1)>').html.includes('<a '));
});

test('images are links, never <img>; a refused image source is a plain marker', () => {
  assert.match(markdownToHtml('![shot](https://x.example/a.png)').html, /<a class="img-link" href="https:\/\/x\.example\/a\.png"[^>]*>🖼 shot<\/a>/);
  assert.ok(!markdownToHtml('![shot](https://x.example/a.png)').html.includes('<img'));
  // A refused image stays the text the agent wrote, like a refused link.
  for (const bad of ['![x](javascript:alert(1))', '![x](data:image/png;base64,AAAA)']) {
    const refused = markdownToHtml(bad).html;
    assert.ok(!refused.includes('<a ') && !refused.includes('<img') && !refused.includes('src='), refused);
  }
});

test('code keeps nested HTML as text; attributes in link titles are escaped', () => {
  const out = markdownToHtml('```html\n<div onclick="x()">\n```\n`<b>` [t](https://x.example "a\\" onmouseover=\\"y")').html;
  assert.match(out, /<pre><code class="language-html">&lt;div onclick=&quot;x\(\)&quot;&gt;\n<\/code><\/pre>/);
  assert.match(out, /<code>&lt;b&gt;<\/code>/);
  assert.ok(!/onmouseover=\\?"y/.test(out.replace(/&quot;/g, '')) || !out.includes(' onmouseover='), out);
});

test('markdown constructs the agent uses render: headings, lists, tables, emphasis, task lists as text', () => {
  const out = markdownToHtml('# H\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n**bold** _it_ ~~gone~~').html;
  assert.match(out, /<h1>H<\/h1>/);
  assert.match(out, /<ul>\n<li>a<\/li>/);
  assert.match(out, /<table>/);
  assert.match(out, /<strong>bold<\/strong> <em>it<\/em> <s>gone<\/s>/);
});

test('a single newline is a line break: the status line’s steps stay on their own lines, as on Slack', () => {
  assert.equal(mrkdwnToHtml('🔎 *Working* — 0:12\n• 📖 Read src/a.ts\n• ✏️ Edit src/a.ts').html, '<p>🔎 <strong>Working</strong> — 0:12<br>\n• 📖 Read src/a.ts<br>\n• ✏️ Edit src/a.ts</p>\n');
  assert.equal(markdownToHtml('line one\nline two').html, '<p>line one<br>\nline two</p>\n');
});

test('the core’s mrkdwn: bold, shortcode emoji, <url|label> links, `/aven verb` → `/verb`, mentions by name', () => {
  const out = mrkdwnToHtml(':information_source: *Working* — see <https://x.example/pr/7|PR 7> and `/aven status`; ping <@u1> and <@u9>', (id) => (id === 'u1' ? 'Ann' : undefined)).html;
  assert.match(out, /ℹ️ <strong>Working<\/strong> — see <a href="https:\/\/x\.example\/pr\/7"[^>]*>PR 7<\/a> and <code>\/status<\/code>; ping @Ann and @u9/);
  assert.equal(mentionsToText('hi <@u1|ann>', () => 'Ann'), 'hi @Ann');
});

test('the h template escapes values and embeds Html; plainText strips markup and cuts', () => {
  const name = '<b>Ann</b> & "co"';
  assert.equal(h`<p title="${name}">${name} ${raw('<i>ok</i>')} ${[1, raw('<u/>')]}</p>`.html, '<p title="&lt;b&gt;Ann&lt;/b&gt; &amp; &quot;co&quot;">&lt;b&gt;Ann&lt;/b&gt; &amp; &quot;co&quot; <i>ok</i> 1<u/></p>');
  assert.equal(escapeHtml("<'>"), '&lt;&#39;&gt;');
  assert.equal(plainText('# Title\n\n*Working* — `code` and [link](https://x.example) ![i](https://x.example/a.png)\n```js\nx\n```'), 'Title Working — code and link i [code]');
  assert.equal(plainText('a'.repeat(200), 20).length, 20);
});
