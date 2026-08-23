import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths, UploadType } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';

export const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://api.mokeedesign.cn';
export const DEFAULT_PROVISION_URL = 'http://192.168.4.1';
const PHOTO_UPLOAD_BATCH_SIZE = 1;
const PWE6_FRAME_BYTES = 960045;

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

function uploadForm({ url, form, headers = {}, onProgress, timeoutMs = 0 }) {
  if (Platform.OS === 'web' || typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { method: 'POST', headers, body: form }).then(responseJson);
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.timeout = timeoutMs;
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
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 6000);
  try {
    const response = await expoFetch(`${baseUrl(provisionUrl)}/status`, {
      signal: abortController.signal,
    });
    return responseJson(response);
  } catch (error) {
    if (abortController.signal.aborted || error.name === 'AbortError' ||
        String(error.message).includes('FetchRequestCanceledException')) {
      throw new Error('连接设备超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForLocalDisplay({ provisionUrl, onProgress, timeoutMs = 150000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const status = await readProvisionStatus(provisionUrl);
      lastConnectionError = null;
      const state = String(status.frame_state || 'idle');
      onProgress?.({ stage: state, progress: state === 'displayed' ? 100 : 99 });
      if (state === 'displayed') return status;
      if (state === 'error') throw new Error(status.frame_error || '墨水屏刷新失败');
    } catch (error) {
      if (String(error.message).includes('墨水屏刷新失败')) throw error;
      lastConnectionError = error;
    }
  }
  throw new Error(lastConnectionError
    ? `等待墨水屏刷新超时：${lastConnectionError.message}`
    : '等待墨水屏刷新超时');
}

export async function sendLocalControl({ provisionUrl = DEFAULT_PROVISION_URL, action = 'display_test_pattern' }) {
  const response = await fetch(`${baseUrl(provisionUrl)}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  await responseJson(response);
  return waitForLocalDisplay({ provisionUrl });
}

export async function publishLocalDisplayPhoto({
  apiBase = DEFAULT_API_BASE,
  provisionUrl = DEFAULT_PROVISION_URL,
  asset,
  onProgress,
}) {
  const photoForm = new FormData();
  if (Platform.OS === 'web') {
    const blob = await (await fetch(asset.uri)).blob();
    photoForm.append('file', blob, asset.fileName || 'photo.jpg');
  } else {
    photoForm.append('file', {
      uri: asset.uri,
      name: asset.fileName || `photo-${Date.now()}.jpg`,
      type: asset.mimeType || 'image/jpeg',
    });
  }

  onProgress?.({ stage: 'preparing', progress: 0 });
  const prepared = await expoFetch(`${baseUrl(apiBase)}/api/eink/prepare?fit=contain&enhancement=standard`, {
    method: 'POST',
    body: photoForm,
  });
  if (!prepared.ok) return responseJson(prepared);

  onProgress?.({ stage: 'uploading', progress: 0 });
  const uploadUrl = `${baseUrl(provisionUrl)}/v1/frame`;
  if (Platform.OS === 'web') {
    const frame = await prepared.blob();
    if (frame.size !== PWE6_FRAME_BYTES) {
      throw new Error(`画面数据长度异常（${frame.size} 字节）`);
    }
    const frameForm = new FormData();
    frameForm.append('frame', frame, 'display.pwe6');
    await uploadForm({
      url: uploadUrl,
      form: frameForm,
      timeoutMs: 120000,
      onProgress: fraction => onProgress?.({
        stage: fraction >= 1 ? 'refreshing' : 'uploading',
        progress: Math.round(fraction * 100),
      }),
    });
    return waitForLocalDisplay({ provisionUrl, onProgress });
  }

  const frameBytes = await prepared.bytes();
  if (frameBytes.byteLength !== PWE6_FRAME_BYTES) {
    throw new Error(`画面数据长度异常（${frameBytes.byteLength} 字节）`);
  }
  const frameFile = new File(Paths.cache, `photowall-${Date.now()}.pwe6`);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 120000);
  try {
    frameFile.create({ overwrite: true, intermediates: true });
    frameFile.write(frameBytes);
    const result = await frameFile.upload(uploadUrl, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'frame',
      mimeType: 'application/vnd.photowall.pwe6',
      sessionType: 'foreground',
      signal: abortController.signal,
      onProgress: ({ bytesSent, totalBytes }) => {
        const progress = totalBytes > 0 ? Math.min(100, Math.round((bytesSent / totalBytes) * 100)) : 0;
        onProgress?.({ stage: progress >= 100 ? 'refreshing' : 'uploading', progress });
      },
    });
    let data = {};
    try { data = result.body ? JSON.parse(result.body) : {}; }
    catch { data = { error: result.body || `HTTP ${result.status}` }; }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(data.error || `请求失败（HTTP ${result.status}）`);
    }
    return waitForLocalDisplay({ provisionUrl, onProgress });
  } finally {
    clearTimeout(timeout);
    if (frameFile.exists) frameFile.delete();
  }
}

export async function provisionDisplay({ provisionUrl = DEFAULT_PROVISION_URL, ssid, password, apiBase }) {
  const response = await fetch(`${baseUrl(provisionUrl)}/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssid: ssid.trim(), password, api_base: baseUrl(apiBase) }),
  });
  return responseJson(response);
}

