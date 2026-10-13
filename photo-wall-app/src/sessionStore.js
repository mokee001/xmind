import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'photowall-device-session-v1';
const DEVICES_KEY = 'photowall-device-sessions-v2';
const PENDING_SETUP_KEY = 'photowall-pending-setup-v1';
const PHOTO_SYNC_KEY = 'photowall-photo-sync-v1';
const RECOVERY_KEY = 'photowall-device-recovery-v1';
const REMOVALS_KEY = 'photowall-device-removal-attempts-v1';
const REPROVISION_KEY = 'photowall-device-reprovision-v1';
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
  // Reads never write a captured snapshot back over a concurrent removal/claim.
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

export async function saveDeviceSession(session, guard = {}) {
  if (!validSession(session)) throw new Error('设备会话无效');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, session.device.device_id, guard);
    const sessions = upsertSession(stored.sessions, session);
    const activeDeviceId = session.device.device_id;
    await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
    await writeValue(KEY, session);
    // Only an explicit successful connection restores a locally removed device.
    const recoveries = await readValue(RECOVERY_KEY) || {};
    if (recoveries[activeDeviceId]) {
      delete recoveries[activeDeviceId];
      await writeValue(RECOVERY_KEY, recoveries);
    }
    return { activeDeviceId, sessions };
  });
}

function checkMutation(stored, deviceId, { current, expectedAccountToken, expectedBindingId } = {}) {
  const existing = stored?.sessions.find(item => item.device.device_id === deviceId);
  if ((current && !current()) || (expectedAccountToken !== undefined && existing?.accountToken !== expectedAccountToken)
    || (expectedBindingId !== undefined && (existing?.device?.binding_id || '') !== expectedBindingId)) {
    throw Object.assign(new Error('设备绑定已变化，请重新打开设备管理。'), { code: 'DEVICE_BINDING_CHANGED' });
  }
}

export async function updateDeviceSession(session, guard = {}) {
  if (!validSession(session)) throw new Error('设备会话无效');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, session.device.device_id, guard);
    const recoveries = await readValue(RECOVERY_KEY) || {};
    if (recoveries[session.device.device_id] && !stored.sessions.some(item => item.device.device_id === session.device.device_id)) throw Object.assign(new Error('这台设备已从此手机移除，请通过添加设备重新连接。'), {code:'DEVICE_LOCALLY_REMOVED'});
    checkMutation(stored, session.device.device_id, guard);
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

export async function selectDeviceSession(deviceId, guard = {}) {
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, deviceId, guard);
    const session = stored.sessions.find(item => item.device.device_id === deviceId);
    if (!session) throw new Error('没有找到这台照片墙');
    await Promise.all([
      writeValue(DEVICES_KEY, { activeDeviceId: deviceId, sessions: stored.sessions }),
      writeValue(KEY, session),
    ]);
    return session;
  });
}

export async function removeDeviceSession(deviceId, guard = {}) {
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, deviceId, guard);
    const sessions = stored.sessions.filter(item => item.device.device_id !== deviceId);
    const activeDeviceId = stored.activeDeviceId === deviceId
      ? sessions[0]?.device?.device_id || null
      : stored.activeDeviceId;
    const activeSession = sessions.find(item => item.device.device_id === activeDeviceId) || null;
    await writeValue(DEVICES_KEY, { activeDeviceId, sessions });
    if (activeSession) await writeValue(KEY, activeSession);
    else await deleteValue(KEY);
    const pending = await readValue(PENDING_SETUP_KEY);
    if (pending?.session?.device?.device_id === deviceId
      && (guard.expectedAccountToken === undefined || pending.session.accountToken === guard.expectedAccountToken)) {
      await deleteValue(PENDING_SETUP_KEY);
    }
    if (!sessions.length) await deleteValue(PHOTO_SYNC_KEY);
    return guard.returnSnapshot ? {activeDeviceId, sessions} : activeSession;
  });
}

export async function loadDeviceRecovery(deviceId) {
  const recoveries = await readValue(RECOVERY_KEY) || {};
  return recoveries[deviceId] || null;
}

export async function loadLocallyRemovedDeviceIds() {
  const [recoveries,stored] = await Promise.all([readValue(RECOVERY_KEY),readDeviceSessions()]);
  return Object.keys(recoveries || {}).filter(deviceId => !stored.sessions.some(item => item.device.device_id === deviceId));
}

export async function forgetDeviceSession(target, guard = {}) {
  const deviceId = target?.device?.device_id;
  if (!deviceId || !target.accountToken) throw new Error('无法安全保存设备恢复信息，请稍后重试。');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, deviceId, {...guard, expectedAccountToken:target.accountToken,expectedBindingId:target.device.binding_id || ''});
    const recoveries = await readValue(RECOVERY_KEY) || {};
    const actual = stored.sessions.find(item => item.device.device_id === deviceId);
    checkMutation(stored, deviceId, {...guard, expectedAccountToken:target.accountToken,expectedBindingId:target.device.binding_id || ''});
    recoveries[deviceId] = {session:{...actual,...(target.recoveryPreferenceProfile ? {recoveryPreferenceProfile:target.recoveryPreferenceProfile} : {})}, removedAt:new Date().toISOString(), reason:'local-only-removal'};
    // Save recovery credentials before removing the visible binding. Never dispatch DELETE here.
    await writeValue(RECOVERY_KEY, recoveries);
    checkMutation(stored, deviceId, {...guard, expectedAccountToken:target.accountToken,expectedBindingId:target.device.binding_id || ''});
    const sessions = stored.sessions.filter(item => item.device.device_id !== deviceId);
    const activeDeviceId = stored.activeDeviceId === deviceId ? sessions[0]?.device?.device_id || null : stored.activeDeviceId;
    const active = sessions.find(item => item.device.device_id === activeDeviceId);
    await writeValue(DEVICES_KEY, {activeDeviceId,sessions});
    if (active) await writeValue(KEY,active); else await deleteValue(KEY);
    const pending = await readValue(PENDING_SETUP_KEY);
    if (pending?.session?.device?.device_id === deviceId) await deleteValue(PENDING_SETUP_KEY);
    return {activeDeviceId,sessions};
  });
}

