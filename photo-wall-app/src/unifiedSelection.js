import { Platform, AppState } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { File, Paths } from 'expo-file-system';
import { curateLocalPhotos, observeLocalPhotoFile } from '../modules/local-photo-curation';
import { runSelectionSync } from './selectionSync.cjs';

export const UNIFIED_SELECTION = process.env.EXPO_PUBLIC_UNIFIED_SELECTION === '1';
export const SELECTION_CONTRACT = 'unified-recollections-v1';
const running = new Set();

async function request(url, options, timeout = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await json(await fetch(url, {...options, signal:controller.signal})); }
  finally { clearTimeout(timer); }
}

export function selectionSources(album) {
  if (!album || album.allPhotos || album.mode === 'all') return ['all'];
  const sources = album.albums?.length ? album.albums : [album];
  return sources.some(a => a.allPhotos) ? ['all'] : [...new Set(sources.map(a => a.id).filter(Boolean))].sort();
}

async function json(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || value.error || `HTTP ${response.status}`);
  return value;
}

export async function syncSelectionInBackground({ apiBase, accountToken, album, active = () => true, firstWall = false }) {
  if (!UNIFIED_SELECTION || Platform.OS !== 'ios' || !accountToken) return;
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') {
    if (firstWall) throw new Error('请允许访问照片后继续。');
    return;
  }
  const sources = selectionSources(album);
  const base = apiBase.replace(/\/+$/, '');
  const headers = { 'X-Account-Token': accountToken };
  const session = await request(base+'/api/selection/session', {
    method: 'POST', headers: { ...headers, 'Content-Type':'application/json' }, body: JSON.stringify({sources}),
  });
  if (session.contract !== SELECTION_CONTRACT || !/^[a-zA-Z0-9_-]{1,100}$/.test(session.scope)) throw new Error('选片服务版本不匹配');
  if (running.has(session.scope)) {
    if (firstWall) throw new Error('照片正在同步，请稍后重试。');
    return;
  }
  running.add(session.scope);
  const deadline = Date.now() + (firstWall ? 90000 : Infinity);
  const isActive = () => active() && Date.now() < deadline && AppState.currentState === 'active';
  try {
    // One source at a time. Source-specific checkpoints avoid cursor collisions.
    for (let sourceIndex = 0; sourceIndex < sources.length && isActive(); sourceIndex++) {
      const source = sources[sourceIndex];
      const stateFile = new File(Paths.document, `selection-${session.scope}-${sourceIndex}.json`);
      const backupFile = new File(Paths.document, `selection-${session.scope}-${sourceIndex}.backup.json`);
      await runSelectionSync({
        active: isActive,
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
        readPage: after => MediaLibrary.getAssetsAsync({ first:firstWall ? 60 : 300, after:after || undefined,
          mediaType:[MediaLibrary.MediaType.photo], sortBy:[[MediaLibrary.SortBy.creationTime,false]],
          ...(source === 'all' ? {} : {album:source}),
        }),
        curate: async assets => {
          if (!assets.length) return {assets:[],reviewedIds:[]};
          const result = await curateLocalPhotos(assets.map(a => a.id), {maximumCandidates:300});
          const byId = new Map(assets.map(a => [a.id,a]));
          if (!Array.isArray(result.reviewedIds)) throw new Error('照片索引模块版本不匹配');
          return {assets:(result.candidates || []).map(c => byId.get(c.id)).filter(Boolean), reviewedIds:result.reviewedIds};
        },
        upload: async asset => {
          if (!isActive()) throw new Error('Selection suspended');
          const freshPermission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
          if (freshPermission.status !== 'granted') throw new Error('Photo permission revoked');
          let info;
          try { info = await MediaLibrary.getAssetInfoAsync(asset, {shouldDownloadFromNetwork:false}); }
          catch { return false; } // Deleted or iCloud-only asset; retry on a later pass.
          const uri = info.localUri || info.uri;
          if (!uri?.startsWith('file:')) return false;
          const vision = await observeLocalPhotoFile(uri);
          if (!isActive()) throw new Error('Selection suspended');
          const form = new FormData();
          form.append('files', {uri, name:asset.filename || `${asset.id}.jpg`, type:'image/jpeg'});
          form.append('metadata', JSON.stringify([{local_engine:'apple-vision-local-v1',vision}]));
          form.append('sources', JSON.stringify(sources));
          const result = await request(base+'/api/selection/upload', {method:'POST',headers,body:form}, firstWall ? 20000 : 120000);
          if (result.contract !== SELECTION_CONTRACT || result.saved !== 1) throw new Error('照片上传未确认');
        },
      });
    }
  } finally { running.delete(session.scope); }
}
