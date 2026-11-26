// Operators and the settings they keep in chat (OpenSpec `operator-controls`). Pure: who is an operator, the
// `/aven operators` grammar and its add/remove rules, the `/aven model` and `/aven effort` grammar, and the
// texts. state.ts stores the list and the values, commands.ts runs the verbs, tasks.ts reads the values when a
// session starts.
//
// Three levels in chat: reads along, may drive (access.ts), operator. An operator is a person of the HOME
// workspace named by the installation's config (the driver's own setting: TEAMS_OPERATORS, the web's operators)
// or by the list kept here. Where neither names anyone the platform's earlier rule holds — on Slack, whose
// driver names nobody, that is everyone in the home workspace. All of it only with OPERATOR_CONTROLS=1; without
// the flag the earlier rule is the whole rule.

import { CLI_EFFORT_LEVELS, CLI_MODEL_NAMES, defaultEffortFor } from './cliversion.js';
import { CAPABILITIES, DEFAULT_GRANT_MS, activeGrants, type GrantRecord } from './grants.js';

/** One chat-listed operator, as state.json keeps it. */
export interface OperatorEntry {
  user: string;
  by: string; // who added them
  at: string; // ISO
}

export interface OperatorCtx {
  flag: boolean; // OPERATOR_CONTROLS
  isHome: boolean;
  /** The driver's config rule; absent (Slack) = the driver names nobody. */
  configured?: (user: string | undefined) => boolean;
  list: readonly OperatorEntry[];
}

/** True while the platform's "everyone in the home workspace" rule is in force: nobody is named anywhere. */
export const everyoneRule = (c: Pick<OperatorCtx, 'configured' | 'list'>): boolean => !c.configured && c.list.length === 0;

export function isOperatorNow(c: OperatorCtx, user: string | undefined): boolean {
  if (!c.isHome) return false;
  if (!c.flag) return c.configured ? c.configured(user) : true;
  if (c.configured?.(user)) return true;
  if (user && c.list.some((e) => e.user === user)) return true;
  return everyoneRule(c);
}

export type OperatorsCmd =
  | { action: 'list' }
  | { action: 'add'; userId: string }
  | { action: 'remove'; userId: string }
  | { action: 'error'; message: string };

// The core's mention form, as access.ts reads it: `<@id>` or Slack's `<@id|name>`.
const MENTION_RE = /<@([^>|\s]+)(?:\|[^>]*)?>/;

export function parseOperatorsCmd(rest: string, cmd: string): OperatorsCmd {
  const [action, ...tail] = rest.trim().split(/\s+/).filter(Boolean);
  if (!action) return { action: 'list' };
  if (action === 'add' || action === 'remove') {
    const m = MENTION_RE.exec(tail.join(' '));
    if (!m) return { action: 'error', message: `Usage: \`${cmd} operators ${action} @person\` (a real @-mention).` };
    return { action, userId: m[1] };
  }
  return { action: 'error', message: `Usage: \`${cmd} operators\` · \`add @person\` · \`remove @person\`` };
}

/**
 * Apply add/remove to the chat list. `configuredCount` is how many people the config names (0 on Slack);
 * `configured` says whether it names this one. The first add under the everyone rule also names the caller —
 * otherwise naming someone would lock the namer out. Remove refuses a config-named person (the config is not
 * chat's to cut) and the last operator when the config names none (the list never returns to "everyone" by itself).
 */
export function applyOperatorsCmd(
  c: Pick<OperatorCtx, 'configured' | 'list'> & { configuredCount: number },
  cmd: Exclude<OperatorsCmd, { action: 'list' } | { action: 'error' }>,
  by: string,
  now: Date,
): { next: OperatorEntry[]; note: string } | { error: string } {
  const at = now.toISOString();
  const has = (u: string) => c.list.some((e) => e.user === u);
  if (cmd.action === 'add') {
    if (has(cmd.userId)) return { error: `<@${cmd.userId}> is already an operator.` };
    const first = everyoneRule(c);
    const next = [...c.list, ...(first && cmd.userId !== by ? [{ user: by, by, at }] : []), { user: cmd.userId, by, at }];
    return {
      next,
      note:
        `✅ <@${cmd.userId}> is an operator.` +
        (first ? ` Operators are now a named list: ${next.map((e) => `<@${e.user}>`).join(', ')} — everyone else in this workspace no longer is one.` : ''),
    };
  }
  if (c.configured?.(cmd.userId)) return { error: `<@${cmd.userId}> is named in the installation's config and cannot be removed in chat.` };
  if (!has(cmd.userId)) return { error: `<@${cmd.userId}> is not on the operators list.` };
  if (c.list.length === 1 && c.configuredCount === 0) return { error: "Can't remove the last operator — add another one first." };
  return { next: c.list.filter((e) => e.user !== cmd.userId), note: `🚫 <@${cmd.userId}> is no longer an operator.` };
}

const day = (iso: string): string => iso.slice(0, 10);

