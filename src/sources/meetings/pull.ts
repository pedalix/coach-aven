// Meetings as one source kind with several providers (granola, gmeet, wispr). One PullSummary
// per run so the poller treats "meetings" like any other kind: a failing provider marks the
// kind failed (the others still land), a dead credential parks it for re-auth.
import { join } from 'node:path';
import { sourcesConfigDir, tokenPath } from '../tokens.js';
import type { MeetingsSourcesConfig, PullContext, PullSummary } from '../types.js';
import { pullGmeet } from './gmeet.js';
import { pullGranola } from './granola.js';
import { pullWispr } from './wispr.js';

export function granolaTokenPath(slug: string): string {
  return join(sourcesConfigDir(slug), 'granola.json');
}
export function wisprTokenPath(slug: string): string {
  return join(sourcesConfigDir(slug), 'wispr.json');
}

export async function pullMeetings(ctx: PullContext, cfg: MeetingsSourcesConfig, o: { since?: string; full?: boolean } = {}): Promise<PullSummary> {
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  let reauth = false;
  const note = (provider: string, r: { account: string; count: number; reauth: boolean; error?: string }) => {
    counts[`${provider}/${r.account}`] = r.count;
    if (r.error) errors.push(`${provider}/${r.account}: ${r.error}`);
    if (r.reauth) reauth = true;
  };
  if (cfg.granola) {
    const since = o.since ?? cfg.granola.since;
    note('granola', await pullGranola(ctx, granolaTokenPath(ctx.slug), { ...(since ? { since } : {}), full: o.full ?? false }));
  }
  if (cfg.gmeet) {
    const since = o.since ?? cfg.gmeet.since;
    for (const account of cfg.gmeet.accounts) note('gmeet', await pullGmeet(ctx, tokenPath(ctx.slug, 'google'), account, { ...(since ? { since } : {}), full: o.full ?? false }));
  }
  if (cfg.wispr) {
    const since = o.since ?? cfg.wispr.since;
    note('wispr', await pullWispr(ctx, wisprTokenPath(ctx.slug), { ...(since ? { since } : {}), full: o.full ?? false }));
  }
  return { kind: 'meetings', ok: errors.length === 0, reauth, counts, errors, startedAt, finishedAt: new Date().toISOString() };
}
