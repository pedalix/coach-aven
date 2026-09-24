import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepLabel, foldSteps, trailView, TRAIL_BUDGET } from './steps.js';

test('stepLabel — core tools render with their icon and key argument', () => {
  assert.equal(stepLabel('Read', { file_path: '/a/b.php' }), '📖 Read /a/b.php');
  assert.equal(stepLabel('Grep', { pattern: 'voucher' }), '🔍 Grep voucher');
  assert.equal(stepLabel('Bash', { command: 'npm test' }), '⚙️ npm test');
  assert.equal(stepLabel('WebSearch', { query: 'x' }), '🌐 Search x');
});

test('stepLabel — Task and Agent both label as Subtask, numbered when seq given', () => {
  assert.equal(stepLabel('Task', { description: 'find code' }), '🤖 Subtask: find code');
  assert.equal(stepLabel('Agent', { description: 'find code' }), '🤖 Subtask: find code');
  assert.equal(stepLabel('Agent', { prompt: 'dig' }, 2), '🤖 Subtask 2: dig');
});

test('stepLabel — MCP tools render as "server: tool <key arg>"', () => {
  assert.equal(
    stepLabel('mcp__youtrack__search_issues', { query: 'project: CB Voucher' }),
    '🔌 youtrack: search_issues project: CB Voucher',
  );
  assert.equal(stepLabel('mcp__youtrack__get_issue', { id: 'CB-53' }), '🔌 youtrack: get_issue CB-53');
  // no string args → bare server: tool
  assert.equal(stepLabel('mcp__grafana__list_datasources', {}), '🔌 grafana: list_datasources');
});

test('stepLabel — unknown non-MCP tool falls back to a wrench', () => {
  assert.equal(stepLabel('ToolSearch', { query: 'yt' }), '🔧 ToolSearch');
});

test('stepLabel — long arguments are truncated', () => {
  const label = stepLabel('mcp__youtrack__search_issues', { query: 'q'.repeat(100) });
  assert.equal(label.length < 80, true);
  assert.equal(label.endsWith('…'), true);
});

// ── trailView — the fold + elide budget that keeps the modal under Slack's view limit ──

test('foldSteps — consecutive same-kind steps collapse with the range of their arguments', () => {
  const runs = foldSteps(['📖 Read a.php', '📖 Read m.php', '📖 Read z.php', '⚙️ npm test']);
  assert.deepEqual(
    runs.map((r) => r.text),
    ['📖 Read ×3 — a.php … z.php', '⚙️ npm test'],
  );
  assert.deepEqual(runs.map((r) => [r.from, r.to]), [[0, 2], [3, 3]]);
});

test('foldSteps — Bash, narration and subtask spawns never fold', () => {
  const steps = ['⚙️ git status', '⚙️ git diff', '💬 _looking_', '💬 _thinking_', '🤖 Subtask 1: dig', '🤖 Subtask 2: dig'];
  assert.deepEqual(foldSteps(steps).map((r) => r.text), steps);
});

test('foldSteps — the ↳N subagent lane is part of the key, so lanes never merge', () => {
  const runs = foldSteps(['↳1 📖 Read a.php', '↳2 📖 Read b.php', '↳2 📖 Read c.php']);
  assert.deepEqual(
    runs.map((r) => r.text),
    ['↳1 📖 Read a.php', '↳2 📖 Read ×2 — b.php … c.php'],
  );
});

test('foldSteps — MCP folds per (server, tool), not per server', () => {
  const runs = foldSteps([
    '🔌 youtrack: get_issue CB-1',
    '🔌 youtrack: get_issue CB-2',
    '🔌 youtrack: search_issues project: CB',
  ]);
  assert.deepEqual(
    runs.map((r) => r.text),
    ['🔌 youtrack: get_issue ×2 — CB-1 … CB-2', '🔌 youtrack: search_issues project: CB'],
  );
});

test('foldSteps — an argument-less kind collapses to the bare count', () => {
  assert.deepEqual(foldSteps(['📝 Updating plan…', '📝 Updating plan…']).map((r) => r.text), ['📝 Updating plan… ×2']);
});

test('trailView — numbers are the ORIGINAL step indices, ranged over a fold', () => {
  assert.deepEqual(trailView(['⚙️ a', '📖 Read x', '📖 Read y', '⚙️ b']), [
    '1. ⚙️ a',
    '2–3. 📖 Read ×2 — x … y',
    '4. ⚙️ b',
  ]);
});

test('trailView — a trail that fits is returned whole, folding only what repeats', () => {
  const steps = Array.from({ length: 40 }, (_, i) => `⚙️ command number ${i}`);
  assert.deepEqual(trailView(steps).length, 40);
});

test('trailView — folding alone rescues a repetitive trail, no elision needed', () => {
  const steps = Array.from({ length: 5000 }, (_, i) => `📖 Read src/file${i}.php`);
  const out = trailView(steps);
  assert.deepEqual(out, ['1–5000. 📖 Read ×5000 — src/file0.php … src/file4999.php']);
});

test('trailView — an unfoldable trail elides the middle and says how much it hid', () => {
  const steps = Array.from({ length: 4000 }, (_, i) => `⚙️ some shell command number ${i}`);
  const out = trailView(steps);
  const joined = out.join('\n');
  assert.equal(joined.length <= TRAIL_BUDGET, true); // the ceiling holds
  assert.equal(out[0], '1. ⚙️ some shell command number 0');
  assert.equal(out.at(-1), '4000. ⚙️ some shell command number 3999');
  const note = out.filter((l) => l.includes('hidden'));
  assert.equal(note.length, 1);
  // Head + tail + hidden must account for every original step, and the tail gets the bulk.
  const hidden = Number(/… (\d+) steps hidden/.exec(note[0])?.[1]);
  const head = out.indexOf(note[0]);
  const tail = out.length - head - 1;
  assert.equal(head + hidden + tail, 4000);
  assert.equal(tail > head * 3, true);
});

test('trailView — the ceiling holds for a mixed real-shaped trail', () => {
  const steps: string[] = [];
  for (let i = 0; i < 3000; i++) {
    steps.push(`↳${i % 4} 📖 Read /root/work/lumora/app/Http/Controllers/Thing${i}.php`);
    steps.push(`⚙️ cd /root/work/lumora && ./vendor/bin/phpunit --filter Test${i}`);
    if (i % 10 === 0) steps.push(`💬 _narration line ${i} about what is going on_`);
  }
  const joined = trailView(steps).join('\n');
  assert.equal(joined.length <= TRAIL_BUDGET, true);
});
