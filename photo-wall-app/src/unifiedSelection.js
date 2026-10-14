import { Platform, AppState } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { appendLocalFetchFile } from './fetchUpload';
import { curateLocalPhotos, observeLocalPhotoFile } from '../modules/local-photo-curation';
import { runSelectionSync } from './selectionSync.cjs';
import { createPhotoPrewarm, prewarmContextKey } from './photoPrewarm.cjs';
import { createReadinessProbe, generationPayload } from './selectionReadiness.cjs';

export const UNIFIED_SELECTION = process.env.EXPO_PUBLIC_UNIFIED_SELECTION === '1';
export const SELECTION_CONTRACT = 'unified-recollections-v1';
const running = new Set();
let libraryRevision = 0, warmRun = 0;
const prewarm = createPhotoPrewarm({
  curate: assets => curateLocalPhotos(assets.map(a => a.id), {maximumCandidates:300}),
  observe: observeLocalPhotoFile,
});

export function invalidatePhotoPrewarm() {
  libraryRevision++; warmRun++; prewarm.invalidate();
}

const permissionKey = permission => JSON.stringify([permission.status, permission.accessPrivileges || 'unknown']);
const photoPage = (source, first, after) => MediaLibrary.getAssetsAsync({ first, after:after || undefined,
  mediaType:[MediaLibrary.MediaType.photo], sortBy:[[MediaLibrary.SortBy.creationTime,false]],
  ...(source === 'all' ? {} : {album:source}),
});
function curatedAssets(assets, result) {
  const byId = new Map(assets.map(a => [a.id,a]));
  if (!Array.isArray(result.reviewedIds)) throw new Error('照片索引模块版本不匹配');
  return {assets:(result.candidates || []).map(c => byId.get(c.id)).filter(Boolean), reviewedIds:result.reviewedIds};
}

// No session request or upload here. The exact first page and native options are
// shared with the foreground queue, including original candidate ordering.
export async function prewarmPhotoSelection({ owner, album, active = () => true }) {
  if (!UNIFIED_SELECTION || Platform.OS !== 'ios') return;
  const run = ++warmRun, revision = libraryRevision;
  const valid = () => revision === libraryRevision && AppState.currentState === 'active';
  const continuing = () => valid() && active() && run === warmRun && running.size === 0;
  if (!continuing()) return;
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (!continuing() || permission.status !== 'granted') return;
  const sources = selectionSources(album);
  if (!sources.length) return;
  const key = prewarmContextKey({owner,sources,permission,libraryRevision:revision});
  const page = await photoPage(sources[0], 60);
  if (!continuing() || !page.assets.length) return;
  const result = await prewarm.curate(key, page.assets, valid);
  if (!continuing()) return;
  for (const asset of curatedAssets(page.assets, result).assets.slice(0,16)) {
    if (!continuing()) return;
    const freshPermission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!continuing()) return;
    if (permissionKey(permission) !== permissionKey(freshPermission)) { invalidatePhotoPrewarm(); return; }
    let info;
    try { info = await MediaLibrary.getAssetInfoAsync(asset, {shouldDownloadFromNetwork:false}); }
    catch { continue; }
    if (!continuing()) return;
    const uri = info.localUri || info.uri;
    if (uri?.startsWith('file:')) await prewarm.observe(key, {...asset,...info}, uri, valid);
  }
}

