import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entropy, hash6, ibanValid, luhn, scrubSummary, scrubText } from './scrub.js';

// Shapes mirror real traffic (a vendor's "your account" mail pasted into Slack, a pasted .env,
// a shell snippet) with FAKE values. If a shape stops matching reality, change the fixture,
// not the assertion. Ported from owen-ops/connectors/common/scrub.test.ts — keep in step.

const tagFor = (kind: string, value: string) => `[REDACTED:${kind}:${hash6(value)}]`;

test('DSN: only the password segment is replaced, user and host stay readable', () => {
  const { text, findings } = scrubText('db: postgres://app:hunter22!@pg.internal:5432/x and redis://:r3d1s-pass@cache:6379');
  assert.equal(text, `db: postgres://app:${tagFor('dsn', 'hunter22!')}@pg.internal:5432/x and redis://:${tagFor('dsn', 'r3d1s-pass')}@cache:6379`);
  assert.deepEqual(findings.map((f) => f.kind), ['dsn', 'dsn']);
});

test('same secret → same tag (correlation without recovery)', () => {
  const a = scrubText('password: Zx9-Same-Secret').text;
  const b = scrubText('Passwort = Zx9-Same-Secret').text;
  assert.equal(a.slice(a.indexOf('[')), b.slice(b.indexOf('[')));
  assert.equal(hash6('Zx9-Same-Secret').length, 6);
});

test('kv: EN/DE/RU keywords with :, =, is/ist and whitespace separators', () => {
  const cases: Array<[string, string]> = [
    ['Password: K/9988776655ab', 'K/9988776655ab'],
    ['Kennwort ist Winter2026!x', 'Winter2026!x'],
    ['passwort="geheim-123"', 'geheim-123'],
    ['пароль: Stag1ng-009', 'Stag1ng-009'],
    ['API_KEY=abcd1234efgh', 'abcd1234efgh'],
    ['token xyz123abc', 'xyz123abc'],
  ];
  for (const [input, secret] of cases) {
    const out = scrubText(input).text;
    assert.equal(out.includes(secret), false, `${input} → ${out}`);
    assert.ok(out.includes('[REDACTED:kv:'), `${input} → ${out}`);
  }
});

test('kv: prose with a bare keyword and a plain word is NOT redacted', () => {
  for (const s of ['the token expired yesterday', 'password reset mail went out', 'secret santa planning', 'token: https://docs.example/how-to']) {
    assert.equal(scrubText(s).text, s);
  }
});

test('token prefixes, bearer and JWT', () => {
  const s = 'use xoxp-1234567890-abcdefghij and Bearer abcdefghijklmnopqrstuv.wxyz plus eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456ghi789 and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE';
  const { text, findings } = scrubText(s);
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['aws', 'bearer', 'github', 'jwt', 'slack']);
  assert.equal(/xoxp-|ghp_|AKIA|eyJ/.test(text), false);
  assert.deepEqual(scrubSummary(findings), { kinds: ['aws', 'bearer', 'github', 'jwt', 'slack'], count: 5 });
});

test('PEM block is replaced wholesale', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAbCd\n-----END RSA PRIVATE KEY-----';
  const { text, findings } = scrubText(`attached below\n${key}\nthanks`);
  assert.equal(text, `attached below\n${tagFor('pem', key)}\nthanks`);
  assert.equal(findings[0]!.confidence, 'exact');
});

test('.env block in a code fence: every secret-ish key is redacted, plain config survives', () => {
  const s = '```\nAPP_ENV=production\nDB_HOST=10.0.0.5\nDB_PASSWORD=Tr0ub4dor&3xyz\nSTRIPE_KEY=sk-live-ZmFrZS1zdHJpcGUta2V5LWZvci10ZXN0cw\nAPP_URL=https://shop.example\n```';
  const { text } = scrubText(s);
  assert.equal(text.includes('Tr0ub4dor&3xyz'), false);
  assert.equal(text.includes('sk-live-ZmFrZS1zdHJpcGUta2V5LWZvci10ZXN0cw'), false);
  assert.ok(text.includes('APP_ENV=production'));
  assert.ok(text.includes('DB_HOST=10.0.0.5'));
  assert.ok(text.includes('APP_URL=https://shop.example'));
});

