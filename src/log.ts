// Tiny structured-ish logger. Stdout for normal flow, stderr for streamed agent
// output so the two can be redirected independently.
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (msg: string) => console.log(`[${ts()}] ${msg}`),
  warn: (msg: string) => console.log(`[${ts()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] ERROR ${msg}`),
  step: (msg: string) => console.log(`[${ts()}] → ${msg}`),
  // Raw passthrough for streamed sandbox/agent output (no timestamp framing).
  raw: (chunk: string) => process.stderr.write(chunk),
};
