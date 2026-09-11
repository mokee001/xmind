// Extend the active snapshot rather than rebuilding it: other device/account
// features may own fields that this screen does not understand.
function extendPreferenceSnapshot(base = {}, changes = {}) {
  return {
    ...base,
    ...changes,
    schedule: { ...(base.schedule || {}), ...(changes.schedule || {}) },
    rules: { ...(base.rules || {}), ...(changes.rules || {}) },
    photoRange: { mode: 'all', since: '', ...(base.photoRange || {}), ...(changes.photoRange || {}) },
    temporalPreference: changes.temporalPreference || base.temporalPreference || 'balanced',
  };
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key])]));
}

function snapshotsEqual(left, right) {
  const normalize = snapshot => {
    const result = extendPreferenceSnapshot(snapshot);
    // Newly recognized neutral items are defaults, not user edits.
    result.rules = Object.fromEntries(Object.entries(result.rules).filter(([, value]) => value !== 'normal'));
    return comparable(result);
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

module.exports = { extendPreferenceSnapshot, snapshotsEqual };
