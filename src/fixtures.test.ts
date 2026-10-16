import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEnvelope, rehome } from './fixtures.js';

// A synthetic envelope with every shape the real ones carry (seen in the prod journal):
// tokens, trigger ids, a human with a username, a mention in free text, rich_text blocks,
// our own button meta, a modal input, a file with private URLs.
const TEAM = 'T0000FAKE01';
const CHAN = 'C0BBTB2RYM8';
const HUMAN = 'U03D1FXGTFZ';
const BOT = 'U0BAG0AV0JH';
const SECRET_TEXT = 'how many free lift tickets for Obersaxen';

const raw = () => ({
  token: 'PBTxdRtIrGN26RhPQ7uW5iMA',
  team_id: TEAM,
  api_app_id: 'A0BBDKW4GLQ',
  type: 'event_callback',
  event_id: 'Ev0BC1234567',
  event_time: 1788339099,
  authorizations: [{ team_id: TEAM, user_id: BOT, is_bot: true }],
  event: {
    type: 'app_mention',
    user: HUMAN,
    channel: CHAN,
    ts: '1788339099.134099',
    thread_ts: '1788339000.000001',
    client_msg_id: '115640b9-9573-405e-9034-b4cc3f5c1b03',
    text: `Hi <@${BOT}> ${SECRET_TEXT}, cc <#${CHAN}|aven-caldora>`,
    blocks: [
      {
        type: 'rich_text',
        block_id: 'Ab3C',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Hi ' },
              { type: 'user', user_id: BOT },
              { type: 'text', text: ` ${SECRET_TEXT}` },
            ],
          },
        ],
      },
    ],
    files: [
      { id: 'F0BC1234567', name: 'Sales Q3 secret.pdf', title: 'Sales Q3 secret', mimetype: 'application/pdf', size: 1234, url_private: 'https://files.slack.com/x', url_private_download: 'https://files.slack.com/y', permalink: 'https://p', thumb_64: 'https://t' },
    ],
  },
  user: { id: HUMAN, username: 'vera.lindqvist', name: 'vera.lindqvist', team_id: TEAM },
  // Shapes the first eyeball pass over real fixtures caught slipping through:
  profile: { first_name: 'Carla', real_name_normalized: 'Carla X', image_72: 'https://avatars.slack-edge.com/2022/abc_419c92e4bd2e', avatar_hash: '419c92e4bd2e', email: 'c@example.ch' },
  channel_meta: { name_normalized: 'aven-lumora', old_name: 'aven-art' },
  pr_button: { type: 'button', action_id: 'pr_link:0', url: 'https://github.com/BluefinOrg/caldora-admin/pull/38' },
  prefilled: { type: 'plain_text_input', initial_value: 'Draft a report for CB-256 about the FERRYCO Schifffahrt audit' },
  trigger_id: '11959422868163.2616500879654.354bee718353e53a0b81c67146cdacaf',
  response_url: 'https://hooks.slack.com/actions/T0000FAKE01/1/abc',
  enterprise: { id: 'E0XYZ', name: 'Big Corp' },
  actions: [{ action_id: 'fb_good', type: 'button', value: '{"t":"tmtka6lpq-1","s":"caldora","k":"thread:1788367041.990969"}', text: { type: 'plain_text', text: '👍 Helped' } }],
  view: {
    callback_id: 'fb_reason_modal',
    private_metadata: '{"t":"tmtka6lpq-1","s":"caldora","k":"thread:1.2","c":"C0BBTB2RYM8","ts":"1.0"}',
    state: {
      values: {
        fb_reason: { reason: { type: 'radio_buttons', selected_option: { value: 'tone', text: { type: 'plain_text', text: 'Too technical / wrong tone' } } } },
        fb_note: { note: { type: 'plain_text_input', value: 'it said staging numbers but I asked about prod' } },
      },
    },
  },
});

const fx = () => scrubEnvelope(raw(), { kind: 'app_mention', capturedOn: '2026-09-02' });

