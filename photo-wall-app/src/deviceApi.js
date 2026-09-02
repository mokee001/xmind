import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths, UploadType } from 'expo-file-system';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library/legacy';
import { cutoutPet, isPetCutoutAvailable, removePetCutout } from '../modules/pet-cutout';

export const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://api.mokeedesign.cn';
export const DEFAULT_PROVISION_URL = 'http://192.168.4.1';
const PHOTO_UPLOAD_BATCH_SIZE = 1;
const PHOTO_SYNC_ASSET_LIMIT = 200;
const PHOTO_LOCATION_GROUP_LIMIT = 12;
const PHOTO_LOCATION_INFO_CONCURRENCY = 16;
const PWE6_FRAME_BYTES = 960045;
const PET_COLLAGE_ASSET_LIMIT = 5000;
const PET_COLLAGE_POLL_INTERVAL_MS = 1500;
const PET_COLLAGE_TIMEOUT_MS = 10 * 60 * 1000;
const PET_COLLAGE_ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;
const PET_COLLAGE_STATUS_REQUEST_TIMEOUT_MS = 30 * 1000;
const PET_COLLAGE_CUTOUT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DISPLAY_DELIVERY_POLL_INTERVAL_MS = 2500;
const DISPLAY_DELIVERY_TIMEOUT_MS = 10 * 60 * 1000;
const placeNameCache = new Map();

function coordinateGroup(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // 城市级聚合，既避免把同一城市拆成很多卡片，也不把精确坐标传到云端。
  return {
    key: `${latitude.toFixed(1)},${longitude.toFixed(1)}`,
    latitude,
    longitude,
  };
}

function reverseGeocodedCity(result) {
  return String(result?.city || result?.subregion || result?.region || result?.country || '').trim();
}

async function resolvePlaceName(coordinate) {
  if (!coordinate || Platform.OS !== 'ios') return '';
  if (!placeNameCache.has(coordinate.key)) {
    placeNameCache.set(coordinate.key, Location.reverseGeocodeAsync({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    }).then(results => reverseGeocodedCity(results?.[0])).catch(() => ''));
  }
  return placeNameCache.get(coordinate.key);
}

async function collectAssetPlaceMetadata(assets) {
  const located = [];
  for (let offset = 0; offset < assets.length; offset += PHOTO_LOCATION_INFO_CONCURRENCY) {
    const chunk = assets.slice(offset, offset + PHOTO_LOCATION_INFO_CONCURRENCY);
    const details = await Promise.all(chunk.map(async asset => {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: false });
        return { asset, coordinate: coordinateGroup(info?.location || asset?.location) };
      } catch {
        return { asset, coordinate: null };
      }
    }));
    located.push(...details.filter(item => item.coordinate));
  }

  const groups = new Map();
  for (const item of located) {
    const group = groups.get(item.coordinate.key) || { coordinate: item.coordinate, assets: [] };
    group.assets.push(item.asset);
    groups.set(item.coordinate.key, group);
  }
  const selectedGroups = [...groups.values()]
    .sort((left, right) => right.assets.length - left.assets.length)
    .slice(0, PHOTO_LOCATION_GROUP_LIMIT);
  const metadata = [];
  for (const group of selectedGroups) {
    const placeLabel = await resolvePlaceName(group.coordinate);
    if (!placeLabel) continue;
    for (const asset of group.assets) {
      metadata.push({
        filename: asset.filename,
        place_label: placeLabel,
        place_key: `place:${placeLabel}`,
      });
    }
  }
  return metadata;
}

function baseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function requestError(message, status, data = {}) {
  return Object.assign(new Error(message), { status, data });
}

async function responseJson(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw requestError(data.error || `请求失败（HTTP ${response.status}）`, response.status, data);
  }
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
        reject(requestError(data.error || `请求失败（HTTP ${request.status}）`, request.status, data));
        return;
      }
      onProgress?.(1);
      resolve(data);
    };
    request.send(form);
  });
}

