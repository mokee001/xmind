import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';

export const DEFAULT_API_BASE = 'https://api.mokeedesign.cn';
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

function uploadForm({ url, form, headers = {}, onProgress }) {
  if (Platform.OS === 'web' || typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { method: 'POST', headers, body: form }).then(responseJson);
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error('网络连接失败，请检查手机网络后重试'));
    request.ontimeout = () => reject(new Error('上传超时，请稍后重试'));
    request.onload = () => {
      let data = {};
      try { data = request.responseText ? JSON.parse(request.responseText) : {}; }
      catch { data = { error: request.responseText || `HTTP ${request.status}` }; }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(data.error || `请求失败（HTTP ${request.status}）`));
        return;
      }
      onProgress?.(1);
      resolve(data);
    };
    request.send(form);
  });
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

export async function publishDisplayPhoto({ apiBase = DEFAULT_API_BASE, deviceId, accountToken, asset, onProgress }) {
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
  return uploadForm({
    url: `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/publish?fit=contain&enhancement=standard`,
    form,
    headers: { 'X-Account-Token': accountToken },
    onProgress,
  });
}

async function uploadAssets({ apiBase, assets, onProgress }) {
  const form = new FormData();
  for (const asset of assets) {
    const info = await MediaLibrary.getAssetInfoAsync(asset);
    form.append('files', {
      uri: info.localUri || info.uri || asset.uri,
      name: asset.filename || `photo-${asset.id}.jpg`,
      type: asset.mediaType === MediaLibrary.MediaType.photo ? 'image/jpeg' : 'application/octet-stream',
    });
  }
  return uploadForm({ url: `${baseUrl(apiBase)}/api/upload`, form, onProgress });
}

export async function syncJuly2026Photos({ apiBase = DEFAULT_API_BASE, onProgress }) {
  if (Platform.OS === 'web') {
    throw new Error('网页预览无法读取系统相册，请在已安装的手机 App 中一键发布');
  }

  const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能同步 2026 年 7 月的照片');
  }

  const start = new Date(2026, 6, 1);
  const end = new Date(2026, 7, 1);
  const assets = [];
  let after;
  onProgress?.({ stage: 'scanning', progress: 0, scanned: 0 });
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
    onProgress?.({ stage: 'scanning', progress: 0, scanned: assets.length });
    after = page.endCursor;
    if (!page.hasNextPage) break;
  } while (after);

  if (!assets.length) {
    throw new Error('没有找到已授权且拍摄于 2026 年 7 月的照片');
  }

  let synced = 0;
  for (let index = 0; index < assets.length; index += 20) {
    const batch = assets.slice(index, index + 20);
    const result = await uploadAssets({
      apiBase,
      assets: batch,
      onProgress: fraction => onProgress?.({
        stage: 'uploading',
        progress: Math.round(((index + (batch.length * fraction)) / assets.length) * 100),
        scanned: assets.length,
        uploaded: Math.min(assets.length, Math.round(index + (batch.length * fraction))),
      }),
    });
    synced += Number(result.saved) || batch.length;
  }
  onProgress?.({ stage: 'uploaded', progress: 100, scanned: assets.length, uploaded: synced });
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

export async function readDisplayStatus({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const result = await listDisplays({ apiBase, accountToken });
  const device = (result.devices || []).find(item => item.device_id === deviceId);
  if (!device) throw new Error('线上服务中没有找到已绑定的墨水屏');
  return device;
}
