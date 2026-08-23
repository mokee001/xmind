import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'photowall-device-session-v1';
const PENDING_SETUP_KEY = 'photowall-pending-setup-v1';
const PHOTO_SYNC_KEY = 'photowall-photo-sync-v1';

async function readValue(key) {
  const value = Platform.OS === 'web'
    ? globalThis.sessionStorage?.getItem(key)
    : await SecureStore.getItemAsync(key);
  return value ? JSON.parse(value) : null;
}

async function writeValue(key, value) {
  const serialized = JSON.stringify(value);
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.setItem(key, serialized);
  } else {
    await SecureStore.setItemAsync(key, serialized, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
}

async function deleteValue(key) {
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.removeItem(key);
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

export async function loadDeviceSession() {
  try {
    const session = await readValue(KEY);
    if (session?.device?.device_id?.endsWith('-demo')) {
      await deleteValue(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export async function saveDeviceSession(session) {
  await writeValue(KEY, session);
}

export async function clearDeviceSession() {
  await deleteValue(KEY);
}

export async function loadPendingDeviceSetup() {
  try {
    return await readValue(PENDING_SETUP_KEY);
  } catch {
    return null;
  }
}

export async function savePendingDeviceSetup(setup) {
  await writeValue(PENDING_SETUP_KEY, setup);
}

export async function clearPendingDeviceSetup() {
  await deleteValue(PENDING_SETUP_KEY);
}

export async function loadPhotoSyncPreference() {
  try {
    return await readValue(PHOTO_SYNC_KEY);
  } catch {
    return null;
  }
}

export async function savePhotoSyncPreference(preference) {
  await writeValue(PHOTO_SYNC_KEY, preference);
}

export async function clearPhotoSyncPreference() {
  await deleteValue(PHOTO_SYNC_KEY);
}