function getJson({ url, headers = {}, timeoutMs = 12000 }) {
  if (Platform.OS === 'web' || typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { headers, cache: 'no-store' }).then(responseJson);
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.timeout = timeoutMs;
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.onerror = () => reject(new Error('无法连接 PhotoWall 云端，请检查 iPhone 网络后重试'));
    request.ontimeout = () => reject(new Error('连接 PhotoWall 云端超时，请检查 iPhone 网络后重试'));
    request.onload = () => {
      let data = {};
      try { data = request.responseText ? JSON.parse(request.responseText) : {}; }
      catch { data = { error: request.responseText || `HTTP ${request.status}` }; }
      if (request.status < 200 || request.status >= 300) {
        reject(requestError(data.error || `请求失败（HTTP ${request.status}）`, request.status, data));
        return;
      }
      resolve(data);
    };
    request.send();
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

async function uploadAssets({ apiBase, accountToken, assets, metadata = [], onProgress }) {
  const form = new FormData();
  if (metadata.length) form.append('metadata', JSON.stringify(metadata));
  for (const asset of assets) {
    // iCloud-only assets frequently expose only a ph:// URI until iOS downloads
    // the original. Ask Photos to materialize the file before multipart upload.
    const info = await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true });
    const uri = info.localUri || info.uri || asset.uri;
    if (!uri || String(uri).startsWith('ph://')) {
      throw new Error(`“${asset.filename || '照片'}”尚未从 iCloud 下载，请保持网络连接后重试`);
    }
    const filename = asset.filename || `photo-${asset.id}.jpg`;
    const extension = String(filename).split('.').pop()?.toLowerCase();
    const mimeType = {
      heic: 'image/heic', heif: 'image/heif', png: 'image/png',
      webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }[extension] || 'image/jpeg';
    form.append('files', {
      uri,
      name: filename,
      type: mimeType,
    });
  }
  return uploadForm({
    url: `${baseUrl(apiBase)}/api/upload`,
    form,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
    onProgress,
  });
}

