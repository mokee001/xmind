"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const labels = {quality:"画质", aesthetic:"美观", preference:"偏好", memory:"回忆"};
const statusLabels = {selected:"入选",non_photo:"基础非照片过滤",quality:"画质过滤",historical_content:"历史内容复核排除",duplicate:"相似组未保留",theme:"主题过滤",not_selected:"通过过滤，未入选"};
const sourceLabels = {camera:"相机来源",shared:"分享照片／无 EXIF",non_photo:"非照片"};
let meta, result, photos = new Map(), annotations = {}, activeTab = "final", timer, requestVersion = 0, activePhoto, baseline = null, selectedEvent = null, dirty = false;
let collectionResult=null, albumPhotos=new Map(), displayedAlbums=[], activeAlbum=null, albumIndex=0, albumTimer=null;
const hashEngine=()=>location.hash==="#stories"?"stories":location.hash==="#hybrid"?"hybrid":location.hash==="#compare"?"compare":location.hash==="#ente"?"ente":location.hash==="#local"?"photo-wall":"memories";
let collectionEngine=hashEngine(), enteState=null, enteRecord=null, enteTimer=null, albumComparison=null, activeAlbumEngine="photo-wall";
let hybridRecord=null, hybridError="", hybridBusy=false;
let storiesRecord=null, storiesPrevious=null, storiesBefore=false, storiesError="", storiesBusy=false;
let memoriesRecord=null, memoriesError="", memoriesBusy=false;
function setMemorySize(value){
  const select=$("memory-size"),text=String(value);
  if(![...select.options].some(o=>o.value===text))select.add(new Option(`${text} 张`,text));
  select.value=text;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method:"POST", headers:{"Content-Type":"application/json","X-Lab-Token":meta.token}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
function error(message = "") { $("error").textContent=message; $("error").hidden=!message; $("collection-error").textContent=message; $("collection-error").hidden=!message; }
function range(id,label,min,max,step) {
  return `<div class="control"><label for="${id}">${label}</label><output id="${id}-value"></output><input id="${id}" name="${id}" type="range" min="${min}" max="${max}" step="${step}"></div>`;
}
function setConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (key === "weights") { for (const [k,v] of Object.entries(value)) $("w_"+k).value=v; }
    else if ($(key)) $(key).value=value;
  }
  updateOutputs();
}
function updateOutputs() {
  for (const input of document.querySelectorAll('input[type="range"]')) {
    const output=$(input.id+"-value");
    if (output) output.value=input.id.startsWith("w_") ? Math.round(Number(input.value)*100)+"%" :
      Number(input.value).toFixed(input.step === "1" ? 0 : input.id === "clip_distance" ? 3 : 2);
  }
}
function configFromForm() {
  const cfg = {};
  for (const key of Object.keys(meta.defaults)) {
    cfg[key] = key === "weights" ? Object.fromEntries(Object.keys(labels).map(k=>[k, Number($("w_"+k).value)])) :
      ["theme","as_of"].includes(key) ? $(key).value : Number($(key).value);
  }
  return cfg;
}
function markDirty() {
  updateOutputs(); dirty=true; $("profile").value="custom";
  $("run-state").textContent="参数已改变 · 等待重选"; $("run-state").classList.add("dirty"); $("save").disabled=true;
  // Invalidate any in-flight request immediately; it must not clear newer edits.
  requestVersion++;
  clearTimeout(timer);
  if ($("auto-run").checked) timer=setTimeout(()=>run(),350);
}
async function run(config = configFromForm()) {
  clearTimeout(timer); const version=++requestVersion;
  error(); $("run-state").textContent="正在从缓存重选…"; $("save").disabled=true;
  try {
    const [value, albums]=await Promise.all([api("/api/run",{config}),api("/api/collections",{config}).catch(e=>({error:e.message}))]);
    if (version !== requestVersion) return;
    collectionResult=albums.error ? null : albums;
    $("collection-error").textContent=albums.error||""; $("collection-error").hidden=!albums.error;
    dirty=false; result=value; $("settings-fields").disabled=false; render();
  } catch (e) { if (version === requestVersion) {error(e.message); $("run-state").textContent="未完成 · 保留上次结果"; dirty=true;} }
}
function card(id, rank, compact=false) {
  const p=photos.get(id); if (!p) return "";
  const mark=annotations[id]?.mark;
  const diff=baseline ? (result.selected_ids.includes(id) && !baseline.result.selected_ids.includes(id) ? "added" : baseline.result.selected_ids.includes(id) && !result.selected_ids.includes(id) ? "removed" : "") : "";
  const sub=compact ? p.status_label : (p.final_score !== undefined ? `综合 ${p.final_score.toFixed(3)} · ${sourceLabels[p.capture_source] || "来源未知"}` : "Ente 导入结果 · 非本地重算");
  return `<button type="button" class="photo-card ${diff}" data-photo="${esc(id)}" aria-label="查看 ${esc(p.filename)}，${esc(p.status_label)}"><img src="${esc(p.image)}" loading="lazy" alt="${esc(p.filename)}">${rank ? `<span class="rank">${rank}</span>` : ""}${mark ? `<span class="mark-badge">${esc(meta.marks[mark])}</span>` : ""}<div class="caption"><span class="filename">${esc(p.filename)}</span><span class="subline">${esc(sub)}</span></div></button>`;
}
function empty(text) { return `<div class="empty">${esc(text)}</div>`; }
function render() {
  photos = new Map(result.photos.map(p=>[p.id,p]));
  const imported=result.engine === "ente-import";
  $("engine-label").textContent=result.engine_label;
  $("result-title").textContent=imported ? "Ente 的回忆结果" : (meta.themes[result.config.theme] === "全部照片" ? "值得留下的照片" : meta.themes[result.config.theme]+" · 本次精选");
  $("run-state").textContent=imported ? "导入快照 · 只读" : `${result.elapsed_ms} ms · 缓存重选完成`;
  $("run-state").classList.remove("dirty");
  $("settings-fields").disabled=imported; $("save").disabled=imported || dirty;
  const filtered=["non_photo","historical_content","quality","theme"].reduce((s,k)=>s+(result.counts[k]||0),0);
  $("stats").innerHTML=[ [meta.dataset.count,"样本"], [result.selected_ids.length,"入选"], ...(imported ? [[result.events.length,"回忆分组"]] : [[filtered,"过滤"],[result.counts.duplicate||0,"相似组移出"],[result.counts.not_selected||0,"候选未入选"]]) ].map(([n,t])=>`<span class="stat"><strong>${n}</strong>${t}</span>`).join("");
  $("final-grid").innerHTML=result.selected_ids.map((id,i)=>card(id,i+1)).join("") || empty(imported ? "导入包没有自然生成的回忆。不会自动补成我们的选片结果。" : "当前条件下没有照片入选。试着降低画质门槛或切换主题；非照片规则不会被绕过。");
  $("result-description").textContent=imported ? "保留导入照片顺序。详情中的基础评分来自本项目缓存，不是 Ente 评分。" : "点击照片查看得分和处理原因。这里是电脑回放，不代表手机端已运行。";
  $("event-description").textContent=imported ? "按 Ente 导入包保留回忆标题、封面和组内照片顺序。" : "按拍摄时间聚合本次入选照片。不是 Ente 旅行回忆，也不是同一个人的身份聚类。";
  $("events-grid").innerHTML=result.events.map(ev=>`<button class="event-card ${selectedEvent===ev.id?"active":""}" data-event="${esc(ev.id)}"><img src="${esc(photos.get(ev.cover)?.image)}" loading="lazy" alt="${esc(ev.title)}"><div class="caption"><strong>${esc(ev.title)}</strong><span>${ev.photo_ids.length} 张 · 点击展开</span></div></button>`).join("") || empty("没有可展示的分组");
  const ev=result.events.find(e=>e.id===selectedEvent); $("event-photos").innerHTML=ev ? ev.photo_ids.map((id,i)=>card(id,i+1)).join("") : "";
  const currentFilter=$("status-filter").value;
  $("status-filter").innerHTML='<option value="all">全部照片</option>'+Object.entries(result.counts).map(([key,n])=>`<option value="${esc(key)}">${esc(statusLabels[key])} · ${n}</option>`).join("");
  if (result.counts[currentFilter]) $("status-filter").value=currentFilter;
  renderAudit(); renderComparison();
  $("signature").textContent=`数据集 ${meta.dataset.id.slice(0,12)} / 结果 ${result.id}\n`+(imported ? `Ente ${result.provenance.commit} / ${result.provenance.model}` : `特征 ${result.signature.features.slice(0,12)} / 引擎 ${result.signature.engine_revision.slice(0,12)} / 日期 ${result.config.as_of} / 时区 +08:00`);
  $("mode").textContent=result.selection_mode;
  $("warnings").innerHTML=result.warnings.map(w=>`<li>${esc(w)}</li>`).join("");
  renderCollections();
}