test('scrubEnvelope — nothing identifying survives, as a flat string search', () => {
  const s = JSON.stringify(fx());
  for (const leak of [TEAM, CHAN, HUMAN, BOT, 'PBTxdRtIrGN26RhPQ7uW5iMA', '11959422868163', 'vincent', 'Big Corp', 'E0XYZ', 'A0BBDKW4GLQ', 'Ev0BC1234567', '115640b9', 'hooks.slack.com', 'files.slack.com', 'Obersaxen', 'lift tickets', 'Sales Q3', 'staging numbers', 'aven-caldora', 'Carla', '419c92e4bd2e', 'avatars.slack-edge', 'example.ch', 'aven-lumora', 'aven-art', 'BluefinOrg', 'caldora-admin', 'Schifffahrt', 'CB-256']) {
    assert.ok(!s.includes(leak), `leaked: ${leak}`);
  }
});

test('scrubEnvelope — structure is preserved: same keys, same block types, same timestamps', () => {
  const before = raw();
  const after = fx().body as typeof before;
  const keysOf = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keysOf(after), keysOf(before));
  assert.deepEqual(keysOf(after.event), keysOf(before.event));
  assert.equal(after.event.ts, '1788339099.134099');
  assert.equal(after.event.thread_ts, '1788339000.000001');
  assert.equal(after.event_time, 1788339099);
  assert.equal(after.event.blocks[0].type, 'rich_text');
  assert.equal(after.event.blocks[0].block_id, 'Ab3C'); // block ids are not identity
  assert.equal(after.event.blocks[0].elements[0].elements.length, 3);
  assert.equal(after.event.blocks[0].elements[0].elements[1].type, 'user');
});

test('scrubEnvelope — roles: team/channel/actor/bot get the lowest placeholders and are consistent everywhere', () => {
  const f = fx();
  assert.deepEqual(f.roles, { team: 'T_FIX_1', channel: 'C_FIX_1', actor: 'U_FIX_1', bot: 'U_FIX_2' });
  const b = f.body as ReturnType<typeof raw>;
  assert.equal(b.team_id, 'T_FIX_1');
  assert.equal(b.event.channel, 'C_FIX_1');
  assert.equal(b.event.user, 'U_FIX_1');
  assert.equal(b.user.id, 'U_FIX_1');
  assert.equal(b.authorizations[0].user_id, 'U_FIX_2');
  assert.equal(b.event.blocks[0].elements[0].elements[1].user_id, 'U_FIX_2'); // rich_text mention element
});

test('scrubEnvelope — free text keeps its mentions (remapped) and nothing else', () => {
  const b = fx().body as ReturnType<typeof raw>;
  assert.equal(b.event.text, '<@U_FIX_2> <#C_FIX_1> [text]'); // routing survives, content does not
  assert.equal(b.event.blocks[0].elements[0].elements[0].text, '[text]');
  assert.equal(b.actions[0].text.text, '[text]'); // our own labels too — shape is what matters
});

test('scrubEnvelope — our own values survive: button meta, radio option, private_metadata; typed input does not', () => {
  const b = fx().body as ReturnType<typeof raw>;
  assert.equal(b.actions[0].value, '{"t":"tmtka6lpq-1","s":"caldora","k":"thread:1788367041.990969"}');
  assert.equal(b.view.state.values.fb_reason.reason.selected_option.value, 'tone');
  assert.equal(b.view.state.values.fb_note.note.value, '[text]');
  // private_metadata is ours, but it embeds a channel id inside a JSON string — the embedded
  // id rule reaches in and remaps it, so rehome() can later point it at the twin's channel.
  assert.equal(b.view.private_metadata, '{"t":"tmtka6lpq-1","s":"caldora","k":"thread:1.2","c":"C_FIX_1","ts":"1.0"}');
});

