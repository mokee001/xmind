const $ = (id) => document.getElementById(id);
const form = $("uploadForm");
const fileInput = $("file");
const submit = $("submit");
const preview = $("preview");
const emptyPreview = $("emptyPreview");
const dropzone = $("dropzone");
const hostInput = $("host");
let localPreviewUrl = null;
let uploading = false;

hostInput.value = localStorage.getItem("einkHost") || hostInput.value;

function showPreview(url) {
  preview.src = url;
  preview.classList.add("show");
  emptyPreview.hidden = true;
}

function selectFile(file) {
  if (!file) return;
  if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
  localPreviewUrl = URL.createObjectURL(file);
  showPreview(localPreviewUrl);
  dropzone.querySelector("strong").textContent = file.name;
  dropzone.querySelector("small").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  submit.disabled = uploading;
}

fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((event) => dropzone.addEventListener(event, (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
}));
["dragleave", "drop"].forEach((event) => dropzone.addEventListener(event, (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
}));
dropzone.addEventListener("drop", (e) => {
  if (!e.dataTransfer.files.length) return;
  const transfer = new DataTransfer();
  transfer.items.add(e.dataTransfer.files[0]);
  fileInput.files = transfer.files;
  selectFile(fileInput.files[0]);
});

function setSteps(progress, state) {
  const ids = ["stepProcess", "stepLeft", "stepRight", "stepRefresh"];
  const thresholds = [1, 3, 51, 99];
  ids.forEach((id, index) => {
    const element = $(id);
    element.classList.toggle("done", state === "done" || progress > (index === 3 ? 99 : thresholds[index + 1] || 100));
    element.classList.toggle("active", state !== "done" && progress >= thresholds[index] && progress <= (thresholds[index + 1] || 100));
  });
}

function renderStatus(status) {
  const progress = Number(status.progress || 0);
  $("stage").textContent = status.stage || "等待上传";
  $("percent").textContent = `${Math.round(progress)}%`;
  $("progressBar").style.width = `${progress}%`;
  $("error").hidden = !status.error;
  $("error").textContent = status.error || "";
  uploading = ["queued", "processing", "uploading"].includes(status.state);
  submit.disabled = uploading || !fileInput.files.length;
  submit.textContent = uploading ? "正在推送，请勿关闭页面" : "推送到墨水屏";
  setSteps(progress, status.state);

  const connection = $("connection");
  connection.className = `connection ${status.state === "error" ? "offline" : status.host ? "online" : ""}`;
  connection.querySelector("span").textContent = status.state === "error" ? "连接异常" : status.host || "检查设备";

  if (status.preview_url && status.state !== "error") {
    showPreview(`${status.preview_url}?v=${status.updated_at || Date.now()}`);
  }
}

async function pollStatus() {
  try {
    const response = await fetch("/api/eink/status", { cache: "no-store" });
    renderStatus(await response.json());
  } catch (error) {
    $("connection").className = "connection offline";
    $("connection").querySelector("span").textContent = "后端离线";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || uploading) return;

  const host = hostInput.value.trim();
  localStorage.setItem("einkHost", host);
  const query = new URLSearchParams({
    host,
    dither: $("dither").checked,
    fit: $("fit").value,
    rotation: $("rotation").value,
    enhancement: $("enhancement").value,
  });
  const body = new FormData();
  body.append("file", file);
  uploading = true;
  submit.disabled = true;

  try {
    const response = await fetch(`/api/eink/upload?${query}`, { method: "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderStatus(result);
  } catch (error) {
    renderStatus({ state: "error", stage: "提交失败", error: error.message, progress: 0 });
  }
});

pollStatus();
setInterval(pollStatus, 800);
