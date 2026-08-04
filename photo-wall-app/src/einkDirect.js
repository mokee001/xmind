const MAGIC = 'PWE6';
const HEADER_BYTES = 45;
const EXPECTED_WIDTH = 1200;
const EXPECTED_HEIGHT = 1600;
const HALF_WIDTH = EXPECTED_WIDTH / 2;
const CHUNK_PIXELS = 1000;

function byteToProtocol(value) {
  return String.fromCharCode(97 + (value & 0x0f), 97 + ((value >> 4) & 0x0f));
}

function wordToProtocol(value) {
  return byteToProtocol(value & 0xff) + byteToProtocol((value >> 8) & 0xff);
}

function readAscii(bytes, start, length) {
  let value = '';
  for (let index = start; index < start + length; index += 1) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

export function parsePanelFrame(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < HEADER_BYTES) {
    throw new Error('PWE6 画面文件不完整');
  }
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const magic = readAscii(bytes, 0, 4);
  const version = view.getUint8(4);
  const width = view.getUint16(5, false);
  const height = view.getUint16(7, false);
  const payloadSize = view.getUint32(9, false);
  if (magic !== MAGIC || version !== 1) throw new Error('不支持的 PWE6 画面格式');
  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    throw new Error(`屏幕尺寸不匹配: ${width}×${height}`);
  }
  if (HEADER_BYTES + payloadSize !== arrayBuffer.byteLength) {
    throw new Error('PWE6 数据长度校验失败');
  }
  return {
    width,
    height,
    payload: new Uint8Array(arrayBuffer, HEADER_BYTES, payloadSize),
  };
}

function panelCode(payload, pixelIndex) {
  const packed = payload[pixelIndex >> 1];
  return pixelIndex & 1 ? (packed >> 4) & 0x0f : packed & 0x0f;
}

async function loaderCommand(host, command, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}/${command}`, {
      method: 'POST',
      body: '',
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok || !body.includes('Ok!')) {
      throw new Error(`屏幕响应异常: HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function encodeChannelChunk(payload, startX, channelOffset, length) {
  const chars = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const channelIndex = channelOffset + index;
    const y = Math.floor(channelIndex / HALF_WIDTH);
    const x = startX + (channelIndex % HALF_WIDTH);
    chars[index] = String.fromCharCode(97 + panelCode(payload, y * EXPECTED_WIDTH + x));
  }
  return chars.join('');
}

async function sendChannel(host, payload, startX, progressStart, progressSpan, onProgress) {
  const total = HALF_WIDTH * EXPECTED_HEIGHT;
  for (let offset = 0; offset < total; offset += CHUNK_PIXELS) {
    const length = Math.min(CHUNK_PIXELS, total - offset);
    const encoded = encodeChannelChunk(payload, startX, offset, length);
    await loaderCommand(host, `${encoded}${wordToProtocol(encoded.length)}LOAD_`);
    onProgress?.({
      stage: startX === 0 ? '发送左半屏' : '发送右半屏',
      progress: progressStart + progressSpan * ((offset + length) / total),
    });
  }
}

export async function pushFrameToOfficialLoader({ host, frame, onProgress }) {
  const parsed = parsePanelFrame(frame);
  onProgress?.({ stage: '初始化墨水屏', progress: 1 });
  await loaderCommand(host, 'EPDY_', 30000);
  await sendChannel(host, parsed.payload, 0, 2, 47, onProgress);
  onProgress?.({ stage: '切换右半屏', progress: 50 });
  await loaderCommand(host, 'NEXT_');
  await sendChannel(host, parsed.payload, HALF_WIDTH, 51, 47, onProgress);
  onProgress?.({ stage: '墨水屏全刷中', progress: 99 });
  await loaderCommand(host, 'SHOW_', 90000);
  onProgress?.({ stage: '显示完成', progress: 100 });
}

export async function preparePanelFrame({ apiBase, file, dither = true, fit = 'contain', rotation = 0, enhancement = 'standard', accessToken }) {
  const query = new URLSearchParams({
    dither: String(dither),
    fit,
    rotation: String(rotation),
    enhancement,
  });
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${apiBase}/api/eink/prepare?${query}`, {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    body: form,
  });
  if (!response.ok) {
    let message = `云端转换失败: HTTP ${response.status}`;
    try {
      const detail = await response.json();
      message = detail.error || message;
    } catch (_) {}
    throw new Error(message);
  }
  return response.arrayBuffer();
}
