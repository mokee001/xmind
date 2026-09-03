import { fromByteArray, toByteArray } from 'base64-js';
import { PermissionsAndroid, Platform } from 'react-native';

const SERVICE_UUID = '7d2e0001-6f7a-4f2b-9d3a-54d7f1b0a001';
const INFO_UUID = '7d2e0002-6f7a-4f2b-9d3a-54d7f1b0a001';
const COMMAND_UUID = '7d2e0003-6f7a-4f2b-9d3a-54d7f1b0a001';
const EVENT_UUID = '7d2e0004-6f7a-4f2b-9d3a-54d7f1b0a001';
const FRAME_VERSION = 1;
const COMMAND_CHUNK_BYTES = 140;
const BLUETOOTH_READY_TIMEOUT_MS = 10000;
const WIFI_SCAN_TIMEOUT_MS = 20000;
const PHYSICAL_CONFIRM_TIMEOUT_MS = 30000;
const PHYSICAL_CONFIRM_RETRY_MS = 750;
const PAIRING_TIMEOUT_MS = 30000;
const PAIRING_RETRY_MS = 750;

let manager;
let connectedDevice;
let connectedInfo;
let eventSubscription;
let disconnectSubscription;
let commandMessageId = 0;
let eventFrame;
let wifiScanWaiter;
let authorizationWaiter;
let provisionCompleted = false;
let connectionReleasePromise;
const discoveredDevices = new Map();
const statusListeners = new Set();

function logBle(event, details = {}) {
  console.info('[PhotoWall BLE]', JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
  }));
}

function getManager() {
  if (Platform.OS === 'web') throw new Error('网页预览不支持蓝牙配网');
  if (!manager) {
    const { BleManager } = require('react-native-ble-plx');
    manager = new BleManager();
  }
  return manager;
}

