import { DEFAULT_API_BASE } from './deviceApi';
import { withRequestTimeout } from './networkRecovery.cjs';

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

function requestJson(url, options = {}) {
  return withRequestTimeout(async signal => responseJson(await fetch(url, { ...options, signal })),
    { signal: options.signal, timeoutMs: 8000 });
}

function authHeaders(accessToken, json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(accessToken ? { 'X-User-Token': accessToken } : {}),
  };
}

export async function registerAccount({ apiBase = DEFAULT_API_BASE, name = '我' } = {}) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/accounts/register`, {
    method: 'POST',
    headers: authHeaders('', true),
    body: JSON.stringify({ name }),
  });
  return { account: result.account, accessToken: result.access_token };
}

export async function readAccount({ apiBase = DEFAULT_API_BASE, accessToken }) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/accounts/me`, {
    headers: authHeaders(accessToken),
  });
  return result;
}

export async function updateAccount({ apiBase = DEFAULT_API_BASE, accessToken, name }) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/accounts/me`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({ name }),
  });
  return result;
}

export async function listHouseholds({ apiBase = DEFAULT_API_BASE, accessToken }) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/households`, {
    headers: authHeaders(accessToken),
  });
  return result;
}

export async function adoptDevice({
  apiBase = DEFAULT_API_BASE,
  accessToken,
  deviceId,
  deviceAccountToken,
  householdName,
}) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/households/adopt-device`, {
    method: 'POST',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({
      device_id: deviceId,
      device_account_token: deviceAccountToken,
      household_name: householdName,
    }),
  });
  return result;
}

export async function readHouseholdMembers({ apiBase = DEFAULT_API_BASE, accessToken, householdId }) {
  const result = await requestJson(
    `${baseUrl(apiBase)}/api/households/${encodeURIComponent(householdId)}/members`,
    { headers: authHeaders(accessToken) },
  );
  return result;
}

export async function createHouseholdInvite({ apiBase = DEFAULT_API_BASE, accessToken, householdId }) {
  const result = await requestJson(
    `${baseUrl(apiBase)}/api/households/${encodeURIComponent(householdId)}/invites`,
    { method: 'POST', headers: authHeaders(accessToken) },
  );
  return result;
}

export async function acceptHouseholdInvite({ apiBase = DEFAULT_API_BASE, accessToken, code }) {
  const result = await requestJson(`${baseUrl(apiBase)}/api/households/invites/accept`, {
    method: 'POST',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({ code }),
  });
  return result;
}

export async function updateHouseholdMember({
  apiBase = DEFAULT_API_BASE,
  accessToken,
  householdId,
  userId,
  canPublish,
}) {
  const result = await requestJson(
    `${baseUrl(apiBase)}/api/households/${encodeURIComponent(householdId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: authHeaders(accessToken, true),
      body: JSON.stringify({ can_publish: canPublish }),
    },
  );
  return result;
}

export async function removeHouseholdMember({
  apiBase = DEFAULT_API_BASE,
  accessToken,
  householdId,
  userId,
}) {
  const result = await requestJson(
    `${baseUrl(apiBase)}/api/households/${encodeURIComponent(householdId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: authHeaders(accessToken) },
  );
  return result;
}