async function request(url, options, timeout = 60000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await json(await expoFetch(url, {...options, signal:controller.signal})); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

export function createFirstWallReadiness({ apiBase, accountToken, options, active, signal }) {
  const base = apiBase.replace(/\/+$/, '');
  const headers = {'Content-Type':'application/json','X-Account-Token':accountToken,
    'X-Selection-Contract':SELECTION_CONTRACT};
  const probe = createReadinessProbe({active, check:() => request(base+'/api/selection/readiness', {
    method:'POST', signal, headers, body:JSON.stringify(generationPayload(options)),
  }, 5000)});
  return {...probe, async resume() {
    if (!active() || signal?.aborted) return;
    const result = await request(base+'/api/selection/session', {method:'POST', signal, headers,
      body:JSON.stringify({sources:options.selectionSources || ['all']})}, 10000);
    if (result.contract !== SELECTION_CONTRACT) throw new Error('选片服务版本不匹配');
  }};
}

export function selectionSources(album) {
  if (!album || album.allPhotos || album.mode === 'all') return ['all'];
  const sources = album.albums?.length ? album.albums : [album];
  return sources.some(a => a.allPhotos) ? ['all'] : [...new Set(sources.map(a => a.id).filter(Boolean))].sort();
}

async function json(response) {
  let value;
  try { value = await response.json(); }
  catch (error) { if (response.ok) throw error; }
  if (!response.ok) throw Object.assign(new Error(value?.detail || value?.error || `HTTP ${response.status}`), {
    status:response.status, data:value, photoErrorCode:response.headers?.get('X-Photo-Error-Code') || '',
  });
  return value;
}

export async function syncSelectionInBackground({ apiBase, accountToken, album, active = () => true, firstWall = false,
  prewarmOwner = accountToken, shouldStop = () => false, signal }) {
  if (!UNIFIED_SELECTION || Platform.OS !== 'ios' || !accountToken) return;
  warmRun++; // Stop scheduling speculative work; keep an in-flight result reusable.
  const revision = libraryRevision;
  const deadline = Date.now() + (firstWall ? 90000 : Infinity);
  const isActive = () => active() && !signal?.aborted && revision === libraryRevision
    && Date.now() < deadline && AppState.currentState === 'active';
  if (!isActive()) return;
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    if (firstWall) throw new Error('请允许访问照片后继续。');
    return;
  }
  if (!isActive()) return;
  const sources = selectionSources(album);
  const key = prewarmContextKey({owner:prewarmOwner,sources,permission,libraryRevision:revision});
  const base = apiBase.replace(/\/+$/, '');
  const headers = { 'X-Account-Token': accountToken };
  const session = await request(base+'/api/selection/session', {
    method: 'POST', signal, headers: { ...headers, 'Content-Type':'application/json' }, body: JSON.stringify({sources}),
  });
  if (!isActive()) return;
  if (session.contract !== SELECTION_CONTRACT || !/^[a-zA-Z0-9_-]{1,100}$/.test(session.scope)) throw new Error('选片服务版本不匹配');
  if (running.has(session.scope)) {
    if (firstWall) throw new Error('照片正在同步，请稍后重试。');
    return;
  }
  running.add(session.scope);
  try {
    // One source at a time. Source-specific checkpoints avoid cursor collisions.
    for (let sourceIndex = 0; sourceIndex < sources.length && isActive(); sourceIndex++) {
      if (shouldStop()) return;
      const source = sources[sourceIndex];
      const stateFile = new File(Paths.document, `selection-${session.scope}-${sourceIndex}.json`);
      const backupFile = new File(Paths.document, `selection-${session.scope}-${sourceIndex}.backup.json`);
      await runSelectionSync({
        active: isActive,
        shouldStop,
        maxPages: firstWall ? 1 : 3,
        maxUploads: firstWall ? 16 : 72,
        load: async () => {
          for (const file of [stateFile,backupFile]) {
            try { if (file.exists) return JSON.parse(await file.text()); } catch { /* Try last complete checkpoint. */ }
          }
          return null; // Content addressing makes a lost checkpoint safe to rescan.
        },
        save: async state => {
          if (stateFile.exists) {
            try { const previous = await stateFile.text(); JSON.parse(previous); backupFile.write(previous); } catch { /* Retain older backup. */ }
          }
          stateFile.write(JSON.stringify(state));
        },
        readPage: after => photoPage(source, firstWall ? 60 : 300, after),
        curate: async assets => {
          if (!assets.length) return {assets:[],reviewedIds:[]};
          let result;
          try { result = await prewarm.curate(key, assets, isActive); }
          catch (error) {
            if (!firstWall || !isActive()) throw error;
            // Failed speculative work cannot poison the real foreground attempt.
            result = await prewarm.curate(key, assets, isActive);
          }
          return curatedAssets(assets, result);
        },
        upload: async asset => {
          if (!isActive()) throw new Error('Selection suspended');
          const freshPermission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
          if (permissionKey(permission) !== permissionKey(freshPermission)) {
            invalidatePhotoPrewarm(); throw new Error('照片访问范围已变化，请重新准备。');
          }
          let info;
          try { info = await MediaLibrary.getAssetInfoAsync(asset, {shouldDownloadFromNetwork:false}); }
          catch { return false; } // Deleted or iCloud-only asset; retry on a later pass.
          if (!isActive()) throw new Error('Selection suspended');
          const uri = info.localUri || info.uri;
          if (!uri?.startsWith('file:')) return false;
          let vision;
          try { vision = await prewarm.observe(key, {...asset,...info}, uri, isActive); }
          catch (error) {
            if (!firstWall || !isActive()) throw error;
            vision = await prewarm.observe(key, {...asset,...info}, uri, isActive);
          }
          if (!isActive()) throw new Error('Selection suspended');
          // A ready response can arrive while native analysis is running.
          // Leave this asset pending instead of sending an unnecessary upload.
          if (shouldStop()) throw Object.assign(new Error('First wall ready'), {code:'SELECTION_READY'});
          const form = new FormData();
          appendLocalFetchFile(form, 'files', {uri, name:asset.filename});
          form.append('metadata', JSON.stringify([{local_engine:'apple-vision-local-v1',vision}]));
          form.append('sources', JSON.stringify(sources));
          let result;
          try {
            result = await request(base+'/api/selection/upload', {method:'POST',headers,body:form,signal}, firstWall ? 20000 : 120000);
          } catch (error) {
            const unavailablePhoto = error.photoErrorCode
              ? ['unsupported_photo_format','unreadable_photo'].includes(error.photoErrorCode)
              : ['不支持的照片格式','照片文件损坏或无法读取'].includes(error.message);
            // Leave this asset unconfirmed; later photos can still reach the wall.
            if (error.status === 422 && unavailablePhoto) return false;
            throw error;
          }
          if (result.contract !== SELECTION_CONTRACT || result.saved !== 1) throw new Error('照片上传未确认');
        },
      });
    }
  } catch (error) {
    if (error.code !== 'SELECTION_READY') throw error;
  } finally { running.delete(session.scope); }
}
