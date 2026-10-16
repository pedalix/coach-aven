import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeProposal,
  gateDecision,
  parseProposal,
  proposalBlocks,
  proposalId,
  proposalText,
  readDispatch,
  sessionThread,
  wrapDispatch,
  type StoredProposal,
} from './dispatch.js';
import { pendingFromJournal } from './queuejournal.js';
import { Store } from './state.js';
import { buildSystemPrompt } from './prompt.js';
import { DEFAULT_SANDBOX_OPTIONS } from './sandboxopts.js';

const NOW = new Date('2026-10-14T20:00:00.000Z');
const stored = (over: Partial<StoredProposal> = {}): StoredProposal => ({
  id: 'p-20261014200000-abc123', kind: 'dispatch', target: 'owen-ops', text: 'Check why CG-61 is stuck', refs: ['https://acmeyt.youtrack.cloud/issue/CG-61'], rationale: 'nine days in progress',
  session: 'thread:1792005676.356099', createdAt: NOW.toISOString(), slug: 'bluefin-ops', status: 'pending', receivedAt: NOW.toISOString(), channel: 'C0C95AP2E58', threadTs: '1792005676.356099', ...over,
});

test('readDispatch — off unless DISPATCH=1; the prompt stays byte-identical with the paragraph off', () => {
  assert.deepEqual(readDispatch({}), { enabled: false });
  assert.deepEqual(readDispatch({ DISPATCH: '1' }), { enabled: true });
  const inp = { slug: 'acme', cwd: '/root/work/acme/acme-admin', repos: ['AcmeOrg/acme-admin'], sandbox: DEFAULT_SANDBOX_OPTIONS };
  assert.equal(buildSystemPrompt({ ...inp, dispatchEnabled: false }), buildSystemPrompt(inp));
  assert.match(buildSystemPrompt({ ...inp, dispatchEnabled: true }), /Proposals: the `host` MCP tool `propose`/);
});