test('IBAN: mod-97 valid → redacted, invalid → untouched; card: Luhn valid → redacted', () => {
  assert.equal(ibanValid('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(ibanValid('DE89 3704 0044 0532 0130 01'), false);
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  const ok = scrubText('IBAN DE89 3704 0044 0532 0130 00, Karte 4111 1111 1111 1111');
  assert.deepEqual(ok.findings.map((f) => f.kind), ['iban', 'card']);
  const bad = 'IBAN DE89 3704 0044 0532 0130 01, Karte 4111 1111 1111 1112, ticket 1234567890123';
  assert.equal(scrubText(bad).text, bad);
});

test('false-positive guards: URLs without userinfo, git SHAs, UUIDs, inline base64 images in code', () => {
  const s = [
    'see https://github.com/pedalix/coach-aven/commit/805a863f1e2d3c4b5a6978899aabbccddeeff001',
    'commit 805a863f1e2d3c4b5a6978899aabbccddeeff001 fixed it',
    'id 123e4567-e89b-12d3-a456-426614174000',
    '```',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">',
    '```',
  ].join('\n');
  assert.equal(scrubText(s).text, s);
});

test('a normal Slack task mention passes through untouched', () => {
  const s = '<@U123> please look at the failing CI on PR #112 — the deploy step times out after 10 minutes, logs in #alerts';
  assert.equal(scrubText(s).text, s);
  assert.deepEqual(scrubSummary([]), { kinds: [], count: 0 });
});

test('entropy layer: random string after a keyword is `likely`; same string in prose is not', () => {
  const rnd = 'q8Zr2Lm9Xv4Kp7Wt1Yh6Bn3Cd5Fg0Js';
  assert.ok(entropy(rnd) >= 3.8);
  const hit = scrubText(`your api key is below\n${rnd}`);
  assert.equal(hit.findings.length, 1);
  assert.equal(hit.findings[0]!.confidence, 'likely');
  const miss = scrubText(`the build id was ${rnd} and it passed`);
  assert.equal(miss.findings.length, 0);
  assert.equal(scrubText(`your api key is below\n${rnd}`, { exactOnly: true }).findings.length, 0);
});

// CANARY: planted secrets must never survive. Add a row whenever a real leak shape turns up.
const CANARY: Array<{ id: string; text: string; secrets: string[] }> = [
  { id: 'vendor-account-mail', text: 'Here are your credentials:\nLogin: https://outlook.office.com/\nUsername: owen.test@contoso.example\nPassword: K/9988776655ab\nPlease change your password after first login.', secrets: ['K/9988776655ab'] },
  { id: 'dsn-in-prose', text: 'prod is mysql://pms_ro:S3cr3t-Pa55@db.prod.example:3306/pms, read-only', secrets: ['S3cr3t-Pa55'] },
  { id: 'env-paste', text: '```\nDB_PASSWORD=Tr0ub4dor&3xyz\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n```', secrets: ['Tr0ub4dor&3xyz', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'] },
  { id: 'aws-pair', text: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', secrets: ['AKIAIOSFODNN7EXAMPLE'] },
  { id: 'slack-token', text: 'bot token is xoxb-1234567890-abcdefghijkl-mnopqrstuvwx', secrets: ['xoxb-1234567890-abcdefghijkl-mnopqrstuvwx'] },
  { id: 'github-pat', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the clone', secrets: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] },
  { id: 'russian-kv', text: 'пароль от стейджинга: Stag1ng-009, логин admin', secrets: ['Stag1ng-009'] },
  { id: 'iban', text: 'Rechnung bitte an DE89 3704 0044 0532 0130 00', secrets: ['DE89370400440532013000'] },
  { id: 'pem', text: 'key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----', secrets: ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'] },
];

test('canary: planted secrets never reach the output', () => {
  for (const c of CANARY) {
    const out = scrubText(c.text).text;
    for (const s of c.secrets) {
      assert.equal(out.indexOf(s), -1, `${c.id}: leaked ${s}\n${out}`);
      assert.equal(out.indexOf(s.replace(/(.{4})/g, '$1 ').trim()), -1, `${c.id}: leaked spaced ${s}`);
    }
  }
});
