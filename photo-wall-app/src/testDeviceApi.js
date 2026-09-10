import { DEFAULT_API_BASE } from './deviceApi';

function baseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function responseJson(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `请求失败（HTTP ${response.status}）`), {
      status: response.status,
      data,
    });
  }
  return data;
}

function testHeaders(testKey, json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'X-PhotoWall-Test-Key': testKey,
  };
}

export async function createTestDisplay({
  apiBase = DEFAULT_API_BASE,
  testKey,
  name = '模拟照片墙',
}) {
  const response = await fetch(`${baseUrl(apiBase)}/api/test/devices`, {
    method: 'POST',
    headers: testHeaders(testKey, true),
    body: JSON.stringify({ name }),
  });
  return responseJson(response);
}

export async function advanceTestDisplay({
  apiBase = DEFAULT_API_BASE,
  testKey,
  deviceId,
}) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/test/devices/${encodeURIComponent(deviceId)}/advance`,
    { method: 'POST', headers: testHeaders(testKey) },
  );
  return responseJson(response);
}

export async function setTestDisplayState({
  apiBase = DEFAULT_API_BASE,
  testKey,
  deviceId,
  state,
  progress,
  error = '',
}) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/test/devices/${encodeURIComponent(deviceId)}/state`,
    {
      method: 'PATCH',
      headers: testHeaders(testKey, true),
      body: JSON.stringify({ state, progress, error }),
    },
  );
  return responseJson(response);
}

export async function deleteTestDisplay({
  apiBase = DEFAULT_API_BASE,
  testKey,
  deviceId,
}) {
  const response = await fetch(
    `${baseUrl(apiBase)}/api/test/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE', headers: testHeaders(testKey) },
  );
  return responseJson(response);
}
