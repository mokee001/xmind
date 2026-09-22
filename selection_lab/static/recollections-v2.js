'use strict';
const $=id=>document.getElementById(id);
const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
let result,token,assets,selected=new Set(),mode='all',previewSequence=0,position=0,openingFocus,showAllPeople=false;
async function api(path,data){const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error||'请求未完成');return value;}
function payload(){return {snapshot_id:result.id,identity_revision:result.identity_revision,person_confirmation_revision:result.person_confirmation_revision,mode,person_ids:[...selected]};}
function render(){
  assets=new Map(result.photos.map(p=>[p.id,p]));
  const ids=result.display_photo_ids;
  $('summary').textContent=`第一层精选 ${result.display_counts.first_layer} 张 · 当前展示 ${ids.length} 张`;
  $('scope-note').textContent=result.display_scope.needs_review?'人物识别结果已更新，请重新确认人物偏好。':result.display_scope.mode==='all'?'展示范围：全部精选照片':`展示范围：选中的 ${result.display_scope.person_ids.length} 个人物候选`;
  $('empty').hidden=ids.length>0;
  $('display-photos').replaceChildren();
  ids.forEach((id,i)=>{const p=assets.get(id),b=node('button'),img=node('img');img.src=p.image;img.loading='lazy';img.alt=p.filename;b.setAttribute('aria-label',`查看精选照片 ${i+1}`);b.append(img);b.onclick=()=>{openingFocus=b;position=i;showFrame();$('photo-viewer').showModal();};$('display-photos').append(b);});
  $('base-summary').textContent=`本批第一层包含 ${result.albums.length} 个主题／旅程候选集。调整展示偏好不会改写这些候选集，也不会再次检查每册最低张数。`;
  $('preferences-open').disabled=false;
}
function showFrame(){const ids=result.display_photo_ids;if(!ids.length)return;const p=assets.get(ids[position]);$('photo').src=p.image;$('photo').alt=p.filename;$('photo-counter').textContent=`${position+1} / ${ids.length}`;}
function renderPeople(){
  $('people').replaceChildren();
  if(!result.preference_people.length)$('people').append(node('p','第一层精选中暂未识别到可选择的人物。'));
  const all=result.preference_people;
  $('people-more').hidden=all.length<=6;
  $('people-more').textContent=showAllPeople?'收起':`查看全部 ${all.length} 人`;
  $('people-more').setAttribute('aria-expanded',String(showAllPeople));
  $('people-selection').textContent=selected.size?`已选 ${selected.size} 人：${all.filter(g=>selected.has(g.id)).map(g=>g.title).join('、')}`:'尚未选择人物';
  for(const g of (showAllPeople?all:all.slice(0,6))){
    const label=node('label');label.className='person'+(selected.has(g.id)?' selected':'');
    const input=node('input');input.type='checkbox';input.checked=selected.has(g.id);input.setAttribute('aria-label',`选择${g.title}`);
    const img=node('img');img.src='/person-preview/'+encodeURIComponent(g.id);img.alt=g.title;img.loading='lazy';
    label.append(input,img,node('span',g.title),node('small',`精选中 ${g.selected_photo_count} 张`));
    input.onchange=()=>{input.checked?selected.add(g.id):selected.delete(g.id);mode='include';syncMode();renderPeople();updatePreview();};
    $('people').append(label);
  }
}
function syncMode(){document.querySelectorAll('input[name="mode"]').forEach(i=>i.checked=i.value===mode);}
async function updatePreview(){
  const seq=++previewSequence;$('preference-error').textContent='';$('preference-count').textContent='正在计算展示范围…';
  try{const view=await api('/api/display-preferences-preview',payload());if(seq!==previewSequence)return;$('preference-count').textContent=`保存后展示 ${view.display_counts.visible} / ${view.display_counts.first_layer} 张精选照片${mode==='include'&&!selected.size?' · 尚未选择人物':''}`;}
  catch(e){if(seq===previewSequence){$('preference-error').textContent=e.message;$('preference-count').textContent='未能计算展示范围';}}
}
$('preferences-open').onclick=()=>{openingFocus=document.activeElement;selected=new Set(result.display_scope.person_ids);mode=result.display_scope.mode;showAllPeople=false;syncMode();renderPeople();$('preferences').showModal();updatePreview();};
document.querySelectorAll('input[name="mode"]').forEach(i=>i.onchange=()=>{mode=i.value;updatePreview();});
$('people-more').onclick=()=>{showAllPeople=!showAllPeople;renderPeople();};
$('clear-people').onclick=()=>{selected.clear();renderPeople();updatePreview();};
$('preferences-close').onclick=()=>$('preferences').close();
$('preferences').addEventListener('close',()=>{previewSequence++;openingFocus?.focus();});
$('preferences-save').onclick=async()=>{const b=$('preferences-save');b.disabled=true;try{const view=await api('/api/display-preferences',payload());previewSequence++;Object.assign(result,view);render();$('preferences').close();}catch(e){$('preference-error').textContent=e.message;}finally{b.disabled=false;}};
$('photo-close').onclick=()=>$('photo-viewer').close();$('photo-viewer').addEventListener('close',()=>openingFocus?.focus());
$('previous').onclick=()=>{position=(position-1+result.display_photo_ids.length)%result.display_photo_ids.length;showFrame();};
$('next').onclick=()=>{position=(position+1)%result.display_photo_ids.length;showFrame();};
$('photo-viewer').addEventListener('keydown',e=>{if(e.key==='ArrowRight'){$('next').click();e.preventDefault();}if(e.key==='ArrowLeft'){$('previous').click();e.preventDefault();}});
async function load(){try{const value=await api('/api/recollections-v2');token=value.token;result=value.result;if(!result)throw Error('本批精选尚未生成');render();if(location.hash==='#preferences')$('preferences-open').click();}catch(e){$('error').hidden=false;$('error').textContent=e.message;}}
load();
