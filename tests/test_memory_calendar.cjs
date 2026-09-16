const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RENDERED_MONTHS,
  parseConfirmedAt,
  localDateKey,
  normalizeMemoryRecords,
  groupMemoryRecords,
  monthNumber,
  calendarMonth,
  initialMonthRange,
  extendMonthRange,
  confirmedTimeLabel,
} = require('../photo-wall-app/src/memoryCalendar.cjs');

const receipt = (id, confirmedAt, fields = {}) => ({ id, confirmedAt, title: '一次真实展示', revision: 'rev-1', ...fields });

function inTimezone(zone, action) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('receipt timestamps accept explicit offsets and Python microseconds without changing the instant', () => {
  const timestamp = Date.UTC(2026, 8, 16, 0, 1, 2, 123);
  assert.equal(parseConfirmedAt('2026-09-16T08:01:02.123456+08:00'), timestamp);
  assert.equal(parseConfirmedAt('2026-09-16T00:01:02.123Z'), timestamp);
  assert.equal(parseConfirmedAt('2026-09-15T17:01:02.123-07:00'), timestamp);
});

test('invalid calendar dates and timestamps without an explicit timezone cannot create memories', () => {
  const invalid = [
    '2026-02-29T01:00:00Z', '2024-02-30T01:00:00Z', '2026-13-01T00:00:00Z',
    '2026-09-31T00:00:00Z', '2026-09-16T24:00:00Z', '2026-09-16T00:60:00Z',
    '2026-09-16T00:00:60Z', '2026-09-16T00:00:00+25:00', '2026-09-16T00:00:00+08:60',
    '2026-09-16T00:00:00', '2026-09-16', '', null, 1789516800000,
  ];
  invalid.forEach(value => assert.ok(Number.isNaN(parseConfirmedAt(value)), String(value)));
  assert.ok(Number.isFinite(parseConfirmedAt('2024-02-29T01:00:00Z')));
  assert.deepEqual(normalizeMemoryRecords(invalid.map((time, index) => receipt(String(index), time))), []);
});

test('future receipts are excluded even later on the same local day, while the cutoff itself is valid', () => {
  const now = Date.UTC(2026, 8, 16, 8, 0, 0);
  const records = normalizeMemoryRecords([
    receipt('past', '2026-09-16T07:59:59Z'),
    receipt('now', '2026-09-16T08:00:00Z'),
    receipt('future', '2026-09-16T08:00:00.001Z'),
    receipt('tomorrow', '2026-09-17T00:00:00Z'),
  ], now);
  assert.deepEqual(records.map(record => record.id), ['now', 'past']);
});

test('duplicate ids count once, keep the latest valid receipt and cannot be masked by a future copy', () => {
  const now = Date.UTC(2026, 8, 16, 8);
  const input = [
    receipt('same', '2026-09-15T00:00:00Z', { title: '较早版本' }),
    receipt('same', '2026-09-16T00:00:00Z', { title: '已确认版本', revision: 'rev-2' }),
    receipt(' same ', '2026-09-17T00:00:00Z', { title: '未来内容' }),
    receipt('other', '2026-09-16T00:00:00Z'),
    receipt('', '2026-09-16T00:00:00Z'),
  ];
  const before = JSON.stringify(input);
  const output = normalizeMemoryRecords(input, now);
  assert.equal(output.length, 2);
  assert.equal(output.find(record => record.id === 'same').title, '已确认版本');
  assert.equal(output.find(record => record.id === 'same').revision, 'rev-2');
  assert.equal(JSON.stringify(input), before);
});

test('grouping uses the device local day across UTC midnight and year boundaries', () => {
  const records = [receipt('new-year', '2025-12-31T16:15:00Z')];
  const now = Date.UTC(2026, 0, 2);
  inTimezone('Asia/Shanghai', () => {
    const result = groupMemoryRecords(records, now);
    assert.deepEqual(Object.keys(result.byDay), ['2026-01-01']);
    assert.equal(confirmedTimeLabel(records[0].confirmedAt), '2026年1月1日 00:15:00');
  });
  inTimezone('America/Los_Angeles', () => {
    assert.deepEqual(Object.keys(groupMemoryRecords(records, now).byDay), ['2025-12-31']);
  });
});

test('day grouping survives a daylight saving transition without splitting the local day', () => {
  inTimezone('America/New_York', () => {
    const result = groupMemoryRecords([
      receipt('before', '2026-03-08T06:50:00Z'),
      receipt('after', '2026-03-08T07:10:00Z'),
    ], Date.UTC(2026, 2, 9));
    assert.deepEqual(Object.keys(result.byDay), ['2026-03-08']);
    assert.deepEqual(result.byDay['2026-03-08'].map(record => record.id), ['after', 'before']);
  });
});

test('no invalid record, blank title or extra image field is promoted to photo content', () => {
  const now = Date.UTC(2026, 8, 16);
  const result = normalizeMemoryRecords([
    null, {}, receipt(null, '2026-09-15T00:00:00Z'),
    receipt('valid', '2026-09-15T00:00:00Z', { title: ' ', imageUrl: 'https://example.invalid/private.jpg', preview: {} }),
  ], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, '照片墙展示记录');
  assert.equal('imageUrl' in result[0], false);
  assert.equal('preview' in result[0], false);
  assert.deepEqual(groupMemoryRecords([], now).records, []);
  assert.deepEqual(Object.keys(groupMemoryRecords([], now).byDay), []);
});

test('month grids start on Monday and handle leap years without fake adjacent-month dates', () => {
  inTimezone('Asia/Shanghai', () => {
    const leap = calendarMonth(2024 * 12 + 1);
    assert.equal(leap.cells.length, 35);
    assert.deepEqual(leap.cells.slice(0, 3), [null, null, null]);
    assert.equal(leap.cells[3].key, '2024-02-01');
    assert.equal(leap.cells.filter(Boolean).at(-1).day, 29);
    assert.equal(calendarMonth(2026 * 12 + 1).cells.filter(Boolean).length, 28);
    const september = calendarMonth(2026 * 12 + 8);
    assert.equal(september.cells[0], null);
    assert.equal(september.cells[1].key, '2026-09-01');
    assert.equal(september.cells.at(-1), null);
  });
});

test('month navigation crosses years in three-month batches and keeps the native tree bounded', () => {
  inTimezone('Asia/Shanghai', () => {
    const now = new Date(2026, 0, 31, 12);
    assert.equal(monthNumber(now), 2026 * 12);
    assert.equal(localDateKey(now), '2026-01-31');
    let range = initialMonthRange(now);
    assert.equal(range.last - range.first + 1, 7);
    assert.equal(calendarMonth(range.first).key, '2025-10');
    for (const direction of [...Array(24).fill('earlier'), ...Array(48).fill('later')]) {
      const old = range;
      range = extendMonthRange(range, direction);
      assert.ok(range.last - range.first + 1 <= MAX_RENDERED_MONTHS);
      assert.equal(direction === 'earlier' ? old.first - range.first : range.last - old.last, 3);
    }
  });
});
