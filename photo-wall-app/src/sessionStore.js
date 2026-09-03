import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'photowall-device-session-v1';
const DEVICES_KEY = 'photowall-device-sessions-v2';
const PENDING_SETUP_KEY = 'photowall-pending-setup-v1';
const PHOTO_SYNC_KEY = 'photowall-photo-sync-v1';
const ORGANIZING_PAUSED_KEY = 'photowall-organizing-paused-v1';
let deviceMutationQueue = Promise.resolve();

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

function validSession(session) {
  return session?.device?.device_id && !session.device.device_id.endsWith('-demo');
}

function upsertSession(sessions, session) {
  const deviceId = session.device.device_id;
  return [...sessions.filter(item => item.device?.device_id !== deviceId), session];
}

function serializeDeviceMutation(operation) {
  const result = deviceMutationQueue.then(operation, operation);
  deviceMutationQueue = result.catch(() => {});
  return result;
}

async function readDeviceSessions() {
  const [stored, legacy] = await Promise.all([readValue(DEVICES_KEY), readValue(KEY)]);
  let sessions = Array.isArray(stored?.sessions) ? stored.sessions.filter(validSession) : [];
  if (!stored && validSession(legacy)) sessions = [legacy];
  const requestedActiveId = stored?.activeDeviceId || (!stored ? legacy?.device?.device_id : null);
  const activeDeviceId = sessions.some(item => item.device.device_id === requestedActiveId)
    ? requestedActiveId
    : sessions[0]?.device?.device_id || null;
  if (sessions.length || stored) await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
  if (legacy?.device?.device_id?.endsWith('-demo')) await deleteValue(KEY);
  return { activeDeviceId, sessions };
}

export async function loadDeviceSessions() {
  try {
    return await readDeviceSessions();
  } catch {
    return { activeDeviceId: null, sessions: [] };
  }
}

export async function loadDeviceSession() {
  const stored = await loadDeviceSessions();
  return stored.sessions.find(item => item.device.device_id === stored.activeDeviceId) || null;
}

export async function saveDeviceSession(session) {
  if (!validSession(session)) throw new Error('设备会话无效');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    const sessions = upsertSession(stored.sessions, session);
    const activeDeviceId = session.device.device_id;
    await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
    await writeValue(KEY, session);
    return { activeDeviceId, sessions };
  });
}

export async function updateDeviceSession(session) {
  if (!validSession(session)) throw new Error('设备会话无效');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    const sessions = upsertSession(stored.sessions, session);
    const activeDeviceId = sessions.some(item => item.device.device_id === stored.activeDeviceId)
      ? stored.activeDeviceId
      : session.device.device_id;
    const activeSession = sessions.find(item => item.device.device_id === activeDeviceId);
    await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
    await writeValue(KEY, activeSession);
    return { activeDeviceId, sessions };
  });
}

export async function selectDeviceSession(deviceId) {
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    const session = stored.sessions.find(item => item.device.device_id === deviceId);
    if (!session) throw new Error('没有找到这台照片墙');
    await Promise.all([
      writeValue(DEVICES_KEY, { activeDeviceId: deviceId, sessions: stored.sessions }),
      writeValue(KEY, session),
    ]);
    return session;
  });
}

export async function removeDeviceSession(deviceId) {
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    const sessions = stored.sessions.filter(item => item.device.device_id !== deviceId);
    const activeDeviceId = stored.activeDeviceId === deviceId
      ? sessions[0]?.device?.device_id || null
      : stored.activeDeviceId;
    const activeSession = sessions.find(item => item.device.device_id === activeDeviceId) || null;
    await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
    if (activeSession) await writeValue(KEY, activeSession);
    else await deleteValue(KEY);
    return activeSession;
  });
}

export async function clearDeviceSession() {
  const session = await loadDeviceSession();
  if (session?.device?.device_id) await removeDeviceSession(session.device.device_id);
  else await deleteValue(KEY);
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

export async function loadOrganizingPaused() {
  try {
    return Boolean(await readValue(ORGANIZING_PAUSED_KEY));
  } catch {
    return false;
  }
}

export async function saveOrganizingPaused(paused) {
  await writeValue(ORGANIZING_PAUSED_KEY, Boolean(paused));
}
