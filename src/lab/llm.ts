// The bench's model runner — BENCH ONLY. In production the model never runs in the bot, the
// daemon or anywhere on the host: the LLM rung runs inside the project sandbox and writes its labels
// back through a host tool with a closed list. On the bench (a dev experiment on the owner's machine,
// on the owner's own data) we call `claude -p` directly so variants can be compared in minutes.
// src/lab/imports.test.ts keeps every non-lab module from importing this file.
//
// Every call is cached by a hash of (model, system, prompt): re-running a variant after a metrics
// change costs nothing, and a resumed run picks up where it stopped. The cache stores the cost too,
// so a cached replay still reports what the run WOULD cost — the number a variant is judged on.
//
// That key is only honest if (model, system, prompt) is ALL the child sees. `claude -p` also loads the
// CLAUDE.md / CLAUDE.local.md / AGENTS.md of its working directory and every parent (only --bare skips them,
// and it cannot run on a subscription token): spawned from a checkout, every bench call — the synth render
// whose output is committed included — carried the repo's guide and the owner's private local notes, paid
// their tokens, and depended on which checkout ran it. So the child works in its isolated config dir, and
// CLAUDE_CODE_DISABLE_CLAUDE_MDS is set after the scrub (the walk up the parents would still reach a checkout
// while LAB_DIR sits inside one, as the default data/lab does). Cache entries written before this were made
// with those files in context; the key is left as it was, so the paid cache stays usable.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LlmCall {
  model: string; // 'haiku' | 'sonnet' | 'opus' or a full id
  system: string;
  prompt: string;
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  costUsd: number;
  inputTokens: number; // fresh + cache-written + cache-read: what the call consumed
  outputTokens: number;
  ms: number;
  model: string;
  cached: boolean;
  error?: string;
}

export const cacheKey = (c: LlmCall): string =>
  createHash('sha256').update(`${c.model}\u0000${c.system}\u0000${c.prompt}`).digest('hex').slice(0, 32);

// Models wrap JSON in fences or prose now and then; take the first balanced object/array.
export function parseJsonLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body.trim());
  } catch {
    /* fall through to the scan */
  }
  for (let i = 0; i < body.length; i++) {
    const open = body[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let j = i; j < body.length; j++) {
      const ch = body[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(body.slice(i, j + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error(`no JSON in model output: ${text.slice(0, 120)}`);
}

// The `claude -p --output-format json` envelope → LlmResult fields.
export function readEnvelope(raw: string): Omit<LlmResult, 'cached' | 'ms'> {
  const d = JSON.parse(raw) as {
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
    modelUsage?: Record<string, unknown>;
  };
  const u = d.usage ?? {};
  return {
    text: d.result ?? '',
    costUsd: d.total_cost_usd ?? 0,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    model: Object.keys(d.modelUsage ?? {})[0] ?? '',
    error: d.is_error ? d.result || 'model error' : undefined,
  };
}

export interface RunnerOpts {
  cacheFile: string; // JSONL: {key, result}
  configDir: string; // an isolated CLAUDE_CONFIG_DIR — never the owner's own
  token: string; // a subscription token (CLAUDE_CODE_OAUTH_TOKEN)
  concurrency?: number;
  retries?: number;
}

// Strip the variables a parent Claude Code session sets, so the child neither reports to nor waits
// on the session that launched the bench.
const PARENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CONFIG_DIR$|AI_AGENT$|ANTHROPIC_)/;

export class LlmRunner {
  private cache = new Map<string, LlmResult>();
  private active = 0;
  private waiting: Array<() => void> = [];
  spentUsd = 0; // fresh (non-cached) spend of this process

  constructor(private opts: RunnerOpts) {
    if (existsSync(opts.cacheFile)) {
      for (const line of readFileSync(opts.cacheFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { key: string; result: LlmResult };
          if (!row.result.error) this.cache.set(row.key, row.result);
        } catch {
          /* a torn last line from a killed run */
        }
      }
    }
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    mkdirSync(opts.configDir, { recursive: true });
  }

  async call(c: LlmCall): Promise<LlmResult> {
    const key = cacheKey(c);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    await this.slot();
    try {
      let last: LlmResult | undefined;
      for (let attempt = 0; attempt <= (this.opts.retries ?? 2); attempt++) {
        last = await this.spawnOnce(c);
        if (!last.error) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
      const res = last!;
      if (!res.error) {
        this.cache.set(key, res);
        appendFileSync(this.opts.cacheFile, `${JSON.stringify({ key, result: res })}\n`);
        this.spentUsd += res.costUsd;
      }
      return res;
    } finally {
      this.release();
    }
  }

  private async slot(): Promise<void> {
    if (this.active < (this.opts.concurrency ?? 4)) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private spawnOnce(c: LlmCall): Promise<LlmResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!PARENT_VARS.test(k)) env[k] = v;
    env.CLAUDE_CONFIG_DIR = this.opts.configDir;
    env.CLAUDE_CODE_OAUTH_TOKEN = this.opts.token;
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'; // set after the scrub, which drops every CLAUDE_CODE_* of the parent
    const args = ['-p', '--model', c.model, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--max-turns', '1', '--system-prompt', c.system];
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn('claude', args, { env, cwd: this.opts.configDir, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), c.timeoutMs ?? 300_000);
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (err += b.toString()));
      child.on('close', () => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        try {
          resolve({ ...readEnvelope(out), ms, cached: false });
        } catch {
          resolve({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, ms, model: c.model, cached: false, error: `claude -p failed: ${(err || out).slice(0, 300)}` });
        }
      });
      child.stdin.end(c.prompt);
    });
  }
}

// Read the subscription token for the bench: LAB_CLAUDE_TOKEN, else CLAUDE_CODE_OAUTH_TOKEN from an
// env file (the bot's own .env by default — the bench runs on the owner's machine).
export function benchToken(envFile: string): string {
  if (process.env.LAB_CLAUDE_TOKEN) return process.env.LAB_CLAUDE_TOKEN;
  const m = /^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
  if (!m) throw new Error(`no CLAUDE_CODE_OAUTH_TOKEN in ${envFile} (or set LAB_CLAUDE_TOKEN)`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}