function encodeUtf8(value) {
  const bytes = [];
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes) {
  let value = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let codePoint = first;
    if ((first & 0xe0) === 0xc0 && index < bytes.length) {
      codePoint = ((first & 0x1f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
      codePoint = ((first & 0x0f) << 12) |
        ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
      codePoint = ((first & 0x07) << 18) |
        ((bytes[index++] & 0x3f) << 12) |
        ((bytes[index++] & 0x3f) << 6) |
        (bytes[index++] & 0x3f);
    }
    value += String.fromCodePoint(codePoint);
  }
  return value;
}

function emitStatus(event) {
  const status = {
    status: String(event.status || 'error'),
    message: String(event.message || ''),
    deviceId: String(event.deviceId || connectedInfo?.deviceId || ''),
    localUrl: String(event.localUrl || ''),
    errorCode: String(event.errorCode || ''),
  };
  for (const listener of statusListeners) {
    try { listener(status); } catch {}
  }
}

function rejectWifiScan(error) {
  if (!wifiScanWaiter) return;
  const waiter = wifiScanWaiter;
  wifiScanWaiter = undefined;
  clearTimeout(waiter.timeout);
  waiter.reject(error);
}

function resolveWifiScan(networks) {
  if (!wifiScanWaiter) return;
  const waiter = wifiScanWaiter;
  wifiScanWaiter = undefined;
  clearTimeout(waiter.timeout);
  waiter.resolve(networks);
}

async function releaseProvisioningConnection(reason) {
  if (connectionReleasePromise) return connectionReleasePromise;
  const device = connectedDevice;
  if (!device) return;

  connectedDevice = undefined;
  connectedInfo = undefined;
  eventSubscription?.remove();
  eventSubscription = undefined;
  disconnectSubscription?.remove();
  disconnectSubscription = undefined;
  rejectWifiScan(new Error('配网已取消'));
  if (authorizationWaiter) {
    authorizationWaiter.reject?.(new Error('配网已取消'));
    authorizationWaiter = undefined;
  }

  logBle('connection_released', { reason: String(reason || 'cancelled') });
  connectionReleasePromise = (async () => {
    try { await device.cancelConnection(); } catch {}
  })();
  try {
    await connectionReleasePromise;
  } finally {
    connectionReleasePromise = undefined;
  }
}

function processEvent(event) {
  if (event?.type === 'authorization') {
    logBle('authorization_event', {
      status: String(event.status || ''),
      setupTokenPresent: Boolean(event.setupToken),
    });
    if (!authorizationWaiter || event.status !== 'authorized' || !event.setupToken) return;
    authorizationWaiter.resolve(String(event.setupToken));
    authorizationWaiter = undefined;
    return;
  }
  if (event?.type === 'wifi_networks') {
    logBle('wifi_networks_received', {
      networkCount: Array.isArray(event.networks) ? event.networks.length : 0,
    });
    const networks = Array.isArray(event.networks)
      ? event.networks.map(network => ({
        ssid: String(network.ssid || ''),
        signalStrength: Number(network.signalStrength) || -127,
        secure: Boolean(network.secure),
      })).filter(network => network.ssid).sort((left, right) => right.signalStrength - left.signalStrength)
      : [];
    resolveWifiScan(networks);
    return;
  }
  if (event?.type !== 'status') return;
  logBle('status_received', {
    status: String(event.status || ''),
    message: String(event.message || ''),
    errorCode: String(event.errorCode || ''),
  });
  if (event.status === 'connected') provisionCompleted = true;
  if (wifiScanWaiter && ['scan_failed', 'busy', 'invalid_setup_token'].includes(event.errorCode)) {
    rejectWifiScan(new Error(event.message || 'Wi-Fi 扫描失败'));
  }
  emitStatus(event);
}

function consumeEventFrame(value) {
  const bytes = toByteArray(value || '');
  if (bytes.length < 5 || bytes[0] !== FRAME_VERSION) return;
  const messageId = bytes[1];
  const sequence = bytes[2];
  const totalChunks = bytes[3];
  if (!totalChunks || sequence >= totalChunks) {
    eventFrame = undefined;
    return;
  }
  if (sequence === 0) eventFrame = { messageId, nextSequence: 0, totalChunks, chunks: [] };
  if (!eventFrame || eventFrame.messageId !== messageId ||
      eventFrame.totalChunks !== totalChunks || eventFrame.nextSequence !== sequence) {
    eventFrame = undefined;
    return;
  }
  eventFrame.chunks.push(bytes.slice(4));
  eventFrame.nextSequence += 1;
  if (eventFrame.nextSequence !== totalChunks) return;

  const length = eventFrame.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of eventFrame.chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  eventFrame = undefined;
  try { processEvent(JSON.parse(decodeUtf8(payload))); } catch {}
}

function friendlyBleError(error) {
  const message = String(error?.reason || error?.message || error || '蓝牙操作失败');
  if (/unauthorized|permission|not authorized/i.test(message)) return new Error('请在系统设置中允许 PhotoWall 使用蓝牙');
  if (/powered.?off|bluetooth.*off/i.test(message)) return new Error('请打开手机蓝牙后重试');
  if (/encrypt(ion)?.*insufficient|insufficient.*encrypt(ion)?/i.test(message)) return new Error('蓝牙安全配对未完成，请在系统提示中点击“配对”后重试');
  if (/cancel/i.test(message)) return new Error('蓝牙操作已取消');
  if (/timeout/i.test(message)) return new Error('连接设备超时，请靠近设备后重试');
  return new Error(message);
}

function isPairingInProgressError(error) {
  const message = String(error?.reason || error?.message || error || '');
  return /encrypt(ion)?.*insufficient|insufficient.*encrypt(ion)?/i.test(message);
}

async function readEncryptedDeviceInfo(device) {
  const deadline = Date.now() + PAIRING_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await device.readCharacteristicForService(SERVICE_UUID, INFO_UUID);
    } catch (error) {
      if (!isPairingInProgressError(error)) throw error;
      lastError = error;
      emitStatus({
        status: 'pairing',
        message: '请在系统提示中点击“配对”',
        deviceId: connectedInfo?.deviceId,
      });
      await new Promise(resolve => setTimeout(resolve, PAIRING_RETRY_MS));
    }
  }
  throw lastError || new Error('蓝牙安全配对超时');
}

