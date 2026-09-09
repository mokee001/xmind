(()=>{"use strict";
const $=s=>document.querySelector(s),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const preview=new URLSearchParams(location.search).has("preview");
let result,token,photos=new Map(),current=null,position=0,timer=null,openingFocus=null;
async function api(path,data){const r=await fetch(path,data===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json","X-Lab-Token":token},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(value.error||"请求未完成");return value;}
function fail(error){$("#error").textContent=error.message;$("#error").hidden=false;}
function card(a){const liked=result.feedback[a.id]?.favorite;return `<article class="memory-card"><button class="open-memory" data-open="${esc(a.id)}" aria-label="打开回忆：${esc(a.title)}，${a.photo_ids.length}张"><img class="cover" src="${esc(photos.get(a.cover).image)}" alt="${esc(a.title)}封面" loading="lazy"><span class="shade"></span><span class="card-label">${esc(a.label)}${a.year?` / ${a.year}`:""}</span><span class="card-title"><strong>${esc(a.title)}</strong><small>${a.photo_ids.length} 张照片 · ${esc(a.subtitle)}</small></span><span class="card-play" aria-hidden="true">▶</span></button><button class="card-favorite ${liked?"active":""}" data-favorite="${esc(a.id)}" aria-label="${liked?"取消收藏":"收藏"}${esc(a.title)}" aria-pressed="${Boolean(liked)}">${liked?"♥":"♡"}</button></article>`;}
function render(){
  photos=new Map(result.photos.map(p=>[p.id,p]));
  const byId=new Map(result.albums.map(a=>[a.id,a]));
  const featured=result.featured_ids.map(id=>byId.get(id)).filter(a=>a&&!result.feedback[a.id]?.hidden);
  const others=result.albums.filter(a=>!result.featured_ids.includes(a.id)&&!result.feedback[a.id]?.hidden);
  const albums=[...featured,...others];
  $("#featured").innerHTML=albums.map(card).join("")||'<p class="empty">暂时没有足够素材形成新的回忆。可以在下方恢复少推荐的回忆。</p>';
  $("#subtitle").textContent=albums.length?`${albums.length} 段回忆，重新遇见那些值得留下的时刻。`:"让回忆慢慢积累。";
  const hidden=result.albums.filter(a=>result.feedback[a.id]?.hidden);
  $("#hidden-albums").hidden=!hidden.length;
  $("#hidden-albums").innerHTML=hidden.length?`已少推荐：${hidden.map(a=>`<button data-restore="${esc(a.id)}">恢复「${esc(a.title)}」</button>`).join("")}`:"";
}
async function preference(id,action){if(preview){$("#player-notice").textContent="预览检查模式：不记录观看或偏好。";return;}const value=await api("/api/recollections-feedback",{album_id:id,action});result.feedback[id]=value.feedback;}
async function favorite(id){const liked=result.feedback[id]?.favorite;await preference(id,liked?"unfavorite":"favorite");render();if(current)updatePlayerButtons();}
function pause(){if(timer){clearInterval(timer);timer=null;}$("#play").textContent="播放回忆";}
function frame(){const id=current.photo_ids[position],p=photos.get(id),img=$("#main-photo");img.src=p.image;img.alt=`${current.title}，第 ${position+1} 张`;$("#counter").textContent=`${String(position+1).padStart(2,"0")} / ${current.photo_ids.length}`;$("#strip").innerHTML=current.photo_ids.map((id,i)=>`<button data-frame="${i}" class="${i===position?"active":""}" aria-label="第${i+1}张" aria-pressed="${i===position}"><img loading="lazy" src="${esc(photos.get(id).image)}" alt=""></button>`).join("");$("#strip .active")?.scrollIntoView({block:"nearest",inline:"nearest",behavior:"smooth"});}
function updatePlayerButtons(){const liked=result.feedback[current.id]?.favorite;$("#favorite").textContent=liked?"♥ 已收藏":"♡ 收藏";$("#favorite").setAttribute("aria-pressed",String(Boolean(liked)));}
async function openAlbum(id){openingFocus=document.activeElement;current=result.albums.find(a=>a.id===id);position=0;pause();$("#player-label").textContent=current.label;$("#player-title").textContent=current.title;$("#player-subtitle").textContent=`${current.photo_ids.length} 张照片 · ${current.subtitle}`;$("#player-notice").textContent="";$("#player").showModal();frame();updatePlayerButtons();try{await preference(id,"seen");}catch(error){$("#player-notice").textContent=error.message;}}
document.addEventListener("click",async event=>{const open=event.target.closest("[data-open]"),fav=event.target.closest("[data-favorite]"),restore=event.target.closest("[data-restore]");try{if(open)await openAlbum(open.dataset.open);if(fav)await favorite(fav.dataset.favorite);if(restore){await preference(restore.dataset.restore,"restore");await load();}}catch(error){fail(error);}});
$("#close").onclick=()=>$("#player").close();$("#player").addEventListener("close",()=>{pause();openingFocus?.focus();});
$("#prev").onclick=()=>{pause();position=(position-1+current.photo_ids.length)%current.photo_ids.length;frame();};$("#next").onclick=()=>{pause();position=(position+1)%current.photo_ids.length;frame();};
$("#play").onclick=()=>{if(timer){pause();return;}$("#play").textContent="暂停";timer=setInterval(()=>{if(position===current.photo_ids.length-1){pause();return;}position++;frame();},3500);};
$("#strip").onclick=event=>{const target=event.target.closest("[data-frame]");if(target){pause();position=Number(target.dataset.frame);frame();}};
$("#player").addEventListener("keydown",event=>{if(event.target.tagName==="BUTTON"&&event.key===" ")return;if(event.key==="ArrowLeft"){$("#prev").click();event.preventDefault();}if(event.key==="ArrowRight"){$("#next").click();event.preventDefault();}});
document.addEventListener("visibilitychange",()=>{if(document.hidden)pause();});
$("#favorite").onclick=async()=>{try{await favorite(current.id);}catch(error){$("#player-notice").textContent=error.message;}};
$("#hide").onclick=async()=>{try{await preference(current.id,"hide");$("#player").close();await load();$("#message").textContent=preview?"预览检查模式：未保存偏好。":"已少推荐这段回忆，可在列表下方恢复。";}catch(error){$("#player-notice").textContent=error.message;}};
async function load(){const value=await api("/api/recollections");token=value.token;result=value.result;if(!result)throw new Error("这批照片的回忆尚未生成。");render();}
$("#refresh").onclick=async()=>{const button=$("#refresh");button.disabled=true;try{await load();$("#message").textContent="已根据收藏、观看记录与内容差异更新推荐。";}catch(error){fail(error);}finally{button.disabled=false;}};
load().catch(fail);
})();