async function uploadAssetMetadata({ apiBase, accountToken, metadata }) {
  if (!metadata.length) return { updated_metadata: 0 };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  return uploadForm({
    url: `${baseUrl(apiBase)}/api/upload`,
    form,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
}

async function fetchKnownPhotoNames({ apiBase, accountToken }) {
  const url = `${baseUrl(apiBase)}/api/known_photos?_=${Date.now()}`;
  const result = await getJson({
    url,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
  return new Set(result.names || []);
}

export async function syncPhotoAlbum({ apiBase = DEFAULT_API_BASE, accountToken, album, onProgress, shouldPause }) {
  if (Platform.OS === 'web') {
    throw new Error('网页预览无法读取系统相册，请在已安装的手机 App 中同步照片');
  }
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能同步相册');
  }
  const known = await fetchKnownPhotoNames({ apiBase, accountToken });
  const assets = [];
  const locationAssets = [];
  let matched = 0;
  let available = 0;
  let after;
  const sourceAlbumId = typeof album === 'string' ? album : album?.id;
  onProgress?.({ stage: 'scanning', progress: 0, scanned: 0, uploaded: 0 });
  do {
    if (shouldPause?.()) {
      return { available, scanned: matched, synced: 0, paused: true, unchanged: false, hasMore: true };
    }
    const request = {
      first: 100,
      after,
      mediaType: [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    };
    if (!album?.allPhotos && sourceAlbumId) request.album = sourceAlbumId;
    const page = await MediaLibrary.getAssetsAsync(request);
    available = Math.max(available, Number(page.totalCount) || 0);
    matched += page.assets.length;
    for (const asset of page.assets) {
      if (locationAssets.length < PHOTO_SYNC_ASSET_LIMIT) locationAssets.push(asset);
      if (assets.length >= PHOTO_SYNC_ASSET_LIMIT) break;
      if (!known.has(asset.filename)) assets.push(asset);
    }
    onProgress?.({ stage: 'scanning', progress: 0, scanned: matched, pending: assets.length, uploaded: 0 });
    after = page.endCursor;
    if (!page.hasNextPage || assets.length >= PHOTO_SYNC_ASSET_LIMIT) break;
  } while (after);

  if (!matched) {
    throw new Error(permission.accessPrivileges === 'limited'
      ? 'iPhone 当前没有允许 PhotoWall 读取的照片，请先在系统照片选择器中增加照片'
      : 'iPhone 相册中没有可读取的照片');
  }
  const placeMetadata = await collectAssetPlaceMetadata(locationAssets);
  const newNames = new Set(assets.map(asset => asset.filename));
  const existingPlaceMetadata = placeMetadata.filter(item => !newNames.has(item.filename));
  // 新版云端允许只补充照片元数据；旧版云端返回 422 时不阻断正常照片同步。
  if (existingPlaceMetadata.length) {
    await uploadAssetMetadata({ apiBase, accountToken, metadata: existingPlaceMetadata }).catch(caught => {
      if (caught?.status !== 422) throw caught;
    });
  }
  if (!assets.length) {
    return { available, scanned: matched, synced: 0, unchanged: true, hasMore: false };
  }
  let synced = 0;
  for (let index = 0; index < assets.length; index += PHOTO_UPLOAD_BATCH_SIZE) {
    if (shouldPause?.()) {
      return {
        available,
        scanned: matched,
        synced,
        paused: true,
        unchanged: false,
        hasMore: true,
      };
    }
    const batch = assets.slice(index, index + PHOTO_UPLOAD_BATCH_SIZE);
    const batchNames = new Set(batch.map(asset => asset.filename));
    const result = await uploadAssets({
      apiBase,
      accountToken,
      assets: batch,
      metadata: placeMetadata.filter(item => batchNames.has(item.filename)),
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
  return {
    available,
    scanned: matched,
    synced,
    paused: false,
    unchanged: false,
    hasMore: assets.length >= PHOTO_SYNC_ASSET_LIMIT,
  };
}

export async function readRecognizedContent({ apiBase = DEFAULT_API_BASE, accountToken }) {
  const headers = accountToken ? { 'X-Account-Token': accountToken } : {};
  const cacheKey = Date.now();
  const [people, albums, known, library] = await Promise.all([
    getJson({ url: `${baseUrl(apiBase)}/api/people?_=${cacheKey}`, headers }),
    getJson({ url: `${baseUrl(apiBase)}/api/smart_albums?_=${cacheKey}`, headers }),
    getJson({ url: `${baseUrl(apiBase)}/api/known_photos?_=${cacheKey}`, headers }),
    getJson({ url: `${baseUrl(apiBase)}/api/photos?_=${cacheKey}`, headers }),
  ]);
  const photos = Array.isArray(library.photos)
    ? library.photos.filter(photo => Number(photo?.quality) > 0 && !photo?.tags?.includes('junk'))
    : [];
  const enrichedAlbums = (albums.albums || []).map(album => {
    const filters = Array.isArray(album?.filter) ? album.filter.map(String) : [];
    const candidates = photos
      .filter(photo => {
        if (!filters.length) return true;
        const tags = new Set((photo?.tags || []).map(String));
        return filters.every(filter => tags.has(filter));
      })
      .sort((left, right) => (
        Number(right?.aesthetic || right?.quality) - Number(left?.aesthetic || left?.quality)
      ));
    const covers = [...new Set([
      album?.cover,
      ...candidates.map(photo => photo?.path),
    ].filter(Boolean))].slice(0, 10);
    return { ...album, covers };
  });
  return {
    total: Number(albums.total) || 0,
    processedTotal: Array.isArray(known.names) ? known.names.length : Number(albums.total) || 0,
    goodTotal: Number(albums.good_total) || 0,
    peopleAvailable: Boolean(people.available),
    people: people.people || [],
    albums: enrichedAlbums,
  };
}

export async function readSelectionModel({ apiBase = DEFAULT_API_BASE, accountToken }) {
  return getJson({
    url: `${baseUrl(apiBase)}/api/model?_=${Date.now()}`,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
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

export async function listWallTemplates({ apiBase = DEFAULT_API_BASE } = {}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/templates`);
  const result = await responseJson(response);
  return {
    ...result,
    templates: Array.isArray(result.templates)
      ? result.templates.filter(template => template?.qualified !== false)
      : [],
  };
}

export async function generateWall({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  template = 'template_1',
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

export async function publishGeneratedWall({ apiBase, deviceId, accountToken, wallId }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/publish-last-wall`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Account-Token': accountToken },
      body: JSON.stringify({ wall_id: wallId || '' }),
    },
  );
  return responseJson(response);
}

export async function createPetCollageJob({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  filenames,
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/pet-collage/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accountToken ? { 'X-Account-Token': accountToken } : {}),
    },
    body: JSON.stringify({ filenames }),
  });
  return responseJson(response);
}

export async function readPetCollageJob({ apiBase = DEFAULT_API_BASE, accountToken, jobId }) {
  return getJson({
    url: `${baseUrl(apiBase)}/api/pet-collage/jobs/${encodeURIComponent(jobId)}?_=${Date.now()}`,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
    timeoutMs: PET_COLLAGE_STATUS_REQUEST_TIMEOUT_MS,
  });
}

export async function uploadPetCollageCutout({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  jobId,
  filename,
  cutoutUri,
  onProgress,
}) {
  const form = new FormData();
  form.append('filename', filename);
  form.append('file', {
    uri: cutoutUri,
    name: `${filename.replace(/\.[^.]+$/, '') || 'pet'}-cutout.png`,
    type: 'image/png',
  });
  return uploadForm({
    url: `${baseUrl(apiBase)}/api/pet-collage/jobs/${encodeURIComponent(jobId)}/cutouts`,
    form,
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
    onProgress,
    timeoutMs: PET_COLLAGE_CUTOUT_UPLOAD_TIMEOUT_MS,
  });
}

async function waitForPetCollageJob({
  apiBase,
  accountToken,
  jobId,
  statuses,
  onProgress,
  timeoutMs = PET_COLLAGE_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastJob = null;
  while (Date.now() < deadline) {
    let job;
    try {
      job = await readPetCollageJob({ apiBase, accountToken, jobId });
    } catch (error) {
      if (error?.status || Date.now() >= deadline) throw error;
      onProgress?.({
        stage: lastJob?.status || 'analyzing',
        progress: Number(lastJob?.progress) || 0,
        message: '云端仍在处理，正在重新连接',
        job: lastJob,
      });
      await new Promise(resolve => setTimeout(resolve, PET_COLLAGE_POLL_INTERVAL_MS));
      continue;
    }
    lastJob = job;
    onProgress?.({
      stage: job.status,
      progress: Number(job.progress) || 0,
      message: job.message || '',
      job,
    });
    if (job.status === 'failed') throw new Error(job.error || job.message || '宠物拼贴任务失败');
    if (statuses.includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, PET_COLLAGE_POLL_INTERVAL_MS));
  }
  throw new Error('宠物拼贴处理超时，请稍后重试');
}

async function readAuthorizedPetAssets({ album, onProgress }) {
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能制作宠物拼贴');
  }
  const assets = [];
  let after;
  do {
    const page = await MediaLibrary.getAssetsAsync({
      first: Math.min(100, PET_COLLAGE_ASSET_LIMIT - assets.length),
      after,
      ...(!album?.allPhotos && album?.id ? { album: album.id } : {}),
      mediaType: [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    assets.push(...page.assets);
    onProgress?.({ stage: 'scanning', progress: 0, scanned: assets.length });
    after = page.endCursor;
    if (!page.hasNextPage || assets.length >= PET_COLLAGE_ASSET_LIMIT) break;
  } while (after);
  return assets;
}

export async function generatePetCollage({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  album,
  onProgress,
}) {
  if (Platform.OS !== 'ios' || !isPetCutoutAvailable()) {
    throw new Error('宠物拼贴抠图需要安装 iOS 17 或更高版本的完整 App');
  }

  const assets = await readAuthorizedPetAssets({ album, onProgress });
  const assetsByFilename = new Map();
  const duplicateFilenames = new Set();
  assets.forEach(asset => {
    if (!asset.filename || duplicateFilenames.has(asset.filename)) return;
    if (!assetsByFilename.has(asset.filename)) {
      assetsByFilename.set(asset.filename, asset);
      return;
    }
    assetsByFilename.delete(asset.filename);
    duplicateFilenames.add(asset.filename);
  });
  if (assetsByFilename.size < 5) {
    throw new Error('排除同名文件后，当前授权的照片不足 5 张，无法制作宠物拼贴');
  }

  const created = await createPetCollageJob({
    apiBase,
    accountToken,
    filenames: [...assetsByFilename.keys()],
  });
  const selectedJob = await waitForPetCollageJob({
    apiBase,
    accountToken,
    jobId: created.job_id,
    statuses: ['awaiting_cutouts'],
    onProgress,
    timeoutMs: PET_COLLAGE_ANALYSIS_TIMEOUT_MS,
  });

  const selected = Array.isArray(selectedJob.selected) ? selectedJob.selected : [];
  if (selected.length !== 5) throw new Error('云端没有返回 5 张待抠图照片');
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const asset = assetsByFilename.get(item.filename);
    if (!asset) throw new Error(`iPhone 中找不到云端选中的照片：${item.filename}`);
    const info = await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true });
    const sourceUri = info.localUri;
    if (!sourceUri) throw new Error(`无法将照片下载到 iPhone：${item.filename}`);

    let cutout;
    try {
      onProgress?.({
        stage: 'cutout',
        progress: 72 + Math.round((index / selected.length) * 18),
        completed: index,
        total: selected.length,
        message: `正在抠取第 ${index + 1}/5 张宠物照片`,
      });
      cutout = await cutoutPet(sourceUri);
      await uploadPetCollageCutout({
        apiBase,
        accountToken,
        jobId: created.job_id,
        filename: item.filename,
        cutoutUri: cutout.uri,
        onProgress: fraction => onProgress?.({
          stage: 'cutout',
          progress: 72 + Math.round(((index + fraction) / selected.length) * 18),
          completed: index,
          total: selected.length,
          message: `正在上传第 ${index + 1}/5 张透明抠图`,
        }),
      });
    } finally {
      if (cutout?.uri) await removePetCutout(cutout.uri).catch(() => {});
    }
  }

  const ready = await waitForPetCollageJob({
    apiBase,
    accountToken,
    jobId: created.job_id,
    statuses: ['ready'],
    onProgress,
  });
  if (!ready.wall?.image_url) throw new Error('云端未返回宠物拼贴预览');
  return ready.wall;
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
  const known = await fetchKnownPhotoNames({ apiBase, accountToken });
  const assets = [];
  let matched = 0;
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
    matched += page.assets.length;
    assets.push(...page.assets.filter(asset => !known.has(asset.filename)));
    onProgress?.({ stage: 'scanning', progress: 0, scanned: matched });
    after = page.endCursor;
    if (!page.hasNextPage) break;
  } while (after);

  if (!matched) {
    throw new Error('没有找到已授权且拍摄于 2026 年 7 月的照片');
  }
  if (!assets.length) return { scanned: matched, synced: 0, unchanged: true };

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
        scanned: matched,
        uploaded: Math.min(assets.length, Math.round(index + (batch.length * fraction))),
      }),
    });
    synced += Number(result.saved) || batch.length;
  }
  onProgress?.({ stage: 'uploaded', progress: 100, scanned: matched, uploaded: synced });
  return { scanned: matched, synced, unchanged: false };
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

