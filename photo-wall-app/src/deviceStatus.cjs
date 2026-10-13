const STATUS_TIMEOUT_MS = 8000;
const OBSERVATION_FRESH_MS = 20000;

function sameDeviceBinding(a, b) {
  return !!(a && b && a.deviceId === b.deviceId && a.bindingKey === b.bindingKey
    && a.bindingEpoch === b.bindingEpoch);
}

function deviceConnectionStatus({ connected, preview, device, observation, scope, now = Date.now() }) {
  if (!connected) return { deviceOnline:false, connectionLabel:'连接照片墙' };
  if (preview) return { deviceOnline:true, connectionLabel:'演示连接' };
  const observed = sameDeviceBinding(observation, scope) ? observation : null;
  if (observed?.readFailed) return { deviceOnline:false, connectionLabel:'连接确认失败' };
  const latest = observed?.device && Number(observed.device.last_seen || 0) >= Number(device?.last_seen || 0)
    ? observed.device : device;
  const lastSeen = Number(latest?.last_seen) || 0;
  const fault = Boolean(latest?.error) || ['error','failed'].includes(latest?.state);
  const deviceOnline = !fault && lastSeen > 0 && now / 1000 - lastSeen <= 90;
  const freshRead = observed && !observed.readFailed && now - observed.receivedAt <= OBSERVATION_FRESH_MS;
  return { deviceOnline, connectionLabel:fault ? '设备异常' : deviceOnline ? '已连接'
    : lastSeen && freshRead ? '暂时离线' : '确认连接中' };
}

async function withDeviceStatusTimeout(read, { signal, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => {
      reject(Object.assign(new Error('设备状态读取已取消'), {name:'AbortError'}));
      controller.abort();
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, {once:true});
    timer = setTimeout(() => {
      reject(Object.assign(new Error('读取设备状态超时'), {code:'DEVICE_STATUS_TIMEOUT'}));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Bound the whole operation, including a body read that ignores native abort.
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Object.assign(new Error('设备状态读取已取消'), {name:'AbortError'});
      return read(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function createDeviceStatusPoll({ getScope, isBusy, readDevice, onObserved, onIdle, onError, now = Date.now }) {
  let active = true, pending = null;
  const binding = {...getScope()};
  const current = scope => active && sameDeviceBinding(scope, getScope());
  return {
    refresh() {
      if (!active || !sameDeviceBinding(binding, getScope())) return Promise.resolve({cancelled:true});
      if (pending) return pending.promise;
      const scope = {...getScope()}, busyAtStart = isBusy();
      const controller = new AbortController();
      const request = {controller, promise:null};
      pending = request;
      request.promise = (async () => {
        try {
          const device = await readDevice(scope, controller.signal);
          if (!current(scope) || device.device_id !== scope.deviceId) return {cancelled:true};
          onObserved({...scope, device:{device_id:device.device_id, last_seen:device.last_seen,
            state:device.state, error:device.error}, receivedAt:now(), readFailed:false});
          // A read started during an operation must not later overwrite its result.
          if (!busyAtStart && !isBusy() && scope.sequence === getScope().sequence) await onIdle(device, scope);
          return {ok:true, device};
        } catch (error) {
          if (current(scope) && !controller.signal.aborted) {
            await onError(error, scope, !busyAtStart && !isBusy() && scope.sequence === getScope().sequence);
          }
          return {ok:false, error};
        } finally {
          if (pending === request) pending = null;
        }
      })();
      return request.promise;
    },
    cancel() { active = false; pending?.controller.abort(); },
  };
}

function connectionCheckResult(result, now = Date.now()) {
  if (result?.cancelled) return null;
  if (!result?.ok) return {state:'failed', message:result?.error?.message || '暂时无法连接服务，请检查手机网络后重试。'};
  const device = result.device;
  if (device?.error || ['error','failed'].includes(device?.state)) return {state:'device-error', message:'已连通服务，但照片墙报告异常。请检查设备后重试。'};
  if (Number(device?.last_seen) > 0 && now / 1000 - Number(device.last_seen) <= 90) {
    return {state:'connected', message:'连接检查完成：服务可访问，照片墙在线。'};
  }
  return {state:'offline', message:'服务可访问，照片墙暂时离线。请检查屏幕电源和 Wi-Fi；无需反复点击检查。'};
}

module.exports = { sameDeviceBinding, deviceConnectionStatus, withDeviceStatusTimeout, createDeviceStatusPoll, connectionCheckResult };
