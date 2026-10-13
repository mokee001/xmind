// Local scenarios only: these states never read browser connectivity or a device.
export const NETWORK_SCENARIOS = ['service-unreachable', 'device-offline'];

export function createNetworkDemo({ scenario, schedule = setTimeout, cancel = clearTimeout,
  readTimeout = 8000, removeTimeout = 10000, responseDelay = 650,
  deviceId = 'demo-frame', removalResponse } = {}) {
  let service = scenario !== 'service-unreachable', device = scenario !== 'device-offline';
  let history = 'idle', checking = false, removing = false, removed = false;
  let removalPendingDevice = false, destroyed = false;
  let removalKind = null;
  const listeners = new Set(), requests = new Map();
  const snapshot = () => ({ service, device: service ? device : null, history, checking, removing,
    removed, removalKind, removalPendingDevice, simulated: true });
  const emit = () => listeners.forEach(listener => listener(snapshot()));
  function request(kind, timeout, callback, signal) {
    if (destroyed || signal?.aborted) return Promise.resolve({ canceled: true });
    if (requests.has(kind)) return requests.get(kind).promise;
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    let timer;
    const finish = canceled => {
      if (requests.get(kind) !== entry) return;
      cancel(timer); signal?.removeEventListener('abort', abort); requests.delete(kind);
      const result = canceled ? { canceled: true } : callback();
      if (kind === 'check') checking = false;
      if (kind === 'remove') removing = false;
      if (canceled && kind === 'history') history = 'idle';
      emit(); settle(result);
    };
    const abort = () => finish(true);
    const entry = { promise, abort };
    requests.set(kind, entry);
    signal?.addEventListener('abort', abort, { once: true });
    // An unavailable service reaches a real, bounded demo deadline; it does not
    // become successful merely because the user tried again.
    timer = schedule(() => finish(false), service ? Math.min(responseDelay, timeout) : timeout);
    return promise;
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    blocker(stage) {
      if (removed) return 'removed';
      if (!service && stage !== 'local') return 'service-unreachable';
      if (!device && stage === 'receipt') return 'device-offline';
      return null;
    },
    readHistory({ signal } = {}) {
      if (destroyed || signal?.aborted) return Promise.resolve({ canceled: true });
      if (requests.has('history')) return requests.get('history').promise;
      history = 'loading'; emit();
      return request('history', readTimeout, () => {
        history = service ? 'ready' : 'error';
        return { ok: service, simulated: true };
      }, signal);
    },
    check({ signal } = {}) {
      if (destroyed || signal?.aborted) return Promise.resolve({ canceled: true });
      if (requests.has('check')) return requests.get('check').promise;
      checking = true; emit();
      return request('check', readTimeout, () => ({ ok: service, deviceOnline: service && device, simulated: true }), signal);
    },
    remove({ confirmed = false, signal } = {}) {
      if (!confirmed) return Promise.resolve({ ok: false, confirmationRequired: true });
      if (destroyed || signal?.aborted) return Promise.resolve({ canceled: true });
      if (requests.has('remove')) return requests.get('remove').promise;
      removing = true; emit();
      return request('remove', removeTimeout, () => {
        if (!service) return { ok: false, reason: 'timeout', simulated: true };
        let response;
        try { response = removalResponse ? removalResponse() : { device_id: deviceId, removed: true, reprovision_required: true }; }
        catch { return { ok: false, reason: 'unconfirmed', simulated: true }; }
        if (response?.device_id !== deviceId || response.removed !== true) return { ok: false, reason: 'unconfirmed', simulated: true };
        removed = true; removalKind = 'cloud'; removalPendingDevice = !device;
        return { ok: true, removed: true, pendingDevice: removalPendingDevice, simulated: true };
      }, signal);
    },
    removeLocal({ confirmed = false } = {}) {
      if (!confirmed || destroyed) return { ok: false, confirmationRequired: !confirmed };
      requests.get('remove')?.abort();
      removed = true; removalKind = 'local'; removalPendingDevice = false; emit();
      return { ok: true, localOnly: true, cloudBindingRemoved: false, simulated: true };
    },
    completeReconnect({ confirmed = false } = {}) {
      if (!confirmed || !service || destroyed) return false;
      removed = false; removalKind = null; removalPendingDevice = false; device = true; emit();
      return true;
    },
    restoreService() { service = true; emit(); },
    recover() { service = true; device = true; emit(); },
    destroy() {
      destroyed = true;
      [...requests.values()].forEach(request => request.abort());
      listeners.clear();
    },
  };
}

export function networkNotice(state) {
  if (state.removed && state.removalKind === 'local') return { label: '此手机未连接', title: '已从此手机移除',
    copy: '云端绑定尚未解除。重新连接完成前，不会显示为已连接。' };
  if (state.removed) return { label: '未连接', title: '设备已移除',
    copy: state.removalPendingDevice ? '模拟服务已确认移除。屏幕恢复联网后同步清除连接设置。' : '模拟服务已确认移除设备。原有偏好仍保留。' };
  if (state.checking) return { label: '正在检查连接…', title: '正在检查连接…', copy: '正在确认手机与服务、照片墙的连接状态。' };
  if (!state.service) return { label: state.history === 'loading' ? '确认连接中' : '暂时连不上服务',
    title: state.history === 'loading' ? '正在读取展示记录…' : '暂时无法读取展示记录',
    copy: '请检查手机网络后重试。暂时无法确认照片墙状态，已有记录会保留。' };
  if (!state.device) return { label: '照片墙离线', title: '照片墙暂时离线',
    copy: '手机可以访问服务。请检查照片墙电源和 Wi-Fi；展示记录仍可查看。' };
  return { label: '已连接', title: state.history === 'loading' ? '正在读取展示记录…' : '连接已恢复',
    copy: '模拟服务已恢复访问。读取记录不会代替照片墙的上屏回执。' };
}
