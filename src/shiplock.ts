// The one lock every `ship` on this machine takes (OpenSpec ship-dispatcher D7): a file in the overlays' checkout,
// created exclusively, holding who ships what since when. A lock whose pid is gone on this host is stale and is
// cleared with a word. No flock: node has none, and the file doubles as the "who is shipping" answer.
import { hostname } from 'node:os';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

interface Holder {
  pid: number;
  host: string;
  slugs: string[];
  startedAt: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function acquireShipLock(
  path: string,
  slugs: string[],
  o: { pid?: number; host?: string; now?: Date; isAlive?: (pid: number) => boolean } = {},
): { ok: true; release: () => void; note?: string } | { ok: false; message: string } {
  const me: Holder = { pid: o.pid ?? process.pid, host: o.host ?? hostname(), slugs, startedAt: (o.now ?? new Date()).toISOString() };
  const isAlive = o.isAlive ?? alive;
  let note: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(me) + '\n', { flag: 'wx' });
      const release = () => {
        try {
          const h = JSON.parse(readFileSync(path, 'utf8')) as Holder;
          if (h.pid === me.pid && h.host === me.host) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      return { ok: true, release, ...(note ? { note } : {}) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let h: Holder | undefined;
      try {
        h = JSON.parse(readFileSync(path, 'utf8')) as Holder;
      } catch {
        h = undefined; // unreadable: treat as stale
      }
      if (h && (h.host !== me.host || isAlive(h.pid)))
        return { ok: false, message: `another ship is running: ${h.slugs.join(' ')} since ${h.startedAt} (pid ${h.pid} on ${h.host}) — wait for it, or remove ${path} if that process is gone` };
      note = h ? `cleared a stale lock: ${h.slugs.join(' ')} since ${h.startedAt} (pid ${h.pid} is gone)` : `cleared an unreadable lock at ${path}`;
      try {
        unlinkSync(path);
      } catch {
        /* raced away */
      }
    }
  }
  return { ok: false, message: `could not take the lock at ${path}` };
}
