// What an operator does, as functions — the one implementation behind both the typed commands (commands.ts) and the
// controls of the operator's Home section and Session card (interactions.ts; OpenSpec operator-controls D6): who is
// an operator, reload the config, start and end a grant, set a project's model or effort, and the view of what is
// set. Platform-neutral; every function returns the words for the private reply.

import type { Config } from '../../config.js';
import type { Store } from '../../state.js';
import { loadProjects, registryPrivilegeWarnings, teamProjects, type ProjectConfig, type RegistryRef } from '../../projects.js';
import { normalizeTenant } from '../../teamkeys.js';
import type { ChatDriverName } from '../drivers.js';
import { ROUTINE_TZ, type Pollers } from '../../pollers.js';
import { installationPermissions } from '../../github.js';
import { githubRepos } from '../../repohost.js';
import { effectNote, grantNotice, isActive, type CapabilityName, type GrantRecord } from '../../grants.js';
import { errText } from '../slack/blocks.js';
import { isOperatorNow, operatorPart, operatorProject, settingSetText, settingShowText, type OperatorCtx, type OperatorPart, type OperatorProject, type SettingName } from '../../operators.js';
import type { Actor, ChatDriver } from '../driver.js';
import { log } from '../../log.js';

export interface OperateDeps {
  cfg: Config;
  store: Store;
  reg: RegistryRef;
  pollers: Pick<Pollers, 'endGrant'>;
  homeTeamId?: string;
  surface?: ChatDriverName;
  // The driver's own operator setting (CommandDeps.isOperator) and its values as written.
  isOperator?: (user: string | undefined) => boolean;
  configuredOperators?: readonly string[];
  onReload?: () => string[];
}

export interface Operate {
  /** The rule's inputs for this tenant: the flag, home or not, the driver's setting, the chat list. */
  ctx(tenant: string | undefined): OperatorCtx;
  isOperator(actor: Pick<Actor, 'tenant' | 'user'>): boolean;
  /** `/aven reload`: swap the registry; the reply's text. A failure leaves the old registry in place. */
  reload(tenant: string | undefined): string;
  /** Start (or extend) a grant, announced in `conv`; the reply's text. */
  grant(d: ChatDriver, project: ProjectConfig, capability: CapabilityName, ms: number, by: string, conv: string, tid: string | undefined): Promise<string>;
  /** End a grant early through the pollers' end path (the notice goes where the grant was made). */
  endGrant(project: ProjectConfig, capability: CapabilityName, by: string): Promise<string>;
  /** Set (`value`) or remove (undefined) a project's chat-set model or effort. */
  setSetting(name: SettingName, slug: string, value: string | undefined, by: string): string;
  /** `/aven model|effort` with no argument: the value in force and where it comes from. */
  showSetting(name: SettingName, slug: string): string;
  /** What an operator sees of one project. */
  project(slug: string): OperatorProject;
  /** The operator's Home section for this person, or undefined when they get none (flag off, not an operator). */
  part(actor: Pick<Actor, 'tenant' | 'user'>, note?: string): OperatorPart | undefined;
}

