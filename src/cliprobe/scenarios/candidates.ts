// Exploratory candidates from the SDK's declarations, not observed before this probe (design D7):
// facts a design may want (withdrawing a message, the interrupt's receipt, peer messages, compaction).
import type { ProbeCtx } from '../ctx.js';
import type { Scenario } from '../types.js';
import { answeredIn, CHAIN, SIDE } from './lib.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const S = 1000;
const ECHO = { args: ['--replay-user-messages'] };
// A message uuid the probe chooses (the normalizer maps it like any UUID).
const SIDE_UUID = '7f3c1d2e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

const interruptReceipt: Scenario<ProbeCtx> = {
  meta: {
    id: 'interrupt-receipt',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'An interrupt’s response lists in `still_queued` the uuid of a message written before it and not yet taken up (`interrupt_receipt_v1`).',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'), { uuid: SIDE_UUID });
    await ctx.sleep(300);
    const id = await ctx.interrupt();
    const resp = (await ctx.expect(ctx.is.controlResponse(id), 10 * S, 'a response to the interrupt')) as Any;
    const init = ctx.frames.find(ctx.is.init) as Any;
    const queued: unknown[] = resp.response?.response?.still_queued ?? [];
    ctx.check(queued.includes(SIDE_UUID), `still_queued lists the message (got ${JSON.stringify(queued)})`);
    return { capabilities: init?.capabilities ?? null, stillQueued: queued.length };
  },
};

const cancelAsyncMessage: Scenario<ProbeCtx> = {
  meta: {
    id: 'cancel-async-message',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'A message written mid-tool and withdrawn with `cancel_async_message` before the boundary is never taken up.',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'), { uuid: SIDE_UUID });
    await ctx.sleep(300);
    const id = await ctx.control({ subtype: 'cancel_async_message', message_uuid: SIDE_UUID });
    const resp = (await ctx.expect(ctx.is.controlResponse(id), 10 * S, 'a response to cancel_async_message')) as Any;
    await ctx.precondition(ctx.is.result, 150 * S, 'the chain finishes');
    await ctx.sleep(15 * S);
    const w = answeredIn(ctx.results, 'France');
    ctx.check(!ctx.frames.some(ctx.is.replayOf('France')), 'the withdrawn message is never echoed');
    ctx.check(w.answeredIn === 0, 'the withdrawn message is never answered');
    return { response: resp.response?.subtype, results: w.results };
  },
};

const originPeer: Scenario<ProbeCtx> = {
  meta: {
    id: 'origin-peer',
    contract: false,
    runs: 1,
    variants: ['bypass', 'undeclared'],
    extras: ECHO,
    hypothesis:
      'A peer message (`origin.kind: "peer"`) to a session that runs without asking is delivered like any message when it declares `fromMode: "bypass"`, and held when it declares no mode.',
  },
  async run(ctx, v) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    const origin: Record<string, unknown> = { kind: 'peer', from: 'probe-peer', name: 'Probe Peer', ...(v === 'bypass' ? { fromMode: 'bypass' } : {}) };
    await ctx.send(SIDE('France'), { origin });
    await ctx.precondition(ctx.is.result, 150 * S, 'the chain finishes');
    await ctx.sleep(20 * S);
    const w = answeredIn(ctx.results, 'France');
    if (v === 'bypass') ctx.check(w.answeredIn >= 1, `delivered (results ${w.results}, answered in #${w.answeredIn})`);
    else ctx.check(w.answeredIn === 0, `held (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, echoed: ctx.frames.some(ctx.is.replayOf('France')) };
  },
};

const compaction: Scenario<ProbeCtx> = {
  meta: {
    id: 'compaction',
    contract: false,
    runs: 1,
    hypothesis: '`/compact` written as a user message compacts the conversation: `system/compact_boundary` comes, and the session goes on.',
  },
  async run(ctx) {
    await ctx.send('Remember the code word PROBE-OTTER-7. Reply with only: OK');
    const r1 = (await ctx.precondition(ctx.is.result, 90 * S, 'a first result')) as Any;
    await ctx.send('/compact');
    await ctx.expect((f) => f.type === 'system' && f.subtype === 'compact_boundary', 180 * S, 'system/compact_boundary');
    await ctx.send('Reply with only: OK2');
    const r2 = (await ctx.expect((f) => ctx.is.result(f) && f !== r1 && /OK2/.test(String((f as Any).result)), 120 * S, 'the session goes on')) as Any;
    return { sameSessionId: r2.session_id === r1.session_id };
  },
};

export const CANDIDATES: Scenario<ProbeCtx>[] = [interruptReceipt, cancelAsyncMessage, originPeer, compaction];
