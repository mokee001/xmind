// Coordination only. The native module remains the single source of photo rules.
const PREWARM_ENGINE = 'apple-vision-local-v1:curation-384-score052-text5:classification1-640-face3-human2-1600';

function assetStamp(asset) {
  return [asset.id, asset.modificationTime || asset.creationTime || 0];
}

function prewarmContextKey({ owner, sources, permission, libraryRevision = 0, engine = PREWARM_ENGINE }) {
  return JSON.stringify([owner, sources, permission?.status, permission?.accessPrivileges || 'unknown', libraryRevision, engine]);
}

// An unbound onboarding can be claimed once by its first account. Later account
// changes get a new local key; the key and all cached results die with the app.
function createPrewarmOwner() {
  let owner = '', generation = 0;
  return next => {
    next ||= '';
    if (owner && owner !== next) generation++;
    owner = next;
    return `local-onboarding-${generation}`;
  };
}

function createPhotoPrewarm({ curate, observe, maxObservations = 16 }) {
  let context = null, epoch = 0, curation = null, serial = Promise.resolve();
  const observations = new Map();
  const cancelled = () => Object.assign(new Error('照片准备已失效，请重新读取。'), { code:'PREWARM_INVALIDATED' });
  const invalidate = () => { epoch++; curation = null; observations.clear(); };
  const useContext = key => { if (context !== key) { invalidate(); context = key; } };
  const enqueue = (key, work, active) => {
    const generation = epoch;
    const current = () => context === key && epoch === generation && active();
    const result = serial.catch(() => {}).then(async () => {
      if (!current()) throw cancelled();
      const value = await work();
      if (!current()) throw cancelled();
      return value;
    });
    serial = result.catch(() => {});
    return result;
  };
  return {
    invalidate,
    useContext,
    curate(key, assets, active = () => true) {
      if (!active()) return Promise.reject(cancelled());
      useContext(key);
      const signature = JSON.stringify(assets.map(assetStamp));
      if (curation?.signature === signature) return curation.promise;
      const entry = { signature };
      entry.promise = enqueue(key, () => curate(assets), active).catch(error => {
        if (curation === entry) curation = null;
        throw error;
      });
      curation = entry;
      return entry.promise;
    },
    observe(key, asset, uri, active = () => true) {
      if (!active()) return Promise.reject(cancelled());
      useContext(key);
      const signature = JSON.stringify([...assetStamp(asset), uri]);
      if (observations.has(signature)) return observations.get(signature);
      const promise = enqueue(key, () => observe(uri), active).catch(error => {
        if (observations.get(signature) === promise) observations.delete(signature);
        throw error;
      });
      observations.set(signature, promise);
      while (observations.size > maxObservations) observations.delete(observations.keys().next().value);
      return promise;
    },
  };
}

module.exports = { PREWARM_ENGINE, assetStamp, prewarmContextKey, createPrewarmOwner, createPhotoPrewarm };
