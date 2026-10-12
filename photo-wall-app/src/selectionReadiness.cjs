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
  const current = () => !closed && active();
  const start = force => {
    if (!current() || disabled || ready || failure || pending || (!force && now()-lastCheck < intervalMs)) return;
    lastCheck = now();
    pending = Promise.resolve().then(check).then(result => {
      if (!current()) return;
      if (result?.contract !== SELECTION_CONTRACT || typeof result.ready !== 'boolean') {
        throw Object.assign(new Error('选片服务版本不匹配'), { terminal:true });
      }
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
      // Transient/network errors only disable this optimization for the moment.
      // The bounded upload/generate path still performs its normal validation.
    }).finally(() => { pending = null; });
  };
  const result = () => { if (failure) throw failure; return current() && ready; };
  return {
    poll() { start(false); return result(); },
    async refresh() { start(true); if (pending) await pending; return result(); },
    close() { closed = true; },
  };
}

module.exports = { SELECTION_CONTRACT, generationPayload, createReadinessProbe };