export function createOperate(deps: OperateDeps): Operate {
  const { cfg, store, reg, pollers, homeTeamId, surface } = deps;
  const ctx = (tenant: string | undefined): OperatorCtx => ({
    flag: cfg.operatorControls,
    isHome: normalizeTenant(tenant, homeTeamId) === undefined,
    ...(deps.isOperator ? { configured: deps.isOperator } : {}),
    list: store.listOperators(),
  });
  const isOperator = (actor: Pick<Actor, 'tenant' | 'user'>): boolean => isOperatorNow(ctx(actor.tenant), actor.user);
  const installationOf = (name: SettingName): string | undefined => (name === 'model' ? cfg.claudeModel : undefined);
  const defaults = cfg.claudeModel ? { model: cfg.claudeModel } : {};
  const project = (slug: string): OperatorProject => operatorProject(slug, store.getProjectSettings(slug), defaults, store.listGrants(), Date.now(), ROUTINE_TZ);

  return {
    ctx,
    isOperator,
    project,

    // No restart: everything holds the RegistryRef and reads `.current` per use. Scope honesty: prompts/MCP are baked
    // into a session at openChat, so running conversations keep their current setup until their persistent claude
    // process ends — new sessions pick up the new config immediately.
    reload(tenant) {
      try {
        const before = reg.current.projects.map((p) => p.slug);
        const next = loadProjects(cfg.projectsConfigPath);
        reg.current = next;
        for (const w of registryPrivilegeWarnings(next)) log.warn(w);
        const after = next.projects.map((p) => p.slug);
        const added = after.filter((s) => !before.includes(s));
        const removed = before.filter((s) => !after.includes(s));
        const delta = [added.length ? `added: ${added.join(', ')}` : '', removed.length ? `removed: ${removed.join(', ')}` : ''].filter(Boolean).join(' · ');
        // With a workspaces block the fleet count spans ALL tenants — say how many of
        // them this workspace actually sees, so "8 project(s)" doesn't read as "8 here".
        const mine = teamProjects(next, tenant, homeTeamId).length;
        const scope = next.workspaces && mine !== after.length ? `, ${mine} in this workspace` : '';
        const extra = deps.onReload?.() ?? [];
        return `:arrows_counterclockwise: Config reloaded — ${after.length} project(s)${scope}${delta ? ` (${delta})` : ''}. New prompts/MCP apply to new sessions; running conversations keep their current setup.${extra.length ? `\nAgent messaging: ${extra.join('; ')}.` : ''}`;
      } catch (err) {
        return `${errText(err)}\n_The previous config stays active._`;
      }
    },

    async grant(d, p, capability, ms, by, conv, tid) {
      const now = Date.now();
      const rec: GrantRecord = {
        slug: p.slug,
        capability,
        at: new Date(now).toISOString(),
        until: new Date(now + ms).toISOString(),
        by,
        ...(tid ? { teamId: tid } : {}),
        ...(surface ? { surface } : {}),
        channel: conv,
      };
      store.setGrant(rec);
      log.info(`grant: ${p.slug} ${capability} until ${rec.until} by ${by}`);
      const failed = await d.post({ conv }, { kind: 'text', text: grantNotice(rec, ROUTINE_TZ) }).then(
        () => '',
        (e: unknown) => {
          log.warn(`grant: announcement not posted in ${conv}: ${e instanceof Error ? e.message : String(e)}`);
          return ' _(The channel announcement could not be posted.)_';
        },
      );
      const repo = githubRepos(p.repos)[0];
      const note = effectNote(cfg.github?.kind, capability, repo ? await installationPermissions(cfg, repo) : undefined);
      return `:white_check_mark: Granted — it applies from the next message on.${failed}${note ? `\n:warning: ${note}` : ''}`;
    },

    async endGrant(p, capability, by) {
      const held = store.getGrant(p.slug, capability);
      if (!held || !isActive(held, Date.now())) return `:information_source: *${p.slug}* holds no \`${capability}\` grant.`;
      // The pollers' end path: the notice goes where the grant was made (its channel and surface), not necessarily here.
      await pollers.endGrant(held, by);
      return `:white_check_mark: Ended *${p.slug}*'s \`${capability}\` grant.`;
    },

    setSetting(name, slug, value, by) {
      store.patchProjectSettings(slug, { [name]: value ? { value, by, at: new Date().toISOString() } : undefined });
      log.info(`${name}: ${slug} → ${value ?? 'default'} by ${by}`);
      return settingSetText(name, slug, value, installationOf(name), installationOf(name) ? undefined : project(slug).defaults[name]);
    },

    showSetting(name, slug) {
      return settingShowText(name, slug, store.getProjectSettings(slug)[name], installationOf(name), project(slug).defaults[name]);
    },

    part(actor, note) {
      if (!cfg.operatorControls || !isOperator(actor)) return undefined;
      const c = ctx(actor.tenant);
      const now = Date.now();
      const grants = store.listGrants();
      return operatorPart(
        { ...c, configuredNames: deps.configuredOperators ?? [] },
        teamProjects(reg.current, actor.tenant, homeTeamId).map((p) => operatorProject(p.slug, store.getProjectSettings(p.slug), defaults, grants, now, ROUTINE_TZ)),
        note,
      );
    },
  };
}
