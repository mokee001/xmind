const API_BASE = 'https://api.mokeedesign.cn';

async function responseJson(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `请求失败（HTTP ${response.status}）` };
  }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

export async function claimDisplay(pairingCode, name = '客厅照片墙') {
  const response = await fetch(`${API_BASE}/api/devices/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_code: String(pairingCode || '').replace(/\D/g, ''),
      name,
    }),
  });
  return responseJson(response);
}

export { API_BASE };
