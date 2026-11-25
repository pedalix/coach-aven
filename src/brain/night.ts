// Company brain: one project's nightly tidy, start to finish (design D9) — the impure half of tidy.ts. The
// scheduler (pollers.ts) calls it for every project during the tidy hour; everything it needs from the engine is
// passed in, so it is tested over a temp installation directory with a fake session.

import { log } from '../log.js';
import type { MirrorResult } from '../memjournal.js';
import { brainAfterTurn, readIndex, readLint, readTidy, rebuildBrain, updateTidy } from './store.js';
import { endTidy, startTidy, tidyDigest, tidyPrompt } from './tidy.js';

type TidySession = { mirrorMemory?: (message: string) => Promise<MirrorResult>; memoryReads?: () => string[] };

export interface NightDeps {
  projectBusy: (slug: string) => boolean;
  /** Forget the tidy conversation's Claude session: every night starts fresh instead of resuming a growing one. */
  fresh: (key: string) => Promise<void>;
  /** One no-UI turn on `key`; `after` runs once the answer is in, while the sandbox is still up. */
  runAsk: (key: string, prompt: string, after: (session: TidySession) => Promise<void>) => Promise<string>;
  key: string; // the tidy's conversation: `cron:tidy:<slug>`
  memoryDir: string; // the project's memory directory in the sandbox
  tidying: Set<string>; // slugs with a tidy in flight (the scheduler ticks every minute)
}

export type NightOutcome = 'no-brain' | 'done-today' | 'nothing-due' | 'busy' | 'in-flight' | 'tidied' | 'failed';

// Nothing due → no turn, and a stopped sandbox stays stopped: only the host's files are read. A project with a
// live turn is left for the next tick of the hour (both would write the memory files); a failed tidy is not
// retried that night, and does not count towards the three runs.
export async function nightlyTidy(d: NightDeps, slug: string, day: string): Promise<NightOutcome> {
  if (d.tidying.has(slug)) return 'in-flight';
  const index = await readIndex(slug);
  if (!index) return 'no-brain'; // never mirrored a record: no brain directory, and none is created here
  const state = await readTidy(slug);
  if (state.lastDay === day) return 'done-today';
  const run = startTidy((await readLint(slug)) ?? [], index, state);
  if (!run.share.length) {
    await updateTidy(slug, (s) => ({ ...s, lastDay: day }));
    return 'nothing-due';
  }
  if (d.projectBusy(slug)) return 'busy';
  d.tidying.add(slug);
  try {
    let mirrored: MirrorResult | undefined;
    await d.fresh(d.key);
    const answer = await d.runAsk(d.key, tidyPrompt(d.memoryDir, run.share), async (session) => {
      // The use log gets the tidy as a routine's turn (it never counts as a person's use); no answer is logged.
      const m = await brainAfterTurn(session, slug, { turnId: `tidy-${day}`, key: d.key, by: 'routine', question: '', answer: '', logAnswer: false });
      mirrored = m;
    });
    const after = { index: (await readIndex(slug)) ?? index, findings: (await readLint(slug)) ?? [], instructions: mirrored?.instructions };
    await updateTidy(slug, (s) => endTidy(s, run, after, day));
    // The lint of that mirror was built against the digests from before the tidy: build it once more, so a
    // changed CLAUDE.md the tidy has now seen is no longer listed (and does not start tomorrow's).
    if (mirrored?.instructions && run.share.some((f) => f.code === 'instructions-changed')) {
      after.findings = (await rebuildBrain(slug, mirrored.files, new Date(), mirrored.instructions)).findings;
    }
    log.info(`tidy ${slug}: ${run.share.length} finding(s) given, ${after.findings.length} listed after — ${tidyDigest(answer)}`);
    return 'tidied';
  } catch (e) {
    log.error(`tidy ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    await updateTidy(slug, (s) => ({ ...s, lastDay: day })).catch(() => {});
    return 'failed';
  } finally {
    d.tidying.delete(slug);
  }
}
