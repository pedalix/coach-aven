// The hub's reporter (design D16, task 7.4): what a line becomes in Sentry, the SDK options, and — with
// the Worker's test DSN (vitest.config.ts, answered by test/setup.ts) — a refusal that really arrives.
import { describe, expect, it } from 'vitest';
import { connect, freshKey, keyOf, login, sign, waitClosed } from './client.js';
import { sentryRequests } from './setup.js';
import { challengeText } from '../../src/messaging/protocol.js';
import { log, SENTRY_KEYS_MAX, sentryKeys, sentryOptions, toSentry } from '../src/report.js';

interface SentEvent {
  message?: string;
  level?: string;
  environment?: string;
  tags?: Record<string, string>;
}
const events = (): SentEvent[] =>
  sentryRequests().flatMap((r) => r.lines.filter((l): l is SentEvent => typeof l === 'object' && l !== null && 'message' in l));
const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms; sent: ${JSON.stringify(events())}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('What reaches Sentry', () => {
  it('Info stays in the logs; warnings and errors become one tagged line', () => {
    expect(toSentry('info', 'hub.expired', { task: 't1' })).toBeUndefined();
    expect(toSentry('warn', 'hub.rejected', { from: 'home', to: 'bluefin/caldora', method: 'message/send', reason: 'backlog' })).toEqual({
      message: 'hub.rejected from=home to=bluefin/caldora method=message/send reason=backlog',
      level: 'warning',
      tags: { area: 'hub', event: 'hub.rejected', reason: 'backlog' },
      key: 'hub.rejected|backlog|',
    });
    expect(toSentry('error', 'hub.auth.refused', { reason: 'bad_sig', installation: 'bluefin', note: 'two words' })).toMatchObject({
      message: 'hub.auth.refused reason=bad_sig installation=bluefin note="two words"',
      level: 'error',
      tags: { area: 'hub', event: 'hub.auth.refused', reason: 'bad_sig', installation: 'bluefin' },
    });
  });

  it('No DSN, no SDK; the environment tells the hub apart', () => {
    expect(sentryOptions({}).dsn).toBeUndefined();
    expect(sentryOptions({ SENTRY_DSN: '' }).dsn).toBeUndefined();
    expect(sentryOptions({ SENTRY_DSN: 'https://k@sentry.example/2', SENTRY_ENVIRONMENT: 'hub-north', SENTRY_RELEASE: 'abc123' })).toEqual({
      dsn: 'https://k@sentry.example/2',
      environment: 'hub-north',
      release: 'abc123',
      sendDefaultPii: false,
    });
    expect(sentryOptions({ SENTRY_DSN: 'https://k@sentry.example/2' }).environment).toBe('hub');
  });

  it('A refused key reaches Sentry once an hour, without the signature', async () => {
    const before = events().length;
    // northwind is reserved for its own key: another key claiming it is the loud refusal.
    const first = await login('northwind', 'wrong');
    expect(await waitClosed(first)).toEqual({ code: 4003, reason: 'reserved' });
    const wanted = (e: SentEvent): boolean => e.message === 'hub.auth.refused reason=reserved claimed=northwind';
    await until(() => events().some(wanted));
    const event = events().find(wanted)!;
    expect(event).toMatchObject({ level: 'error', environment: 'hub-test', tags: { area: 'hub', event: 'hub.auth.refused', reason: 'reserved' } });
    expect(event.tags, 'a claimed name is no tag: it is the client’s word').not.toHaveProperty('installation');
    // The redial an hour has not passed for: logged, not sent. Another refusal is, and arrives after it.
    const again = await connect({ as: 'northwind' });
    const ch = await again.next((f) => f.t === 'challenge');
    const sig = await sign('wrong', challengeText('hub.example', 'northwind', keyOf('wrong').x, ch.nonce));
    again.send({ t: 'auth', v: 2, name: 'northwind', key: keyOf('wrong').x, sig });
    expect(await waitClosed(again)).toEqual({ code: 4003, reason: 'reserved' });
    const mismatch = await login('quillon', 'wrong', { hint: 'kestrel' });
    expect(await waitClosed(mismatch)).toEqual({ code: 4003, reason: 'hint mismatch' });
    await until(() => events().some((e) => e.message === 'hub.auth.refused reason="hint mismatch" claimed=quillon'));
    expect(events().slice(before).filter(wanted)).toHaveLength(1);
    expect(JSON.stringify(sentryRequests())).not.toContain(sig);
  });

  it('Refusals before admission are deduped on the reason alone: invented names do not become events', async () => {
    const before = events().length;
    for (const name of ['zz-a1', 'zz-a2', 'zz-a3', 'zz-a4']) {
      const c = await connect({ as: 'zz-hint' });
      await c.next((f) => f.t === 'challenge');
      c.send({ t: 'auth', v: 2, name, key: (await freshKey()).x, sig: 'AAAA' });
      expect(await waitClosed(c)).toEqual({ code: 4003, reason: 'hint mismatch' });
    }
    await new Promise((r) => setTimeout(r, 300));
    const sent = events().slice(before).filter((e) => e.tags?.event === 'hub.auth.refused');
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  it('The dedupe map is bounded, however many keys come by', () => {
    for (let i = 0; i < SENTRY_KEYS_MAX + 100; i++) log('warn', 'hub.test.bound', { reason: `r${i}` });
    expect(sentryKeys()).toBeLessThanOrEqual(SENTRY_KEYS_MAX);
  });
});
