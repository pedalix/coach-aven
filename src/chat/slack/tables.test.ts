// A pasted Slack table rides in an attachment's `table` block; the normalizers append it to the text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSlackTables, withSlackTables } from './tables.js';

const t = (text: string) => ({ type: 'raw_text', text });
const ATTACHMENTS = [
  {
    id: 1,
    blocks: [
      {
        type: 'table',
        block_id: 'b1',
        rows: [
          [null, null, null],
          [t('Date'), t('Task'), t('Hours')],
          [t('01/10/2026'), t('Rollout review | deploy'), t('4')],
          [t('02/10/2026'), null, t('0')],
        ],
      },
    ],
  },
];

test('a table block becomes a pipe table: empty rows dropped, the first row the header, pipes escaped, short rows padded', () => {
  assert.equal(
    renderSlackTables(ATTACHMENTS),
    ['| Date | Task | Hours |', '| --- | --- | --- |', '| 01/10/2026 | Rollout review \\| deploy | 4 |', '| 02/10/2026 |  | 0 |'].join('\n'),
  );
});

test('no table → the text as it was; a table → appended after the text, or alone', () => {
  assert.equal(withSlackTables('hello', [{ id: 1, blocks: [{ type: 'section' }] }]), 'hello');
  assert.equal(withSlackTables('hello', undefined), 'hello');
  assert.equal(renderSlackTables([{ blocks: [{ type: 'table', rows: [[null, null]] }] }]), '');
  assert.match(withSlackTables('the picture:', ATTACHMENTS), /^the picture:\n\n\| Date \| Task \| Hours \|/);
  assert.match(withSlackTables('', ATTACHMENTS), /^\| Date/);
});
