// The A2A 1.0 subset agent messaging speaks (OpenSpec `agent-messaging`, design D7): types, parsers and
// validators only — no SDK. Imports nothing from `node:` (imports.test.ts), so the hub can share it.
//
//   envelope `ask`    ↔ SendMessage (a new task, or a reply to `input-required`)
//   envelope `answer` ↔ a Task status update (working, input-required, the final answer, failures)
//   envelope `cancel` ↔ CancelTask
//   `agents` → `cards` ↔ Agent Card discovery
// Parsers take untrusted JSON: they return undefined for anything malformed and ignore fields they do
// not know (design D5: within v1 changes are additive, a receiver ignores what it does not know).

/** A2A 1.0 task states. */
export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'] as const;
export type TaskState = (typeof TASK_STATES)[number];
const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'canceled', 'failed', 'rejected']);
export const isTerminal = (s: TaskState): boolean => TERMINAL.has(s);

export interface TextPart {
  kind: 'text';
  text: string;
}
export interface A2AMessage {
  role: 'user' | 'agent';
  parts: TextPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}
export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  /** ISO time. */
  timestamp: string;
}
export interface A2ATask {
  id: string;
  contextId: string;
  status: TaskStatus;
}
/** An agent's card, plus our extension `domain` (design D14). */
export interface AgentCard {
  name: string;
  description: string;
  /** Whether the agent would take a new task from the caller now (accept list, caps). */
  accepting: boolean;
  domain: string;
  /**
   * What the agent offers by name (agent-skills): the A2A AgentSkill subset, from the project's own Claude
   * Code skills its installation chose to show. Always present on a card this release builds (`[]` when
   * none); a card from an older release has none, and reads as `[]`.
   */
  skills: AgentSkill[];
}

/**
 * One skill on a card (A2A AgentSkill subset): `id` is what `send_message`'s `skill` names. `tags` is
 * always present (A2A requires it; `[]` when the SKILL.md gives none), `examples` only when given.
 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

/** A skill id: the Agent Skills name rule — lowercase letters, digits and hyphens, at most 64. */
export const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isSkillId = (s: unknown): s is string => typeof s === 'string' && SKILL_RE.test(s);
/** A card travels in every `agents` answer, so a skill's text is capped. */
export const SKILL_LIMITS = { card: 32, name: 64, description: 300, tags: 8, tag: 40, examples: 5, example: 200 } as const;
/** Up to `max` non-empty strings, each cut to `len`; anything else in the list is dropped. */
export const capStrings = (x: unknown, max: number, len: number): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, max).map((v) => v.trim().slice(0, len)) : [];

/** Task and message ids: 24 lowercase hex characters (design D9 step 4, D10). */
export const ID_RE = /^[0-9a-f]{24}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string';
const MAX_TEXT = 256 * 1024; // the answer cap (design D9/D10): larger text is refused, not cut

export function parseMessage(x: unknown): A2AMessage | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (a.role !== 'user' && a.role !== 'agent') return undefined;
  if (!isId(a.messageId)) return undefined;
  if (!Array.isArray(a.parts) || !a.parts.length) return undefined;
  const parts: TextPart[] = [];
  for (const p of a.parts) {
    if (!obj(p) || (p as Any).kind !== 'text' || !str((p as Any).text)) return undefined;
    parts.push({ kind: 'text', text: (p as Any).text });
  }
  if (parts.reduce((n, p) => n + p.text.length, 0) > MAX_TEXT) return undefined;
  if (a.taskId !== undefined && !isId(a.taskId)) return undefined;
  if (a.contextId !== undefined && !str(a.contextId)) return undefined;
  return { role: a.role, parts, messageId: a.messageId, ...(a.taskId ? { taskId: a.taskId } : {}), ...(a.contextId ? { contextId: a.contextId } : {}) };
}

export function parseStatus(x: unknown): TaskStatus | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!(TASK_STATES as readonly string[]).includes(a.state) || !str(a.timestamp)) return undefined;
  let message: A2AMessage | undefined;
  if (a.message !== undefined) {
    message = parseMessage(a.message);
    if (!message) return undefined;
  }
  return { state: a.state, timestamp: a.timestamp, ...(message ? { message } : {}) };
}

export function parseTask(x: unknown): A2ATask | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!isId(a.id) || !str(a.contextId)) return undefined;
  const status = parseStatus(a.status);
  return status ? { id: a.id, contextId: a.contextId, status } : undefined;
}

export function parseCard(x: unknown): AgentCard | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!str(a.name) || !str(a.description) || typeof a.accepting !== 'boolean' || !str(a.domain)) return undefined;
  // Additive within version 2: a card without `skills` (an older release) reads as offering none, and a
  // malformed entry is dropped, not the card.
  const skills = Array.isArray(a.skills) ? a.skills.map(parseSkill).filter((x: AgentSkill | undefined): x is AgentSkill => !!x).slice(0, SKILL_LIMITS.card) : [];
  return { name: a.name, description: a.description, accepting: a.accepting, domain: a.domain, skills };
}

function parseSkill(x: unknown): AgentSkill | undefined {
  if (!obj(x)) return undefined;
  const a = x as Any;
  if (!isSkillId(a.id) || !str(a.name) || typeof a.description !== 'string') return undefined;
  const examples = capStrings(a.examples, SKILL_LIMITS.examples, SKILL_LIMITS.example);
  return {
    id: a.id,
    name: a.name.slice(0, SKILL_LIMITS.name),
    description: a.description.slice(0, SKILL_LIMITS.description),
    tags: capStrings(a.tags, SKILL_LIMITS.tags, SKILL_LIMITS.tag),
    ...(examples.length ? { examples } : {}),
  };
}

/** The text of a message, parts joined. */
export const textOf = (m: A2AMessage): string => m.parts.map((p) => p.text).join('\n');

/** A one-part text message. */
export const textMessage = (role: A2AMessage['role'], text: string, messageId: string, taskId?: string): A2AMessage => ({
  role,
  parts: [{ kind: 'text', text }],
  messageId,
  ...(taskId ? { taskId } : {}),
});
