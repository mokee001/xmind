import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const ACCOUNT_KEY = 'photowall-family-account-v1';

export async function loadAccountSession() {
  try {
    const value = Platform.OS === 'web'
      ? globalThis.sessionStorage?.getItem(ACCOUNT_KEY)
      : await SecureStore.getItemAsync(ACCOUNT_KEY);
    const parsed = value ? JSON.parse(value) : null;
    return parsed?.accessToken && parsed?.account?.user_id ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveAccountSession(session) {
  if (!session?.accessToken || !session?.account?.user_id) {
    throw new Error('账户会话无效');
  }
  const serialized = JSON.stringify(session);
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.setItem(ACCOUNT_KEY, serialized);
    return session;
  }
  await SecureStore.setItemAsync(ACCOUNT_KEY, serialized, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return session;
}

export async function clearAccountSession() {
  if (Platform.OS === 'web') {
    globalThis.sessionStorage?.removeItem(ACCOUNT_KEY);
  } else {
    await SecureStore.deleteItemAsync(ACCOUNT_KEY);
  }
}