/** `configuredNames`: the config's own values, as written (Teams ids, e-mails) — shown to operators only. */
export function operatorsListText(c: Pick<OperatorCtx, 'configured' | 'list'> & { configuredNames: readonly string[] }, cmd: string): string {
  const lines = ['*Operators — this installation*'];
  for (const n of c.configuredNames) lines.push(`• \`${n}\` — named in the installation's config`);
  for (const e of c.list) lines.push(`• <@${e.user}> — added in chat by <@${e.by}> on ${day(e.at)}`);
  if (everyoneRule(c)) lines.push('_Nobody is named: everyone in the home workspace is an operator. The first `add` makes it a list (you included)._');
  else if (!c.configuredNames.length && !c.list.length) lines.push('_Nobody is named._');
  lines.push('', `Manage: \`${cmd} operators add @person\` · \`remove @person\``);
  return lines.join('\n');
}

// ── a project's model and effort ────────────────────────────────────────────────────────────────────────────

export type SettingName = 'model' | 'effort';
/** A chat-set value, as state.json keeps it. */
export interface ChatSetValue {
  value: string;
  by: string;
  at: string; // ISO
}

export const SETTING_VALUES: Record<SettingName, readonly string[]> = { model: CLI_MODEL_NAMES, effort: CLI_EFFORT_LEVELS };

export type SettingCmd = { action: 'show' } | { action: 'set'; value: string } | { action: 'default' } | { action: 'error'; message: string };

export function parseSettingCmd(name: SettingName, rest: string, cmd: string): SettingCmd {
  const words = rest.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { action: 'show' };
  const accepted = SETTING_VALUES[name];
  if (words.length === 1 && words[0] === 'default') return { action: 'default' };
  if (words.length === 1 && accepted.includes(words[0])) return { action: 'set', value: words[0] };
  return { action: 'error', message: `Usage: \`${cmd} ${name} ${accepted.join('|')}|default\` — accepted: ${accepted.map((v) => `\`${v}\``).join(', ')}.` };
}

/** What a new session of the project starts with: the chat-set value, else the installation's, else the CLI's own. */
export const settingInForce = (chat: ChatSetValue | undefined, installation: string | undefined): string | undefined => chat?.value ?? installation;

export function settingShowText(name: SettingName, slug: string, chat: ChatSetValue | undefined, installation: string | undefined, cliDefault?: string): string {
  if (chat) return `*${slug}* — ${name}: \`${chat.value}\`, set in chat by <@${chat.by}> on ${day(chat.at)}.`;
  if (installation) return `*${slug}* — ${name}: \`${installation}\`, the installation's default.`;
  if (cliDefault) return `*${slug}* — ${name}: \`${cliDefault}\` (default — nothing is set).`;
  return `*${slug}* — ${name}: the agent CLI's own default (nothing is set).`;
}

/** The reach of a change is `/aven reload`'s: sessions that start afterwards. */
export const NEW_SESSIONS_NOTE = 'Conversations that start from now on use it; a running conversation keeps what it started with until its session ends or is restarted (*⚙️ Session* → *🔄 Restart session*).';

export function settingSetText(name: SettingName, slug: string, value: string | undefined, installation: string | undefined, cliDefault?: string): string {
  const what = value ? `\`${value}\`` : installation ? `the installation's default (\`${installation}\`)` : cliDefault ? `\`${cliDefault}\` (default)` : "the agent CLI's own default";
  return `✅ *${slug}* — ${name}: ${what}. ${NEW_SESSIONS_NOTE}`;
}

// ── what an operator sees (the Home's section, the Session card's part) ─────────────────────────────────────

/** A value in force, by name. `set`: an operator set it in chat; otherwise it is the default — the installation's
 *  setting or what the CLI reported — and `value` is absent only while nobody has seen what the default is. */
export interface ShownSetting {
  value?: string;
  set: boolean;
}
/** One project as an operator sees it: what its next session starts on, and what it holds right now. */
export interface OperatorProject {
  slug: string;
  model: ShownSetting;
  effort: ShownSetting;
  defaults: { model?: string; effort?: string }; // what `default` would give, by name, when known
  grants: { capability: string; until: string; by: string }[];
  line: string; // the read-out, in mrkdwn (operatorProjectLine)
  rev: string; // changes with every render: a control drawn from it starts from this state, not the last press
}
/** The operator's Home section. `note`: the outcome of the control just pressed — the Home has no reply of its own. */
export interface OperatorPart {
  operators: string[]; // one line each, as operatorsListText words them
  everyone: boolean; // nobody is named: the everyone rule is in force
  projects: OperatorProject[];
  note?: string;
}

/** The installation's own model setting (CLAUDE_MODEL), when it has one. */
export interface Defaults {
  model?: string;
}

/** `opus` when set in chat; `claude-sonnet-5-5 (default)` for a known default; `default` while it is not known. */
export const shownText = (s: ShownSetting): string => (s.set ? `\`${s.value}\`` : s.value ? `\`${s.value}\` _(default)_` : '_default_');
/** The same without markup, for a menu: `opus`, `claude-sonnet-5-5 (default)`, `default`. */
export const shownLabel = (s: ShownSetting): string => (s.set ? (s.value ?? '') : s.value ? `${s.value} (default)` : 'default');

