(function(root){
  "use strict";
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function overlap(a,b){const x=new Set(a.candidate_ids||a.photo_ids),y=new Set(b.candidate_ids||b.photo_ids);return [...x].filter(i=>y.has(i)).length/new Set([...x,...y]).size;}
  function bestMatch(album,others){return others.filter(a=>a.kind===album.kind).map(a=>({album:a,score:overlap(album,a)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.album.id.localeCompare(b.album.id))[0]?.album||null;}
  const verdicts={good:"值得保留",mixed:"混入无关照片",missing:"漏了关键照片",duplicate:"重复画面太多",cover:"封面不合适",unsure:"尚不确定"};
  if(typeof module!=="undefined")module.exports={esc,overlap,bestMatch};
  if(!root.document)return;
  const $=s=>document.querySelector(s);
  let result=null,token=null,allReviews={},kind="event",variant="controlled",selectedId=null,leftId=null,photoMap=new Map(),reviewContext=null;
  async function api(path,data){const response=await fetch(path,data===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json","X-Lab-Token":token},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error||"请求未完成");return value;}
  function fail(error){$("#error").textContent=error.message;$("#error").hidden=false;}
  function photo(id){return photoMap.get(id);}
  function reviewFor(v,id){return Object.values(allReviews).find(r=>r.snapshot_id===result.id&&r.variant===v&&r.album_id===id);}
  function chosen(){return result?.variants.narrative.find(a=>a.id===selectedId);}
  function loadResult(value){result=value;photoMap=new Map(result.photos.map(p=>[p.id,p]));const requested=new URLSearchParams(location.search).get("album"),a=result.variants.narrative.find(x=>x.id===requested);selectedId=a?.id||null;if(a)kind=a.kind;leftId=null;document.querySelectorAll("[data-kind]").forEach(b=>{b.classList.toggle("active",b.dataset.kind===kind);b.setAttribute("aria-pressed",String(b.dataset.kind===kind));});render();}
  function render(){
    const d=result.diagnostics,s=result.stats;
    $("#summary").innerHTML=`<div><strong>${d.input_count}</strong>张原始照片</div><div><strong>${d.eligible_count}</strong>张通过基础筛选</div><div><strong>${d.episodes.precise_inputs}</strong>张可用于活动组装</div><div><strong>${s.narrative.events}</strong>组活动候选</div><div><strong>${s.narrative.trips}</strong>组出行候选</div>`;
    $("#provenance").textContent=`快照 ${result.id} · 全量 Ente 缓存回放 · ${result.provenance.version}。未重新推理照片，未上传。`;
    const values=result.variants.narrative.filter(a=>a.kind===kind);
    if(!values.some(a=>a.id===selectedId)){selectedId=values[0]?.id||null;leftId=null;}
    $("#album-list").innerHTML=values.map(a=>`<button class="album-card ${a.id===selectedId?"active":""}" data-album="${esc(a.id)}" aria-pressed="${a.id===selectedId}"><img loading="lazy" src="${esc(photo(a.cover).image)}" alt="${esc(a.title)}封面"><div class="caption"><strong>${esc(a.title)}</strong><small>${a.photo_ids.length} 张精选 / ${a.candidate_count} 张候选 · ${a.selected_scene_count} 个画面片段</small></div></button>`).join("")||'<p class="empty">这批照片还没有足够证据组成这一类回忆。</p>';
    $("#comparison").hidden=!selectedId;
    if(selectedId)renderComparison();
  }
  function renderComparison(auto=true){
    const right=chosen(),options=result.variants[variant].filter(a=>a.kind===right.kind);
    if(auto&&(!leftId||!options.some(a=>a.id===leftId)))leftId=bestMatch(right,options)?.id||null;
    const left=options.find(a=>a.id===leftId);
    $("#left-album").innerHTML='<option value="">不选择对照相册</option>'+options.map(a=>`<option value="${esc(a.id)}" ${a.id===leftId?"selected":""}>${esc(a.title)} · ${a.photo_ids.length} 张</option>`).join("");
    $("#comparison-title").textContent=right.title;
    const shared=left?left.photo_ids.filter(id=>right.photo_ids.includes(id)).length:0;
    $("#match-note").textContent=left?`两侧共同入选 ${shared} 张。自动配对仅根据候选照片重叠，不表示已确认是同一次经历；可用左侧下拉框换组。${variant==="legacy"?"当前左侧是原算法参考，包含旧的展示数量上限。":"当前两侧选片方法相同，只比较活动分组；出行类的结果应相同。"}`:"原方案没有与这组重叠的可展示相册。可手动选择其他相册对照，空白不代表识别失败。";
    $("#left-content").innerHTML=left?albumHTML(left,variant):'<p class="empty">没有相应的对照结果。</p>';
    $("#right-content").innerHTML=albumHTML(right,"narrative");
  }
  function albumHTML(a,v){
    const r=reviewFor(v,a.id),e=a.evidence||{};
    const links=(e.links||[]).map(l=>`<li>${esc(l.reason)}</li>`).slice(0,8).join("");
    return `<div class="album-facts"><span>${a.candidate_count} 张候选 → ${a.photo_ids.length} 张入选</span>${a.scene_count!==undefined?`<span>覆盖 ${a.selected_scene_count} / ${a.scene_count} 个画面片段</span>`:""}<span>${esc(a.subtitle)}</span></div><div class="photo-grid">${a.photo_ids.map((id,i)=>`<button class="photo" data-photo="${esc(id)}" data-owner="${esc(a.id)}" data-variant="${v}" aria-label="查看第 ${i+1} 张照片${id===a.cover?"，封面":""}"><img loading="lazy" src="${esc(photo(id).image)}" alt="第 ${i+1} 张回忆照片"><span class="${id===a.cover?"cover":""}">${String(i+1).padStart(2,"0")}${id===a.cover?" / 封面":""}</span></button>`).join("")}</div><div class="column-actions"><button data-review="${esc(a.id)}" data-variant="${v}">记录这一组</button><span class="review-badge">${r?`已记录：${verdicts[r.verdict]}`:"尚未人工验收"}</span></div><details class="explain"><summary>查看分组与选片依据</summary><p>${esc(a.description)}</p>${a.removed?`<p>近似重复合并 ${a.removed.length} 张。片段数是规则分段统计，不是人工质量评分。</p>`:""}${links?`<ul>${links}</ul>`:""}<p>点击“记录这一组”，可查看全部候选、被去重或未入选的照片，并补充漏片。</p></details>`;
  }
  function openPhoto(id,album){
    const p=photo(id);if(!p)return;
    $("#viewer-title").textContent=p.filename;
    $("#viewer-image").src=p.image;$("#viewer-image").alt=p.filename;
    const duplicate=album?.removed?.find(x=>x.id===id);
    $("#viewer-caption").textContent=[album?.selection_reasons?.[id],duplicate?`${duplicate.reason}；保留 ${photo(duplicate.representative)?.filename}`:"",!p.eligible?"基础筛选未通过，可在验收中记录误筛。":"",p.date_source==="unknown"?"拍摄日期未知":""].filter(Boolean).join(" · ");
    $("#viewer").showModal();
  }
  function openReview(v,id){
    const album=result.variants[v].find(a=>a.id===id),r=reviewFor(v,id);
    reviewContext={variant:v,album,wrong:new Set(r?.wrong_ids||[]),keep:new Set(r?.must_keep_ids||[])};
    $("#review-title").textContent=album.title;$("#verdict").value=r?.verdict||"unsure";$("#review-note").value=r?.note||"";
    $("#review-scope").value="selected";$("#review-search").value="";$("#review-status").textContent="";
    renderReview();$("#reviewer").showModal();
  }
  function renderReview(){
    const {album,wrong,keep}=reviewContext,scope=$("#review-scope").value,query=$("#review-search").value.trim().toLowerCase();
    const ids=(scope==="all"?result.photos.map(p=>p.id):scope==="pool"?(album.candidate_ids||album.photo_ids):album.photo_ids).filter(id=>photo(id).filename.toLowerCase().includes(query));
    $("#review-photos").innerHTML=ids.map(id=>{const p=photo(id),selected=album.photo_ids.includes(id),value=wrong.has(id)?"wrong":keep.has(id)?"keep":"",dup=album.removed?.find(x=>x.id===id);return `<div class="review-photo ${value?"marked":""}"><button type="button" data-review-photo="${esc(id)}" aria-label="放大 ${esc(p.filename)}"><img loading="lazy" src="${esc(p.image)}" alt="${esc(p.filename)}"></button><small title="${esc(p.filename)}">${esc(p.filename)}</small><small>${selected?"本组已入选":dup?"近似重复未保留":p.eligible?"未入选本组":"基础筛选未通过"}</small><select data-mark="${esc(id)}" aria-label="标记 ${esc(p.filename)}"><option value="">暂不标记</option>${selected?`<option value="wrong" ${value==="wrong"?"selected":""}>不该入选</option>`:""}<option value="keep" ${value==="keep"?"selected":""}>必须保留</option></select></div>`;}).join("")||'<p class="empty">没有匹配的照片。</p>';
    updateReviewCount();
  }
  function updateReviewCount(){const c=reviewContext;$("#review-status").textContent=`待保存：${c.wrong.size} 张不该入选，${c.keep.size} 张必须保留。`}
  $("#album-list").addEventListener("click",event=>{const card=event.target.closest("[data-album]");if(!card)return;selectedId=card.dataset.album;leftId=null;render();});
  document.querySelectorAll("[data-kind]").forEach(button=>button.addEventListener("click",()=>{kind=button.dataset.kind;selectedId=null;leftId=null;document.querySelectorAll("[data-kind]").forEach(b=>{b.classList.toggle("active",b===button);b.setAttribute("aria-pressed",String(b===button));});if(result)render();}));
  $("#left-variant").addEventListener("change",event=>{variant=event.target.value;leftId=null;if(selectedId)renderComparison();});
  $("#left-album").addEventListener("change",event=>{leftId=event.target.value||null;renderComparison(false);});
  $("#comparison").addEventListener("click",event=>{const image=event.target.closest("[data-photo]"),review=event.target.closest("[data-review]");if(image)openPhoto(image.dataset.photo,result.variants[image.dataset.variant].find(a=>a.id===image.dataset.owner));if(review)openReview(review.dataset.variant,review.dataset.review);});
  $("#close-viewer").addEventListener("click",()=>$("#viewer").close());
  $("#close-review").addEventListener("click",()=>$("#reviewer").close());
  $("#review-scope").addEventListener("change",renderReview);$("#review-search").addEventListener("input",renderReview);
  $("#review-photos").addEventListener("click",event=>{const button=event.target.closest("[data-review-photo]");if(button)openPhoto(button.dataset.reviewPhoto,reviewContext.album);});
  $("#review-photos").addEventListener("change",event=>{const input=event.target.closest("[data-mark]");if(!input)return;const c=reviewContext,id=input.dataset.mark;c.wrong.delete(id);c.keep.delete(id);if(input.value==="wrong")c.wrong.add(id);if(input.value==="keep")c.keep.add(id);input.closest(".review-photo").classList.toggle("marked",Boolean(input.value));updateReviewCount();});
  $("#review-form").addEventListener("submit",async event=>{event.preventDefault();const c=reviewContext,button=$("#save-review");button.disabled=true;try{const {review}=await api("/api/memory-experiment-review",{snapshot_id:result.id,variant:c.variant,album_id:c.album.id,verdict:$("#verdict").value,note:$("#review-note").value,wrong_ids:[...c.wrong],must_keep_ids:[...c.keep]});const existing=Object.keys(allReviews).find(k=>allReviews[k].snapshot_id===review.snapshot_id&&allReviews[k].variant===review.variant&&allReviews[k].album_id===review.album_id);allReviews[existing||`${review.variant}:${review.album_id}`]=review;$("#review-status").textContent="已保存到本机；未改变算法或当前相册。";renderComparison(false);}catch(error){$("#review-status").textContent=error.message;}finally{button.disabled=false;}});
  $("#generate").addEventListener("click",async()=>{const button=$("#generate");button.disabled=true;$("#error").hidden=true;$("#status").textContent="正在用本地缓存组装和选片…";try{const value=await api("/api/memory-experiment-run",{config:result?.config||{}});loadResult(value.result);$("#status").textContent="实验已生成并保存，原方案仍可查看。";}catch(error){fail(error);$("#status").textContent="本次生成未完成，仍保留上一份结果。";}finally{button.disabled=false;}});
  async function start(){try{const [bootstrap,value]=await Promise.all([api("/api/bootstrap"),api("/api/memory-experiment")]);token=bootstrap.token;allReviews=value.reviews||{};if(value.result){loadResult(value.result);$("#status").textContent="已读取本机保存的实验结果。";}else{$("#status").textContent="尚无实验结果，点击上方按钮生成。";}}catch(error){fail(error);$("#status").textContent="读取失败，请确认本地实验服务已启动。";}}
  start();
})(typeof globalThis!=="undefined"?globalThis:this);
