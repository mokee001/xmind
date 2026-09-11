import { requireCurrentWall } from './templateCatalog';
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths, UploadType } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import { cutoutPet, isPetCutoutAvailable, removePetCutout } from '../modules/pet-cutout';
import {
  curateLocalPhotos,
  isLocalPhotoCurationAvailable,
} from '../modules/local-photo-curation';

const CLOUD_API_BASE = 'https://api.mokeedesign.cn';
const configuredApiBase = process.env.EXPO_PUBLIC_API_BASE;
const configuredForLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(
  configuredApiBase || '',
);

// Local endpoints are useful for browser/simulator work, but a release build
// must never try to call the phone itself.
export const DEFAULT_API_BASE = !__DEV__ && configuredForLocalhost
  ? CLOUD_API_BASE
  : configuredApiBase || CLOUD_API_BASE;
export const DEFAULT_PROVISION_URL = 'http://192.168.4.1';
const PHOTO_UPLOAD_BATCH_SIZE = 1;
const PHOTO_PIPELINE = process.env.EXPO_PUBLIC_PHOTO_PIPELINE || 'local_preferred';
const LOCAL_CANDIDATE_LIMIT = Number(process.env.EXPO_PUBLIC_LOCAL_CANDIDATE_LIMIT) || 160;
const LOCAL_MINIMUM_CANDIDATES = Number(process.env.EXPO_PUBLIC_LOCAL_MINIMUM_CANDIDATES) || 12;
const LOCAL_INITIAL_ANALYSIS_LIMIT = Number(process.env.EXPO_PUBLIC_LOCAL_INITIAL_ANALYSIS_LIMIT) || 600;
const PWE6_FRAME_BYTES = 960045;
const PET_COLLAGE_ASSET_LIMIT = 5000;
const PET_COLLAGE_POLL_INTERVAL_MS = 1500;
const PET_COLLAGE_TIMEOUT_MS = 10 * 60 * 1000;
const PET_COLLAGE_ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;

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

async function fetchKnownPhotoNames({ apiBase, accountToken }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/known_photos`, {
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
  return new Set((await responseJson(response)).names || []);
}

function selectedAlbumSources(album) {
  const sources = Array.isArray(album?.albums) && album.albums.length
    ? album.albums
    : album ? [album] : [{ allPhotos: true }];
  const allPhotos = sources.find(source => source?.allPhotos);
  if (allPhotos) return [allPhotos];
  return [...new Map(sources.filter(source => source?.id).map(source => [source.id, source])).values()];
}

async function readAssetsFromSelectedAlbums({ album, knownNames = null, limit = Infinity, onProgress }) {
  const sources = selectedAlbumSources(album);
  const assetsById = new Map();
  let scanned = 0;

  for (const source of sources) {
    let after;
    do {
      const request = {
        first: Math.min(100, Math.max(1, limit - assetsById.size)),
        after,
        mediaType: [MediaLibrary.MediaType.photo],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      };
      if (!source?.allPhotos) request.album = source.nativeAlbum || source.id;
      const page = await MediaLibrary.getAssetsAsync(request);
      scanned += page.assets.length;
      for (const asset of page.assets) {
        if (knownNames?.has(asset.filename)) continue;
        const assetId = asset.id || asset.uri || asset.filename;
        if (assetId && !assetsById.has(assetId)) assetsById.set(assetId, asset);
      }
      onProgress?.({ stage: 'scanning', progress: 0, scanned: assetsById.size, inspected: scanned, uploaded: 0 });
      after = page.endCursor;
      if (!page.hasNextPage || assetsById.size >= limit) break;
    } while (after);
    if (assetsById.size >= limit) break;
  }

  return { assets: [...assetsById.values()], scanned };
}

function localFallback(reason, assets, { preserveAll = false, candidateLimit = LOCAL_CANDIDATE_LIMIT } = {}) {
  const fallbackAssets = preserveAll ? assets : assets.slice(0, candidateLimit);
  return {
    assets: fallbackAssets,
    local: {
      used: false,
      fallback: true,
      reason,
      inspected: assets.length,
      candidates: fallbackAssets.length,
    },
  };
}

async function selectUploadCandidatesLocally(assets, onProgress, {
  initialAnalysisLimit = LOCAL_INITIAL_ANALYSIS_LIMIT,
  candidateLimit = LOCAL_CANDIDATE_LIMIT,
  allowLegacyAll = true,
} = {}) {
  if (PHOTO_PIPELINE === 'cloud_legacy') {
    return localFallback('legacy_mode', assets, { preserveAll: allowLegacyAll, candidateLimit });
  }
  if (!isLocalPhotoCurationAvailable()) {
    if (PHOTO_PIPELINE === 'local_only') throw new Error('设备端识别模块不可用，且本地专用模式禁止云端兜底');
    return localFallback('native_module_unavailable', assets, { candidateLimit });
  }

  onProgress?.({
    stage: 'local_analysis',
    progress: 5,
    scanned: assets.length,
    uploaded: 0,
  });
  try {
    // Assets arrive newest-first. The first pass is deliberately bounded so a
    // large library can show value before the persistent background index is ready.
    const initialAssets = assets.slice(0, initialAnalysisLimit);
    const result = await curateLocalPhotos(
      initialAssets.map(asset => asset.id).filter(Boolean),
      { maximumCandidates: candidateLimit },
    );
    const byID = new Map(initialAssets.map(asset => [asset.id, asset]));
    const candidates = (result.candidates || []).map(item => byID.get(item.id)).filter(Boolean);
    if (candidates.length < Math.min(LOCAL_MINIMUM_CANDIDATES, assets.length)) {
      if (PHOTO_PIPELINE === 'local_only') {
        throw new Error(`本机只找到 ${candidates.length} 张候选照片，低于安全下限`);
      }
      return localFallback('insufficient_local_candidates', assets, { candidateLimit });
    }
    onProgress?.({
      stage: 'local_analysis',
      progress: 100,
      scanned: assets.length,
      selected: candidates.length,
      uploaded: 0,
      local: result,
    });
    return {
      assets: candidates,
      local: {
        ...result,
        used: true,
        fallback: false,
        candidates: candidates.length,
      },
    };
  } catch (error) {
    if (PHOTO_PIPELINE === 'local_only') throw error;
    return localFallback(`local_analysis_failed:${error.message}`, assets, { candidateLimit });
  }
}

export async function syncPhotoAlbum({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  album,
  onProgress,
  initialAssetLimit = Infinity,
  initialAnalysisLimit = LOCAL_INITIAL_ANALYSIS_LIMIT,
  candidateLimit = LOCAL_CANDIDATE_LIMIT,
  allowLegacyAll = true,
}) {
  if (Platform.OS === 'web') {
    throw new Error('网页预览无法读取系统相册，请在已安装的手机 App 中同步照片');
  }
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    throw new Error('需要照片访问权限，才能同步相册');
  }
  const known = await fetchKnownPhotoNames({ apiBase, accountToken });
  onProgress?.({ stage: 'scanning', progress: 0, scanned: 0, uploaded: 0 });
  const { assets: discoveredAssets } = await readAssetsFromSelectedAlbums({
    album,
    knownNames: known,
    limit: initialAssetLimit,
    onProgress,
  });

  if (!discoveredAssets.length) {
    return { scanned: 0, synced: 0, unchanged: true, local: null };
  }
  const selection = await selectUploadCandidatesLocally(discoveredAssets, onProgress, {
    initialAnalysisLimit,
    candidateLimit,
    allowLegacyAll,
  });
  const assets = selection.assets;
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
  return {
    scanned: discoveredAssets.length,
    selected: assets.length,
    synced,
    unchanged: false,
    local: selection.local,
  };
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

export async function readSelectionModel({ apiBase = DEFAULT_API_BASE, accountToken }) {
  const response = await fetch(`${baseUrl(apiBase)}/api/model`, {
    headers: accountToken ? { 'X-Account-Token': accountToken } : {},
  });
  return responseJson(response);
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
  template = 'auto',
  title = '我的一天',
  filters = [],
  excludeFilters = [],
  deviceId = '',
  preferenceRevisionId = '',
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accountToken ? { 'X-Account-Token': accountToken } : {}) },
    body: JSON.stringify({
      template,
      title,
      filters,
      exclude_filters: excludeFilters,
      device_id: deviceId,
      preference_revision_id: preferenceRevisionId,
    }),
  });
  return responseJson(response);
}

export async function readDevicePreferenceProfile({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/preferences?device_id=${encodeURIComponent(deviceId)}`,
    { headers: accountToken ? { 'X-Account-Token': accountToken } : {} },
  );
  return responseJson(response);
}

