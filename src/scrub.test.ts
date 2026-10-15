import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyMessage, entropy, extractSecrets, hash6, ibanValid, luhn, scrubMessage, scrubSummary, scrubText, vaultId, withheldMarker } from './scrub.js';
import { buildPayload, vaultFile } from './sources/common/vault.js';
import { vaultPathsFor } from './sources/tokens.js';

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

/** Run `fn` with env overrides, restoring the previous values afterwards. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Puller side (src/sources): carrier classification, withholding, vault ─────────────────

// Fixtures are shaped after real traffic (Tobin's account mail, pasted .env in a DM, a snippet reply
// in a thread) with FAKE values. If a shape here stops matching real mail, change the fixture, not
// the assertion.
const CONTOSO_MAIL = {
  source: 'gmail',
  id: 'm1',
  subject: 'Your Contoso Account',
  text: `Hi Owen,
Sorry for the delay. Here are your Contoso credentials:
Login: https://outlook.office.com/
Username: owen.test@contoso.example
Password: K/9988776655ab

Please change your password after your first login.
DSN for staging: mysql://pms_ro:S3cr3t-Pa55@db.staging.example:3306/pms
Cheers, Tobin`,
  attachments: [{ name: 'image.png', size: 2048, contentType: 'image/png' }],
};

const SLACK_ENV_DM = {
  source: 'slack',
  id: 'D1:1.1',
  text: `here you go
\`\`\`
APP_ENV=production
DB_HOST=10.0.0.5
DB_USERNAME=app
DB_PASSWORD=Tr0ub4dor&3xyz
MAIL_HOST=smtp.example
STRIPE_KEY=sk-live-ZmFrZS1zdHJpcGUta2V5LWZvci10ZXN0cw
\`\`\`
ping me if it fails`,
};

const SLACK_SNIPPET_REPLY = {
  source: 'slack',
  id: 'C2:2.2',
  subject: 're: deploy broken again',
  text: `    export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
    export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
    aws s3 ls`,
};


test('classifyMessage: carriers by strong exact kind, two findings, password+login bundle, strong subject, attachment', () => {
  assert.equal(classifyMessage(CONTOSO_MAIL).carrier, true);
  assert.ok(classifyMessage(CONTOSO_MAIL).reasons.some((r) => r.startsWith('exact:') && r.includes('dsn')));
  // The same mail without the DSN: a lone kv hit, but "Password:" beside "Username:" is a credential bundle.
  const bundle = { ...CONTOSO_MAIL, text: CONTOSO_MAIL.text.replace(/DSN for staging:.*\n/, '') };
  assert.deepEqual(classifyMessage(bundle).reasons, ['exact:kv+login']);
  assert.ok(classifyMessage({ subject: 'Zugangsdaten VPN', text: 'siehe anhang' }).reasons.includes('subject'));
  assert.ok(classifyMessage({ subject: 'Your login details for the portal', text: 'see below' }).reasons.includes('subject'));
  assert.ok(classifyMessage({ text: 'fyi', attachments: [{ name: 'prod.env' }] }).reasons[0]!.startsWith('attachment:'));
  assert.ok(classifyMessage({ text: 'fyi', attachments: [{ name: 'server.pem' }] }).carrier);
  // Two weak findings together are a carrier; one is not.
  assert.equal(classifyMessage({ text: 'token: abc123def456 and secret: zyx987wvu654' }).carrier, true);
  assert.equal(classifyMessage({ text: 'password: changed' }).carrier, false);
  // Two Luhn-valid numbers (task ids, invoice refs) are not a credential bundle.
  assert.equal(classifyMessage({ subject: 'You have 2 overdue tasks', text: 'Task 4539578763621486 and task 6011000990139424 are overdue' }).carrier, false);
  assert.equal(classifyMessage({ text: 'card 4539578763621486 pin: 123456' }).carrier, false, 'card + one kv stays inline');
  // Body phrases alone no longer withhold: a body *about* credentials is inline-redacted, not dropped.
  assert.equal(classifyMessage({ text: 'here are your credentials for the portal, call me' }).carrier, false);
  assert.equal(classifyMessage({ subject: 'Lunch?', text: 'the VPN was slow today, also the password reset flow is nicer now' }).carrier, false);
  assert.equal(classifyMessage({ text: 'logo.png attached', attachments: [{ name: 'logo.png' }] }).carrier, false);
});

test('classifyMessage: mail ABOUT credentials and link-token pairs stay inline (2026-10-14 false positives)', () => {
  // Owen → Tobin, security findings: "credentials" in the subject, zero secrets in the body, one
  // prose "pass (" that the kv layer still trips on — inline at most, never withheld.
  const foc = {
    subject: 'FOC Cloud: 18 credentials to rotate (list attached)',
    text: 'FOC Cloud: 19 distinct credentials in 41 places. The Azure SQL admin password sits in 13 places. History needs a proper scanner pass (gitleaks / trufflehog), which I\'d leave for the security guy.',
  };
  assert.equal(classifyMessage(foc).carrier, false, classifyMessage(foc).reasons.join(','));
  // GitHub notification mail: "credential" in a branch name, "token is required" in the PR body.
  const gh = {
    subject: 'Re: [monto/CartFlow] feat/surface-tax-and-webflow-credential-failures (PR #2802)',
    text: 'with it on, a token is required. A request that carries a token is refused when the flag is active.',
  };
  assert.equal(classifyMessage(gh).carrier, false, classifyMessage(gh).reasons.join(','));
  // Two tracking tokens inside URLs (newsletter / unfurl shape) are not a bundle.
  assert.equal(classifyMessage({ text: 'see https://x.example/a?link_token=abcdef123456 and https://x.example/b?msg_token=zyxwvu987654' }).carrier, false);
  // Prose "token" twice with symbol-bearing values is not a bundle either.
  assert.equal(classifyMessage({ text: 'a 1.05M-token context-window; better token (90%) efficiency' }).carrier, false);
  // Delivery subjects still withhold.
  assert.ok(classifyMessage({ subject: 'Your credentials for the portal', text: 'see below' }).reasons.includes('subject'));
  assert.ok(classifyMessage({ subject: 'New credentials attached', text: 'siehe anhang' }).reasons.includes('subject'));
  // Login + password bundle still withholds, even with a URL token beside it.
  assert.ok(classifyMessage({ text: 'Login: owen\nPassword: K/9988776655ab\nhttps://x.example/?token=abcdef123456' }).reasons.includes('exact:kv+login'));
});

test('scrubText: "token is required" / "password is changed" are prose, not values', () => {
  assert.equal(scrubText('with it on, a token is required').findings.length, 0);
  assert.equal(scrubText('the password is changed').findings.length, 0);
  assert.equal(scrubText('the password is Tr0ub4dor&3xyz').findings.length, 1);
  assert.equal(scrubText('password: changed').findings.length, 1, 'an explicit colon is taken at its word');
});

test('classifyMessage: the subjects the first live pull wrongly withheld are not carriers', () => {
  const real = [
    '[Action required] Migrate your legacy user API keys',
    '[GitHub] Your Dependabot alerts for the week of Sep 29 - Oct 6',
    '[Brevo] SMTP keys are marked inactive',
    '📅 You have 1 overdue task',
    'Re: Cloudvisor x WAFR',
    'Updates to managing AI crawlers on your account',
    'Your Contoso Account', // subject alone is generic — the BODY decides (see bundle test above)
    'Password reset requested',
    'Accepted: BLUEFIN Devs Weekly Sync',
  ];
  for (const subject of real) {
    const c = classifyMessage({ subject, text: 'Plain notification body with a link https://example.com/x?id=42 and nothing else.' });
    assert.equal(c.carrier, false, `${subject} → ${c.reasons.join(',')}`);
  }
});

test('scrubMessage: carrier → body withheld, attachments reduced to name+size, meta set, input untouched', () => {
  const before = JSON.stringify(CONTOSO_MAIL);
  const out = scrubMessage(CONTOSO_MAIL);
  assert.equal(JSON.stringify(CONTOSO_MAIL), before);
  const vid = vaultId('gmail', 'm1');
  assert.equal(out.text, withheldMarker(vid));
  assert.deepEqual(out.attachments, [{ name: 'image.png', size: 2048 }]);
  assert.deepEqual(out.scrub, { withheld: true, kinds: ['dsn', 'kv'], redactions: 0, vault: vid });
  assert.equal(out.subject, 'Your Contoso Account'); // headers survive
  assert.equal(JSON.stringify(out).includes('K/9988776655ab'), false);
  assert.equal(JSON.stringify(out).includes('S3cr3t-Pa55'), false);
});

test('scrubMessage: non-carrier keeps body with inline redactions', () => {
  const out = scrubMessage({ source: 'slack', id: 'x', text: 'deployed, build 805a863, ping @nico' });
  assert.equal(out.text, 'deployed, build 805a863, ping @nico');
  assert.deepEqual(out.scrub, { withheld: false, kinds: [], redactions: 0 });
});

test('Slack .env in a code block and a snippet reply are carriers; extractSecrets returns the raw values', () => {
  for (const m of [SLACK_ENV_DM, SLACK_SNIPPET_REPLY]) {
    const out = scrubMessage(m);
    assert.equal(out.scrub.withheld, true, m.id);
  }
  const secrets = extractSecrets(SLACK_ENV_DM);
  const values = secrets.map((s) => s.value);
  assert.ok(values.includes('Tr0ub4dor&3xyz'));
  assert.ok(values.includes('sk-live-ZmFrZS1zdHJpcGUta2V5LWZvci10ZXN0cw'));
  for (const s of secrets) {
    assert.equal(s.context.includes(s.value), false, 'context must not contain the value');
    assert.equal(s.hash6, hash6(s.value));
  }
  const aws = extractSecrets(SLACK_SNIPPET_REPLY).map((s) => s.kind);
  assert.ok(aws.includes('aws'));
  assert.ok(aws.includes('kv')); // AWS_SECRET_ACCESS_KEY=… via the secret/key keyword
});

test('vault: deterministic id, path validation, payload carries secrets + ref, never the scrubbed marker', () => {
  assert.equal(vaultId('gmail', 'm1'), vaultId('gmail', 'm1'));
  assert.notEqual(vaultId('gmail', 'm1'), vaultId('slack', 'm1'));
  const paths = withEnv({ XDG_CONFIG_HOME: '/home/x/.xdg', AVEN_DATA_DIR: '/srv/aven-data' }, () => vaultPathsFor('proj-a'));
  assert.equal(paths.dir, '/srv/aven-data/proj-a/vault');
  assert.equal(paths.recipientFile, '/home/x/.xdg/coach-aven/sources/proj-a/vault.recipient');
  assert.equal(vaultFile(paths.dir, vaultId('gmail', 'm1')), `/srv/aven-data/proj-a/vault/${vaultId('gmail', 'm1')}.json.age`);
  assert.throws(() => vaultFile(paths.dir, '../etc/passwd'));
  const p = buildPayload({ ...CONTOSO_MAIL, account: 'owen@home.example', ts: '2026-10-01T11:18:42Z', author: 'tobin@example' });
  assert.equal(p.vault_id, vaultId('gmail', 'm1'));
  assert.equal(p.body, CONTOSO_MAIL.text);
  assert.deepEqual(p.secrets.map((s) => s.kind).sort(), ['dsn', 'kv']);
  assert.equal(p.ref.account, 'owen@home.example');
});

// CANARY: every planted secret in the fixture set must be absent from the serialised output.
// Add a line to src/fixtures/scrub-canary.jsonl whenever a real leak shape is discovered (and
// the same line to scrub-gold.jsonl, which `orch sources audit` measures recall on).
test('canary: planted secrets never reach a scrubbed message', () => {
  const lines = readFileSync(new URL('./fixtures/scrub-canary.jsonl', import.meta.url), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 8);
  for (const line of lines) {
    const { secrets, ...msg } = JSON.parse(line) as { secrets: string[] } & Parameters<typeof scrubMessage>[0];
    const out = JSON.stringify(scrubMessage(msg));
    for (const s of secrets) assert.equal(out.indexOf(s), -1, `${msg.id}: leaked ${s}\n${out}`);
    // and the IBAN/card also must not survive with its original spacing
    for (const s of secrets) assert.equal(out.indexOf(s.replace(/(.{4})/g, '$1 ').trim()), -1, `${msg.id}: leaked spaced ${s}`);
  }
});
