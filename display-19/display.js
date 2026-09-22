const layers = [...document.querySelectorAll(".wall")];
const empty = document.getElementById("empty");
const emptyTitle = document.getElementById("empty-title");
const emptyDetail = document.getElementById("empty-detail");
const status = document.getElementById("status");

const params = new URLSearchParams(window.location.search);
const configuredServer = params.get("server");
const standaloneServer = `${window.location.protocol}//${window.location.hostname}:8000`;
const defaultServer = window.location.port === "8019" ? standaloneServer : window.location.origin;
let serverUrl;
let displayDeviceId = params.get("device_id") || "";
const fitMode = params.get("fit") === "cover" ? "cover" : "contain";

let activeLayer = -1;
let reconnectDelay = 1000;
let reconnectTimer;
let heartbeatTimer;
let socket;

layers.forEach((layer) => {
  layer.style.objectFit = fitMode;
});

function setStatus(state, message) {
  status.dataset.state = state;
  status.textContent = message;
}

function imageUrl(path) {
  if (!serverUrl) throw new Error("server is not configured");
  const url = new URL(path, serverUrl);
  url.searchParams.set("screen_t", Date.now().toString());
  return url.toString();
}

function showWall(wall) {
  if (!wall?.image_url) return;

  const nextLayer = activeLayer === 0 ? 1 : 0;
  const incoming = layers[nextLayer];
  const outgoing = activeLayer >= 0 ? layers[activeLayer] : null;
  incoming.onload = () => {
    empty.hidden = true;
    incoming.classList.add("is-visible");
    outgoing?.classList.remove("is-visible");
    incoming.alt = [wall.title, wall.date].filter(Boolean).join(" ") || "家庭照片墙";
    if (outgoing) outgoing.alt = "";
    activeLayer = nextLayer;
  };
  incoming.onerror = () => setStatus("offline", "画面加载失败，等待重试");
  incoming.src = imageUrl(wall.image_url);
}

function websocketUrl() {
  if (!serverUrl) throw new Error("server is not configured");
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/display";
  url.search = "";
  if (displayDeviceId) url.searchParams.set("device_id", displayDeviceId);
  url.hash = "";
  return url.toString();
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function connect() {
  if (!serverUrl) return;
  window.clearInterval(heartbeatTimer);
  setStatus("connecting", "正在连接");
  socket = new WebSocket(websocketUrl());

  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    setStatus("online", "已连接");
    heartbeatTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25000);
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "wall") showWall(message);
    } catch {
      setStatus("offline", "收到无效画面，等待重试");
    }
  });

  socket.addEventListener("close", () => {
    window.clearInterval(heartbeatTimer);
    setStatus("offline", "连接已中断，正在重连");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => socket.close());
}

async function keepScreenAwake() {
  if (!("wakeLock" in navigator)) return;
  try {
    await navigator.wakeLock.request("screen");
  } catch {
    // Kiosk startup also disables desktop blanking; Wake Lock is best-effort.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepScreenAwake();
});

async function localDisplayConfig() {
  try {
    const response = await fetch("/display-config.json", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function bootstrap() {
  if (configuredServer) {
    serverUrl = new URL(configuredServer);
    connect();
    return;
  }

  const config = await localDisplayConfig();
  if (config?.configured && config.backend_url) {
    displayDeviceId = config.device_id || displayDeviceId;
    serverUrl = new URL(config.backend_url);
    connect();
    return;
  }
  if (config) {
    if (config.mode === "connecting") {
      emptyTitle.textContent = "正在完成设备连接";
      emptyDetail.textContent = "连接完成后会自动显示照片";
      setStatus("connecting", "正在连接");
    } else {
      emptyTitle.textContent = "等待设备连接";
      emptyDetail.textContent = "设备添加完成后会自动显示照片";
      setStatus(config.error ? "offline" : "connecting", config.error ? "请在手机 App 中重试" : "等待连接");
    }
    window.setTimeout(bootstrap, 2000);
    return;
  }

  serverUrl = new URL(defaultServer);
  connect();
}

keepScreenAwake();
bootstrap();