function normalizeApiBase(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+(?::\d+)?$/i.test(normalized) ? normalized : '';
}

async function requestAndroidPermissions() {
  if (Platform.OS !== 'android') return;
  const permissions = Platform.Version >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(permissions);
  if (permissions.some(permission => result[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error('请允许附近设备权限后重试');
  }
}

async function waitForBluetooth() {
  await requestAndroidPermissions();
  const bleManager = getManager();
  if (await bleManager.state() === 'PoweredOn') return;
  await new Promise((resolve, reject) => {
    let subscription;
    const timeout = setTimeout(() => {
      subscription?.remove();
      reject(new Error('等待蓝牙开启超时'));
    }, BLUETOOTH_READY_TIMEOUT_MS);
    subscription = bleManager.onStateChange(state => {
      if (state === 'PoweredOn') {
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      } else if (state === 'Unauthorized' || state === 'Unsupported') {
        clearTimeout(timeout);
        subscription.remove();
        reject(new Error(state === 'Unauthorized'
          ? '请在系统设置中允许 PhotoWall 使用蓝牙'
          : '当前手机不支持蓝牙低功耗'));
      }
    }, true);
  });
}

function requireConnection() {
  if (!connectedDevice || !connectedInfo?.setupToken) throw new Error('请先连接 PhotoWall 设备');
  return connectedDevice;
}

async function writeCommand(command) {
  if (!connectedDevice) throw new Error('请先连接 PhotoWall 设备');
  const payload = encodeUtf8(JSON.stringify(command));
  const totalChunks = Math.ceil(payload.length / COMMAND_CHUNK_BYTES);
  if (!totalChunks || totalChunks > 255) throw new Error('蓝牙命令过长');
  commandMessageId = (commandMessageId + 1) & 0xff;
  for (let sequence = 0; sequence < totalChunks; sequence += 1) {
    const offset = sequence * COMMAND_CHUNK_BYTES;
    const chunk = payload.slice(offset, offset + COMMAND_CHUNK_BYTES);
    const frame = new Uint8Array(chunk.length + 4);
    frame.set([FRAME_VERSION, commandMessageId, sequence, totalChunks]);
    frame.set(chunk, 4);
    await connectedDevice.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      COMMAND_UUID,
      fromByteArray(frame),
    );
  }
}

async function sendCommand(command) {
  requireConnection();
  await writeCommand({ ...command, setupToken: connectedInfo.setupToken });
}

async function awaitPhysicalConfirmation() {
  logBle('physical_confirmation_waiting');
  emitStatus({
    status: 'awaiting_confirmation',
    message: '请按住设备 BOOT 键确认配网',
    deviceId: connectedInfo?.deviceId,
  });
  const tokenPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      authorizationWaiter?.reject(new Error('设备确认超时，请按住 BOOT 键后重试'));
    }, PHYSICAL_CONFIRM_TIMEOUT_MS);
    authorizationWaiter = {
      resolve: setupToken => {
        clearTimeout(timeout);
        authorizationWaiter = undefined;
        resolve(setupToken);
      },
      reject: error => {
        clearTimeout(timeout);
        authorizationWaiter = undefined;
        reject(error);
      },
    };
  });
  const retryPromise = (async () => {
    const startedAt = Date.now();
    try {
      while (authorizationWaiter && Date.now() - startedAt < PHYSICAL_CONFIRM_TIMEOUT_MS) {
        await writeCommand({ op: 'authorize' });
        await new Promise(resolve => setTimeout(resolve, PHYSICAL_CONFIRM_RETRY_MS));
      }
    } catch (error) {
      authorizationWaiter?.reject(friendlyBleError(error));
    }
  })();
  try {
    return await tokenPromise;
  } finally {
    await retryPromise;
  }
}