export function operatorProject(
  slug: string,
  settings: { model?: ChatSetValue; effort?: ChatSetValue; cliModel?: string },
  defaults: Defaults,
  grants: GrantRecord[],
  now: number,
  tz: string,
): OperatorProject {
  // "Default", by name: the installation's setting, else what the CLI last reported for this project; the effort's
  // default follows the model in force (cliversion.ts defaultEffortFor).
  const dm = defaults.model ?? settings.cliModel;
  const de = defaultEffortFor(settings.model?.value ?? dm);
  const p = {
    slug,
    model: settings.model ? { value: settings.model.value, set: true } : { ...(dm ? { value: dm } : {}), set: false },
    effort: settings.effort ? { value: settings.effort.value, set: true } : { ...(de ? { value: de } : {}), set: false },
    // What choosing `default` would give: the default model, and the effort the model in force defaults to.
    defaults: { ...(dm ? { model: dm } : {}), ...(de ? { effort: de } : {}) },
    grants: activeGrants(grants, slug, now).map((g) => ({ capability: g.capability, until: g.until, by: g.by })),
  };
  return { ...p, line: operatorProjectLine(p, tz), rev: now.toString(36) };
}

export function operatorPart(c: Pick<OperatorCtx, 'configured' | 'list'> & { configuredNames: readonly string[] }, projects: OperatorProject[], note?: string): OperatorPart {
  return {
    operators: [...c.configuredNames.map((n) => `\`${n}\` _(config)_`), ...c.list.map((e) => `<@${e.user}>`)],
    everyone: everyoneRule(c),
    projects,
    ...(note ? { note } : {}),
  };
}

/** One mrkdwn line per project: `*atlas* — model `opus` · effort `high` · grants: `workflows` until 14:30`. */
export function operatorProjectLine(p: Pick<OperatorProject, 'slug' | 'model' | 'effort' | 'grants'>, tz: string): string {
  const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const grants = p.grants.length ? p.grants.map((g) => `\`${g.capability}\` until ${hhmm(g.until)}`).join(', ') : '_none_';
  return `*${p.slug}* — model ${shownText(p.model)} · effort ${shownText(p.effort)} · grants: ${grants}`;
}

/** What a control carries: the project, what to change, the value. `h` marks a control on the Home. Short keys: a
 *  Slack option's value is capped. */
export interface OperatorChoice {
  s: string; // slug
  w: 'model' | 'effort' | 'grant' | 'ungrant';
  v: string; // a model name, an effort level, `default`, or a capability
  h?: 1;
}

export interface OperatorOption {
  label: string;
  value: string; // an OperatorChoice, as JSON
}
/**
 * One project's controls: a list for the model and one for the effort — each with the value in force selected, the
 * default named (`claude-sonnet-5-5 (default)`) — and one button per capability, which starts a grant or, while one
 * is held, ends it.
 */
export function operatorControls(p: OperatorProject, home: boolean): {
  model: { options: OperatorOption[]; current: OperatorOption };
  effort: { options: OperatorOption[]; current: OperatorOption };
  grants: (OperatorOption & { held: boolean; capability: string })[];
} {
  const opt = (label: string, w: OperatorChoice['w'], v: string): OperatorOption => ({ label, value: JSON.stringify({ s: p.slug, w, v, ...(home ? { h: 1 } : {}) } satisfies OperatorChoice) });
  const list = (w: 'model' | 'effort', names: readonly string[], s: ShownSetting) => {
    const dflt = opt(shownLabel({ ...(p.defaults[w] ? { value: p.defaults[w] } : {}), set: false }), w, 'default');
    const options = [...names.map((n) => opt(n, w, n)), dflt];
    return { options, current: (s.set && options.find((o) => o.label === s.value)) || dflt };
  };
  const mins = DEFAULT_GRANT_MS / 60_000;
  return {
    model: list('model', CLI_MODEL_NAMES, p.model),
    effort: list('effort', CLI_EFFORT_LEVELS, p.effort),
    grants: Object.keys(CAPABILITIES).map((c) => {
      const held = p.grants.some((g) => g.capability === c);
      return { ...(held ? opt(`End ${c} grant`, 'ungrant', c) : opt(`Grant ${c} ${mins} min`, 'grant', c)), held, capability: c };
    }),
  };
}

export function parseOperatorChoice(raw: string): OperatorChoice | undefined {
  try {
    const v = JSON.parse(raw) as Partial<OperatorChoice>;
    if (typeof v.s !== 'string' || typeof v.v !== 'string') return undefined;
    if (v.w === 'model' || v.w === 'effort') return SETTING_VALUES[v.w].includes(v.v) || v.v === 'default' ? (v as OperatorChoice) : undefined;
    if (v.w === 'grant' || v.w === 'ungrant') return Object.hasOwn(CAPABILITIES, v.v) ? (v as OperatorChoice) : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}
