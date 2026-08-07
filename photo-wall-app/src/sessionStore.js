import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'photowall-device-session-v1';
const PENDING_SETUP_KEY = 'photowall-pending-setup-v1';

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

export async function loadDeviceSession() {
  try {
    return await readValue(KEY);
  } catch {
    return null;
  }
}

export async function saveDeviceSession(session) {
  await writeValue(KEY, session);
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
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.removeItem(PENDING_SETUP_KEY);
  } else {
    await SecureStore.deleteItemAsync(PENDING_SETUP_KEY);
  }
}
