import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, emit, formatEvent, type EventName, type EventSink } from './events.js';

function sink(now = 0) {
  const logged: { level: string; line: string }[] = [];
  const captured: { line: string; level: string; tags: Record<string, string> }[] = [];
  const s: EventSink & { t: number } = {
    t: now,
    log: (level, line) => void logged.push({ level, line }),
    capture: (line, level, tags) => void captured.push({ line, level, tags }),
    now: () => s.t,
  };
  return { s, logged, captured };
}

test('emit — every catalogued event logs at its level; warnings and errors also reach Sentry, explicitly', () => {
  for (const [name, def] of Object.entries(EVENTS) as [EventName, (typeof EVENTS)[EventName]][]) {
    const { s, logged, captured } = sink();
    emit(name, Object.fromEntries(def.fields.map((f) => [f, 'x'])), { sink: s });
    assert.equal(logged.length, 1, name);
    assert.equal(logged[0]!.level, def.level, name);
    assert.equal(captured.length, def.level === 'info' ? 0 : 1, `${name}: Sentry only for warnings and errors`);
    if (captured[0]) assert.deepEqual(captured[0].tags, { area: 'messaging', event: name });
  }
});

test('formatEvent — catalogue order, quoted when needed; an unknown field is a bug', () => {
  assert.equal(formatEvent('ask.rejected', { reason: 'unsupported version', from: 'home/nora', versions: { theirs: 2, ours: 1 } }), 'messaging ask.rejected from=home/nora reason="unsupported version" versions="{\\"theirs\\":2,\\"ours\\":1}"');
  assert.throws(() => formatEvent('hub.replaced', { installation: 'home', who: 'x' }), /has no field who/);
});

test('emit — onceEvery drops repeats of the same key inside the window (hub.connect.failed once per reason per hour)', () => {
  const { s, logged } = sink(0);
  const once = (reason: string) => emit('hub.connect.failed', { installation: 'home', reason }, { sink: s, onceEvery: { key: reason, ms: 3_600_000 } });
  once('bad_sig');
  once('bad_sig');
  once('unknown');
  s.t = 3_600_000;
  once('bad_sig');
  assert.deepEqual(logged.map((l) => l.line), [
    'messaging hub.connect.failed installation=home reason=bad_sig',
    'messaging hub.connect.failed installation=home reason=unknown',
    'messaging hub.connect.failed installation=home reason=bad_sig',
  ]);
});