export async function reprovisionDisplay({ apiBase = DEFAULT_API_BASE, deviceId, accountToken, setupToken = '' }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/reprovision`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Account-Token': accountToken,
      },
      body: JSON.stringify({ setup_token: setupToken }),
    },
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
  if (!device) {
    throw Object.assign(new Error('线上服务中没有找到已绑定的设备'), {
      status: 404,
      code: 'DEVICE_NOT_FOUND',
    });
  }
  return device;
}

export async function waitForDisplayRevision({
  apiBase = DEFAULT_API_BASE,
  deviceId,
  accountToken,
  revision,
  onProgress,
  timeoutMs = DISPLAY_DELIVERY_TIMEOUT_MS,
}) {
  const expectedRevision = String(revision || '');
  if (!expectedRevision) throw new Error('发布结果缺少画面版本，请重新发布');
  const deadline = Date.now() + timeoutMs;
  let lastDevice = null;
  let lastError = null;

  while (true) {
    try {
      const device = await readDisplayStatus({ apiBase, deviceId, accountToken });
      lastDevice = device;
      lastError = null;
      onProgress?.(device);
      const currentRevision = String(device.revision || '');
      if (currentRevision && currentRevision !== expectedRevision) {
        throw Object.assign(new Error('这次发布已被另一张画面替换，请确认最新预览后重新发布'), {
          code: 'DISPLAY_REVISION_REPLACED',
        });
      }
      if (String(device.displayed_revision || '') === expectedRevision) return device;
      const state = String(device.state || '').toLowerCase();
      if (device.error || state === 'error' || state === 'failed') {
        throw Object.assign(new Error(device.error || '照片墙刷新失败'), {
          code: 'DISPLAY_DELIVERY_FAILED',
        });
      }
    } catch (error) {
      if (error?.status || error?.code === 'DISPLAY_REVISION_REPLACED' || error?.code === 'DISPLAY_DELIVERY_FAILED') {
        throw error;
      }
      lastError = error;
      onProgress?.(lastDevice, { reconnecting: true });
    }

    if (Date.now() >= deadline) {
      throw new Error(lastError
        ? `暂时无法确认照片墙刷新结果：${lastError.message}`
        : '照片墙刷新超时，请检查设备电源和网络');
    }
    await new Promise(resolve => setTimeout(resolve, DISPLAY_DELIVERY_POLL_INTERVAL_MS));
  }
}