function collectionMode(enabled) {
  document.body.classList.toggle("collection-mode",enabled);
  $("toggle-lab").textContent=enabled ? "调整选片策略" : "查看精选相册";
}
async function refreshEnte() {
  clearTimeout(enteTimer);
  $("ente-refresh").disabled=true;
  try {enteState=await api("/api/ente");enteRecord=enteState.record;renderCollections();if(enteState.state==="running"&&collectionEngine!=="photo-wall")enteTimer=setTimeout(refreshEnte,3000);}
  catch(e) {$("ente-progress-message").textContent=e.message;}
  finally {$("ente-refresh").disabled=false;}
}
async function refreshHybrid() {
  try {hybridRecord=(await api("/api/hybrid")).record;hybridError="";}
  catch(e){hybridError=e.message;}
  if(collectionEngine==="hybrid")renderCollections();
}
async function runHybrid(config=configFromForm()) {
  if(hybridBusy)return;
  hybridBusy=true;hybridError="";renderCollections();
  try {hybridRecord=(await api("/api/hybrid-run",{config})).record;await refreshRuns(hybridRecord.id);}
  catch(e){hybridError=e.message;}
  finally {hybridBusy=false;renderCollections();}
}
async function refreshStories() {
  try {const value=await api("/api/stories");storiesRecord=value.record;storiesPrevious=value.previous;storiesError="";}
  catch(e){storiesError=e.message;}
  if(collectionEngine==="stories")renderCollections();
}
async function runStories(config=configFromForm()) {
  if(storiesBusy)return;
  storiesBusy=true;storiesError="";renderCollections();
  try {storiesRecord=(await api("/api/stories-run",{config})).record;storiesBefore=false;await refreshStories();await refreshRuns(storiesRecord.id);}
  catch(e){storiesError=e.message;}
  finally {storiesBusy=false;renderCollections();}
}
async function refreshMemories(){
  try{memoriesRecord=(await api("/api/memories")).record;memoriesError="";if(memoriesRecord)setMemorySize(memoriesRecord.result.album_settings.max_photos);}
  catch(e){memoriesError=e.message;}
  if(collectionEngine==="memories")renderCollections();
}
async function runMemories(config=configFromForm(),options={max_photos:Number($("memory-size").value),max_albums:memoriesRecord?.result.album_settings.max_albums??18}){
  if(memoriesBusy)return;
  memoriesBusy=true;memoriesError="";renderCollections();
  try{memoriesRecord=(await api("/api/memories-run",{config,album_settings:options})).record;await refreshRuns(memoriesRecord.id);}
  catch(e){memoriesError=e.message;}
  finally{memoriesBusy=false;renderCollections();}
}
function albumCards(albums, photoMap) {
  return albums.map(album=>`<button type="button" class="collection-card" data-album="${esc(album.id)}" aria-label="打开${esc(album.title)}，${album.photo_ids.length}张照片"><img src="${esc(photoMap.get(album.cover)?.image)}" loading="lazy" alt="${esc(album.title)}封面"><span class="collection-shade"></span><span class="collection-count">${album.photo_ids.length} 张照片</span><span class="collection-caption"><strong>${esc(album.title)}</strong><span>${esc(album.subtitle||"Ente 回忆")}</span></span><span class="collection-play" aria-hidden="true">▶</span></button>`).join("");
}
function mergedEnteAlbums(record) {
  const themes=record.ente_recognition;
  const people=record.ente_people;
  if(!themes&&!people)return null;
  const overview=people?.albums.find(a=>a.kind==="all_faces");
  const albums=overview ? [{...overview,title:"人物相册",faces:undefined,
    subtitle:"人物照片 · 汇总展示",description:"所有检测到人脸的照片汇总成一个相册，不按人脸簇拆分，也不表示这些照片属于同一个人。"},...(themes?.albums||[])] : (themes?.albums||[]);
  const used=new Set(albums.flatMap(a=>a.photo_ids));
  const photos=[...new Map([...(themes?.photos||[]),...(people?.photos||[])].filter(p=>used.has(p.id)).map(p=>[p.id,p])).values()];
  return {albums,photos};
}
function renderCollections() {
  if($("album-dialog").open)$("album-dialog").close();
  const comparing=collectionEngine==="compare";
  const hybrid=collectionEngine==="hybrid";
  const stories=collectionEngine==="stories";
  const memories=collectionEngine==="memories";
  $("engine-memories").classList.toggle("active",memories);$("engine-memories").setAttribute("aria-pressed",String(memories));
  $("memories-status").hidden=!memories;document.body.classList.toggle("memories-mode",memories);
  if(!memories)$("legacy-engines").open=true;
  $("engine-stories").classList.toggle("active",stories);$("engine-stories").setAttribute("aria-pressed",String(stories));
  $("stories-status").hidden=!stories;$("story-groups").hidden=!stories;
  $("engine-hybrid").classList.toggle("active",hybrid);$("engine-hybrid").setAttribute("aria-pressed",String(hybrid));
  $("hybrid-status").hidden=!hybrid;
  $("album-comparison").hidden=!comparing;$("collection-grid").hidden=comparing||stories;$("collection-notes").hidden=comparing;
  $("collection-title").textContent=comparing?"两套能力，相册结果对照":"为你精选";
  $("engine-compare").classList.toggle("active",comparing);$("engine-compare").setAttribute("aria-pressed",String(comparing));
  if(memories){
    clearTimeout(enteTimer);$("ente-tools").hidden=true;
    for(const id of ["engine-local","engine-ente"]){$(id).classList.remove("active");$(id).setAttribute("aria-pressed","false");}
    $("collection-title").textContent="回忆精选";
    const source=memoriesRecord?.result.collection_snapshot;
    displayedAlbums=source?.albums||[];albumPhotos=new Map((source?.photos||[]).map(p=>[p.id,p]));
    $("collection-summary").textContent=MemoriesView.summary(source);
    $("collection-error").textContent=memoriesError;$("collection-error").hidden=!memoriesError;
    $("memories-run").disabled=memoriesBusy||!meta;$("memory-size").disabled=memoriesBusy;
    $("memories-message").textContent=memoriesBusy?"正在本地重新成册，保留上次结果…":source?`${displayedAlbums.length?`本次每册 ${Math.min(...displayedAlbums.map(a=>a.photo_ids.length))}–${Math.max(...displayedAlbums.map(a=>a.photo_ids.length))} 张`:"当前条件下没有足够照片成册"} · 调整上限后点击重新生成 · 旧结果保留`:"尚未生成这批照片的统一精选";
    $("collection-grid").innerHTML=albumCards(displayedAlbums,albumPhotos)||empty("没有达到主题及成册条件的相册，不用无关照片补齐。");
    $("collection-source").textContent=MemoriesView.notes(source,memoriesRecord?.id);$("collection-local-notes").hidden=true;
    return;
  }
  if(stories){
    clearTimeout(enteTimer);$("ente-tools").hidden=true;
    for(const id of ["engine-local","engine-ente"]){$(id).classList.remove("active");$(id).setAttribute("aria-pressed","false");}
    $("collection-title").textContent="人物与主题时光";
    const viewing=storiesBefore&&storiesPrevious?storiesPrevious:storiesRecord;
    const source=viewing?.result.collection_snapshot;
    $("stories-before").disabled=!storiesPrevious||storiesBusy;
    $("stories-before").setAttribute("aria-pressed",String(storiesBefore));
    $("stories-after").setAttribute("aria-pressed",String(!storiesBefore));
    $("stories-change").textContent=StoryAlbums.comparison(storiesPrevious?.result.collection_snapshot,storiesRecord?.result.collection_snapshot,storiesBefore);
    displayedAlbums=source?.albums||[];albumPhotos=new Map((source?.photos||[]).map(p=>[p.id,p]));
    $("collection-summary").textContent=source?`${displayedAlbums.length} 个候选相册 · ${albumPhotos.size} 张不同照片 · ${meta.dataset.count} 张原始候选`:"新聚合尚未生成，不用旧主题相册代替";
    $("collection-error").textContent=storiesError;$("collection-error").hidden=!storiesError;
    $("stories-run").disabled=storiesBusy||!meta;
    $("stories-message").textContent=storiesBusy?"正在复用本机识别缓存生成并保存，不上传照片…":source?`${meta.dataset.count} 张均已识别，${source.eligible_count} 张通过原有过滤；本页每组精选 3–12 张、每类最多 10 组，不是全候选相册。自动分组不等于确认身份或真实旅程。调参后点击按钮另存新结果，旧方案不变。`:"需要本批完整 Ente 识别缓存，不下载或上传原图来补齐。";
    $("story-groups").innerHTML=StoryAlbums.sections(source,albums=>albumCards(albums,albumPhotos));
    $("collection-source").textContent=StoryAlbums.notes(source,viewing?.id);
    $("collection-local-notes").hidden=true;
    return;
  }
  if(hybrid){
    clearTimeout(enteTimer);$("ente-tools").hidden=true;
    for(const id of ["engine-local","engine-ente"]){$(id).classList.remove("active");$(id).setAttribute("aria-pressed","false");}
    $("collection-title").textContent="Ente 识别＋我的成册";
    const source=hybridRecord?.result.collection_snapshot;
    displayedAlbums=source?.albums||[];albumPhotos=new Map((source?.photos||[]).map(p=>[p.id,p]));
    $("collection-summary").textContent=source?`${displayedAlbums.length} 个精选集 · ${albumPhotos.size} 张不同照片 · ${meta.dataset.count} 张候选` : "组合方案尚未生成，不使用旧结果代替";
    $("collection-error").textContent=hybridError;$("collection-error").hidden=!hybridError;
    $("hybrid-run").disabled=hybridBusy||!meta;
    $("hybrid-message").textContent=hybridBusy?"正在用完整 Ente 识别特征重新成册，不上传照片…":source?`全部 ${source.diagnostics.recognized_count} 张已完成识别，${source.eligible_count} 张通过原有过滤。本页是已保存的组合方案，不是 Ente 原版回忆；调参后需点击下方按钮另存新结果。`:"需要本批已完成的 Ente 特征；不会把它的 18 张自然回忆重新分组。";
    $("collection-grid").innerHTML=albumCards(displayedAlbums,albumPhotos)||empty(source?"当前条件下没有足够照片成册，不强行补齐。":"请生成组合方案后查看。");
    $("collection-source").textContent=source?`${source.provenance.note} 内容相似度阈值 ${source.provenance.clip_threshold}；原图未知日期也可参与主题相册。快照 ${hybridRecord.id}。`:"";
    $("collection-local-notes").hidden=false;
    return;
  }
  if(comparing){
    for(const id of ["engine-local","engine-ente"]){$(id).classList.remove("active");$(id).setAttribute("aria-pressed","false");}
    $("ente-tools").hidden=true;
    $("collection-summary").textContent=`${meta.dataset.count} 张相同候选 · 左右独立生成 · 点击封面逐张对照`;
    albumComparison?.update({local:collectionResult,record:enteRecord,meta,state:enteState});
    return;
  }
  const imported=collectionEngine === "ente";
  const enteResult=enteRecord?.result;
  const recognition=imported && $("ente-output").value==="recognition";
  $("ente-output-controls").hidden=!imported;
  $("ente-tools").hidden=!imported;
  $("collection-error").hidden=imported||!$("collection-error").textContent;
  $("engine-local").classList.toggle("active",!imported);$("engine-local").setAttribute("aria-pressed",String(!imported));
  $("engine-ente").classList.toggle("active",imported);$("engine-ente").setAttribute("aria-pressed",String(imported));
  $("ente-progress").hidden=!imported;
  $("ente-run").disabled=!enteState?.can_run||enteState?.state==="running";
  const activeStatus=["running","failed"].includes(enteState?.state);
  $("ente-stage").textContent=enteResult&&!activeStatus ? (recognition ? "Ente 识别相册 · 不限张数" : `${enteRecord.name} · ${enteResult.selection_mode}`) : (enteState?.stage||"Ente 尚未准备好");
  $("ente-progress-message").textContent=activeStatus ? `${enteState.message}${enteResult?" 下方保留的是上次成功的快照。":""}` : (enteResult ? (recognition ? "人物照片统一成册，与其他主题一起展示；点击封面查看照片。" : `保留 Ente 分组及组内顺序。源码版本 ${enteResult.provenance.commit.slice(0,12)}。`) : (enteState?.message||"尚无本批照片的原版结果，不使用当前方案代替。"));
  $("ente-capability").textContent=enteResult ? "已有独立实跑结果 · 非完整手机 App" : (enteState?.stage||"等待本机引擎准备");
  const d=enteResult?.ente_diagnostics;
  $("ente-diagnostics").hidden=!imported||!d;
  if(imported&&d){
    const n=v=>Number.isFinite(Number(v))?Number(v):"—";
    $("ente-diagnostics").innerHTML=`<h3>识别完成，不等于满足成册条件</h3><p>本机源码回放，不是完整 Ente 手机 App。保留原版门槛；未套用当前方案的照片过滤或聚合。</p><div class="ente-metrics"><span><strong>${n(d.photo_count)}</strong>张照片已识别</span><span><strong>${n(d.face_count)}</strong>次人脸检测（非人数）</span><span><strong>${n(d.cluster_count)}</strong>个人脸分组（非确认身份）</span><span><strong>${n(d.files_with_city)}</strong>张照片有城市索引</span></div><h4>内容主题召回 · 不是成品相册</h4><table><thead><tr><th>主题</th><th>超过相似度 ${n(d.clip_threshold)}</th><th>原版起组条件</th></tr></thead><tbody>${(d.themes||[]).slice(0,6).map(t=>`<tr><td>${esc(t.title)}</td><td>${n(t.matching_count)} 张（有日期 ${n(t.memory_matching_count??t.matching_count)}）</td><td>至少 ${n(d.clip_minimum_candidates)} 张</td></tr>`).join("")}</tbody></table><p>最大人脸组 ${n(d.largest_cluster_faces)} 张脸；未命名人物回忆需要至少 ${n(d.unnamed_minimum_nonconsecutive_days)} 个非连续日期，并满足其他条件。当前历史回忆日期窗口 ${n(d.historical_window_files)} 张、近期窗口 ${n(d.recent_window_files)} 张。</p><p class="hint">日期按来源区分：旧样本为文件名日期，新相簿优先 EXIF；缺失时区按东八区解释。相似度不是概率；这些数值不证明识别正确，也不能代表完整相册或手机端效果。原版包含随机轮换，因此重跑不保证逐张一致。</p>`;
  }
  if(imported&&d) $("ente-diagnostics").insertAdjacentHTML("beforeend",`<p>本轮共有 ${Number(d.unknown_date_count||0)} 张缺少可靠日期：仍参与主题及人脸识别，不进入原版回忆计算。回忆计算输入 ${Number(d.memory_input_count??d.photo_count)} 张。</p>`);
  if(imported&&d&&recognition) $("ente-diagnostics").innerHTML=`<details><summary>识别依据 · ${d.photo_count} 张已分析 · 相似度阈值 ${d.clip_threshold}</summary><p>当前展示主题识别的全部匹配照片，不要求至少 10 张，也不经过回忆的日期、人物条件或额外选片。相似度不是正确率。原版回忆可在上方切换查看。</p><p>其中 ${Number(d.unknown_date_count||0)} 张缺少可靠日期：保留识别结果，但不进入原版回忆计算。</p></details>`;
  $("collection-local-notes").hidden=imported;
  const source=imported ? (enteResult ? (recognition ? mergedEnteAlbums(enteResult) : {albums:enteResult.events,photos:enteResult.photos.filter(p=>enteResult.selected_ids.includes(p.id))}) : null) : collectionResult;
  displayedAlbums=source?.albums||[]; albumPhotos=new Map((source?.photos||[]).map(p=>[p.id,p]));
  $("collection-summary").textContent=source ? `${displayedAlbums.length} 个${recognition?"相册":"精选集"} · ${albumPhotos.size} 张${recognition?"不同":""}照片${imported?" · Ente 独立结果":" · 已自动整理"}` : (imported?"Ente · 等待真实结果":"尚未生成精选集");
  $("collection-source").textContent=recognition ? "人物相册汇总含人脸的照片，不区分身份；其余相册来自 Ente 主题匹配。不限最低张数，不代表原版回忆相册。" : imported ? (enteResult ? `Ente 结果快照 · ${enteResult.selection_mode}。${enteResult.provenance.platform} / ${enteResult.provenance.model}。来源由导出方记录，不经过本项目重排。` : "原版未产出前不展示模拟相册。") : collectionResult?.provenance.note||"需要本机内容识别索引，未用模拟主题替代。";
  $("collection-grid").innerHTML=albumCards(displayedAlbums,albumPhotos) || empty(recognition ? (enteResult?.ente_recognition ? "没有照片达到主题识别阈值。" : "请点击本机重跑 Ente，生成可查看的主题识别照片。") : imported ? (enteResult?"原版核心算法本轮未生成精选相簿（0 组）。完整 Ente App 的最终效果尚未验证。":"Ente 的真实结果会显示在这里，当前方案仍保留在左侧入口。") : "当前条件下没有足够照片组成精选集。可以返回实验台查看过滤原因。");
}
function stopAlbumPlayback() {clearInterval(albumTimer);albumTimer=null;$("album-play").textContent="播放精选";}
function showAlbumPhoto(index) {
  if(!activeAlbum)return;
  albumIndex=Math.max(0,Math.min(index,activeAlbum.photo_ids.length-1));
  const p=albumPhotos.get(activeAlbum.photo_ids[albumIndex]);
  $("album-face-overlay").innerHTML="";
  $("album-image").onload=drawAlbumFaces;
  $("album-image").src=p.image; $("album-image").alt=p.filename;
  $("album-counter").textContent=`${albumIndex+1} / ${activeAlbum.photo_ids.length}`;
  $("album-date").textContent=p.taken_at ? new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",timeZone:"Asia/Shanghai"}).format(new Date(p.taken_at*1000)) : "";
  if(!p.taken_at)$("album-date").textContent="日期未知";
  if(activeAlbumEngine==="ente"&&!p.date_source){const sampleDate=p.filename.match(/^(20\d\d-\d\d-\d\d)__/);$("album-date").textContent=sampleDate?`${sampleDate[1]} · 样本日期`:"日期未核实";}
  $("album-prev").disabled=albumIndex===0;$("album-next").disabled=albumIndex===activeAlbum.photo_ids.length-1;
  $("album-strip").innerHTML=activeAlbum.photo_ids.map((id,i)=>`<button class="${i===albumIndex?"active":""}" data-album-index="${i}" aria-label="第${i+1}张" aria-pressed="${i===albumIndex}"><img src="${esc(albumPhotos.get(id)?.image)}" alt="" loading="lazy"></button>`).join("");
  const dateSource={filename_date:"日期来自样本文件名（仅到日）",filename_datetime:"日期来自文件名时间，按东八区解释",exif_original_offset:"日期来自 EXIF 拍摄时间及原时区",exif_original_assumed_utc8:"日期来自 EXIF 拍摄时间，缺失时区按东八区解释",unknown:"没有可靠拍摄日期"}[p.date_source]||"日期来自旧缓存，未核实拍摄时间";
  $("album-metadata").textContent=activeAlbum.faces ? `绿色框标出本组在这张照片中的 ${activeAlbum.faces[p.id].length} 张脸；身份尚未确认。${dateSource}` : activeAlbum.scores ? `Ente 主题相似度 ${activeAlbum.scores[p.id].toFixed(4)} · 不是概率或画质分数 · ${dateSource}` : activeAlbumEngine==="ente" ? `照片来自 Ente 结果包 · ${dateSource}` : `${dateSource} · 本机 Vision 检测 ${p.face_count??0} 张人脸（不代表身份识别）。`;
  if(activeAlbumEngine==="hybrid"){
    const evidence=p.content_evidence;
    $("album-metadata").textContent=`${dateSource} · Ente 检测 ${evidence?.face_count??0} 张脸（不代表同一身份）。主题匹配：${evidence?.matches.map(m=>`${m.type} ${m.score.toFixed(3)}`).join("、")||"未达到映射主题阈值，可由日期相册入选"}。相似度不是概率；画质、去重和成册沿用本项目规则。`;
  }
  if(activeAlbumEngine==="stories"){
    const other=(storiesBefore?storiesRecord:storiesPrevious)?.result.collection_snapshot?.albums.find(a=>a.id===activeAlbum.id);
    $("album-metadata").textContent=`${dateSource}。${activeAlbum.faces?"绿色框为本组目标人脸，身份待确认。":""}${StoryAlbums.facts(activeAlbum)} ${StoryAlbums.albumChange(activeAlbum,other,storiesBefore)}`;
  }
  if(activeAlbumEngine==="memories")$("album-metadata").textContent=`${dateSource}。${MemoriesView.facts(activeAlbum,p)}`;
  requestAnimationFrame(drawAlbumFaces);
}
function drawAlbumFaces() {
  const overlay=$("album-face-overlay"), img=$("album-image");
  const faces=activeAlbum?.faces?.[activeAlbum.photo_ids[albumIndex]]||[];
  overlay.toggleAttribute("hidden",!faces.length);
  if(!faces.length||!img.complete||!img.naturalWidth||!img.clientWidth)return;
  const width=img.clientWidth,height=img.clientHeight;
  const scale=Math.min(width/img.naturalWidth,height/img.naturalHeight);
  const w=img.naturalWidth*scale,h=img.naturalHeight*scale,x=(width-w)/2,y=(height-h)/2;
  overlay.setAttribute("viewBox",`0 0 ${width} ${height}`);
  overlay.innerHTML=faces.map(f=>{const b=f.box;return `<rect x="${x+b[0]*w}" y="${y+b[1]*h}" width="${(b[2]-b[0])*w}" height="${(b[3]-b[1])*h}" fill="none" stroke="#7dffb4" stroke-width="3"/>`;}).join("");
}
function openAlbum(id) {
  openAlbumSource({albums:displayedAlbums,photos:[...albumPhotos.values()],engine:collectionEngine},id);
}
function openAlbumSource(source,id,index=0) {
  activeAlbum=source.albums.find(a=>a.id===id); if(!activeAlbum)return;
  albumPhotos=new Map(source.photos.map(p=>[p.id,p]));activeAlbumEngine=source.engine;
  stopAlbumPlayback(); $("album-title").textContent=activeAlbum.title;$("album-subtitle").textContent=activeAlbum.subtitle||"Ente 回忆";
  $("album-description").textContent=activeAlbum.description||"保留导入的原始照片顺序。";
  showAlbumPhoto(index);$("album-dialog").showModal();requestAnimationFrame(drawAlbumFaces);
}
function toggleAlbumPlayback() {
  if(albumTimer){stopAlbumPlayback();return;}
  if(!activeAlbum)return;
  if(albumIndex===activeAlbum.photo_ids.length-1)showAlbumPhoto(0);
  $("album-play").textContent="暂停播放";
  albumTimer=setInterval(()=>{if(albumIndex>=activeAlbum.photo_ids.length-1){stopAlbumPlayback();return;}showAlbumPhoto(albumIndex+1);},3200);
}
function renderAudit() {
  if (!result) return;
  const stage=$("status-filter").value, query=$("search").value.trim().toLowerCase();
  const list=result.photos.filter(p=>(stage==="all" || p.status===stage) && (!$("marked-only").checked || annotations[p.id]?.mark) && (!query || `${p.filename} ${(p.tags||[]).join(" ")}`.toLowerCase().includes(query)));
  $("audit-count").textContent=`${list.length} 张`;
  $("audit-grid").innerHTML=list.map(p=>card(p.id,null,true)).join("") || empty("没有匹配的照片");
}
function renderComparison() {
  $("comparison").hidden=!baseline;
  if (!baseline) return;
  const before=new Set(baseline.result.selected_ids), after=new Set(result.selected_ids);
  const added=[...after].filter(id=>!before.has(id)).length, removed=[...before].filter(id=>!after.has(id)).length;
  $("comparison").innerHTML=`<p>对照「${esc(baseline.name)}」：新增 ${added} 张，移出 ${removed} 张，共同 ${[...after].filter(id=>before.has(id)).length} 张。</p><span>绿框为新增；“全部与淘汰”中红框为移出。结果相同也是有效结果，不人为制造差异。</span><button id="clear-comparison" class="secondary">关闭对比</button>`;
  $("clear-comparison").onclick=()=>{baseline=null;render();};
}
function switchTab(tab) {
  activeTab=tab;
  for (const button of document.querySelectorAll("[data-tab]")) {const active=button.dataset.tab===tab;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));}
  for (const name of ["final","events","audit","ente"]) $("view-"+name).hidden=name!==tab;
}
function detail(id) {
  const p=photos.get(id); if (!p) return; activePhoto=id;
  $("detail-name").textContent=p.filename; $("detail-image").src=p.image; $("detail-image").alt=p.filename;
  $("detail-status").textContent=p.status_label; $("detail-reason").textContent=p.reason;
  $("show-representative").hidden=!p.representative;
  $("show-representative").onclick=()=>detail(p.representative);
  const metrics={"来源":sourceLabels[p.capture_source]||"未知", "缓存画质":p.quality?.toFixed(3),"缓存美观":p.aesthetic?.toFixed(3),"回忆分":p.memory_score?.toFixed(3),"最终综合分":p.final_score?.toFixed(4)};
  $("detail-metrics").innerHTML=Object.entries(metrics).filter(([,v])=>v!==undefined).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("detail-tags").innerHTML=(p.tags||[]).map(t=>`<span>${esc(t)}</span>`).join("");
  $("detail-score").innerHTML=p.score_parts ? '<p class="hint">归一化权重后的得分贡献；多样性是挑选约束，不包含在此综合分内。</p>'+Object.entries(p.score_parts).map(([k,v])=>`<div class="score-row"><span>${labels[k]}</span><span>${v.toFixed(4)}</span></div>`).join("")+`<p class="hint">${esc((p.memory_reasons||[]).join(" · "))}</p>` : "";
  $("annotation-mark").value=annotations[id]?.mark||""; $("annotation-note").value=annotations[id]?.note||""; $("annotation-state").textContent="";
  if (!$("photo-dialog").open) $("photo-dialog").showModal();
}
async function refreshRuns(selected="") {
  const runs=await api("/api/runs"); $("saved-count").textContent=runs.length;
  $("saved-list").innerHTML='<option value="">选择方案…</option>'+runs.map(r=>`<option value="${esc(r.id)}">${esc(r.name)} · ${r.count} 张${r.engine==="ente-import"?" · Ente":""}</option>`).join("");
  $("saved-list").value=selected; savedChanged();
}
function savedChanged() {
  const id=$("saved-list").value;
  for (const k of ["load","restore","compare"]) $(k).disabled=!id;
  $("export-run").hidden=!id; if (id) $("export-run").href="/api/export/"+id;
}
async function savedAction(action) {
  try {
    const record=await api("/api/runs/"+$("saved-list").value);
    if(record.result.engine==="photo-wall-memories"){
      if(action==="compare")throw new Error("统一精选是主题相册成员并集，不与全局 Top N 混比。请选择查看快照。");
      clearTimeout(timer);clearTimeout(enteTimer);requestVersion++;memoriesRecord=record;memoriesError="";
      collectionEngine="memories";history.replaceState(null,"","#memories");setConfig(record.result.config);
      setMemorySize(record.result.album_settings.max_photos);collectionMode(true);renderCollections();
      if(action==="restore")await runMemories(record.result.config,record.result.album_settings);
      return;
    }
    if(record.result.engine==="photo-wall-stories"){
      if(action==="compare")throw new Error("新聚合统计三类相册成员并集，不能与全局 Top N 混比。请用“查看快照”打开完整相册。");
      clearTimeout(timer);clearTimeout(enteTimer);requestVersion++;
      storiesRecord=record;storiesBefore=false;storiesError="";collectionEngine="stories";history.replaceState(null,"","#stories");
      setConfig(record.result.config);collectionMode(true);renderCollections();
      if(action==="restore")await runStories(record.result.config);
      return;
    }
    if(record.result.engine==="photo-wall-ente-hybrid"&&action==="compare")throw new Error("组合方案统计的是全部相册成员，不能与此处的全局 Top N 混比。请选择“查看快照”打开完整组合相册。");
    if(record.result.engine==="photo-wall-ente-hybrid"&&action!=="compare"){
      clearTimeout(timer);clearTimeout(enteTimer);requestVersion++;
      hybridRecord=record;hybridError="";collectionEngine="hybrid";history.replaceState(null,"","#hybrid");
      setConfig(record.result.config);collectionMode(true);renderCollections();
      if(action==="restore")await runHybrid(record.result.config);
      return;
    }
    if (action==="compare") {baseline=record; render(); return;}
    if (action==="restore") {
      if (!record.result.config) throw new Error("Ente 导入快照没有本项目参数；请恢复默认策略，或导入新的 Ente 实跑结果。");
      setConfig(record.result.config); await run(record.result.config); return;
    }
    clearTimeout(timer); clearTimeout(enteTimer); requestVersion++; result=record.result; dirty=false; selectedEvent=null;
    if(result.engine==="ente-import"){enteRecord=record;collectionEngine="ente";}else{collectionResult=record.result.collection_snapshot||null;collectionEngine="photo-wall";}
    if (result.config) setConfig(result.config);
    render(); $("result-title").textContent=record.name+" · 已保存快照";
    $("run-state").textContent="历史结果 · 未重新计算";
    if (result.config) $("settings-fields").disabled=false;
    switchTab("final");
  } catch(e) {error(e.message);}
}
async function init() {
  try {
    meta=await api("/api/bootstrap"); annotations=meta.annotations;
    albumComparison=AlbumComparison.create($("album-comparison"),openAlbumSource);
    $("dataset-label").textContent=`${meta.dataset.count} 张 · ${meta.dataset.name}`;
    $("weights").innerHTML=Object.entries(labels).map(([k,label])=>range("w_"+k,label,0,1,.01)).join("");
    $("advanced").innerHTML=range("semantic_diversity","内容多样性",0,1,.01)+range("event_diversity","事件多样性",0,1,.01)+range("event_gap_hours","事件间隔（小时）",.25,48,.25)+range("clip_distance","CLIP 去重距离",0,.2,.001)+range("hash_distance","dHash 去重距离",0,20,1);
    $("theme").innerHTML=Object.entries(meta.themes).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("");
    const profileLabels={default:"默认均衡",travel:"旅行权重",pet:"宠物权重",family:"家庭权重"};
    $("profile").innerHTML=Object.keys(meta.profiles).map(k=>`<option value="${esc(k)}">${esc(profileLabels[k]||k)}</option>`).join("")+'<option value="custom">自定义</option>';
    $("annotation-mark").innerHTML='<option value="">未标记</option>'+Object.entries(meta.marks).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("");
    setConfig(meta.defaults); $("settings-fields").disabled=false;
    $("ente-schema").textContent=JSON.stringify({schema_version:1,engine:"ente",dataset_id:meta.dataset.id,provenance:{commit:"完整40位Git提交哈希",app_version:"实跑版本",platform:"ios",generated_at:"ISO时间",model:"实际使用的模型及版本",exporter_version:"导出器版本",mode:"natural"},memories:[{id:"原版回忆ID",title:"原版标题",photo_sha256:["清单中的原文件SHA256"],cover_sha256:"本组封面SHA256"}]},null,2);
    $("settings").addEventListener("submit",e=>{e.preventDefault();run();});
    $("settings").addEventListener("input",e=>{if(e.target.id!=="profile" && e.target.id!=="auto-run") markDirty();});
    $("auto-run").onchange=()=>{if($("auto-run").checked && dirty) run(); else clearTimeout(timer);};
    $("profile").onchange=()=>{const name=$("profile").value,p=meta.profiles[name];if(!p)return;setConfig({...configFromForm(),...p});markDirty();$("profile").value=name;};
    $("reset").onclick=()=>{setConfig(meta.defaults);$("profile").value="default";$("settings-fields").disabled=false;baseline=null;run(meta.defaults);};
    document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
    document.addEventListener("click",e=>{const photo=e.target.closest("[data-photo]");if(photo)detail(photo.dataset.photo);const event=e.target.closest("[data-event]");if(event){selectedEvent=event.dataset.event;render();}const album=e.target.closest("[data-album]");if(album)openAlbum(album.dataset.album);const thumb=e.target.closest("[data-album-index]");if(thumb){stopAlbumPlayback();showAlbumPhoto(Number(thumb.dataset.albumIndex));}});
    $("toggle-lab").onclick=()=>collectionMode(!document.body.classList.contains("collection-mode"));
    $("engine-local").onclick=()=>{collectionEngine="photo-wall";clearTimeout(enteTimer);history.replaceState(null,"","#local");renderCollections();};
    $("engine-ente").onclick=()=>{collectionEngine="ente";history.replaceState(null,"","#ente");renderCollections();refreshEnte();};
    $("engine-hybrid").onclick=()=>{collectionEngine="hybrid";history.replaceState(null,"","#hybrid");renderCollections();refreshHybrid();};
    $("hybrid-run").onclick=()=>runHybrid();
    $("engine-stories").onclick=()=>{collectionEngine="stories";history.replaceState(null,"","#stories");renderCollections();refreshStories();};
    $("stories-run").onclick=()=>runStories();
    $("stories-before").onclick=()=>{storiesBefore=true;renderCollections();};
    $("stories-after").onclick=()=>{storiesBefore=false;renderCollections();};
    $("engine-memories").onclick=()=>{collectionEngine="memories";history.replaceState(null,"","#memories");$("legacy-engines").open=false;renderCollections();refreshMemories();};
    $("memories-run").onclick=()=>runMemories();
    $("memory-size").onchange=()=>{$("memories-message").textContent=`每册上限已设为 ${$("memory-size").value} 张；下方仍是上次快照，点击重新生成后生效。`;};
    $("engine-compare").onclick=()=>{collectionEngine="compare";history.replaceState(null,"","#compare");renderCollections();refreshEnte();};
    window.addEventListener("hashchange",()=>{collectionEngine=hashEngine();renderCollections();if(collectionEngine==="memories")refreshMemories();else if(collectionEngine==="stories")refreshStories();else if(collectionEngine==="hybrid")refreshHybrid();else if(collectionEngine!=="photo-wall")refreshEnte();else clearTimeout(enteTimer);});
    $("ente-output").onchange=renderCollections;
    window.addEventListener("resize",drawAlbumFaces);
    $("ente-refresh").onclick=refreshEnte;
    $("ente-run").onclick=async()=>{try{$("ente-run").disabled=true;enteState=await api("/api/ente-run",{});renderCollections();await refreshEnte();}catch(e){$("ente-progress-message").textContent=e.message;$("ente-run").disabled=!enteState?.can_run;}};
    $("album-close").onclick=()=>$("album-dialog").close();$("album-dialog").addEventListener("close",stopAlbumPlayback);
    $("album-prev").onclick=()=>{stopAlbumPlayback();showAlbumPhoto(albumIndex-1);};$("album-next").onclick=()=>{stopAlbumPlayback();showAlbumPhoto(albumIndex+1);};$("album-play").onclick=toggleAlbumPlayback;
    $("album-dialog").addEventListener("keydown",e=>{if(["ArrowLeft","ArrowRight"].includes(e.key)){e.preventDefault();stopAlbumPlayback();showAlbumPhoto(albumIndex+(e.key==="ArrowLeft"?-1:1));}});
    document.addEventListener("visibilitychange",()=>{if(document.hidden)stopAlbumPlayback();});
    $("clean-view").onchange=()=>$("final-grid").classList.toggle("clean",$("clean-view").checked);
    $("status-filter").onchange=renderAudit;$("search").oninput=renderAudit;$("marked-only").onchange=renderAudit;
    $("close-dialog").onclick=()=>$("photo-dialog").close();
    $("save-annotation").onclick=async()=>{const id=activePhoto;try{const value=await api("/api/annotations",{asset_id:id,mark:$("annotation-mark").value,note:$("annotation-note").value});annotations[id]=value;render();$("annotation-state").textContent="已保存到本机";}catch(e){$("annotation-state").textContent=e.message;}};
    $("save").onclick=async()=>{try{if(dirty)throw new Error("请先完成重选");const record=await api("/api/save",{name:$("save-name").value||"方案 · "+new Date().toLocaleString("zh-CN"),config:result.config,expected_id:result.id,collection_id:collectionResult?.id});await refreshRuns(record.id);$("run-state").textContent="方案已保存";}catch(e){error(e.message);}};
    $("saved-list").onchange=savedChanged; for(const action of ["load","restore","compare"])$(action).onclick=()=>savedAction(action);
    $("ente-import").onclick=async()=>{const file=$("ente-file").files[0];try{if(!file)throw new Error("请选择 Ente 开发版结果 JSON");if(file.size>1900000)throw new Error("结果包需小于 1.9 MB，不应包含原图或向量");const data=JSON.parse(await file.text());const record=await api("/api/ente-import",{export:data,name:"Ente · "+file.name});clearTimeout(timer);clearTimeout(enteTimer);requestVersion++;result=record.result;enteRecord=record;collectionEngine="ente";dirty=false;selectedEvent=null;await refreshRuns(record.id);render();switchTab("events");$("ente-status").textContent="结果已导入并保存";}catch(e){$("ente-status").textContent=e.message;}};
    await refreshRuns(); await run(meta.defaults); await refreshEnte(); await refreshHybrid(); await refreshStories(); await refreshMemories();
    registerTools();
  } catch(e) {error(e.message);$("run-state").textContent="初始化失败";}
}
function registerTools() {
  const ctx=document.modelContext; if(!ctx?.registerTool)return;
  const lifecycle=new AbortController(); window.addEventListener("pagehide",()=>lifecycle.abort(),{once:true});
  const tools=[{name:"read_selection_result",description:"读取当前可见选片结果及引擎来源，不运行新实验。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>{
    if(document.body.classList.contains("collection-mode")&&collectionEngine==="compare")return albumComparison.read();
    if(document.body.classList.contains("collection-mode")&&collectionEngine==="memories")return{engine:"photo-wall-memories",snapshot_id:memoriesRecord?.id,albums:displayedAlbums,selected:[...albumPhotos.keys()],provenance:memoriesRecord?.result.provenance,diagnostics:memoriesRecord?.result.collection_snapshot.diagnostics};
    if(document.body.classList.contains("collection-mode")&&collectionEngine==="stories")return{engine:"photo-wall-stories",snapshot_id:storiesRecord?.id,albums:displayedAlbums,selected:[...albumPhotos.keys()],provenance:storiesRecord?.result.provenance,diagnostics:storiesRecord?.result.collection_snapshot.diagnostics};
    if(document.body.classList.contains("collection-mode")&&collectionEngine==="hybrid")return{engine:"photo-wall-ente-hybrid",snapshot_id:hybridRecord?.id,albums:displayedAlbums,selected:[...albumPhotos.keys()],provenance:hybridRecord?.result.provenance};
    if(document.body.classList.contains("collection-mode"))return{engine:collectionEngine==="ente"?({recognition:"ente-recognition-albums",memories:"ente"}[$("ente-output").value]):collectionEngine,display_mode:$("ente-output").value,state:collectionEngine==="ente"?enteState?.state:"complete",albums:displayedAlbums,selected:[...albumPhotos.keys()],provenance:collectionEngine==="ente"?enteRecord?.result.provenance:collectionResult?.provenance,diagnostics:collectionEngine==="ente"?enteRecord?.result.ente_diagnostics:undefined};
    return{engine:result.engine,id:result.id,selected:result.selected_ids,counts:result.counts};
  }},
    {name:"run_selection_experiment",description:"调整本项目选片参数并运行缓存回放，更新当前预览；不保存或发布线上。",inputSchema:{type:"object",properties:{count:{type:"integer",minimum:1,maximum:100},quality_min:{type:"number",minimum:0,maximum:1},theme:{type:"string",enum:Object.keys(THEMES_FOR_TOOL())}},additionalProperties:false},annotations:{readOnlyHint:false},execute:async input=>{const allowed=["count","quality_min","theme"];if(!input||typeof input!=="object"||Object.keys(input).some(k=>!allowed.includes(k)))throw new Error("无效参数");const next={...configFromForm(),...input};const [value,albums]=await Promise.all([api("/api/run",{config:next}),api("/api/collections",{config:next})]);clearTimeout(timer);requestVersion++;setConfig(value.config);result=value;collectionResult=albums;dirty=false;$("settings-fields").disabled=false;render();return{result_id:result.id,selected:result.selected_ids.length,albums:albums.albums.length};}}];
  for(const tool of tools){try{Promise.resolve(ctx.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}
function THEMES_FOR_TOOL(){return meta.themes;}
init();
