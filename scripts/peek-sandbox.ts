#!/usr/bin/env -S npx tsx
// One-off: exec a shell command inside a prod project sandbox to inspect Claude transcripts.
// Usage: npx tsx scripts/peek-sandbox.ts <sandboxName> '<shell command>'
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { Daytona } from '@daytonaio/sdk';

loadEnv({ path: 'infra/prod/runtime/.env', override: true });

const [, , sandboxName, cmd] = process.argv;
if (!sandboxName || !cmd) {
  console.error("usage: peek-sandbox.ts <sandboxName> '<cmd>'");
  process.exit(1);
}

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
  organizationId: process.env.DAYTONA_ORGANIZATION_ID,
});

const sb = await daytona.get(sandboxName);
const res = await sb.process.executeCommand(cmd, undefined, undefined, 0);
console.log('exit', res.exitCode);
console.log(res.result);
