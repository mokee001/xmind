const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  publicationFromResponse, hasDisplayReceipt, nativeWallPresentation, isCurrentWallRequest,
} = require('../photo-wall-app/src/wallExperienceState.cjs');

const wall = { wall_id: 'wall-a', image_url: '/output/wall-a.png' };
const candidate = { deviceId: 'eink-a', wallId: wall.wall_id, image: wall.image_url };
const queued = { device_id: 'eink-a', revision: 'revision-42', displayed_revision: '',
  state: 'queued', preview_url: '/output/device_frames/eink-a/revision-42.png', error: '' };
const accepted = { device: queued, revision: queued.revision, wall };

test('generation and publication acceptance do not count as successful display', () => {
  const publication = publicationFromResponse('eink-a', wall, accepted);
  assert.equal(nativeWallPresentation({ device_id: 'eink-a' }, null, candidate).confirmedImage, null);
  const pending = nativeWallPresentation(queued, publication, candidate);
  assert.equal(pending.confirmedImage, null);
  assert.deepEqual(pending.candidate, candidate);
  assert.equal(pending.awaitingReceipt, true);
});

test('matching receipt retires the candidate even though e-ink image URLs differ', () => {
  const publication = publicationFromResponse('eink-a', wall, accepted);
  const device = { ...queued, state: 'displayed', displayed_revision: queued.revision };
  assert.notEqual(wall.image_url, device.preview_url);
  const shown = nativeWallPresentation(device, publication, candidate);
  assert.equal(shown.confirmedImage, device.preview_url);
  assert.equal(shown.candidate, null);
  assert.equal(shown.awaitingReceipt, false);
});

test('19-inch wall image requires its own exact receipt, never send success alone', () => {
  const device = { device_id: 'screen19', revision: wall.wall_id, state: 'queued' };
  const publication = publicationFromResponse('screen19', wall, { device, revision: wall.wall_id, wall });
  const image = { ...candidate, deviceId: 'screen19' };
  assert.equal(nativeWallPresentation(device, publication, image).confirmedImage, null);
  assert.equal(nativeWallPresentation({ ...device, state: 'displayed' }, publication, image).confirmedImage, null);
  assert.equal(nativeWallPresentation({ ...device, state: 'displayed', displayed_revision: 'older-wall' }, publication, image).confirmedImage, null);
  const shown = nativeWallPresentation({ ...device, state: 'displayed', displayed_revision: wall.wall_id }, publication, image);
  assert.equal(shown.confirmedImage, wall.image_url);
  assert.equal(shown.candidate, null);
});

test('failed or errored receipts cannot label either type of screen as confirmed', () => {
  const publication = publicationFromResponse('eink-a', wall, accepted);
  for (const state of ['failed', 'error']) {
    const device = { ...queued, displayed_revision: queued.revision, state };
    assert.equal(hasDisplayReceipt(device), false);
    const view = nativeWallPresentation(device, publication, candidate);
    assert.equal(view.confirmedImage, null);
    assert.deepEqual(view.candidate, candidate);
    assert.equal(view.awaitingReceipt, false);
  }
  assert.equal(hasDisplayReceipt({ ...queued, state: 'displayed', displayed_revision: queued.revision, error: 'refresh failed' }), false);
});

test('new pending revision never relabels its image with the previous receipt', () => {
  const stale = { ...queued, revision: 'revision-43', displayed_revision: queued.revision };
  const publication = publicationFromResponse('eink-a', wall, accepted);
  assert.equal(nativeWallPresentation(stale, publication, candidate).confirmedImage, null);
  const oldPublication = { ...publication, revision: 'revision-41' };
  assert.deepEqual(nativeWallPresentation({ ...queued, displayed_revision: queued.revision }, oldPublication, candidate).candidate, candidate);
});

test('reopening restores a confirmed server image or a matching persisted 19-inch mapping', () => {
  const device = { ...queued, state: 'displayed', displayed_revision: queued.revision };
  assert.equal(nativeWallPresentation(device, null, null).confirmedImage, device.preview_url);
  const publication = publicationFromResponse('eink-a', wall, accepted);
  const withoutPreview = { ...device, preview_url: undefined };
  assert.equal(nativeWallPresentation(withoutPreview, JSON.parse(JSON.stringify(publication)), null).confirmedImage, wall.image_url);
  assert.equal(nativeWallPresentation(withoutPreview, null, null).confirmedImage, null);
  assert.equal(nativeWallPresentation(withoutPreview, { ...publication, revision: 'wrong' }, null).confirmedImage, null);
});

test('device, wall and revision mismatch are rejected rather than creating a mapping', () => {
  assert.equal(publicationFromResponse('other', wall, accepted), null);
  assert.equal(publicationFromResponse('eink-a', wall, { ...accepted, revision: 'wrong' }), null);
  assert.equal(publicationFromResponse('eink-a', wall, { ...accepted, wall: { ...wall, wall_id: 'other-wall' } }), null);
  assert.equal(publicationFromResponse('eink-a', wall, { device: { device_id: 'eink-a' } }), null);
  const publication = publicationFromResponse('eink-a', wall, accepted);
  const other = nativeWallPresentation({ device_id: 'other', revision: queued.revision, displayed_revision: queued.revision }, publication, candidate);
  assert.equal(other.confirmedImage, null);
  assert.equal(other.candidate, null);
});

test('request identity rejects an old operation, switched device and rebound account', () => {
  const request = { deviceId: 'eink-a', bindingEpoch: 1, sequence: 3 };
  assert.equal(isCurrentWallRequest(request, { ...request }), true);
  assert.equal(isCurrentWallRequest(request, { ...request, sequence: 4 }), false);
  assert.equal(isCurrentWallRequest(request, { ...request, deviceId: 'other' }), false);
  assert.equal(isCurrentWallRequest(request, { ...request, bindingEpoch: 2 }), false);
  assert.equal(isCurrentWallRequest(null, null), false);
});