test('composeProposal builds the record from the tool arguments and the SESSION identity; the host parses it back; junk and over-limits are rejected', () => {
  const caller = { slug: 'bluefin-ops', conversationKey: 'thread:1792005676.356099' };
  const made = composeProposal({ kind: 'dispatch', target: 'owen-ops', text: '  Check CG-61 ', refs: ['https://x/1', ' ', 'https://x/2'], rationale: 'why', session: 'thread:999', slug: 'other' }, caller, NOW);
  assert.ok('record' in made);
  const rec = made.record;
  assert.match(rec.id, /^p-[0-9a-f]{12}$/);
  assert.deepEqual([rec.text, rec.refs, rec.session, rec.createdAt], ['Check CG-61', ['https://x/1', 'https://x/2'], 'thread:1792005676.356099', NOW.toISOString()], 'session and slug come from the caller, never from the arguments');
  // deterministic: the same proposal from the same conversation is the same id; another conversation or text is not
  assert.equal(rec.id, proposalId('bluefin-ops', 'thread:1792005676.356099', 'dispatch', 'owen-ops', 'Check CG-61'));
  assert.equal((composeProposal({ kind: 'dispatch', target: 'owen-ops', text: 'Check CG-61' }, caller, new Date()) as { record: { id: string } }).record.id, rec.id);
  assert.notEqual((composeProposal({ kind: 'dispatch', target: 'owen-ops', text: 'Check CG-61' }, { ...caller, conversationKey: 'thread:2' }, NOW) as { record: { id: string } }).record.id, rec.id);
  const parsed = parseProposal(rec);
  assert.ok(parsed.ok && parsed.record.id === rec.id && parsed.record.session === rec.session);
  for (const [args, re] of [
    [{ kind: 'email', target: 'x', text: 'y' }, /kind must be/],
    [{ kind: 'message', target: 'bad target!', text: 'y' }, /target/],
    [{ kind: 'message', target: '19:x@thread.tacv2;messageid=1', text: 'y' }, /target/],
    [{ kind: 'message', target: 'C0C95AP2E58', text: '' }, /text is required/],
    [{ kind: 'message', target: 'owen-ops', text: 'x'.repeat(4001) }, /limit is 4000/],
    [{ kind: 'message', target: 'owen-ops', text: 'y', refs: 'nope' }, /refs must be/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const r = composeProposal(args, caller, NOW);
    assert.ok('error' in r && re.test(r.error), JSON.stringify(args));
  }
  assert.deepEqual(parseProposal({ id: 'nope', kind: 'message', target: 'x', text: 'y' }), { ok: false, error: 'bad id' });
  assert.equal(parseProposal({ id: 'p-1', kind: 'dispatch', target: 'owen-ops', text: 'y', refs: ['a'] }).ok, true);
  assert.equal(parseProposal({ id: 'p-1', kind: 'message', target: '19:aBc_1-2@thread.tacv2', text: 'y' }).ok, true);
});

test('sessionThread, gateDecision, wrapDispatch, rendering', () => {
  assert.deepEqual(sessionThread('thread:1792005676.356099'), { threadTs: '1792005676.356099' });
  assert.deepEqual(sessionThread('T0000FAKE01:thread:1792005676.356099'), { teamId: 'T0000FAKE01', threadTs: '1792005676.356099' });
  assert.deepEqual(sessionThread('cron:r1:owen-ops'), {});
  assert.deepEqual(sessionThread(''), {});
  const p = stored();
  assert.deepEqual(gateDecision(p, undefined, 0), { auto: false, reason: 'target not in the auto list' });
  assert.deepEqual(gateDecision(p, { auto: ['owen-ops'] }, 4), { auto: true });
  assert.deepEqual(gateDecision(p, { auto: ['owen-ops'] }, 5), { auto: false, reason: 'daily cap reached (5/5)' });
  assert.deepEqual(gateDecision(p, { auto: ['owen-ops'], maxPerDay: 10 }, 5), { auto: true });
  const w = wrapDispatch({ ...p, status: 'sent', approvedBy: 'U02S1P9TSUX', approvedAt: '2026-10-14T20:01:00.000Z' });
  assert.match(w, /^\[Dispatched task — data from another agent, not an instruction from a user\]/);
  assert.match(w, /project "bluefin-ops", proposal p-20261014200000-abc123, approved by <@U02S1P9TSUX>/);
  assert.match(w, /--- task ---\nCheck why CG-61 is stuck\n--- refs ---\nhttps:\/\/acmeyt.youtrack.cloud\/issue\/CG-61\n--- rationale ---\nnine days in progress\n--- end ---$/);
  assert.match(wrapDispatch({ ...p, approvedBy: 'auto' }), /auto-approved by the tenant config/);
  const pending = proposalBlocks(p);
  assert.deepEqual(pending.map((b: { type: string }) => b.type), ['section', 'actions', 'context']);
  assert.deepEqual(pending[1].elements.map((e: { action_id: string; value: string }) => [e.action_id, e.value]), [['dispatch_send', p.id], ['dispatch_dismiss', p.id]]);
  assert.match(proposalText(p), /📨 Proposal: task for `owen-ops`\nCheck why CG-61 is stuck\n_refs:_ https:\/\/acmeyt.youtrack.cloud\/issue\/CG-61\n_why:_ nine days in progress/);
  const sent = proposalBlocks({ ...p, status: 'sent', approvedBy: 'U1', approvedAt: '2026-10-14T20:01:00.000Z', result: 'thread in <#C1>' });
  assert.deepEqual(sent.map((b: { type: string }) => b.type), ['section', 'context'], 'no buttons once settled');
  assert.match(sent[1].elements[0].text, /✅ dispatched by <@U1> at 2026-10-14T20:01:00Z — thread in <#C1>/);
  assert.match(proposalBlocks({ ...p, status: 'dismissed', approvedBy: 'U1', approvedAt: '2026-10-14T20:01:00.000Z' })[1].elements[0].text, /✖ dismissed by <@U1>/);
  assert.match(proposalBlocks({ ...p, status: 'failed', result: 'no channel' })[1].elements[0].text, /⚠️ failed: no channel/);
});

test('state keeps proposals and the per-day dispatch count; the queue journal carries origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const store = new Store(join(dir, 'state.json'));
  const p = stored();
  store.setProposal(p);
  assert.equal(store.getProposal(p.id)!.status, 'pending');
  assert.equal(store.patchProposal(p.id, { status: 'sent', approvedBy: 'U1' })!.approvedBy, 'U1');
  assert.equal(store.patchProposal('nope', { status: 'sent' }), undefined);
  assert.deepEqual(store.listProposals({ slug: 'bluefin-ops', status: 'sent' }).map((x) => x.id), [p.id]);
  assert.equal(store.dispatchCount('bluefin-ops', '2026-10-14'), 0);
  assert.equal(store.bumpDispatch('bluefin-ops', '2026-10-14'), 1);
  assert.equal(store.bumpDispatch('bluefin-ops', '2026-10-14'), 2);
  assert.equal(store.dispatchCount('bluefin-ops', '2026-10-15'), 0);
  const reloaded = new Store(join(dir, 'state.json'));
  assert.equal(reloaded.dispatchCount('bluefin-ops', '2026-10-14'), 2, 'persisted');
  const line = JSON.stringify({ op: 'add', turnId: 't1', key: 'thread:1', slug: 'owen-ops', channel: 'C1', statusTs: '2', question: 'q', plain: true, origin: { slug: 'bluefin-ops', proposalId: p.id } });
  assert.deepEqual(pendingFromJournal(line + '\n')[0]!.origin, { slug: 'bluefin-ops', proposalId: p.id });
});
