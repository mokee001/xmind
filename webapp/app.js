const API = "";
let lastWall = null;

const $ = (id) => document.getElementById(id);

async function api(path, body, method = "POST") {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(API + path, opt);
  return res.json();
}

// ---- 相册授权 + 打标 ----
function renderPhotos(photos) {
  $("photoCount").textContent = `共 ${photos.length} 张`;
  $("photoGrid").innerHTML = photos
    .map(
      (p) => `<figure>
        <img src="/photos/${encodeURIComponent(p.filename)}" alt="" />
        <figcaption>${p.tags.join(" · ")}<br/><span class="q">画质 ${p.quality}</span></figcaption>
      </figure>`
    )
    .join("");
}

// ---- 相册授权：点按钮 → 弹系统相册选择器（网页访问相册的合规方式）----
$("btnAuth").onclick = () => {
  $("fileInput").click();
};

$("fileInput").onchange = async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  $("btnAuth").textContent = "识别中…";
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const r = await fetch("/api/upload", { method: "POST", body: fd }).then((x) => x.json());
  renderPhotos(r.photos);
  $("btnAuth").textContent = "继续添加照片";
  e.target.value = ""; // 允许再次选择同一批
  await fetchAlbums();
};

// ---- 载入示例照片（用服务器自带样片演示，无需手机相册）----
$("btnSample").onclick = async () => {
  $("btnSample").textContent = "载入中…";
  const r = await api("/api/authorize");
  renderPhotos(r.photos);
  $("btnSample").textContent = "重新载入示例";
  await fetchAlbums();
};

// ---- 智能相簿（借鉴苹果相册：AI 主动归类，用户单选即出屏）----
let albums = [];
let activeAlbumId = null;

const coverName = (p) => (p || "").split(/[\\/]/).pop();

async function fetchAlbums() {
  const r = await api("/api/smart_albums", null, "GET");
  albums = r.albums || [];
  const junk = r.junk_total || 0;
  const good = r.good_total || 0;
  if (!r.total) {
    $("junkHint").textContent = "";
  } else if (junk > 0) {
    $("junkHint").textContent = `🧹 已自动剔除 ${junk} 张废片 · 保留 ${good} 张好片`;
  } else {
    $("junkHint").textContent = `共 ${good} 张好片`;
  }
  renderAlbums();
}

function renderAlbums() {
  if (!albums.length) {
    $("albumBox").innerHTML =
      '<span class="muted">还没有相簿。先在上方授权/载入照片，或点「重新识别人物」。</span>';
    return;
  }
  const groups = {};
  albums.forEach((a) => (groups[a.group] = groups[a.group] || []).push(a));
  const order = ["精选", "人物", "宠物", "主题", "情绪", "色彩"];
  $("albumBox").innerHTML = order
    .filter((g) => groups[g])
    .map(
      (g) => `<div class="albumGroup">
        <div class="albumGroupTitle">${g}</div>
        <div class="chips">
          ${groups[g]
            .map(
              (a) => `<button class="chip ${a.id === activeAlbumId ? "on" : ""}" data-id="${a.id}">
                ${a.cover ? `<img src="/api/thumb/${encodeURIComponent(coverName(a.cover))}" alt="" />` : ""}
                <span class="chipLabel">${a.label}</span>
                <i class="chipCount">${a.count}</i>
              </button>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");
  $("albumBox")
    .querySelectorAll(".chip")
    .forEach((b) => (b.onclick = () => selectAlbum(b.dataset.id)));
}

async function selectAlbum(id) {
  // 选中相簿（再点同一个 = 用轮换换一批新照片，不取消）；回到全貌就点「精选」卡片
  activeAlbumId = id;
  const album = albums.find((a) => a.id === activeAlbumId);
  if (album && album.template) $("template").value = album.template;
  renderAlbums();
  await generateWall();
}

async function generateWall() {
  const album = albums.find((a) => a.id === activeAlbumId);
  const filters = album ? album.filter : [];
  const label = album ? album.label : "精选";
  $("genStatus").textContent = `AI 正在生成「${label}」这一屏…`;
  const wall = await api("/api/generate", {
    template: $("template").value,
    title: $("title").value,
    date: $("date").value,
    filters,
  });
  if (wall.error) {
    $("genStatus").textContent = wall.error;
    return;
  }
  lastWall = wall;
  const n = (wall.chosen && wall.chosen.length) || 0;
  const fb = wall.filter_fallback ? "（该相簿照片太少，已回退全部）" : "";
  $("genStatus").textContent = `✅ 已上屏｜${label}｜选用 ${n} 张${fb} · 再点一次换一批`;
  $("wallPreview").innerHTML = `<img src="${wall.image_url}?t=${Date.now()}" alt="wall" />`;
  renderLabelArea(wall.elements);
}

// 手动改模板 = 用当前相簿重新出图（覆盖默认模板）
$("template").onchange = () => {
  generateWall();
};

$("btnCluster").onclick = async () => {
  $("btnCluster").textContent = "识别中…";
  await api("/api/cluster_people");
  await fetchAlbums();
  $("btnCluster").textContent = "重新识别人物";
};

$("btnRefresh").onclick = fetchAlbums;

// ---- 打标训练 ----
function renderLabelArea(elements) {
  if (!elements || !elements.length) {
    $("labelArea").textContent = "本次画面无可打标元素";
    return;
  }
  $("labelArea").innerHTML = elements
    .map(
      (t) => `<div class="labelRow" data-tag="${t}">
        <span class="tag">${t}</span>
        <div class="btns">
          <button class="good" data-s="1">好</button>
          <button class="bad" data-s="0">差</button>
        </div>
      </div>`
    )
    .join("");

  $("labelArea").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      const row = b.closest(".labelRow");
      const tag = row.dataset.tag;
      const score = Number(b.dataset.s);
      row.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const r = await api("/api/label", {
        wall_id: lastWall ? lastWall.wall_id : "",
        samples: [{ tag, score }],
      });
      renderModel(r.model);
    };
  });
}

