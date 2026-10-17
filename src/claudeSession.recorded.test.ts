// ClaudeSession against real CLI output (OpenSpec `cli-probe`, design D6): every contract recording of
// every probed CLI version (src/fixtures/cli/<version>/, listed in cliversion.ts PROBED_CLI_VERSIONS)
// is replayed through the bot's session code, and what the bot makes of it is asserted. The frames the
// bot writes back (its user messages, MCP answers, permission answers) must equal what the probe wrote.
// Reads the fixtures only — nothing from src/cliprobe/ — and needs no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ClaudeSession, type AskQuestion, type InjectOutcome, type OnQuestion, type TurnResult } from './claudeSession.js';
import { PROBED_CLI_VERSIONS } from './cliversion.js';
import type { SandboxHandle } from './driver.js';
import { mcpServer, type HostServerRoute } from './hosttools.js';
import type { RateLimitInfo } from './ratelimit.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Line = { t: number; dir?: 'out' | 'in' | 'echo'; frame?: Any; proc?: 'start' | 'exit'; argv?: string[] };

const FIXTURES = new URL('./fixtures/cli/', import.meta.url).pathname;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const ticks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

function recording(version: string, file: string): Line[] {
  return readFileSync(`${FIXTURES}${version}/${file}`, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
}

// One fake sandbox per CLI process: `push` feeds a recorded stdout frame, `end` ends the stream (exit).
function fakeProcess() {
  let onStdout: ((c: string) => void) | undefined;
  let end: (() => void) | undefined;
  const writes: Any[] = [];
  const handle: SandboxHandle = {
    name: 'replay',
    started: true,
    exec: async () => ({ exitCode: 0, result: '' }),
    uploadFile: async () => {},
    createSession: async () => {},
    startSessionCommand: async () => ({ cmdId: 'cmd' }),
    sessionCommandRunning: async () => true,
    sessionCommandLogs: async () => '',
    streamSessionCommandLogs: (_k, _c, cb) => {
      onStdout = cb;
      return new Promise<void>((r) => (end = r));
    },
    sendSessionInput: async (_k, _c, line) => {
      for (const l of line.split('\n')) if (l.trim()) writes.push(JSON.parse(l));
    },
    deleteSession: async () => {},
  };
  return { handle, writes, push: (f: Any) => onStdout?.(JSON.stringify(f) + '\n'), end: () => end?.() };
}

interface Replay {
  sessions: ClaudeSession[];
  writes: Any[]; // every frame the bot wrote, all processes
  recordedIn: Any[]; // every frame the probe wrote
  turns: TurnResult[];
  idle: string[];
  rate: RateLimitInfo[];
  steps: string[];
  questions: { qs: AskQuestion[]; aborted: boolean }[];
  // Messages written while a turn was pending (a session with the ledger): what became of each.
  injects: { text: string; outcome?: InjectOutcome }[];
  // The background-task list's length after every background_tasks_changed.
  bg: number[];
  mismatches: number;
}

const FOLD = '↩ injected message folded in';

// Drive the bot's session through a recording: a process start opens a session (with --resume when the
// probe resumed), the probe's user message becomes the bot's send(), its interrupt the bot's cancel.
async function replay(lines: Line[], o: { hostServers?: HostServerRoute[]; answers?: (qs: AskQuestion[]) => Record<string, string> } = {}): Promise<Replay> {
  const r: Replay = { sessions: [], writes: [], recordedIn: [], turns: [], idle: [], rate: [], steps: [], questions: [], injects: [], bg: [], mismatches: 0 };
  let turnPending = false;
  const procs: ReturnType<typeof fakeProcess>[] = [];
  const collect = (): void => {
    for (const p of procs) r.writes.push(...p.writes.splice(0));
  };
  let proc: ReturnType<typeof fakeProcess> | undefined;
  let session: ClaudeSession | undefined;
  let ac: AbortController | undefined;
  const pending: Promise<void>[] = [];
  const onQuestion: OnQuestion = (qs, signal) =>
    new Promise((resolve, reject) => {
      const q = { qs, aborted: false };
      r.questions.push(q);
      signal?.addEventListener('abort', () => ((q.aborted = true), reject(new Error('withdrawn'))));
      if (o.answers) resolve(o.answers(qs));
    });
  for (const l of lines) {
    if (l.proc === 'start') {
      const i = l.argv?.indexOf('--resume') ?? -1;
      proc = fakeProcess();
      procs.push(proc);
      // A process spawned with the ledger's flags is a session with the message ledger (agent-messaging D13).
      const ledger = l.argv?.includes('--replay-user-messages') ?? false;
      session = new ClaudeSession(proc.handle, { cwd: '/probe/work', resumeSessionId: i >= 0 ? l.argv![i + 1] : undefined, hostServers: o.hostServers, ledger });
      session.onIdleResult = (t) => r.idle.push(t);
      session.onLedgerMismatch = () => void r.mismatches++;
      session.onRateLimit = (x) => r.rate.push(x);
      r.sessions.push(session);
      await session.open();
    } else if (l.proc === 'exit') {
      proc?.end();
      await ticks();
    } else if (l.dir === 'in') {
      r.recordedIn.push(l.frame);
      if (l.frame.type === 'user' && turnPending && session!.hasLedger()) {
        // Written while a turn runs: the deliverer's inject(), with the uuid the probe wrote.
        const inj: Replay['injects'][number] = { text: l.frame.message.content };
        r.injects.push(inj);
        pending.push(session!.inject(l.frame.message.content, { uuid: l.frame.uuid, label: FOLD }).then((x) => void (inj.outcome = x)));
      } else if (l.frame.type === 'user') {
        ac = new AbortController();
        turnPending = true;
        pending.push(
          session!.send(l.frame.message.content, (s) => r.steps.push(s), ac.signal, onQuestion, undefined, l.frame.uuid).then((t) => {
            turnPending = false;
            r.turns.push(t);
          }),
        );
      } else if (l.frame.type === 'control_request' && l.frame.request?.subtype === 'interrupt') {
        ac?.abort();
      }
      await ticks();
    } else if (l.dir === 'out' || l.dir === 'echo') {
      // A transport's copy of stdin (a Daytona session) reaches the bot's parser like any line.
      proc!.push(l.frame);
      await ticks();
      if (l.frame.type === 'system' && l.frame.subtype === 'background_tasks_changed') r.bg.push(session!.backgroundTasks().length);
    }
    collect();
  }
  await ticks(10);
  collect();
  await Promise.race([Promise.all(pending), new Promise((res) => setTimeout(res, 500))]);
  return r;
}

const ofType = (frames: Any[], pred: (f: Any) => boolean): Any[] => frames.filter(pred);
const isUser = (f: Any): boolean => f.type === 'user';
const isMcpAnswer = (f: Any): boolean => f.type === 'control_response' && f.response?.response && 'mcp_response' in f.response.response;
const isAllow = (f: Any): boolean => f.type === 'control_response' && f.response?.response?.behavior === 'allow';
const lastResult = (lines: Line[]): Any => lines.filter((l) => l.dir === 'out' && l.frame.type === 'result').at(-1)?.frame;

// The assertions per contract scenario (design D6). A contract scenario without one fails the test.
const ASSERT: Record<string, (version: string, lines: Line[]) => Promise<void>> = {
  async turn(_v, lines) {
    const r = await replay(lines);
    const rec = lastResult(lines);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0]!.status, 'ok');
    assert.equal(r.turns[0]!.resultText, rec.result);
    assert.equal(r.turns[0]!.usage?.costUsd, rec.total_cost_usd);
    assert.equal(r.sessions[0]!.sessionId(), rec.session_id);
    assert.deepEqual(ofType(r.writes, isUser), ofType(r.recordedIn, isUser), 'the bot writes the user message the probe wrote');
  },
  async 'host-tool'(_v, lines) {
    const tools = [
      {
        name: 'probe_echo',
        description: 'Echo a text back. A tool of the CLI probe.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        call: (a: Record<string, unknown>) => ({ text: `echo:${String(a.text)}` }),
      },
    ];
    const r = await replay(lines, { hostServers: [{ name: 'probe', handle: mcpServer('probe', tools) }] });
    assert.equal(r.turns[0]?.status, 'ok');
    assert.equal(r.turns[0]!.resultText, lastResult(lines).result);
    assert.deepEqual(ofType(r.writes, isMcpAnswer), ofType(r.recordedIn, isMcpAnswer), 'the bot answers mcp_message exactly as recorded');
    assert.equal(ofType(r.writes, (f) => f.request?.subtype === 'initialize').length, 1, 'the bot registers its host servers');
  },
  async 'ask-user-question'(_v, lines) {
    const r = await replay(lines, { answers: (qs) => Object.fromEntries(qs.map((q) => [q.question, q.options.find((x) => /blue/i.test(x.label))?.label ?? 'blue'])) });
    assert.equal(r.questions.length, 1, 'AskUserQuestion reaches onQuestion');
    assert.deepEqual(ofType(r.writes, isAllow), ofType(r.recordedIn, isAllow), 'the bot answers with the allow the probe wrote');
    assert.equal(r.turns[0]?.status, 'ok');
  },
  async 'question-withdrawn'(_v, lines) {
    const r = await replay(lines);
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0]!.aborted, true, 'control_cancel_request aborts the open question');
  },
  async interrupt(_v, lines) {
    const r = await replay(lines);
    assert.equal(r.turns[0]?.status, 'canceled', 'the interrupted turn settles canceled');
    assert.equal(r.turns[1]?.status, 'ok', 'the next message gets its own turn');
    assert.equal(r.turns[1]!.resultText, lastResult(lines).result);
  },
  async resume(_v, lines) {
    const r = await replay(lines);
    assert.equal(r.sessions.length, 2);
    const resumedFrom = lines.find((l) => l.proc === 'start' && l.argv?.includes('--resume'))!.argv!;
    assert.equal(r.sessions[1]!.sessionId(), lastResult(lines).session_id);
    assert.ok(resumedFrom.includes(r.sessions[0]!.sessionId()!), 'the second process resumed the first session');
    assert.equal(r.turns.at(-1)?.status, 'ok');
  },
  async 'background-report'(_v, lines) {
    const r = await replay(lines);
    const results = lines.filter((l) => l.dir === 'out' && l.frame.type === 'result');
    assert.ok(results.length >= 2);
    assert.equal(r.turns.length, 1, 'only the person’s turn settles');
    const unsolicited = results.slice(1).filter((l) => l.frame.result && !l.frame.is_error).map((l) => l.frame.result);
    assert.deepEqual(r.idle, unsolicited, 'the unsolicited result goes to onIdleResult');
  },
  async 'subagent-parent'(_v, lines) {
    const r = await replay(lines);
    assert.ok(r.steps.some((s) => s.startsWith('↳1 ')), `the subagent’s steps are labelled ↳1 (got ${JSON.stringify(r.steps.slice(0, 6))})`);
  },
  async 'rate-limit-event'(_v, lines) {
    const r = await replay(lines);
    assert.ok(r.rate.length >= 1 && typeof r.rate[0]!.status === 'string', 'onRateLimit receives a parsed event');
  },
};

