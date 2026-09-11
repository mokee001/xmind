import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// A policy is intentionally append-only.  A preference edit must never mutate
// the currently active configuration in place: users need to be able to
// compare, restore, and audit what was on screen before a change.
const PREFERENCE_PROFILE_KEY = 'echooo-model-preferences-v1';

function emptyProfile() {
  return {
    schemaVersion: 1,
    onboardingCompleted: false,
    activeRevisionId: null,
    revisions: [],
  };
}

async function readValue() {
  const raw = Platform.OS === 'web'
    ? globalThis.sessionStorage?.getItem(PREFERENCE_PROFILE_KEY)
    : await SecureStore.getItemAsync(PREFERENCE_PROFILE_KEY);
  if (!raw) return emptyProfile();
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.revisions)) return emptyProfile();
  return {
    ...emptyProfile(),
    ...parsed,
    revisions: parsed.revisions.filter(revision => revision?.id && revision?.snapshot),
  };
}

async function writeValue(profile) {
  const serialized = JSON.stringify(profile);
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.setItem(PREFERENCE_PROFILE_KEY, serialized);
    return;
  }
  await SecureStore.setItemAsync(PREFERENCE_PROFILE_KEY, serialized, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot || {}));
}

function newRevisionId() {
  return `pref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadPreferenceProfile() {
  try {
    return await readValue();
  } catch {
    return emptyProfile();
  }
}

export async function cachePreferenceProfile(profile) {
  const next = {
    ...emptyProfile(),
    ...(profile || {}),
    revisions: Array.isArray(profile?.revisions) ? profile.revisions : [],
  };
  await writeValue(next);
  return next;
}

export function getActivePreferenceRevision(profile) {
  const activeId = profile?.activeRevisionId;
  return profile?.revisions?.find(revision => revision.id === activeId) || null;
}

export async function savePreferenceRevision({ profile, snapshot, source = 'preferences' }) {
  const current = profile?.revisions ? profile : await loadPreferenceProfile();
  const revision = {
    id: newRevisionId(),
    parentId: current.activeRevisionId || null,
    createdAt: new Date().toISOString(),
    source,
    snapshot: cloneSnapshot(snapshot),
  };
  const next = {
    ...current,
    onboardingCompleted: current.onboardingCompleted || source === 'onboarding',
    activeRevisionId: revision.id,
    revisions: [...current.revisions, revision],
  };
  await writeValue(next);
  return next;
}

// Restoring a revision changes only the active pointer.  The historical
// snapshot stays immutable, which makes rollback safe even after many edits.
export async function activatePreferenceRevision(profile, revisionId) {
  const current = profile?.revisions ? profile : await loadPreferenceProfile();
  if (!current.revisions.some(revision => revision.id === revisionId)) {
    throw new Error('未找到要回退的偏好版本');
  }
  const next = { ...current, onboardingCompleted: true, activeRevisionId: revisionId };
  await writeValue(next);
  return next;
}

export async function markPreferenceOnboardingComplete(profile) {
  const current = profile?.revisions ? profile : await loadPreferenceProfile();
  const next = { ...current, onboardingCompleted: true };
  await writeValue(next);
  return next;
}
