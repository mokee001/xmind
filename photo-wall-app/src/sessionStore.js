import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'photowall-device-session-v1';

export async function loadDeviceSession() {
  try {
    const value = Platform.OS === 'web'
      ? globalThis.sessionStorage?.getItem(KEY)
      : await SecureStore.getItemAsync(KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export async function saveDeviceSession(session) {
  const value = JSON.stringify(session);
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.setItem(KEY, value);
  } else {
    await SecureStore.setItemAsync(KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
}
