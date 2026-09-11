const test = require('node:test');
const assert = require('node:assert/strict');
const { extendPreferenceSnapshot, snapshotsEqual } = require('../photo-wall-app/src/preferenceSnapshot.cjs');
const { isValidPhotoRange } = require('../photo-wall-app/src/contentPreferenceDetails.cjs');

test('new preference fields preserve existing device and schedule extensions', () => {
  const old = { schedule: { frequency: '每周', timezone: 'Asia/Shanghai' }, rules: { legacyPerson: 'hide' }, family: { role: 'contributor' }, photoScope: 'limited-system-access' };
  const before = JSON.stringify(old);
  const updated = extendPreferenceSnapshot(old, { schedule: { time: '12:00' }, rules: { pet: 'more' }, photoRange: { mode: 'year', since: '' } });
  assert.equal(JSON.stringify(old), before);
  assert.deepEqual(updated.family, old.family);
  assert.equal(updated.schedule.timezone, 'Asia/Shanghai');
  assert.equal(updated.schedule.frequency, '每周');
  assert.equal(updated.photoScope, 'limited-system-access');
  assert.equal(updated.rules.legacyPerson, 'hide');
  assert.equal(updated.rules.pet, 'more');
});

test('old revisions remain neutral after new fields and neutral recognition appear', () => {
  const old = { rules: { child: 'hide' }, schedule: { frequency: '每周' } };
  const migrated = extendPreferenceSnapshot(old, { rules: { newlyRecognized: 'normal' } });
  assert.equal(snapshotsEqual(old, migrated), true);
  assert.equal(snapshotsEqual(old, { ...migrated, temporalPreference: 'past' }), false);
  assert.equal(snapshotsEqual(old, { ...migrated, photoRange: { mode: 'year', since: '' } }), false);
  assert.equal(snapshotsEqual(old, { ...migrated, rules: { child: 'normal' } }), false);
});

test('date boundaries reject invalid and future capture dates', () => {
  assert.equal(isValidPhotoRange({ mode: 'since', since: '2024-02-29' }, '2026-09-10'), true);
  for (const since of ['2025-02-29', '2026-04-31', '2026-09-11', '', '2026-9-01']) {
    assert.equal(isValidPhotoRange({ mode: 'since', since }, '2026-09-10'), false);
  }
  assert.equal(isValidPhotoRange({ mode: 'all', since: '' }), true);
});
