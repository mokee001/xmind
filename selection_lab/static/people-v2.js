'use strict';
let report, active = ['local','ente','immich','photoprism'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'local';
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; };
function photosFor(faces){
  const by=new Map();for(const f of faces){if(!by.has(f.asset_id))by.set(f.asset_id,[]);by.get(f.asset_id).push(f);}return by;
}
function groupTitle(g,i){return g.title||(g.assigned===false?`未归组的人脸 ${i+1}`:`候选人物组 ${i+1}`);}
function renderPhotos(target, faces){
  target.replaceChildren();
  const assets=new Map(report.photos.map(p=>[p.id,p]));
  for(const [id, fs] of photosFor(faces)){
    const p=assets.get(id);if(!p)continue;
    const figure=el('figure',undefined,'photo'), picture=el('div',undefined,'picture'),img=el('img');
    img.src=p.image;img.loading='lazy';img.alt=p.filename;picture.append(img);
    for(const f of fs){const b=f.box;if(!b||b.length!==4)continue;const box=el('span',undefined,'box');box.style.left=`${b[0]*100}%`;box.style.top=`${b[1]*100}%`;box.style.width=`${(b[2]-b[0])*100}%`;box.style.height=`${(b[3]-b[1])*100}%`;picture.append(box);}
    figure.append(picture,el('figcaption',p.filename));target.append(figure);
  }
}
function render(){
  const engine=report.engines.find(e=>e.id===active);$('engines').replaceChildren();
  for(const e of report.engines){const b=el('button',e.name);b.setAttribute('aria-pressed',String(e.id===active));b.onclick=()=>{active=e.id;render();};$('engines').append(b);}
  $('engine-note').textContent=engine.note||'';$('groups').replaceChildren();
  if(engine.status!=='complete'){$('counts').textContent=engine.status==='failed'?'测试未完成':'测试进行中';$('groups').append(el('p',engine.error||'尚未生成可验证的结果。', 'empty'));return;}
  const groups=engine.groups.filter(g=>$('singletons').checked||photosFor(g.faces).size>=2).sort((a,b)=>photosFor(b.faces).size-photosFor(a.faces).size);
  const multi=engine.groups.filter(g=>photosFor(g.faces).size>=2).length;
  $('counts').textContent=`${engine.face_count===undefined?'':engine.face_count+' 个检测框 · '}${multi} 个含至少 2 张照片的组 · 当前展示 ${groups.length} 组`;
  const assets=new Map(report.photos.map(p=>[p.id,p]));
  groups.forEach((g,i)=>{const b=el('button',undefined,'group'), preview=el('div',undefined,'preview');for(const id of [...photosFor(g.faces).keys()].slice(0,3)){const p=assets.get(id);if(!p)continue;const img=el('img');img.src=p.image;img.loading='lazy';img.alt=p.filename;preview.append(img);}b.append(preview,el('h3',groupTitle(g,i)),el('p',`${photosFor(g.faces).size} 张照片 · 点击查看全部及目标脸框`));b.onclick=()=>{$('viewer-title').textContent=groupTitle(g,i);renderPhotos($('viewer-photos'),g.faces);$('viewer').showModal();};$('groups').append(b);});
  if(!groups.length)$('groups').append(el('p','本轮没有达到显示条件的组。可勾选查看单张小组。','empty'));
}
async function load(){try{const r=await fetch('/api/recollections-v2');if(!r.ok)throw Error('本机报告暂不可用');const value=await r.json();if(!value.result)throw Error('新版人物索引尚未生成');const result=value.result;report={photos:result.photos,engines:[{id:'immich',name:'Immich 完整人物索引',status:'complete',face_count:result.diagnostics.face_count,groups:result.people,note:'保留已检测的全部人脸；原始分组未按精选规则拆分。'}]};active='immich';$('summary').textContent=`${result.diagnostics.input_count} 张照片 · ${result.diagnostics.multi_photo_groups} 组跨照片人物候选 · ${result.diagnostics.unassigned_faces} 个未归组人脸框` ;render();}catch(e){$('summary').textContent=e.message;}}
$('singletons').onchange=render;$('reload').onclick=load;$('close').onclick=()=>$('viewer').close();load();