$("btnTrainAll").onclick = async () => {
  const r = await api("/api/train");
  renderModel(r.model);
};

function renderModel(model) {
  const w = model.weights || {};
  const rows = Object.entries(w)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([t, v]) =>
        `<div class="wrow"><span>${t}</span><div class="bar"><i style="width:${Math.round(
          v * 100
        )}%"></i></div><b>${v}</b></div>`
    )
    .join("");
  $("modelBox").innerHTML = `<div class="muted">已训练样本 ${model.trained_samples || 0} · epochs ${
    model.epochs || 0
  }</div>${rows || '<div class="muted">还没有偏好权重，去打标吧</div>'}`;
}

// ---- 连接屏幕状态（复用 display 的 WS，仅用于显示在线状态）----
function watchConn() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/display`);
  ws.onopen = () => ($("conn").textContent = "已联通屏幕");
  ws.onclose = () => {
    $("conn").textContent = "屏幕断开";
    setTimeout(watchConn, 2000);
  };
}

// ---- 贴纸库：上传透明抠图贴纸 → 达标校验 + 主题标签 ----
function renderStickers(list) {
  const st = list || [];
  const ok = st.filter((s) => s.qualified);
  $("stickerCount").textContent = st.length ? `共 ${st.length} 张 · 达标 ${ok.length}` : "";
  const rej = st.filter((s) => !s.qualified);
  $("stickerReject").innerHTML = rej.length
    ? "未达标：" + rej.map((s) => `${s.filename}（${s.reason}）`).join("；")
    : "";
  $("stickerGrid").innerHTML = st
    .map(
      (s) => `<figure class="${s.qualified ? "" : "dim"}">
        <img src="/api/sticker.png/${encodeURIComponent(s.filename)}" alt="" />
        <figcaption>${(s.themes || []).join(" · ")}${
          s.qualified ? "" : "<br/><span class='q'>未达标</span>"
        }</figcaption>
      </figure>`
    )
    .join("");
}

$("btnSticker").onclick = () => $("stickerInput").click();

$("stickerInput").onchange = async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  $("btnSticker").textContent = "上传中…";
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const themes = $("stickerThemes").value.trim();
  const url = "/api/upload_sticker" + (themes ? `?themes=${encodeURIComponent(themes)}` : "");
  const r = await fetch(url, { method: "POST", body: fd }).then((x) => x.json());
  renderStickers(r.stickers);
  $("btnSticker").textContent = "上传贴纸";
  e.target.value = "";
};

// 启动时拉一次现有数据
(async () => {
  const r = await api("/api/photos", null, "GET");
  if (r.photos && r.photos.length) renderPhotos(r.photos);
  renderModel(await api("/api/model", null, "GET"));
  await fetchAlbums();
  try {
    renderStickers((await api("/api/stickers", null, "GET")).stickers);
  } catch (_) {}
  watchConn();
})();
