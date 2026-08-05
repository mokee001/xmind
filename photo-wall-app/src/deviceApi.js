import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

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

async function uploadAssets({ apiBase, assets }) {
  const form = new FormData();
  for (const asset of assets) {
    form.append('files', {
      uri: asset.uri,
      name: asset.filename || `photo-${asset.id}.jpg`,
      type: asset.mediaType === MediaLibrary.MediaType.photo ? 'image/jpeg' : 'application/octet-stream',
    });
  }
  const response = await fetch(`${baseUrl(apiBase)}/api/upload`, {
    method: 'POST',
    body: form,
  });
  return responseJson(response);
}

export async function syncJuly2026Photos({ apiBase }) {
  if (Platform.OS === 'web') {
    throw new Error('网页预览无法读取系统相册，请在已安装的手机 App 中一键发布');
  }

  const permission = await MediaLibrary.requestPermissionsAsync();
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能同步 2026 年 7 月的照片');
  }

  const start = new Date(2026, 6, 1);
  const end = new Date(2026, 7, 1);
  const assets = [];
  let after;
  do {
    const page = await MediaLibrary.getAssetsAsync({
      first: 100,
      after,
      mediaType: [MediaLibrary.MediaType.photo],
      createdAfter: start,
      createdBefore: end,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    assets.push(...page.assets);
    after = page.endCursor;
    if (!page.hasNextPage) break;
  } while (after);

  if (!assets.length) {
    throw new Error('没有找到已授权且拍摄于 2026 年 7 月的照片');
  }

  let synced = 0;
  for (let index = 0; index < assets.length; index += 20) {
    const result = await uploadAssets({ apiBase, assets: assets.slice(index, index + 20) });
    synced = Math.max(synced, Number(result.count) || 0);
  }
  return { scanned: assets.length, synced };
}

export async function publishJulyCalendar({ apiBase, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/calendar/july-2026/publish`,
    { method: 'POST', headers: { 'X-Account-Token': accountToken } },
  );
  return responseJson(response);
}

export async function listDisplays({ apiBase, accountToken }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/devices`, {
    headers: { 'X-Account-Token': accountToken },
  });
  return responseJson(response);
}
