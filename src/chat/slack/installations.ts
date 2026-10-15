// Slack OAuth installation store: the bridge between Bolt's OAuth flow and our
// state.json. One record per installed workspace (or enterprise org), keyed by
// enterpriseId ?? teamId — the same rule Slack's own reference stores use, so a
// workspace inside an org that installed org-wide resolves to the org record, while
// a single-workspace install (even inside an org) resolves to its own team record.
//
// This is THE multi-tenant foundation: Bolt calls fetchInstallation on every incoming
// event to mint that team's bot token, so everything downstream (event handlers, the
// per-request `client`) is automatically per-workspace. Kept as pure glue over Store —
// no Slack imports beyond types — so it's unit-testable without a workspace.

import type { Installation, InstallationQuery, InstallationStore } from '@slack/bolt';
import type { Store } from '../../state.js';

// Derive the storage key for a completed installation. Org-wide installs key by the
// enterprise id (one token serves every workspace in the org); everything else keys by
// the team id. Throws on a shape we can't key — better to fail the OAuth callback loudly
// than to store an unfetchable record.
export function installKey(installation: Installation): string {
  if (installation.isEnterpriseInstall && installation.enterprise?.id) {
    return installation.enterprise.id;
  }
  if (installation.team?.id) return installation.team.id;
  throw new Error('installation has neither enterprise.id nor team.id — cannot store it');
}

// Derive the lookup key for an incoming event's query. Mirrors installKey: org-wide
// installs query by enterpriseId, everything else by teamId.
export function queryKey(query: InstallationQuery<boolean>): string | undefined {
  if (query.isEnterpriseInstall && query.enterpriseId) return query.enterpriseId;
  return query.teamId ?? undefined;
}

export function createInstallationStore(store: Store): InstallationStore {
  return {
    async storeInstallation(installation) {
      store.setInstallation(installKey(installation), installation);
    },

    async fetchInstallation(query) {
      const key = queryKey(query);
      const found = key ? store.getInstallation(key) : undefined;
      if (!found) {
        // A descriptive throw: Bolt swallows this into "Authorization of installation
        // failed", so the team id here is what makes a client-workspace mishap debuggable.
        throw new Error(
          `no installation stored for ${query.isEnterpriseInstall ? 'enterprise' : 'team'} ` +
            `${key ?? '(no id in query)'} — was the app installed via /slack/install?`,
        );
      }
      return found as Installation;
    },

    async deleteInstallation(query) {
      const key = queryKey(query);
      if (key) store.deleteInstallation(key);
    },
  };
}