export async function startDeviceDiscovery(onDevice) {
  try {
    logBle('discovery_started');
    await waitForBluetooth();
    await stopDeviceDiscovery();
    await releaseProvisioningConnection('discovery_restarted');
    discoveredDevices.clear();
    let knownDevices = [];
    try {
      knownDevices = await getManager().connectedDevices([SERVICE_UUID]);
    } catch (error) {
      logBle('known_devices_unavailable', { message: friendlyBleError(error).message });
    }
    for (const device of knownDevices) {
      discoveredDevices.set(device.id, device);
      onDevice?.({
        deviceId: device.id,
        deviceName: device.name || device.localName || 'PhotoWall',
        firmwareVersion: null,
        setupToken: null,
        signalStrength: Number(device.rssi) || -60,
      });
    }
    await getManager().startDeviceScan([SERVICE_UUID], { allowDuplicates: true }, (error, device) => {
      if (error) {
        emitStatus({ status: 'error', message: friendlyBleError(error).message, errorCode: 'ble_scan_failed' });
        return;
      }
      if (!device) return;
      const firstDiscovery = !discoveredDevices.has(device.id);
      discoveredDevices.set(device.id, device);
      if (firstDiscovery) {
        logBle('device_discovered', {
          transportId: String(device.id || ''),
          deviceName: String(device.name || device.localName || 'PhotoWall'),
          signalStrength: Number(device.rssi) || -127,
        });
      }
      onDevice?.({
        deviceId: device.id,
        deviceName: device.name || device.localName || 'PhotoWall',
        firmwareVersion: null,
        setupToken: null,
        signalStrength: Number(device.rssi) || -127,
      });
    });
    return stopDeviceDiscovery;
  } catch (error) {
    throw friendlyBleError(error);
  }
}

export async function stopDeviceDiscovery() {
  if (!manager) return;
  try { await manager.stopDeviceScan(); } catch {}
  logBle('discovery_stopped');
}

export async function connectProvisioningDevice(deviceId) {
  try {
    logBle('connection_started', { transportId: String(deviceId || '') });
    await waitForBluetooth();
    await stopDeviceDiscovery();
    eventSubscription?.remove();
    disconnectSubscription?.remove();
    provisionCompleted = false;
    connectedInfo = undefined;

    const transportId = discoveredDevices.get(deviceId)?.id || deviceId;
    connectedDevice = await getManager().connectToDevice(transportId, { timeout: 15000, requestMTU: 185 });
    connectedDevice = await connectedDevice.discoverAllServicesAndCharacteristics();
    const infoCharacteristic = await readEncryptedDeviceInfo(connectedDevice);
    const info = JSON.parse(decodeUtf8(toByteArray(infoCharacteristic.value || '')));
    if (!info.deviceId) throw new Error('设备身份信息不完整');
    logBle('encrypted_link_verified', {
      deviceId: String(info.deviceId),
      firmwareVersion: String(info.firmwareVersion || ''),
    });

    connectedInfo = {
      deviceId: String(info.deviceId),
      deviceName: String(info.deviceName || connectedDevice.name || 'PhotoWall'),
      firmwareVersion: String(info.firmwareVersion || ''),
      setupToken: info.setupToken ? String(info.setupToken) : '',
      signalStrength: Number(connectedDevice.rssi ?? discoveredDevices.get(transportId)?.rssi) || -127,
    };
    eventSubscription = connectedDevice.monitorCharacteristicForService(
      SERVICE_UUID,
      EVENT_UUID,
      (error, characteristic) => {
        if (error) {
          if (!provisionCompleted) emitStatus({
            status: 'error',
            message: friendlyBleError(error).message,
            errorCode: 'notification_failed',
          });
          return;
        }
        if (characteristic?.value) consumeEventFrame(characteristic.value);
      },
    );
    disconnectSubscription = connectedDevice.onDisconnected(error => {
      logBle('disconnected', {
        expected: provisionCompleted,
        message: error ? friendlyBleError(error).message : '',
      });
      rejectWifiScan(new Error('设备蓝牙连接已断开'));
      if (authorizationWaiter) {
        authorizationWaiter.reject?.(new Error('设备蓝牙连接已断开'));
        authorizationWaiter = undefined;
      }
      connectedDevice = undefined;
      eventSubscription?.remove();
      eventSubscription = undefined;
      if (!provisionCompleted) emitStatus({
        status: 'error',
        message: error ? friendlyBleError(error).message : '设备蓝牙连接已断开',
        errorCode: 'disconnected',
      });
    });
    if (!connectedInfo.setupToken) connectedInfo.setupToken = await awaitPhysicalConfirmation();
    logBle('physical_confirmation_authorized', {
      deviceId: connectedInfo.deviceId,
      setupTokenPresent: Boolean(connectedInfo.setupToken),
    });
    emitStatus({ status: 'idle', message: '设备已连接', deviceId: connectedInfo.deviceId });
    return { ...connectedInfo };
  } catch (error) {
    connectedDevice = undefined;
    connectedInfo = undefined;
    throw friendlyBleError(error);
  }
}