export async function prepareDeviceRemoval(target, guard = {}) {
  const deviceId = target?.device?.device_id, bindingId = target?.device?.binding_id;
  if (!deviceId) throw new Error('设备信息不完整。');
  return serializeDeviceMutation(async () => {
    const stored = await readDeviceSessions();
    checkMutation(stored, deviceId, {...guard,expectedAccountToken:target.accountToken});
    const attempts = await readValue(REMOVALS_KEY) || {};
    checkMutation(stored, deviceId, {...guard,expectedAccountToken:target.accountToken});
    let attempt = attempts[deviceId];
    if (!bindingId && (!attempt || attempt.accountToken !== target.accountToken)) {
      throw Object.assign(new Error('服务暂未提供安全解绑信息。可以仅从此手机移除，再重新连接。'), {code:'DEVICE_BINDING_REQUIRED'});
    }
    const localBinding = stored.sessions.find(item => item.device.device_id === deviceId)?.device?.binding_id;
    if (localBinding && (bindingId || attempt?.bindingId) !== localBinding) throw Object.assign(new Error('设备绑定已变化，请重新检查后操作。'), {code:'DEVICE_BINDING_CHANGED'});
    if (!attempt || (bindingId && attempt.bindingId !== bindingId) || attempt.accountToken !== target.accountToken) {
      // Correlation ID, not an authentication secret; authorization remains the account token + binding.
      const requestId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
        const random = Math.floor(Math.random() * 16); return (char === 'x' ? random : (random & 3) | 8).toString(16);
      });
      attempt = {deviceId,bindingId,requestId,accountToken:target.accountToken};
      attempts[deviceId] = attempt;
      await writeValue(REMOVALS_KEY,attempts);
    }
    return {deviceId:attempt.deviceId,bindingId:attempt.bindingId,requestId:attempt.requestId};
  });
}

function sameRecoveryBinding(record, target) {
  return record?.deviceId === target?.device?.device_id && record.accountToken === target.accountToken
    && (!target.device.binding_id || record.bindingId === target.device.binding_id);
}

export async function loadDeviceReprovision(target) {
  const records = await readValue(REPROVISION_KEY) || {};
  const record = records[target?.device?.device_id];
  return sameRecoveryBinding(record, target) ? record : null;
}

export async function prepareDeviceReprovision(target, guard = {}) {
  return serializeDeviceMutation(async () => {
    const deviceId = target?.device?.device_id;
    const stored = await readDeviceSessions();
    const recoveries = await readValue(RECOVERY_KEY) || {};
    const source = stored.sessions.find(item => item.device.device_id === deviceId) || recoveries[deviceId]?.session;
    const valid = () => (!guard.current || guard.current()) && source?.accountToken === target?.accountToken
      && (!source?.device?.binding_id || source.device.binding_id === target?.device?.binding_id);
    if (!deviceId || !valid()) throw Object.assign(new Error('设备绑定已变化，请重新打开连接流程。'), {code:'DEVICE_BINDING_CHANGED'});
    const records = await readValue(REPROVISION_KEY) || {};
    if (!valid()) throw Object.assign(new Error('设备绑定已变化，请重新打开连接流程。'), {code:'DEVICE_BINDING_CHANGED'});
    if (!guard.newOperation && sameRecoveryBinding(records[deviceId], target)) return records[deviceId];
    const bindingId = target.device.binding_id, expectedGeneration = target.device.recovery_generation;
    if (!bindingId || typeof expectedGeneration !== 'string' || !expectedGeneration) {
      throw Object.assign(new Error('服务暂未提供安全重新配网能力，请稍后重试。'), {code:'REPROVISION_PROTOCOL_REQUIRED'});
    }
    const operationId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
      const random = Math.floor(Math.random() * 16); return (char === 'x' ? random : (random & 3) | 8).toString(16);
    });
    const operation = {deviceId,accountToken:target.accountToken,bindingId,expectedGeneration,operationId};
    records[deviceId] = operation;
    // Persist the exact intent before either HTTP phase. Timeouts/closing never rebase it.
    await writeValue(REPROVISION_KEY, records);
    if (!valid()) throw Object.assign(new Error('连接操作已取消，已保留本次恢复记录。'), {code:'DEVICE_BINDING_CHANGED'});
    return operation;
  });
}

export async function clearDeviceReprovision(operation, guard = {}) {
  if (!operation?.deviceId) return;
  return serializeDeviceMutation(async () => {
    const records = await readValue(REPROVISION_KEY) || {};
    const record = records[operation.deviceId];
    if (guard.current && !guard.current()) throw Object.assign(new Error('设备连接操作已变化。'), {code:'DEVICE_BINDING_CHANGED'});
    if (!record || record.operationId !== operation.operationId || record.bindingId !== operation.bindingId
      || record.accountToken !== operation.accountToken) return;
    delete records[operation.deviceId];
    await writeValue(REPROVISION_KEY, records);
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