test('scrubEnvelope — by shape: any *name* key, any avatar, any URL, any prefilled field', () => {
  const b = fx().body as ReturnType<typeof raw> & Record<string, Record<string, unknown>>;
  assert.equal(b.profile.first_name, 'fixture');
  assert.equal(b.profile.real_name_normalized, 'fixture');
  assert.equal(b.profile.email, 'fixture');
  assert.equal(b.profile.image_72, 'fixture');
  assert.equal(b.profile.avatar_hash, 'fixture');
  assert.equal(b.channel_meta.name_normalized, 'fixture');
  assert.equal(b.channel_meta.old_name, 'fixture');
  assert.equal(b.pr_button.url, 'https://example.invalid/fixture'); // a PR in a client repo is a location, not a shape
  assert.equal(b.pr_button.action_id, 'pr_link:0'); // ours, kept
  assert.equal(b.prefilled.initial_value, '[text]'); // the bot wrote it, but it is ticket content
});

test('scrubEnvelope — files keep type and size, lose names and every URL', () => {
  const f = fx().body as ReturnType<typeof raw>;
  const file = f.event.files[0] as Record<string, unknown>;
  assert.equal(file.name, 'file-1.pdf'); // extension kept — handlers branch on it
  assert.equal(file.title, 'fixture');
  assert.equal(file.mimetype, 'application/pdf');
  assert.equal(file.size, 1234);
  assert.equal(file.id, 'F_FIX_1');
  for (const k of Object.keys(file)) assert.ok(!/^(url_|permalink|thumb_)/.test(k), `url-ish key survived: ${k}`);
});

test('scrubEnvelope — constants replace secrets; enterprise is nulled; deterministic', () => {
  const a = fx();
  const b = fx();
  assert.deepEqual(a, b);
  const body = a.body as ReturnType<typeof raw>;
  assert.equal(body.token, 'FIXTURE_TOKEN');
  assert.equal(body.trigger_id, 'FIXTURE.trigger.id');
  assert.equal(body.response_url, 'https://hooks.slack.invalid/fixture');
  assert.equal(body.enterprise, null);
  assert.equal(body.api_app_id, 'AFIXTURE');
});

test('scrubEnvelope — a view_submission finds its channel role inside private_metadata', () => {
  const view = { type: 'view_submission', team: { id: TEAM }, user: { id: HUMAN }, view: { callback_id: 'fb_reason_modal', private_metadata: `{"t":"tmtka6lpq-1","c":"${CHAN}","ts":"1.0"}`, state: { values: {} } } };
  const f = scrubEnvelope(view, { kind: 'view_submission', subtype: 'fb_reason_modal', capturedOn: '2026-09-02' });
  assert.equal(f.roles.channel, 'C_FIX_1'); // without this the fixture could never be rehomed onto a twin channel
  const homed = rehome(f, { channel: 'C_SHARED' }) as { view: { private_metadata: string } };
  assert.match(homed.view.private_metadata, /"c":"C_SHARED"/);
});

test('rehome — swaps every occurrence of each role id, bare and inside mentions', () => {
  const homed = rehome(fx(), { team: 'THOME1111', channel: 'C_SHARED', actor: 'U_HUMAN', bot: 'UBOT_THOME1111' }) as ReturnType<typeof raw>;
  assert.equal(homed.team_id, 'THOME1111');
  assert.equal(homed.event.channel, 'C_SHARED');
  assert.equal(homed.event.user, 'U_HUMAN');
  assert.equal(homed.event.text, '<@UBOT_THOME1111> <#C_SHARED> [text]');
  assert.equal(homed.authorizations[0].user_id, 'UBOT_THOME1111');
  assert.equal(homed.user.team_id, 'THOME1111');
  const s = JSON.stringify(homed);
  for (const role of ['T_FIX_1', 'C_FIX_1', 'U_FIX_1', 'U_FIX_2']) assert.ok(!s.includes(role), `role placeholder survived rehoming: ${role}`);
  assert.ok(s.includes('F_FIX_1')); // non-role ids (the file) keep their placeholder — nothing to home them to
  assert.match((homed.view as { private_metadata: string }).private_metadata, /"c":"C_SHARED"/); // reached inside the JSON string
});
