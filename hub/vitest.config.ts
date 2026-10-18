// Hub tests run inside workerd (the Workers runtime) with the real Durable Object, SQLite and
// WebSocket Hibernation. Signing keys are generated here, per run: the public halves go into the
// HUB_CONFIG binding, the private ones only to the tests (TEST_KEYS) — no key material in the repo.
// Sentry is on, as with a DSN in production: test/setup.ts answers its requests and keeps them for
// test/report.test.ts.
import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const jwk = (): { x: string; d: string } => generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { x: string; d: string };
const keys: Record<string, { x: string; d: string }> = { home: jwk(), bluefin: jwk(), northwind: jwk(), wrong: jwk(), rotated: jwk() };
const HUB_CONFIG = JSON.stringify({
  installations: {
    home: { sign: [{ key: keys.home!.x }] },
    // A rotation in progress: the old key expired, the new one valid.
    bluefin: { sign: [{ key: keys.rotated!.x, notAfter: '2020-01-01T00:00:00Z' }, { key: keys.bluefin!.x }] },
    northwind: { sign: [{ key: keys.northwind!.x }] },
  },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.example.toml' },
      miniflare: {
        bindings: { HUB_CONFIG, TEST_KEYS: JSON.stringify(keys), SENTRY_DSN: 'https://public@sentry.example/1', SENTRY_ENVIRONMENT: 'hub-test' },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
