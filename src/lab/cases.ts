// Case keys: the unit a person thinks in. The topics of one call are one call (Owen's overrides are per call:
// 25 of the 30 human fragment labels are one call's answer copied onto every topic), the comments of one
// ticket are the ticket, the messages of one thread are the thread. Two uses:
//   - the dev/test split goes by case, so one call cannot sit on both sides and leak its answer into the
//     threshold that is then scored on it;
//   - a question about a case answers every unit in it (a variant may group its own way via Prediction.group).

import { splitOf } from './metrics.js';
import type { FragmentUnit, ItemUnit, TaskId, Unit } from './types.js';
import { UNIT_OF } from './types.js';

export function caseKeyOf(task: TaskId, u: Unit): string {
  const kind = UNIT_OF[task];
  if (kind === 'fragment') return (u as FragmentUnit).case ?? (u as FragmentUnit).id.replace(/#\d+$/, '');
  if (kind === 'item') {
    const it = u as ItemUnit;
    // A ticket and its comments are ONE case, keyed by the ticket's ref (a comment's id is `<ref>#c<id>`): its
    // comments nearly always share its label, so split apart they leak the ticket's answer across dev and test.
    if (it.type === 'task') return `ticket:${it.id}`;
    if (it.type === 'comment') return `ticket:${it.id.replace(/#c[^#]*$/, '')}`;
    return it.thread ? `thread:${it.thread}` : it.id;
  }
  return u.id;
}

// The split of a unit = the split of its case.
export function splitOfUnit(task: TaskId, u: Unit | undefined, id: string): 'dev' | 'test' {
  return splitOf(u ? caseKeyOf(task, u) : id);
}
