// The bot's sources worker: the `sources` tool table (snapshot/plain/sources-mcp.mjs) answering
// on a worker thread, so a heavy query never stalls the bot's event loop — `unanswered` over a
// 200 MB personal store takes about a second, and Slack wants its acks within three. One thread,
// calls served in order; the DB is opened per call, so a replica swapped by a build is seen at
// once. Plain JS like the server it imports (no build step); hostrouter.ts owns its lifecycle.
//
// The zone goes into this thread's env BEFORE the table is imported: tool descriptions are built at
// import and name the zone ("a whole day in Europe/Moscow"); setting it afterwards fixed the answers
// but left the descriptions saying UTC.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData?.tz) process.env.SOURCES_TZ = workerData.tz;
const { handleMessage } = await import('../../snapshot/plain/sources-mcp.mjs');

parentPort.on('message', ({ seq, message, dbPath }) => {
  try {
    parentPort.postMessage({ seq, reply: handleMessage(message, dbPath) ?? null });
  } catch (e) {
    parentPort.postMessage({ seq, error: e instanceof Error ? e.message : String(e) });
  }
});