export async function autoClaimDisplay({ apiBase, deviceId, setupToken, name = '客厅照片墙' }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/devices/auto-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, setup_token: setupToken, name }),
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

async function uploadAssets({ apiBase, accountToken, assets, onProgress }) {
  const form = new FormData();
  for (const asset of assets) {
    const info = await MediaLibrary.getAssetInfoAsync(asset);
    form.append('files', {
      uri: info.localUri || info.uri || asset.uri,
      name: asset.filename || `photo-${asset.id}.jpg`,
      type: asset.mediaType === MediaLibrary.MediaType.photo ? 'image/jpeg' : 'application/octet-stream',
    });
  }
  return uploadForm({
    url: `${baseUrl(apiBase)}/api/upload`,
    form,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
    onProgress,
  });
}

export async function syncPhotoAlbum({ apiBase = DEFAULT_API_BASE, accountToken, album, onProgress }) {
  if (Platform.OS === 'web') {
    throw new Error('网页预览无法读取系统相册，请在已安装的手机 App 中同步照片');
  }
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能同步相册');
  }
  const knownResponse = await fetch(`${baseUrl(apiBase)}/api/known_photos`, {
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
  const known = new Set((await responseJson(knownResponse)).names || []);
  const assets = [];
  let after;
  onProgress?.({ stage: 'scanning', progress: 0, scanned: 0, uploaded: 0 });
  do {
    const page = await MediaLibrary.getAssetsAsync({
      first: 100,
      after,
      album,
      mediaType: [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    assets.push(...page.assets.filter(asset => !known.has(asset.filename)));
    onProgress?.({ stage: 'scanning', progress: 0, scanned: assets.length, uploaded: 0 });
    after = page.endCursor;
    if (!page.hasNextPage) break;
  } while (after);

  if (!assets.length) {
    return { scanned: 0, synced: 0, unchanged: true };
  }
  let synced = 0;
  for (let index = 0; index < assets.length; index += PHOTO_UPLOAD_BATCH_SIZE) {
    const batch = assets.slice(index, index + PHOTO_UPLOAD_BATCH_SIZE);
    const result = await uploadAssets({
      apiBase,
      accountToken,
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
  return { scanned: assets.length, synced, unchanged: false };
}

export async function readRecognizedContent({ apiBase = DEFAULT_API_BASE, accountToken }) {
  const headers = accountToken ? { 'X-Account-Token': accountToken } : {};
  const [peopleResponse, albumsResponse] = await Promise.all([
    fetch(`${baseUrl(apiBase)}/api/people`, { headers }),
    fetch(`${baseUrl(apiBase)}/api/smart_albums`, { headers }),
  ]);
  const [people, albums] = await Promise.all([
    responseJson(peopleResponse),
    responseJson(albumsResponse),
  ]);
  return {
    total: Number(albums.total) || 0,
    goodTotal: Number(albums.good_total) || 0,
    peopleAvailable: Boolean(people.available),
    people: people.people || [],
    albums: albums.albums || [],
  };
}

export async function refreshRecognizedContent({ apiBase = DEFAULT_API_BASE, accountToken }) {
  const headers = accountToken ? { 'X-Account-Token': accountToken } : {};
  let cluster = null;
  try {
    const response = await fetch(`${baseUrl(apiBase)}/api/cluster_people`, {
      method: 'POST',
      headers,
    });
    cluster = await responseJson(response);
  } catch (error) {
    // Topic/album recognition is already produced during upload. Face
    // clustering is optional and may be unavailable on a lightweight server,
    // so keep the rest of the real recognition result usable.
    cluster = { available: false, error: error.message };
  }
  return { ...(await readRecognizedContent({ apiBase, accountToken })), cluster };
}

export async function generateWall({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  template = 'daily_polaroid',
  title = '我的一天',
  filters = [],
  excludeFilters = [],
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accountToken ? { 'X-Account-Token': accountToken } : {}) },
    body: JSON.stringify({ template, title, filters, exclude_filters: excludeFilters }),
  });
  return responseJson(response);
}

export async function publishGeneratedWall({ apiBase, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/publish-last-wall`,
    { method: 'POST', headers: { 'X-Account-Token': accountToken } },
  );
  return responseJson(response);
}

export async function syncJuly2026Photos({ apiBase = DEFAULT_API_BASE, accountToken, onProgress }) {
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
  // React Native assembles multipart bodies in memory. Uploading a group of
  // full-resolution iPhone photos can exceed iOS' foreground memory limit, so
  // keep each request bounded while leaving cloud selection/deduplication intact.
  for (let index = 0; index < assets.length; index += PHOTO_UPLOAD_BATCH_SIZE) {
    const batch = assets.slice(index, index + PHOTO_UPLOAD_BATCH_SIZE);
    const result = await uploadAssets({
      apiBase,
      accountToken,
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

export async function reprovisionDisplay({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/reprovision`,
    { method: 'POST', headers: { 'X-Account-Token': accountToken } },
  );
  return responseJson(response);
}

export async function removeDisplay({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE', headers: { 'X-Account-Token': accountToken } },
  );
  return responseJson(response);
}

export async function readDisplayStatus({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const result = await listDisplays({ apiBase, accountToken });
  const device = (result.devices || []).find(item => item.device_id === deviceId);
  if (!device) throw new Error('线上服务中没有找到已绑定的墨水屏');
  return device;
}
