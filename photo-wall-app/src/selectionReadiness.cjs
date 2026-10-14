const SELECTION_CONTRACT = 'unified-recollections-v1';

function generationPayload({ template = 'auto', title = '我的一天', filters = [], excludeFilters = [],
  deviceId = '', preferenceRevisionId = '', selectionSources = ['all'] }, unified = true) {
  return { template, title, filters, exclude_filters:excludeFilters, device_id:deviceId,
    preference_revision_id:preferenceRevisionId,
    ...(unified ? { selection_contract:SELECTION_CONTRACT, selection_sources:selectionSources } : {}) };
}

// At most one short request runs beside uploads; polling itself never blocks one.
function createReadinessProbe({ check, active = () => true, intervalMs = 2000, now = Date.now }) {
  let pending = null, lastCheck = -Infinity, ready = false, failure = null, disabled = false, closed = false;
  let latest = null, transientFailure = false;
  const current = () => !closed && active();
  const start = (force, revalidate = false) => {
    if (!current() || disabled || (ready && !revalidate) || failure || pending || (!force && now()-lastCheck < intervalMs)) return;
    lastCheck = now();
    pending = Promise.resolve().then(check).then(result => {
      if (!current()) return;
      if (result?.contract !== SELECTION_CONTRACT || typeof result.ready !== 'boolean') {
        throw Object.assign(new Error('选片服务版本不匹配'), { terminal:true });
      }
      latest = result; transientFailure = false; ready = result.ready;
      if (result.ready) ready = true;
      else if (result.retryable === false) {
        throw Object.assign(new Error(result.reason || '当前照片范围暂时不能生成，请检查偏好。'),
          { terminal:true, code:result.code, retryable:false, data:{code:result.code, retryable:false} });
      } else if (result.retryable !== true) {
        throw Object.assign(new Error('选片服务返回了无效状态'), { terminal:true });
      }
    }).catch(error => {
      if (!current()) return;
      if (error.status === 404) disabled = true;
      else if (error.terminal || [400,401,403,409,422].includes(error.status)) failure = error;
      else transientFailure = true;
      // A failed readiness check cannot authorize uploads or generation.
    }).finally(() => { pending = null; });
  };
  const result = () => { if (failure) throw failure; return current() && ready; };
  return {
    poll() { start(false); return result(); },
    async refresh() { start(true); if (pending) await pending; return result(); },
    async read() {
      start(true, true); if (pending) await pending; result();
      if (!current() || disabled) return null;
      if (transientFailure || !latest) return {contract:SELECTION_CONTRACT, ready:false,
        retryable:true, action:'wait', code:'readiness_unavailable'};
      return latest;
    },
    pauseUploads() {
      start(false); result();
      // Finish the already-bounded initial batch while the worker starts.
      // Readiness 'wait' prevents the next batch, not the remaining initial photos.
      return current() && (ready || transientFailure);
    },
    close() { closed = true; },
  };
}

module.exports = { SELECTION_CONTRACT, generationPayload, createReadinessProbe };
