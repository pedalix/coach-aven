import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeProposals,
  gateDecision,
  parseProposal,
  proposalBlocks,
  proposalText,
  readDispatch,
  sessionThread,
  withOutboxMount,
  wrapDispatch,
  type StoredProposal,
} from './dispatch.js';
import { makeProposal, writeProposal, handleMessage as hostHandle, TOOLS as HOST_TOOLS } from '../snapshot/plain/host-mcp.mjs';
import { withHostMcp, hostMcpSpec } from './hostmcp.js';
import { pendingFromJournal } from './queuejournal.js';
import { Store } from './state.js';
import { buildSystemPrompt } from './prompt.js';
import { DEFAULT_SANDBOX_OPTIONS } from './sandboxopts.js';

const NOW = new Date('2026-10-14T20:00:00.000Z');
const stored = (over: Partial<StoredProposal> = {}): StoredProposal => ({
  id: 'p-20261014200000-abc123', kind: 'dispatch', target: 'owen-ops', text: 'Check why CG-61 is stuck', refs: ['https://acmeyt.youtrack.cloud/issue/CG-61'], rationale: 'nine days in progress',
  session: 'thread:1792005676.356099', createdAt: NOW.toISOString(), slug: 'bluefin-ops', status: 'pending', receivedAt: NOW.toISOString(), channel: 'C0C95AP2E58', threadTs: '1792005676.356099', ...over,
});

test('readDispatch — off unless DISPATCH=1; the prompt, the MCP list and the mounts stay byte-identical with it off', () => {
  assert.deepEqual(readDispatch({}), { enabled: false });
  assert.deepEqual(readDispatch({ DISPATCH: '1' }), { enabled: true });
  assert.equal(withHostMcp(undefined, false), undefined);
  assert.deepEqual(withHostMcp([{ name: 'grafana', command: 'x' }], false)!.map((s) => s.name), ['grafana']);
  assert.deepEqual(withHostMcp([{ name: 'grafana', command: 'x' }], true)!.map((s) => s.name), ['grafana', 'host']);
  assert.deepEqual(withHostMcp([{ name: 'host', command: 'own' }], true)!.length, 1, 'a project-declared host server wins');
  assert.deepEqual(hostMcpSpec().env, { HOST_OUTBOX: '/data/outbox' });
  const inp = { slug: 'acme', cwd: '/root/work/acme/acme-admin', repos: ['AcmeOrg/acme-admin'], sandbox: DEFAULT_SANDBOX_OPTIONS };
  assert.equal(buildSystemPrompt({ ...inp, dispatchEnabled: false }), buildSystemPrompt(inp));
  assert.match(buildSystemPrompt({ ...inp, dispatchEnabled: true }), /Proposals: the `host` MCP tool `propose`/);
  assert.deepEqual(withOutboxMount({ mounts: ['/a:/data/sources:ro'] }, '/h/data/x/outbox').mounts, ['/a:/data/sources:ro', '/h/data/x/outbox:/data/outbox:rw']);
});

test('the sandbox tool validates and writes an atomic file the host parses back; junk and over-limits are rejected on both sides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  const made = makeProposal({ kind: 'dispatch', target: 'owen-ops', text: '  Check CG-61 ', refs: ['https://x/1', ' ', 'https://x/2'], rationale: 'why' }, { AVEN_SESSION: 'thread:1792005676.356099' }, NOW);
  assert.ok('record' in made);
  const rec = (made as { record: Parameters<typeof writeProposal>[0] }).record;
  assert.match(rec.id, /^p-20261014200000-[0-9a-f]{6}$/);
  assert.deepEqual([rec.text, rec.refs, rec.session], ['Check CG-61', ['https://x/1', 'https://x/2'], 'thread:1792005676.356099']);
  writeProposal(rec, dir);
  assert.deepEqual(readdirSync(dir), [`propose-${rec.id}.json`], 'no tmp file left behind');
  writeFileSync(join(dir, 'propose-p-bad.json'), '{not json');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const seen: unknown[] = [];
  assert.deepEqual(consumeProposals(dir, (raw) => seen.push(raw)).length, 2);
  const parsed = seen.map(parseProposal);
  assert.ok(parsed[0]!.ok && parsed[0]!.record.id === rec.id);
  assert.ok(!parsed[1]!.ok, 'unparsable file → undefined → rejected');
  assert.deepEqual(readdirSync(dir), ['notes.txt'], 'claimed files are removed, junk ignored');
  assert.deepEqual(consumeProposals(dir, () => assert.fail('nothing left')), []);
  assert.deepEqual(consumeProposals(join(dir, 'missing'), () => undefined), []);
  for (const [args, re] of [
    [{ kind: 'email', target: 'x', text: 'y' }, /kind must be/],
    [{ kind: 'message', target: 'bad target!', text: 'y' }, /target/],
    [{ kind: 'message', target: 'C0C95AP2E58', text: '' }, /text is required/],
    [{ kind: 'message', target: 'owen-ops', text: 'x'.repeat(4001) }, /limit is 4000/],
    [{ kind: 'message', target: 'owen-ops', text: 'y', refs: 'nope' }, /refs must be/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const r = makeProposal(args, {}, NOW);
    assert.ok('error' in r && re.test(r.error), JSON.stringify(args));
  }
  assert.deepEqual(parseProposal({ id: 'nope', kind: 'message', target: 'x', text: 'y' }), { ok: false, error: 'bad id' });
  assert.equal(parseProposal({ id: 'p-1', kind: 'dispatch', target: 'owen-ops', text: 'y', refs: ['a'] }).ok, true);
  // the stdio server speaks the same JSON-RPC subset as the sources server
  const list = hostHandle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, dir) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ['propose']);
  assert.equal(HOST_TOOLS.length, 1);
  const call = hostHandle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose', arguments: { kind: 'message', target: 'owen-ops', text: 'hi' } } }, dir) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0]!.text, /"ok":true/);
  assert.equal(existsSync(join(dir, `propose-${(JSON.parse(call.result.content[0]!.text) as { id: string }).id}.json`)), true);
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