export async function scanWifiNetworks() {
  requireConnection();
  if (wifiScanWaiter) {
    logBle('wifi_scan_reused');
    return wifiScanWaiter.promise;
  }
  logBle('wifi_scan_requested');
  let resolveScan;
  let rejectScan;
  const result = new Promise((resolve, reject) => {
    resolveScan = resolve;
    rejectScan = reject;
  });
  const waiter = { promise: result, resolve: resolveScan, reject: rejectScan, timeout: undefined };
  waiter.timeout = setTimeout(() => {
    if (wifiScanWaiter !== waiter) return;
    wifiScanWaiter = undefined;
    rejectScan(new Error('Wi-Fi 扫描超时，请重试'));
  }, WIFI_SCAN_TIMEOUT_MS);
  wifiScanWaiter = waiter;
  try {
    await sendCommand({ op: 'scan' });
  } catch (error) {
    rejectWifiScan(friendlyBleError(error));
  }
  return result;
}

export async function provisionWifi({ ssid, password, apiBase }) {
  const networkName = String(ssid || '').trim();
  const serviceBase = normalizeApiBase(apiBase);
  if (!networkName) throw new Error('请选择 Wi-Fi');
  if (networkName.length > 32 || String(password || '').length > 64) {
    throw new Error('Wi-Fi 名称或密码过长');
  }
  if (!serviceBase) throw new Error('PhotoWall 服务地址无效');
  logBle('wifi_credentials_submitted', {
    networkNameLength: networkName.length,
    passwordPresent: String(password || '').length > 0,
    serviceProtocol: serviceBase.startsWith('https://') ? 'https' : 'http',
  });
  await sendCommand({
    op: 'provision',
    ssid: networkName,
    password: String(password || ''),
    apiBase: serviceBase,
  });
}

export function subscribeProvisionStatus(callback) {
  if (typeof callback !== 'function') throw new TypeError('状态订阅必须提供回调函数');
  statusListeners.add(callback);
  return () => {
    statusListeners.delete(callback);
    if (!statusListeners.size && connectedDevice && !provisionCompleted) {
      releaseProvisioningConnection('setup_view_closed').catch(() => {});
    }
  };
}

export async function cancelProvisioning() {
  try {
    if (connectedDevice && connectedInfo) await sendCommand({ op: 'cancel' });
  } finally {
    await releaseProvisioningConnection('cancelled');
  }
}
