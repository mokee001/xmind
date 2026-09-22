// 照片墙 · 创作平台前端：贴纸上传 + 模板上传 + 自动匹配预览。
// 与手机端/硬件屏解耦，只做「内容达标 + 组合预览」。

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// ---------- 连接状态 ----------
async function checkConn() {
  try {
    await api("/api/photos");
    $("conn").textContent = "已连接后端";
    $("conn").className = "pill ok";
  } catch {
    $("conn").textContent = "后端未连接";
    $("conn").className = "pill bad";
  }
}

// ---------- 贴纸 ----------
function renderStickers(list) {
  const grid = $("stickerGrid");
  grid.innerHTML = "";
  const ok = list.filter((s) => s.qualified);
  $("stickerCount").textContent = `共 ${list.length} 张，达标 ${ok.length} 张`;
  list.forEach((s) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const badge = s.qualified
      ? `<span class="badge ok">可生成</span>`
      : `<span class="badge bad">暂不可生成</span>`;
    const themes = (s.themes || []).join(" · ");
    cell.innerHTML = `
      ${badge}
      <div class="sticker-thumb"><img src="/api/sticker.png/${encodeURIComponent(s.filename)}" alt="" /></div>
      <div class="cap">
        <div class="name">${s.filename}</div>
        <div class="tags">${s.qualified ? themes : (s.reason || "")}</div>
      </div>`;
    grid.appendChild(cell);
  });
}

async function loadStickers() {
  try {
    const d = await api("/api/stickers");
    renderStickers(d.stickers || []);
  } catch (e) { console.warn(e); }
}

async function uploadStickers(files) {
  if (!files || !files.length) return;
  const themes = encodeURIComponent($("stickerThemes").value.trim());
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  $("stickerReject").textContent = "上传中…";
  try {
    const d = await api(`/api/upload_sticker?themes=${themes}`, { method: "POST", body: fd });
    renderStickers(d.stickers || []);
    const bad = d.rejected || [];
    $("stickerReject").innerHTML = bad.length
      ? "未达标：" + bad.map((b) => `<div>· ${b.filename}：${b.reason}</div>`).join("")
      : `✅ 新增 ${d.added} 张，达标 ${d.qualified} 张`;
  } catch (e) {
    $("stickerReject").textContent = "上传失败：" + e.message;
  }
}

// ---------- 模板 ----------
function renderTemplates(list) {
  const grid = $("tplGrid");
  grid.innerHTML = "";
  const ok = list.filter((t) => t.qualified);
  $("tplCount").textContent = `共 ${list.length} 套，可生成 ${ok.length} 套`;
  list.forEach((t) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const badge = t.qualified
      ? `<span class="badge ok">可生成</span>`
      : `<span class="badge bad">暂不可生成</span>`;
    const del = t.builtin ? "" : `<div class="del" data-id="${t.id}" title="删除">×</div>`;
    const cover = t.preview_available || t.qualified
      ? `<img src="/api/template_preview/${t.id}.png?t=${Date.now()}" alt="" />`
      : `<div class="sticker-thumb" style="height:110px">无法预览</div>`;
    cell.innerHTML = `
      ${badge}${del}
      ${cover}
      <div class="cap">
        <div class="name">${t.name || t.id}${t.builtin ? " · 内置" : ""}</div>
        <div class="tags">${t.qualified ? `${t.slots} 槽 · ${t.width}×${t.height}` : (t.reason || "")}</div>
      </div>`;
    grid.appendChild(cell);
  });
  grid.querySelectorAll(".del").forEach((el) =>
    el.addEventListener("click", () => deleteTemplate(el.dataset.id)));

  // 同步预览下拉
  const sel = $("previewTpl");
  const cur = sel.value;
  sel.innerHTML = `<option value="">🎲 随机模板（推荐）</option>` +
    ok.filter((t) => t.generation_mode !== "pet_cutout").map((t) => `<option value="${t.id}">${t.name || t.id}</option>`).join("");
  sel.value = cur;
}

async function loadTemplates() {
  try {
    const d = await api("/api/templates");
    renderTemplates(d.templates || []);
  } catch (e) { console.warn(e); }
}

