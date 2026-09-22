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
function audit(){
  const a=report.audit;$('summary').textContent=`同一批 ${a.input} 张照片 · 当前成册资格 ${a.eligible} 张 · 日期未知 ${a.unknown_date} 张`;
  const ul=el('ul');for(const t of [
    `人物：原簇内再次过滤和拆分，没有跨簇找回同一个人；当前精选保留 ${a.story_counts.album_counts.person} 个候选人物相簿。`,
    `去重：原 ViT-B-32 向量仅覆盖 ${a.dedup_vectors}/${a.input} 张，其余照片主要依赖图像哈希和灰度网格。全批 Ente 内容向量属于另一个模型，不能直接混用。`,
    '精选：美观是清晰度、色彩和构图公式；主题时光的偏好使用固定分数，尚未体现个人喜好。',
    `日期：${a.unknown_date} 张缺可靠日期；缺日期影响时间主题与旅程，不应当阻止人物识别。`,
    '宠物：猫狗类别识别已有，但没有同一只宠物的身份聚类。',
    '稳定性：旧打标模块 auto 模式失败时可能回退为文件名生成的演示标签；缓存未记录每张图的实际识别来源，不能据此确认本批是否发生过回退。',
    '这些结果尚无逐张人工真值，不能把组多、框多直接解释成更准确。'
  ])ul.append(el('li',t));$('audit-content').replaceChildren(ul);$('filter-buttons').replaceChildren();
  const names={photo_excluded:'照片被排除',score:'检测分门槛',blur:'清晰度门槛',area:'脸面积门槛',pass:'通过人脸门槛'};
  for(const [key,title] of Object.entries(names)){const b=el('button',`${title} ${a.face_filters[key]||0} 个框`);b.onclick=()=>renderPhotos($('filter-photos'),a.face_filter_examples[key]||[]);$('filter-buttons').append(b);}
  const pairs=a.duplicate_review||[];
  const heading=el('h3',`仅靠灰度＋类别判重的样本：${pairs.length} 对`);
  $('audit-content').append(heading,el('p','这是全体合格照片的诊断，不是实际相簿删除数。按日期差排列，未知日期会影响排序；点击核对，不把所有样本都当作误判。'));
  const buttons=el('div',undefined,'controls');
  pairs.forEach((p,i)=>{const b=el('button',`样本 ${i+1} · 灰度差 ${p.gray_distance}`);b.onclick=()=>{$('viewer-title').textContent=`疑似误去重样本 ${i+1} · 灰度差 ${p.gray_distance}`;renderPhotos($('viewer-photos'),[{asset_id:p.left},{asset_id:p.right}]);$('viewer').showModal();};buttons.append(b);});
  $('audit-content').append(buttons);
}
async function load(){try{const r=await fetch('/api/engine-comparison');if(!r.ok)throw Error('本机报告暂不可用');report=await r.json();audit();render();}catch(e){$('summary').textContent=e.message;}}
$('singletons').onchange=render;$('reload').onclick=load;$('close').onclick=()=>$('viewer').close();load();
