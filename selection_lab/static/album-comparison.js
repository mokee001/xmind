/* Presentation-only comparison: never runs, substitutes, or reranks an engine. */
(function (root) {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const selected = albums => new Set(albums.flatMap(a => a.photo_ids));
  function difference(left, right) {
    const a = new Set(left), b = new Set(right);
    return {shared: [...a].filter(id => b.has(id)), leftOnly: [...a].filter(id => !b.has(id)), rightOnly: [...b].filter(id => !a.has(id))};
  }
  function source(albums, photos, label, engine) {
    const byId = new Map(photos.map(p => [p.id, p]));
    const albumIds = new Set();
    for (const a of albums) {
      if (albumIds.has(a.id) || !a.photo_ids.length || new Set(a.photo_ids).size !== a.photo_ids.length ||
          !a.photo_ids.includes(a.cover) || a.photo_ids.some(id => !byId.has(id))) {
        throw new Error("相册成员或封面数据不完整，暂不能比较。");
      }
      albumIds.add(a.id);
    }
    const ids = selected(albums);
    return {albums, photos: [...byId.values()].filter(p => ids.has(p.id)), byId, ids, label, engine};
  }
  function model(local, record, meta) {
    if (local && local.provenance?.dataset_id !== meta.dataset.id) throw new Error("当前方案与候选集不一致，请重新生成。");
    if (record && (record.dataset_id !== meta.dataset.id || record.result?.signature?.dataset !== meta.dataset.id)) {
      throw new Error("两边不是同一批候选照片，不能直接比较。");
    }
    if (record && (record.result.engine !== "ente-import" || record.result.provenance?.mode !== "natural")) {
      throw new Error("右侧必须是 Ente 自然回忆，不能用调试候选或识别主题代替。");
    }
    const left = local ? source(local.albums, local.photos, "之前的能力 · 当前方案", "photo-wall") : null;
    const right = record ? source(record.result.events, record.result.photos, "Ente · 原版自然回忆", "ente") : null;
    return {left, right, totals: left && right ? difference(left.ids, right.ids) : null};
  }
  // Membership overlap is only a navigation aid, not a semantic match or quality score.
  function closestAlbum(album, candidates) {
    let best = null, shared = 0, jaccard = 0;
    for (const candidate of candidates) {
      const diff = difference(album.photo_ids, candidate.photo_ids);
      const n = diff.shared.length, ratio = n / (n + diff.leftOnly.length + diff.rightOnly.length);
      if (n && (ratio > jaccard || (ratio === jaccard && n > shared))) {
        best = candidate; shared = n; jaccard = ratio;
      }
    }
    return best;
  }
  function coverCard(album, side, own, other) {
    const common = other ? album.photo_ids.filter(id => other.ids.has(id)).length : null;
    return `<article class="cmp-album">
      <button class="collection-card cmp-cover" data-cmp-action="pair" data-side="${side}" data-id="${escape(album.id)}" aria-label="逐张对照：${escape(album.title)}">
        <img src="${escape(own.byId.get(album.cover).image)}" alt="${escape(album.title)}封面" loading="lazy">
        <span class="collection-shade"></span><span class="collection-count">${album.photo_ids.length} 张</span>
        <span class="collection-caption"><strong>${escape(album.title)}</strong><span>${escape(album.subtitle || "Ente 自然回忆")}</span></span>
      </button>
      <div class="cmp-film" aria-label="前四张照片预览">${album.photo_ids.slice(0, 4).map(id => `<img src="${escape(own.byId.get(id).image)}" alt="${escape(own.byId.get(id).filename)}" loading="lazy">`).join("")}</div>
      <div class="cmp-album-meta"><span>${common === null ? "另一方尚无结果" : `对方结果也选了 ${common} 张`}</span><button data-cmp-action="play" data-side="${side}" data-id="${escape(album.id)}">打开相册</button></div>
    </article>`;
  }
  function photoCard(id, index, side, own, otherIds, albumId, pair) {
    const p = own.byId.get(id), shared = otherIds.has(id);
    const badge = shared ? (pair ? "本对相册共同" : "两边都入选") : (pair ? "本对仅此侧" : side === "left" ? "仅当前方案" : "仅 Ente");
    return `<button class="cmp-photo ${shared ? "is-shared" : "is-exclusive"}" data-cmp-action="photo" data-side="${side}" data-id="${escape(albumId)}" data-index="${index}" aria-label="${escape(p.filename)}，${badge}，查看大图">
      <img src="${escape(p.image)}" alt="${escape(p.filename)}" loading="lazy"><span class="cmp-photo-badge">${badge}</span><span class="cmp-filename">${escape(p.filename)}</span>
    </button>`;
  }
  function create(container, openAlbum) {
    let data = null, payload = null, mode = "overview", leftId = "", rightId = "", selectionNote = "", filter = "all";
    function chosen(side) { return data?.[side]?.albums.find(a => a.id === (side === "left" ? leftId : rightId)); }
    function choosePair(side, id) {
      const own = data[side], otherSide = side === "left" ? "right" : "left";
      const album = own?.albums.find(a => a.id === id); if (!album) return;
      const match = closestAlbum(album, data[otherSide]?.albums || []);
      if (side === "left") {leftId = id; rightId = match?.id || "";} else {rightId = id; leftId = match?.id || "";}
      selectionNote = match ? "另一侧暂选照片重合度最高的一组，不代表相同主题；你可以自行换组。" : "另一侧没有含共同照片的相册，未强行配对；可以自行选择任意一组。";
      mode = "pair"; filter = "all";
    }
    function sidebar(side) {
      const own = data[side];
      if (!own) return `<header class="cmp-side-header"><h3>${side === "left" ? "之前的能力 · 当前方案" : "Ente · 原版自然回忆"}</h3><p>尚无可比较结果</p></header>`;
      const unique = data.totals ? (side === "left" ? data.totals.leftOnly : data.totals.rightOnly).length : null;
      return `<header class="cmp-side-header"><h3>${own.label}</h3><p><strong>${own.albums.length}</strong> 个相册 · <strong>${own.ids.size}</strong> 张不同照片${unique === null ? "" : ` · 仅此侧 ${unique} 张`}</p><span>${side === "left" ? "项目已有识别 + 过滤、去重和成册规则" : "独立源码实跑 · 未套用左侧选片规则"}</span></header>`;
    }
    function overview(side) {
      const own = data[side], other = data[side === "left" ? "right" : "left"];
      return `${sidebar(side)}<div class="cmp-albums">${own?.albums.map(a => coverCard(a, side, own, other)).join("") || `<p class="empty">${own ? "本轮真实结果为 0 个相册，不补凑相册。" : "尚无结果；不会使用另一套逻辑填充。"}</p>`}</div>`;
    }
    function pair(side) {
      const own = data[side], album = chosen(side), other = chosen(side === "left" ? "right" : "left");
      const otherIds = new Set(other?.photo_ids || []);
      const ids = (album?.photo_ids || []).filter(id => filter === "all" || (filter === "shared" ? otherIds.has(id) : !otherIds.has(id)));
      return `${sidebar(side)}<label class="cmp-select-label" for="cmp-${side}-album">${side === "left" ? "当前方案相册" : "Ente 相册"}</label><select id="cmp-${side}-album" data-cmp-select="${side}"><option value="">选择一组相册…</option>${(own?.albums || []).map(a => `<option value="${escape(a.id)}" ${album?.id === a.id ? "selected" : ""}>${escape(a.title)} · ${a.photo_ids.length} 张</option>`).join("")}</select>
        ${album ? `<div class="cmp-pair-heading"><span>${escape(album.subtitle || "Ente 自然回忆")} · 展示 ${ids.length} / ${album.photo_ids.length} 张</span><button data-cmp-action="play" data-side="${side}" data-id="${escape(album.id)}">打开相册</button></div><p class="cmp-reason">${escape(album.description || "保留 Ente 原始分组、封面和照片顺序；未额外精选或重排。")}</p><div class="cmp-photos">${ids.map(id => photoCard(id, album.photo_ids.indexOf(id), side, own, otherIds, album.id, true)).join("") || '<p class="empty">该筛选下没有照片。</p>'}</div>` : '<p class="empty">未选相册。不会自动把不同主题当作同一组。</p>'}`;
    }
    function render() {
      if (!data || !payload) return;
      const totals = data.totals;
      const pairStats = chosen("left") && chosen("right") ? difference(chosen("left").photo_ids, chosen("right").photo_ids) : null;
      const diag = payload.record?.result.ente_diagnostics;
      container.innerHTML = `<div class="cmp-controls"><nav class="cmp-view-switch" aria-label="相册对比方式"><button data-cmp-action="overview" aria-pressed="${mode === "overview"}">相册总览</button><button data-cmp-action="pair" aria-pressed="${mode === "pair"}">逐张对照</button></nav><p class="cmp-overlap" role="status">${totals ? `整套结果共同入选 <strong>${totals.shared.length}</strong> 张 · 仅当前方案 ${totals.leftOnly.length} 张 · 仅 Ente ${totals.rightOnly.length} 张` : "等待两套独立结果，不将未运行视为 0 张。"}</p></div>
        <p class="cmp-boundary">同一批 ${payload.meta.dataset.count} 张候选，各自沿用原有成册规则。右侧只展示自然回忆，不混入识别主题或调试组；相册更多不代表质量更好。</p>
        ${payload.state && ["running", "failed"].includes(payload.state.state) ? `<p class="notice">${escape(payload.state.message)}${payload.record ? " 当前对照保留上次成功快照。" : ""}</p>` : ""}
        ${mode === "pair" ? `<div class="cmp-pair-controls"><p>${escape(selectionNote || "任选左右相册；下方标记仅比较这两组，不代表整个候选集的淘汰原因。")}</p><label for="cmp-filter">显示照片</label><select id="cmp-filter" data-cmp-filter><option value="all" ${filter === "all" ? "selected" : ""}>全部照片</option><option value="exclusive" ${filter === "exclusive" ? "selected" : ""}>仅看本对相册的差异</option><option value="shared" ${filter === "shared" ? "selected" : ""}>仅看本对共同照片</option></select><span role="status">${pairStats ? `本对共同 ${pairStats.shared.length} 张 · 左侧独有 ${pairStats.leftOnly.length} 张 · 右侧独有 ${pairStats.rightOnly.length} 张` : "未配对：一侧留空时，不能据此判断另一引擎漏选。"}</span></div>` : ""}
        <div class="cmp-columns">${["left", "right"].map(side => `<section class="cmp-column cmp-${side}" aria-label="${side === "left" ? "当前方案" : "Ente"}相册结果">${mode === "overview" ? overview(side) : pair(side)}</section>`).join("")}</div>
        <details class="cmp-provenance"><summary>这次对比的依据与限制</summary><p>左侧跟随实验台当前参数，右侧是已完成的 Ente 自然回忆快照。本页不运行模型、不改变选片、也不把 Ente 接到左侧规则里；这是两套独立能力的结果对照，不是接入前后的受控效果评测。</p><p>左侧有照片来源、画质及内容过滤；Ente 原版没有套用同一套照片-only 过滤。左侧日期组仍可能混合多个主体，本页没有借机更改成册逻辑。</p><p>${diag ? `Ente 已识别 ${diag.photo_count} 张，其中 ${diag.memory_input_count ?? diag.photo_count} 张有日期、参与回忆计算；${diag.unknown_date_count || 0} 张日期未知，只保留识别。` : "Ente 未提供本轮识别/日期统计，不推断筛选原因。"} 两边的最终未入选都不等同于识别失败。</p><p>当前方案的旧 CLIP 向量覆盖 ${payload.meta.clip?.cached ?? "未知"} / ${payload.meta.dataset.count} 张；向量不齐的候选池使用标签多样性回退。Ente 使用独立的模型空间，不混用向量。</p><p class="mono">候选集 ${escape(payload.meta.dataset.id)}<br>左侧结果 ${escape(payload.local?.id || "无")}<br>Ente 快照 ${escape(payload.record?.id || "无")} · ${escape(payload.record?.created_at || "")}<br>Ente 源码 ${escape(payload.record?.result.provenance.commit || "未知")}</p></details>`;
    }
    container.addEventListener("click", event => {
      const button = event.target.closest("[data-cmp-action]"); if (!button || !container.contains(button) || !data) return;
      const {cmpAction: action, side, id, index} = button.dataset;
      if (action === "play" || action === "photo") {openAlbum(data[side], id, Number(index || 0)); return;}
      if (action === "pair" && id) choosePair(side, id);
      else if (action === "pair") {if (!leftId && !rightId && data.left?.albums.length) choosePair("left", data.left.albums[0].id); mode = "pair";}
      else mode = "overview";
      render();
      container.querySelector(id ? `#cmp-${side}-album` : `[data-cmp-action="${mode}"]`)?.focus();
      if (id) container.scrollIntoView({block: "start"});
    });
    container.addEventListener("change", event => {
      if (event.target.matches("[data-cmp-select]")) {
        if (event.target.dataset.cmpSelect === "left") leftId = event.target.value; else rightId = event.target.value;
        selectionNote = "手动选择的两组相册；标记比较的是这两组的照片，不代表主题相同。";
      } else if (event.target.matches("[data-cmp-filter]")) filter = event.target.value;
      else return;
      const focusId = event.target.id; render(); container.querySelector(`#${focusId}`)?.focus();
    });
    return {update(value) {
      payload = value;
      try {
        data = model(value.local, value.record, value.meta);
        if (!chosen("left")) leftId = ""; if (!chosen("right")) rightId = "";
        render();
      } catch (e) {data = null; container.innerHTML = `<p role="alert" class="notice">${escape(e.message)}</p>`;}
    }, read() {
      return data ? {engine: "independent-album-comparison", mode, dataset_id: payload.meta.dataset.id,
        left: {label: data.left?.label, albums: data.left?.albums, selected: [...(data.left?.ids || [])], result_id: payload.local?.id},
        right: {label: data.right?.label, albums: data.right?.albums, selected: [...(data.right?.ids || [])], snapshot_id: payload.record?.id},
        differences: data.totals, pair: mode === "pair" ? {left: leftId, right: rightId, filter} : null} : {error: "结果不完整或不是同一候选集"};
    }};
  }
  const exports = {difference, closestAlbum, model, coverCard, photoCard, create};
  if (typeof module !== "undefined" && module.exports) module.exports = exports;
  else root.AlbumComparison = exports;
})(globalThis);
