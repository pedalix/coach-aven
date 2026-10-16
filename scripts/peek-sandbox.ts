#!/usr/bin/env -S npx tsx
// One-off: exec a shell command inside an installation's project sandbox to inspect Claude
// transcripts. The Daytona credentials come from that installation's overlay (infra/<slug>/.env).
// Usage: OPS=<slug> npx tsx scripts/peek-sandbox.ts <sandboxName> '<shell command>'
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { Daytona } from '@daytonaio/sdk';

const [, , sandboxName, cmd] = process.argv;
if (!sandboxName || !cmd || !process.env.OPS) {
  console.error("usage: OPS=<slug> peek-sandbox.ts <sandboxName> '<cmd>'");
  process.exit(1);
}
loadEnv({ path: `infra/${process.env.OPS}/.env`, override: true });

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
  organizationId: process.env.DAYTONA_ORGANIZATION_ID,
});

const sb = await daytona.get(sandboxName);
const res = await sb.process.executeCommand(cmd, undefined, undefined, 0);
console.log('exit', res.exitCode);
console.log(res.result);
