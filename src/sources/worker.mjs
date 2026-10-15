// The bot's sources worker: the `sources` tool table (snapshot/plain/sources-mcp.mjs) answering
// on a worker thread, so a heavy query never stalls the bot's event loop — `unanswered` over a
// 200 MB personal store takes about a second, and Slack wants its acks within three. One thread,
// calls served in order; the DB is opened per call, so a replica swapped by a build is seen at
// once. Plain JS like the server it imports (no build step); hostrouter.ts owns its lifecycle.
import { parentPort, workerData } from 'node:worker_threads';
import { handleMessage, setLocalTz } from '../../snapshot/plain/sources-mcp.mjs';

if (workerData?.tz) setLocalTz(workerData.tz);
parentPort.on('message', ({ seq, message, dbPath }) => {
  try {
    parentPort.postMessage({ seq, reply: handleMessage(message, dbPath) ?? null });
  } catch (e) {
    parentPort.postMessage({ seq, error: e instanceof Error ? e.message : String(e) });
  }
});