async function uploadTemplates(files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  $("tplReject").textContent = "上传中…";
  try {
    const d = await api("/api/upload_template", { method: "POST", body: fd });
    renderTemplates(d.templates || []);
    const bad = d.rejected || [];
    $("tplReject").innerHTML = bad.length
      ? "未达标：" + bad.map((b) => `<div>· ${b.filename}：${b.reason}</div>`).join("")
      : `✅ 新增 ${d.added} 套，达标 ${d.qualified} 套`;
  } catch (e) {
    $("tplReject").textContent = "上传失败：" + e.message;
  }
}

async function deleteTemplate(id) {
  if (!confirm(`删除模板 ${id}？`)) return;
  try {
    const d = await api("/api/delete_template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    renderTemplates(d.templates || []);
  } catch (e) { alert("删除失败：" + e.message); }
}

// ---------- 自动匹配预览 ----------
async function runPreview() {
  const btn = $("btnPreview");
  btn.disabled = true;
  btn.textContent = "生成中…";
  $("previewStage").innerHTML = `<span class="muted">正在自动匹配模板与贴纸…</span>`;
  try {
    const d = await api("/api/studio/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: $("previewTpl").value || null,
        title: $("previewTitle").value || "我的一天",
      }),
    });
    if (d.error) throw new Error(d.error);
    $("previewStage").innerHTML = `<img src="${d.image_url}?t=${Date.now()}" alt="预览" />`;
    const st = (d.stickers || []).length
      ? (d.stickers || []).map((s) => `<span class="chip">🌟 ${s}</span>`).join("") +
        (d.stickers_by_theme ? "" : ` <span class="muted">（展示，正式成墙按主题匹配）</span>`)
      : `<span class="muted">（暂无达标贴纸，先去左侧上传）</span>`;
    $("previewMeta").innerHTML =
      `模板：<b>${d.template_name}</b>（${d.slots} 槽）` +
      (d.using_placeholder ? ` · <span class="muted">相册照片不足，用占位图预览</span>` : "") +
      `<br/>贴纸：${st}`;
  } catch (e) {
    $("previewStage").innerHTML = `<span class="muted">预览失败：${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ 生成 / 换一批";
  }
}

// ---------- 拖拽绑定 ----------
function bindDrop(dropId, inputId, handler) {
  const drop = $(dropId), input = $(inputId);
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { handler(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => handler(e.dataTransfer.files));
}

// ---------- 模板格式帮助 ----------
const TPL_SAMPLE = `{
  "id": "my_template",
  "name": "我的模板",
  "canvas": {
    "width": 1280, "height": 720,
    "background": { "type": "gradient", "from": "#F6EFE3", "to": "#EADFCB", "angle": 90 }
  },
  "slots": [
    { "x": 70, "y": 120, "w": 560, "h": 470, "radius": 20, "shadow": true },
    { "x": 680, "y": 120, "w": 520, "h": 230, "radius": 16, "shadow": true },
    { "x": 680, "y": 380, "w": 520, "h": 210, "radius": 16, "shadow": true }
  ],
  "decorations": [
    { "type": "title", "text": "{{title}}", "x": 72, "y": 42, "size": 60, "color": "#3A322A" },
    { "type": "date",  "x": 74, "y": 660, "size": 28, "color": "#9A8C76" }
  ]
}

支持装饰类型：title / date / text / tape / rect / line / circle / ellipse / dots
达标要求：canvas 有 width/height；slots ≥1 且都落在画布内；能成功渲染。`;

// ---------- 启动 ----------
window.addEventListener("DOMContentLoaded", () => {
  bindDrop("stickerDrop", "stickerInput", uploadStickers);
  bindDrop("tplDrop", "tplInput", uploadTemplates);
  $("btnPreview").addEventListener("click", runPreview);
  $("tplHelp").addEventListener("click", (e) => {
    e.preventDefault();
    $("tplHelpBody").textContent = TPL_SAMPLE;
    $("tplHelpDlg").showModal();
  });
  checkConn();
  loadStickers();
  loadTemplates();
});
