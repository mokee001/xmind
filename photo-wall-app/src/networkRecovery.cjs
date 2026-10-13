const READ_TIMEOUT_MS = 8000;

async function withRequestTimeout(request, { signal, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => {
      reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
      controller.abort();
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      reject(Object.assign(new Error('连接服务超时，请检查手机网络后重试'), { code: 'SERVICE_TIMEOUT' }));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Includes the response body; native fetch implementations may ignore abort.
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
      return request(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function serviceFailureMessage(error) {
  if ([401, 403].includes(Number(error?.status)) || error?.code === 'DEVICE_NOT_FOUND') {
    return '暂时无法确认设备权限，已保留本机绑定。请重试，或进入设备管理检查。';
  }
  if (error?.code === 'INVALID_SERVICE_RESPONSE') return '服务返回的内容不完整，请稍后重试。';
  return '手机暂时连接不到服务，请检查网络后重试。尚不能确认照片墙是否离线。';
}

function sameManagedDevice(a, b) {
  return Boolean(a?.device?.device_id && a.device.device_id === b?.device?.device_id
    && a.accountToken === b?.accountToken);
}

module.exports = { READ_TIMEOUT_MS, withRequestTimeout, serviceFailureMessage, sameManagedDevice };