// The delivery rows (agent-messaging D12, task 0.2) through the message ledger (D13, tasks 4.1/4.2).
const folded = (r: Replay, capital: RegExp): void => {
  assert.equal(r.turns.length, 1, 'one turn');
  assert.equal(r.turns[0]!.status, 'ok');
  assert.match(r.turns[0]!.resultText, capital, 'the turn’s one result answers both');
  assert.deepEqual(r.injects.map((i) => i.outcome), [{ kind: 'folded', into: 'turn' }], 'the injected message is folded into the person’s turn');
  assert.ok(r.steps.includes(FOLD), 'the fold shows in the turn’s trail');
  assert.deepEqual(r.idle, [], 'nothing posted as a background update');
  assert.equal(r.mismatches, 0);
};
Object.assign(ASSERT, {
  async 'fold-in'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    folded(r, /Paris/);
    assert.deepEqual(ofType(r.writes, isUser), ofType(r.recordedIn, isUser), 'the bot writes both messages as the probe did, uuids included');
  },
  async 'echo-at-take-up'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    assert.equal(r.turns.length, 1);
    assert.deepEqual(r.injects.map((i) => i.outcome), [{ kind: 'folded', into: 'turn' }], 'taken up after the tool result, inside the turn');
    assert.deepEqual(r.idle, []);
  },
  async 'echo-carries-uuid'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    folded(r, /Madrid/);
    assert.deepEqual(ofType(r.writes, isUser), ofType(r.recordedIn, isUser));
  },
  async 'interrupt-after-inject'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    assert.equal(r.turns[0]?.status, 'canceled', 'the interrupted turn settles canceled');
    const o = r.injects[0]?.outcome;
    assert.equal(o?.kind, 'answered', 'the kept message gets a turn of its own');
    assert.match((o as Extract<InjectOutcome, { kind: 'answered' }>).result.resultText, /Paris/);
    assert.deepEqual(r.idle, [], 'its answer is the delivery’s, not a background update');
  },
  async 'kill-resume'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    assert.deepEqual(r.injects.map((i) => i.outcome), [{ kind: 'lost', takenUp: false }], 'unechoed when the process died: lost, to be delivered again');
    assert.equal(r.turns[0]?.status, 'error');
    assert.equal(r.turns.at(-1)?.status, 'ok', 'the resumed session takes the next turn');
  },
  async 'background-tasks-changed'(_v: string, lines: Line[]) {
    const r = await replay(lines);
    assert.ok(r.bg.some((n) => n > 0), `a running background task is seen (${JSON.stringify(r.bg)})`);
    assert.equal(r.bg.at(-1), 0, 'and the list is empty when it ends');
  },
});
const PENDING: Record<string, string> = {};

for (const version of PROBED_CLI_VERSIONS) {
  const reportPath = `${FIXTURES}${version}/report.json`;
  const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Any) : undefined;
  test(`recorded ${version} — a report with contract recordings exists`, () => {
    assert.ok(report, `${reportPath} is missing`);
  });
  for (const row of (report?.scenarios ?? []).filter((s: Any) => s.contract)) {
    if (PENDING[row.id] && !ASSERT[row.id]) {
      test(`recorded ${version} — ${row.id}`, { todo: PENDING[row.id] }, () => {});
      continue;
    }
    test(`recorded ${version} — ${row.id}`, async () => {
      const check = ASSERT[row.id];
      assert.ok(check, `contract scenario ${row.id} has no replay assertion in claudeSession.recorded.test.ts`);
      await check(version, recording(version, row.recording.file));
    });
  }
}