export async function readDeviceDisplayHistory({ apiBase = DEFAULT_API_BASE, deviceId, accountToken }) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/devices/${encodeURIComponent(deviceId)}/display-history`,
    { headers: accountToken ? { 'X-Account-Token': accountToken } : {} },
  );
  return responseJson(response);
}

export async function createDevicePreferenceRevision({
  apiBase = DEFAULT_API_BASE,
  deviceId,
  accountToken,
  snapshot,
  parentId = '',
  source = 'preferences',
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/preferences/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accountToken ? { 'X-Account-Token': accountToken } : {}) },
    body: JSON.stringify({
      device_id: deviceId,
      snapshot,
      parent_id: parentId,
      source,
    }),
  });
  return responseJson(response);
}

export async function activateDevicePreferenceRevision({
  apiBase = DEFAULT_API_BASE,
  deviceId,
  accountToken,
  revisionId,
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/preferences/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accountToken ? { 'X-Account-Token': accountToken } : {}) },
    body: JSON.stringify({ device_id: deviceId, revision_id: revisionId }),
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
  const response = await fetch(
    `${baseUrl(apiBase)}/api/pet-collage/jobs/${encodeURIComponent(jobId)}`,
    { headers: accountToken ? { 'X-Account-Token': accountToken } : {} },
  );
  return responseJson(response);
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
    timeoutMs: 120000,
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
  while (Date.now() < deadline) {
    const job = await readPetCollageJob({ apiBase, accountToken, jobId });
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
  const { assets } = await readAssetsFromSelectedAlbums({
    album,
    limit: PET_COLLAGE_ASSET_LIMIT,
    onProgress,
  });
  return assets;
}

export async function generatePetCollage({
  apiBase = DEFAULT_API_BASE,
  accountToken,
  album,
  onProgress,
}) {
  if (Platform.OS !== 'ios') {
    throw new Error('宠物拼贴抠图仅支持 iPhone App');
  }
  if (!isPetCutoutAvailable()) {
    throw new Error('当前安装包未包含宠物抠图组件。请安装最新测试版；这不是 iOS 版本不足。');
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
