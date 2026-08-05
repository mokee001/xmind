import { Platform } from 'react-native';

export const DEFAULT_API_BASE = Platform.OS === 'web'
  ? 'https://api.mokeedesign.cn'
  : 'https://api.mokeedesign.cn';
export const DEFAULT_PROVISION_URL = 'http://192.168.4.1';

function baseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function responseJson(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

export async function readProvisionStatus(provisionUrl = DEFAULT_PROVISION_URL) {
  const response = await fetch(`${baseUrl(provisionUrl)}/status`);
  return responseJson(response);
}

export async function provisionDisplay({ provisionUrl = DEFAULT_PROVISION_URL, ssid, password, apiBase }) {
  const response = await fetch(`${baseUrl(provisionUrl)}/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssid: ssid.trim(), password, api_base: baseUrl(apiBase) }),
  });
  return responseJson(response);
}

export async function claimDisplay({ apiBase, pairingCode, name = '客厅照片墙' }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/devices/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode.replace(/\D/g, ''), name }),
  });
  return responseJson(response);
}

export async function publishDisplayPhoto({ apiBase, deviceId, accountToken, asset }) {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const blob = await (await fetch(asset.uri)).blob();
    form.append('file', blob, asset.fileName || 'photo.jpg');
  } else {
    form.append('file', {
      uri: asset.uri,
      name: asset.fileName || `photo-${Date.now()}.jpg`,
      type: asset.mimeType || 'image/jpeg',
    });
  }
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/publish?fit=contain&enhancement=standard`,
    { method: 'POST', headers: { 'X-Account-Token': accountToken }, body: form },
  );
  return responseJson(response);
}

export async function listDisplays({ apiBase, accountToken }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/devices`, {
    headers: { 'X-Account-Token': accountToken },
  });
  return responseJson(response);
}
