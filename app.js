const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tracks = {
  hardware: {name:'硬件', english:'HARDWARE', icon:'chip', short:'硬', subtitle:'让想法成为可触摸的产品', next:'按钮小样试装与尺寸核准', tone:'blue'},
  software: {name:'软件', english:'SOFTWARE', icon:'code', short:'软', subtitle:'连接照片、设备与日常', next:'真实连接与上屏流程回归', tone:'green'},
  template: {name:'模版', english:'TEMPLATES', icon:'layers', short:'模', subtitle:'给每一段回忆合适的表达', next:'抠图依赖与四款出图验收', tone:'pink'}
};
const tabs = [
  ['overview','总进度','grid','blue'], ['tasks','协作待办','check','green'],
  ['files','更新与文件','folder','orange'], ['ideas','产品灵感池','bulb','pink'],
  ['history','迭代记录','history','yellow'], ['specs','产品规范','layers','blue']
];
const statuses = {todo:'待开始', doing:'进行中', blocked:'待协助', done:'已完成'};
const paths = {
 grid:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
 check:'<path d="m5 12 4 4L19 6"/>', folder:'<path d="M3 7V4h6l3 3h9v13H3Z"/>',
 bulb:'<path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/>',
 history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
 chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5"/><rect x="9" y="9" width="6" height="6"/>',
 code:'<rect x="2" y="3" width="20" height="18" rx="3"/><path d="m9 9-3 3 3 3m6-6 3 3-3 3"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
 people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4c2 0 3 2 3 4v2"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>', chevron:'<path d="m9 5 7 7-7 7"/>',
 file:'<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h6"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
 flag:'<path d="M5 22V3c5-4 9 4 15 0v11c-6 4-10-4-15 0"/>',
 link:'<path d="m10 13 4-4m-7 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 2) scale(.9)"/>',
 more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18"/>',
 settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>'
};
const icon = (name, extra='') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
let state, documents = [], busy = false, taskView = 'list', taskStatus = 'all', filter = 'all', searchQuery = '';
const dialog = $('#dialog');
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date());
const uid = prefix => `${prefix}-${crypto.randomUUID().slice(0,8)}`;
const avatar = track => `<span class="avatar ${tracks[track].tone}">${esc(state.owners[track].slice(0,1))}</span>`;
const tag = track => `<span class="track-tag ${tracks[track].tone}"><i></i>${tracks[track].name}</span>`;
const matches = item => filter === 'all' || item.track === filter;
const dateLabel = date => date ? new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(new Date(date+'T12:00:00')) : '未排期';
const route = () => tabs.some(t => t[0] === location.hash.slice(1).split('?')[0]) ? location.hash.slice(1).split('?')[0] : 'overview';
function go(page, track = filter) { location.hash = page + (track === 'all' ? '' : '?track='+track); }
function showToast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(()=>$('#toast').classList.remove('visible'),4000); }
async function api(url, options) {
  if (window.echooStaticStorage) return window.echooStaticStorage.request(url, options);
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.error || '请求失败，请重试'); error.status = response.status; throw error; }
  return body;
}
async function save(change, message) {
  if (busy) return false;
  const next = structuredClone(state); change(next); busy = true;
  const submit = $('button[type="submit"]',dialog);
  if (submit) submit.disabled = true;
  $('#save-state').textContent = '正在保存…';
  try {
    state = await api('/api/state', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
    render(); showToast(message || '已保存'); return true;
  } catch(error) {
    if (error.status === 409) { state = await api('/api/state').catch(()=>state); }
    const errorEl = $('.form-error',dialog);
    if (errorEl) errorEl.textContent = error.message;
    showToast(error.message); $('#save-state').textContent = '未保存 · 请重试'; return false;
  } finally { busy = false; if(submit) submit.disabled = false; }
}
function activity(next, title, track, description='') { next.updates.unshift({id:uid('UP'),title,track,description,date:today()}); }
function openDialog(title, content, className='') {
  if(dialog.open) dialog.close();
  dialog.className = className;
  dialog.innerHTML = `<div class="dialog-head"><div><span class="eyebrow">ECHOO WORKSPACE</span><h2 id="dialog-title">${esc(title)}</h2></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>${content}`;
  dialog.showModal();
}
function render() {
  const page = route();
  filter = new URLSearchParams(location.hash.split('?')[1] || '').get('track') || 'all';
  if (filter !== 'all' && !tracks[filter]) filter = 'all';
  const current = tabs.find(t=>t[0]===page);
  $('#sidebar').innerHTML = `<a class="brand" href="#overview" aria-label="Echoo 总进度">echoo<span>↗</span></a><div class="brand-motto">TOGETHER, WE BUILD.</div><div class="palette"><i></i><i></i><i></i><i></i><i></i></div><div class="nav-caption">项目工作台</div><nav>${tabs.map(([id,name,ico,tone])=>`<a class="nav-item ${page===id?'active':''}" href="#${id}" ${page===id?'aria-current="page"':''}><i class="nav-dot ${tone}"></i>${icon(ico)}<span>${name}</span>${id==='tasks'?`<b>${state.tasks.filter(t=>t.status!=='done').length}</b>`:''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="workspace-mark">E</div><div><strong>Echoo 照片墙</strong><small>三个人，一起把它做好。</small></div><button class="icon-button" data-action="team" aria-label="负责人设置">${icon('settings')}</button></div>`;
  $('#breadcrumb').textContent=current[1];
  $('#search-icon').innerHTML=icon('search');
  $('.team-stack').innerHTML = Object.keys(tracks).map(avatar).join('');
  $('#main').innerHTML = ({overview, tasks, files, ideas, history, specs}[page])();
  $('#save-state').textContent = window.echooStaticStorage ? '仅保存于当前浏览器 · 不跨成员同步' : '更改保存于本机';
  document.title = `${current[1]} · Echoo 工作台`;
  $('#sidebar').classList.remove('mobile-open');
  $('#menu-button').setAttribute('aria-expanded','false');
}
function pageHead(title, description, action, label) {
  return `<div class="page-heading"><div><div class="eyebrow">PROJECT WORKSPACE <span>/</span> ECHOO</div><h1>${title}</h1><p>${description}</p></div>${action?`<button class="button primary" data-action="${action}">${icon('plus')}${label}</button>`:''}</div>`;
}
function filters(extra='') {
  return `<div class="filter-row"><div class="filter-tabs" role="group" aria-label="工作线筛选">${[['all','全部工作线'],...Object.entries(tracks).map(([k,v])=>[k,v.name])].map(([k,v])=>`<button data-action="filter" data-id="${k}" class="${filter===k?'selected':''}">${k!=='all'?`<i class="dot ${tracks[k].tone}"></i>`:''}${v}</button>`).join('')}</div>${extra}</div>`;
}
function taskRow(task, compact=false) {
  return `<div class="task-row ${task.status==='done'?'completed':''}"><button class="task-check ${task.status==='done'?'checked':''}" data-action="toggle-task" data-id="${esc(task.id)}" aria-label="${task.status==='done'?'重新打开':'完成'}：${esc(task.title)}">${task.status==='done'?icon('check'):''}</button><button class="task-title" data-action="edit-task" data-id="${esc(task.id)}"><strong>${esc(task.title)}</strong>${compact?'':`<small>${esc(task.id)} · ${esc(task.description)}</small>`}</button>${tag(task.track)}${compact?'':`<span class="task-owner">${avatar(task.track)}${esc(state.owners[task.track])}</span><span class="due ${task.due&&task.due<today()&&task.status!=='done'?'overdue':''}">${dateLabel(task.due)}</span>`}<span class="status ${task.status}"><i></i>${statuses[task.status]}</span><button class="icon-button" data-action="edit-task" data-id="${esc(task.id)}" aria-label="编辑 ${esc(task.title)}">${icon('chevron')}</button></div>`;
}
function overview() {
  const done = state.tasks.filter(t=>t.status==='done').length;
  const percent = state.tasks.length?Math.round(done/state.tasks.length*100):0;
  const pending = state.tasks.filter(t=>t.status!=='done');
  return `${pageHead('把好想法，一起做出来。','硬件、软件与模版，在这里同步。','new-task','新建待办')}
  <section class="project-summary"><div class="project-label"><span class="project-symbol">e.</span><div><div class="project-name">Echoo 智能照片墙 <span class="project-stage">项目协作</span></div><p>从一张照片，到生活里的一面回忆。</p></div></div><div class="summary-metrics"><div><strong>${String(done).padStart(2,'0')}<small> / ${state.tasks.length}</small></strong><span>任务已完成</span></div><div><strong>03</strong><span>工作线负责人</span></div><div class="overall-progress"><div class="ring" style="--percent:${percent*3.6}deg"><strong>${percent}<small>%</small></strong></div><span>看板完成率</span></div></div></section>
  <div class="section-heading"><h2>三条工作线<span class="section-number">03</span></h2><button class="text-button" data-action="team">${icon('people')}管理负责人</button></div>
  <section class="track-grid">${Object.entries(tracks).map(([key,t],index)=>{
    const items=state.tasks.filter(x=>x.track===key), count=items.filter(x=>x.status==='done').length, pct=items.length?Math.round(count/items.length*100):0;
    return `<article class="track-card ${t.tone}"><div class="track-card-top"><div class="track-icon">${icon(t.icon)}</div><span class="eyebrow">0${index+1} / ${t.english}</span><button class="icon-button" data-action="track-tasks" data-id="${key}" aria-label="查看${t.name}任务">${icon('arrow')}</button></div><h2>${t.name}</h2><p>${t.subtitle}</p><div class="track-owner">${avatar(key)}<span>${esc(state.owners[key])}</span><span class="owner-role">负责人</span></div><div class="progress-caption"><span>已完成 ${count} / ${items.length} 项</span><strong>${pct}<small>%</small></strong></div><div class="progress-bar"><i style="width:${pct}%"></i></div><div class="track-next"><span>下一步</span>${esc(items.find(x=>x.status!=='done')?.title || '全部任务已完成')}${icon('chevron')}</div></article>`;
  }).join('')}</section>
  <div class="overview-bottom"><section class="panel priority-panel"><div class="panel-heading"><h2>优先推进<span class="count">${pending.filter(t=>t.priority==='high').length}</span></h2><a class="text-button" href="#tasks">全部待办 ${icon('arrow')}</a></div><div class="compact-tasks">${pending.filter(t=>t.priority==='high').slice(0,5).map(t=>taskRow(t,true)).join('') || '<div class="empty-inline">优先事项已完成。继续向下一步前进。</div>'}</div><div class="panel-foot">${icon('flag')}下一次联调，先让三条工作线的关键事项就绪。</div></section><section class="panel latest-panel"><div class="panel-heading"><h2>最近更新</h2><a class="text-button" href="#history">${icon('arrow')}<span class="sr-only">全部迭代</span></a></div><div class="activity-list">${recentItems().slice(0,3).map(item=>`<button class="activity-item" data-action="${item.source?'document':'update-detail'}" data-id="${esc(item.source||item.id)}"><span class="activity-line ${tracks[item.track].tone}"></span><div><small>${esc(item.date)} · ${tracks[item.track].name}</small><strong>${esc(item.title)}</strong><p>${esc(item.description)}</p></div></button>`).join('')}</div></section></div>
  <div class="source-note">${icon('file')}初始任务根据项目文档整理，待办为建议计划；完成率按当前看板任务计算，由负责人更新实际进展。</div>`;
}
function tasks() {
  const items = state.tasks.filter(matches).filter(t=>taskStatus==='all'||t.status===taskStatus);
  return `${pageHead('协作待办','每件事都有归属，每一步都能跟进。','new-task','新建待办')}${filters(`<div class="view-switch"><button data-action="view" data-id="list" class="${taskView==='list'?'selected':''}">${icon('file')}列表</button><button data-action="view" data-id="board" class="${taskView==='board'?'selected':''}">${icon('grid')}看板</button></div>`)}<div class="task-toolbar"><span>${items.length} 项任务</span><label>状态 <select id="status-filter"><option value="all">全部状态</option>${Object.entries(statuses).map(([k,v])=>`<option value="${k}" ${taskStatus===k?'selected':''}>${v}</option>`).join('')}</select></label></div>${taskView==='list'?`<section class="panel task-table"><div class="task-table-heading"><span>任务名称</span><span>工作线</span><span>负责人</span><span>截止日期</span><span>状态</span><span></span></div>${items.map(t=>taskRow(t)).join('') || empty('没有符合条件的任务','切换筛选条件，或创建一个新的待办。')}</section>`:`<div class="kanban">${Object.entries(statuses).map(([key,label])=>`<section class="kanban-column"><h2><i class="status-dot ${key}"></i>${label}<span>${items.filter(t=>t.status===key).length}</span></h2>${items.filter(t=>t.status===key).map(t=>`<button class="kanban-card" data-action="edit-task" data-id="${esc(t.id)}"><div>${tag(t.track)}${t.priority==='high'?'<span class="priority">优先</span>':''}</div><h3>${esc(t.title)}</h3><p>${esc(t.description)}</p><footer><span>${avatar(t.track)}${esc(state.owners[t.track])}</span><small>${dateLabel(t.due)}</small></footer></button>`).join('')}<button class="add-card" data-action="new-task" data-status="${key}">${icon('plus')}添加任务</button></section>`).join('')}</div>`}`;
}
function recentItems() { return [...state.updates,...state.releases].sort((a,b)=>b.date.localeCompare(a.date)); }
function files() {
  return `${pageHead('更新与文件','让信息跟上项目，让文件随手可得。','new-update','发布更新')}${filters()}<div class="section-heading"><h2>项目文件<span class="section-number">${documents.filter(d=>matches(d)||d.track==='all').length}</span></h2><span class="muted small">${window.echooStaticStorage?'发布时的项目文档快照':'来自当前项目文档'}</span></div><section class="document-grid">${documents.filter(d=>matches(d)||d.track==='all').map(d=>`<button class="document-card" data-action="document" data-id="${d.id}"><span class="document-icon ${tracks[d.track]?.tone||'orange'}">${icon('file')}</span><strong>${esc(d.title)}</strong><span class="document-path">${esc(d.path)}</span><footer><span>${tracks[d.track]?.name||'跨工作线'} · Markdown</span>${icon('arrow')}</footer></button>`).join('')}</section><div class="section-heading"><h2>协作动态</h2></div><section class="panel updates-feed">${state.updates.filter(matches).map(u=>`<button class="update-row" data-action="update-detail" data-id="${esc(u.id)}">${avatar(u.track)}<div><strong>${esc(u.title)}</strong><p>${esc(u.description)}</p><small>${esc(state.owners[u.track])} · ${u.date}</small></div>${tag(u.track)}</button>`).join('') || empty('把最新进展留在这里','发布一条更新，让另外两位伙伴知道正在发生什么。','new-update','写第一条更新')}</section>`;
}
function empty(title,text,action,label) { return `<div class="empty-state">${icon('layers')}<h3>${title}</h3><p>${text}</p>${action?`<button class="button secondary" data-action="${action}">${icon('plus')}${label}</button>`:''}</div>`; }
function ideas() {
  return `${pageHead('产品灵感池','先记下好想法，再一起决定下一步。','new-idea','记录灵感')}${filters()}<div class="idea-intro"><span class="idea-spark">✳</span><div><strong>下一次突破，也许来自一个小念头。</strong><p>收集产品、交互与视觉想法。采纳后可以转成协作待办。</p></div><span class="idea-total">${state.ideas.filter(matches).length}<small>个想法</small></span></div><div class="idea-grid">${state.ideas.filter(matches).map(i=>`<article class="idea-card ${tracks[i.track].tone}"><div>${tag(i.track)}<span class="idea-state">${{new:'新想法',discuss:'讨论中',adopted:'已采纳'}[i.status]}</span></div><h2>${esc(i.title)}</h2><p>${esc(i.description)}</p><footer><span>${avatar(i.track)}${esc(state.owners[i.track])}</span><button class="text-button" data-action="edit-idea" data-id="${esc(i.id)}">查看 ${icon('arrow')}</button></footer></article>`).join('')}</div>${state.ideas.filter(matches).length?'':`<section class="panel">${empty('灵感池，等你的第一个想法','一个使用场景、一段交互，或一种新的模版表达。','new-idea','记录第一个灵感')}</section>`}`;
}
function history() {
  return `${pageHead('迭代记录','每一次向前，都值得被记下来。','new-release','记录迭代')}${filters()}<div class="timeline">${state.releases.filter(matches).sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<article class="timeline-item"><div class="timeline-date">${r.date.slice(5).replace('-',' / ')}<span>${r.date.slice(0,4)}</span></div><span class="timeline-point ${tracks[r.track].tone}"></span><div class="timeline-content panel"><div>${tag(r.track)}<span class="version">${esc(r.version)}</span></div><h2>${esc(r.title)}</h2><p>${esc(r.description)}</p><footer><span>${avatar(r.track)}${esc(state.owners[r.track])}</span><button class="text-button" data-action="${r.source?'document':'release-detail'}" data-id="${esc(r.source||r.id)}">${r.source?'查看来源':'查看记录'}${icon('arrow')}</button></footer></div></article>`).join('') || empty('还没有迭代记录','记录一次值得留下的变化。')}</div>`;
}
function specs() {
  const entries=[
    ['hardware','hardware','外壳与实体装配','一体前壳 · 隐藏按钮固定 · 先小样后整壳','几何验证与实物验收分开记录。尺寸与安装空间以实物试配为准。'],
    ['software','migration','App 结构与真实连接','回忆日历首页 · 两步引导 · 真实设备回执','保留 BLE、Wi-Fi、认领与保存流程；日历使用已确认的设备展示记录。'],
    ['template','templates','现行四款模版','日常拼贴 / 圣诞手帐 / 分层抠图 / 宠物牛仔','只使用已确认的四款目录。运行依赖不足时明确标为不可用。'],
    ['software','release','预览确认与版本发布','Demo 确认 → App 迁移 → TestFlight 核对','保留代码快照、安装包、版本和构建号；上传完成不等于测试者已可更新。']
  ];
  return `${pageHead('产品规范','让共同确认的原则，成为协作的依据。')}${filters()}<section class="spec-list">${entries.filter(e=>filter==='all'||e[0]===filter).map(([track,source,title,subtitle,description],i)=>`<button class="spec-card panel" data-action="document" data-id="${source}"><span class="spec-number">0${i+1}</span><div><div>${tag(track)}<span class="small muted">项目文档</span></div><h2>${title}</h2><strong>${subtitle}</strong><p>${description}</p></div>${icon('arrow')}</button>`).join('')}</section><div class="source-note">${icon('link')}此处引用现有规范；查看原文可以核对适用范围和历史状态。</div>`;
}
function field(label,content,cls='') { return `<label class="field ${cls}"><span>${label}</span>${content}</label>`; }
function selectTrack(value) { return `<select name="track">${Object.entries(tracks).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v.name} · ${esc(state.owners[k])}</option>`).join('')}</select>`; }
function formEnd(label='保存') { return `<p class="form-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-action="close">取消</button><button class="button primary" type="submit">${label}</button></div></form>`; }
function openTask(id, status='todo', prefill) {
  const t=state.tasks.find(t=>t.id===id) || {title:'',track:filter==='all'?'hardware':filter,status,priority:'normal',due:'',description:'',source:'',...prefill};
  openDialog(id?'待办详情':'新建待办',`<form id="task-form" data-id="${esc(id||'')}">${field('任务名称',`<input name="title" required maxlength="160" value="${esc(t.title)}" placeholder="这件事，具体要完成什么？">`)}<div class="form-grid">${field('工作线与负责人',selectTrack(t.track))}${field('任务状态',`<select name="status">${Object.entries(statuses).map(([k,v])=>`<option value="${k}" ${k===t.status?'selected':''}>${v}</option>`).join('')}</select>`)}${field('优先级',`<select name="priority"><option value="normal">普通</option><option value="high" ${t.priority==='high'?'selected':''}>优先推进</option></select>`)}${field('截止日期（可选）',`<input name="due" type="date" value="${esc(t.due)}">`)}</div>${field('说明与验收标准',`<textarea name="description" rows="4" maxlength="12000" placeholder="补充背景、依赖或完成条件…">${esc(t.description)}</textarea>`)}${t.source?`<button type="button" class="text-button source-button" data-action="document" data-id="${t.source}">${icon('file')}查看来源文档</button>`:''}${formEnd(id?'保存修改':'创建待办')}`);
}
function openEntry(kind,id) {
  const config={idea:['ideas','记录灵感'],update:['updates','发布更新'],release:['releases','记录迭代']}[kind];
  const entry=state[config[0]].find(i=>i.id===id)||{title:'',description:'',track:filter==='all'?'hardware':filter,date:today(),status:'new',version:''};
  openDialog(config[1],`<form id="entry-form" data-kind="${kind}" data-id="${esc(id||'')}">${field('标题',`<input name="title" value="${esc(entry.title)}" required maxlength="160" placeholder="用一句话说清楚…">`)}<div class="form-grid">${field('工作线与负责人',selectTrack(entry.track))}${kind==='idea'?field('状态',`<select name="status">${[['new','新想法'],['discuss','讨论中'],['adopted','已采纳']].map(([k,v])=>`<option value="${k}" ${entry.status===k?'selected':''}>${v}</option>`).join('')}</select>`):field('日期',`<input type="date" name="date" value="${esc(entry.date)}" required>` )}</div>${kind==='release'?field('版本标识',`<input name="version" required value="${esc(entry.version)}" maxlength="80" placeholder="例如 v0.4.3 · 结构试装">`):''}${field('详细内容',`<textarea name="description" rows="5" maxlength="12000" required placeholder="记录变化、观察，或值得一起讨论的事…">${esc(entry.description)}</textarea>`)}${id&&kind==='idea'?`<button type="button" class="text-button" data-action="idea-to-task" data-id="${esc(id)}">${icon('plus')}基于此灵感创建待办</button>`:''}${formEnd('保存记录')}`);
}
async function openDocument(id) {
  openDialog('正在读取文档…',`<div class="empty-inline">${window.echooStaticStorage?'读取发布时的文档快照':'读取当前项目源文件'}</div>`,'wide-dialog');
  try {
    const doc=await api('/api/document?id='+encodeURIComponent(id));
    if(!dialog.open) return;
    $('#dialog-title').textContent=doc.title;
    dialog.insertAdjacentHTML('beforeend',`<div class="doc-meta"><code>${esc(doc.path)}</code><button class="button secondary" data-action="download-doc">${icon('download')}下载原文</button></div><pre class="document-content">${esc(doc.content)}</pre>`);
    $('.empty-inline',dialog).remove(); openDocument.current=doc;
  } catch(error) { $('.empty-inline',dialog).textContent=error.message; }
}
function openTeam() {
  openDialog('三条工作线，三位负责人',`<p class="dialog-description">负责人会自动关联对应工作线的待办、更新与迭代记录。</p><form id="team-form">${Object.entries(tracks).map(([key,t])=>`<div class="member-edit"><span class="track-icon ${t.tone}">${icon(t.icon)}</span>${field(t.name,`<input name="${key}" value="${esc(state.owners[key])}" required maxlength="40" autocomplete="off">`)}</div>`).join('')}${formEnd('保存负责人')}`);
}
function openSearch() {
  openDialog('搜索工作空间',`<label class="search-input">${icon('search')}<input id="global-search" placeholder="搜索任务、文档、灵感或迭代…" aria-label="搜索任务、文档、灵感或迭代"></label><div id="search-results"></div>`,'search-dialog');
  searchQuery=''; renderSearch(); $('#global-search').focus();
}
function renderSearch() {
  const all=[...state.tasks.map(i=>({...i,action:'edit-task',type:'待办'})),...documents.map(i=>({...i,action:'document',type:'文件'})),...state.ideas.map(i=>({...i,action:'edit-idea',type:'灵感'})),...state.releases.map(i=>({...i,action:i.source?'document':'release-detail',id:i.source||i.id,type:'迭代'})),...state.updates.map(i=>({...i,action:'update-detail',type:'更新'}))];
  const found=all.filter(i=>(i.title+' '+(i.description||'')+' '+(state.owners[i.track]||'')).toLowerCase().includes(searchQuery.toLowerCase()));
  $('#search-results').innerHTML=`<p class="small muted">${searchQuery?`${found.length} 条匹配结果`:'快速访问'}</p>${found.slice(0,25).map(i=>`<button class="search-result" data-action="${i.action}" data-id="${esc(i.id)}"><span class="result-type">${i.type}</span><span>${esc(i.title)}</span>${icon('chevron')}</button>`).join('') || '<div class="empty-inline">没有找到相关内容，试试另一个关键词。</div>'}`;
}
function showEntry(id, kind) {
  const item=state[kind].find(i=>i.id===id); if(!item) return;
  openDialog(item.title,`<div class="entry-detail">${tag(item.track)}<span class="muted small">${esc(item.date)} · ${esc(state.owners[item.track])}</span><p>${esc(item.description)}</p></div>`);
}
document.addEventListener('click',async(event)=>{
  const el=event.target.closest('[data-action]'); if(!el)return;
  const {action,id}=el.dataset;
  if(action==='close') dialog.close();
  if(action==='filter') go(route(),id);
  if(action==='track-tasks') {taskStatus='all';go('tasks',id);}
  if(action==='team') openTeam();
  if(action==='search') openSearch();
  if(action==='new-task') openTask(null,el.dataset.status||'todo');
  if(action==='edit-task') openTask(id);
  if(action==='view') {taskView=id;render();}
  if(action==='toggle-task') {
    const t=state.tasks.find(t=>t.id===id); if(!t)return;
    const status=t.status==='done'?'todo':'done';
    await save(next=>{next.tasks.find(t=>t.id===id).status=status;activity(next,`${statuses[status]}：${t.title}`,t.track);},status==='done'?'任务已完成':'任务已重新打开');
  }
  if(action==='document') openDocument(id);
  if(action==='new-idea') openEntry('idea');
  if(action==='edit-idea') openEntry('idea',id);
  if(action==='new-update') openEntry('update');
  if(action==='new-release') openEntry('release');
  if(action==='update-detail') showEntry(id,'updates');
  if(action==='release-detail') showEntry(id,'releases');
  if(action==='idea-to-task') {const idea=state.ideas.find(i=>i.id===id);openTask(null,'todo',{title:idea.title,track:idea.track,description:idea.description});}
  if(action==='download-doc') {const doc=openDocument.current;const url=URL.createObjectURL(new Blob([doc.content],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=doc.path.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
});
document.addEventListener('submit',async event=>{
  if(!dialog.contains(event.target)) return;
  event.preventDefault();
  const form=event.target, values=Object.fromEntries(new FormData(form));
  Object.keys(values).forEach(k=>values[k]=values[k].trim());
  if(Object.entries(values).some(([k,v])=>!v&&['title','hardware','software','template','version'].includes(k))) { $('.form-error',form).textContent='请填写完整，不能只输入空格。';return; }
  let ok=false;
  if(form.id==='team-form') ok=await save(next=>{next.owners=values;},'三位负责人已更新');
  if(form.id==='task-form') {
    const existing=state.tasks.find(t=>t.id===form.dataset.id);
    const item={...values,id:existing?.id||uid('TASK'),source:existing?.source||''};
    ok=await save(next=>{if(existing) next.tasks=next.tasks.map(t=>t.id===item.id?item:t);else next.tasks.unshift(item);activity(next,`${existing?'更新':'新建'}待办：${item.title}`,item.track,item.description);},existing?'待办已更新':'待办已创建');
  }
  if(form.id==='entry-form') {
    const kind=form.dataset.kind, key={idea:'ideas',update:'updates',release:'releases'}[kind];
    const existing=state[key].find(i=>i.id===form.dataset.id);
    const item={...values,id:existing?.id||uid(kind.toUpperCase()),date:values.date||existing?.date||today()};
    if(kind==='release') item.source=existing?.source||'';
    ok=await save(next=>{if(existing)next[key]=next[key].map(i=>i.id===item.id?item:i);else next[key].unshift(item);},'记录已保存');
  }
  if(ok) dialog.close();
});
document.addEventListener('change',event=>{if(event.target.id==='status-filter'){taskStatus=event.target.value;render();}});
document.addEventListener('input',event=>{if(event.target.id==='global-search'){searchQuery=event.target.value;renderSearch();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='k'){event.preventDefault();if(state)openSearch();}});
$('#menu-button').addEventListener('click',()=>{const open=$('#sidebar').classList.toggle('mobile-open');$('#menu-button').setAttribute('aria-expanded',String(open));});
function closeMenu() { $('#sidebar').classList.remove('mobile-open'); $('#menu-button').setAttribute('aria-expanded','false'); }
document.addEventListener('click',event=>{
  if(!event.target.closest('#sidebar, #menu-button')) closeMenu();
  if(event.target.closest('.skip-link')) {event.preventDefault();$('#main').focus();$('#main').scrollIntoView();}
});
document.addEventListener('keydown',event=>{if(event.key==='Escape') closeMenu();});
dialog.addEventListener('click',event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)dialog.close();}});
window.addEventListener('hashchange',()=>{if(state){render();window.scrollTo(0,0);}});
Promise.all([api('/api/state'),api('/api/documents')]).then(([s,d])=>{state=s;documents=d;render();}).catch(error=>{$('#main').innerHTML=`<div class="empty-state"><h1>暂时无法打开工作空间</h1><p>${esc(error.message)}</p><button class="button primary" id="retry">重新加载</button></div>`;$('#retry').onclick=()=>location.reload();});
