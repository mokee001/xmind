/* Four guide stages. This adapter only talks to the local fixture server. */
const M=window.OnboardingV2;
let state=M.initial(),fixture=null,fixtureError='',scenario='normal',variant=0;
let timers=[],requestVersion=0,loadingWall=false,retriedConnection=false,allPeople=false;
const screen=document.getElementById('screen'),dialog=document.getElementById('dialog');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,cls='primary',disabled=false)=>`<button class="${cls}" data-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
const title=(n,text,description)=>`<p class="eyebrow">${n} / ${M.guideSteps.length} · ${M.guideSteps[n-1]}</p><h2 tabindex="-1">${text}</h2><p class="intro">${description}</p>`;
const count=()=>M.allowedIds(state,fixture).length;
const scopeText=()=>state.mode==='include'?`包含所选 ${state.personIds.length} 位人物的精选`:'全部精选照片';
const scheduleText=()=>state.schedule==='daily'?`每天 ${state.time} 自动换组`:'不自动更新，手动换组';
const themeText=()=>state.themeIds.length?'优先安排：'+fixture.themes.filter(t=>state.themeIds.includes(t.id)).map(t=>t.label).join('、'):'主题自然安排';
const errorBox=()=>state.error?`<p class="notice error" role="alert">${esc(state.error)}</p>`:'';
function progress(){
  const ready=state.processing==='ready',failed=state.processing==='failed';
  return `<div class="progress-card" role="status"><span class="${ready||failed?'status-mark':'spinner'}">${ready?'✓':failed?'!':''}</span><div><strong>${failed?'整理暂停，设置已保留':ready?'照片已就绪，等待你确认':'正在整理照片，你可以先设置'}</strong></div><span class="micro">模拟</span></div>`;
}

function selectionNote(){
  if(state.mode!=='include')return '不选人物，使用全部精选。';
  if(!state.personIds.length)return '再选一位人物，或点击“不限人物”。';
  if(!count())return '所选人物暂时没有入选照片。换个人，或选择不限人物。';
  if(count()<fixture.photos_per_wall)return `匹配 ${count()} 张，当前照片墙需要 ${fixture.photos_per_wall} 张。可以再选几位人物。`;
  return `已选 ${state.personIds.length} 位，匹配 ${count()} 张精选。合照中也可能有其他人。`;
}
function themeNote(){
  if(!state.themeIds.length||!fixture)return '';
  const ids=new Set(state.mode==='include'?M.allowedIds(state,fixture):fixture.photo_ids);
  const empty=fixture.themes.filter(t=>state.themeIds.includes(t.id)&&!t.photo_ids.some(id=>ids.has(id)));
  return empty.length?`${empty.map(t=>t.label).join('、')}：当前范围暂无匹配，保留偏好，不补入其他照片。`:'';
}
function settingsDisabled(){
  return !fixture||Boolean(fixtureError)||!M.validThemes(state,fixture)||
    (state.mode==='include'&&(!M.validScope(state,fixture)||state.phase<2||count()<fixture.photos_per_wall))||
    (state.schedule==='daily'&&!M.validTime(state.time));
}
function settingsLabel(){return state.mode==='include'?'确认所选人物，生成预览':'使用全部精选，生成预览';}
function peopleSection(){
  let html=`<section class="people-section" aria-labelledby="people-heading"><div class="preference-heading"><h3 id="people-heading">想看到谁？</h3><button class="quiet" data-action="all-people" ${state.mode==='include'?'':'hidden'}>不限人物</button></div><p class="preference-hint">来自整个相册，点头像选择，再点取消。</p>`;
  if(!fixture||fixtureError)html+=`<p class="notice error">${esc(fixtureError||'正在读取本地人物样本。')}</p>${button('重新读取样本','reload-data','quiet')}`;
  else if(state.phase<2)html+='<p class="people-pending" role="status"><span class="spinner"></span>正在准备相册中的人物，可以先选下面的主题。</p>';
  else if(!fixture.people.length)html+='<p class="fine">相册中暂未找到可选择的人物，不影响使用全部精选。</p>';
  else html+=`<div class="avatar-bubbles" role="group" aria-label="整个相册中的人物">${(allPeople?fixture.people:fixture.people.slice(0,6)).map(p=>`<button class="avatar-bubble" data-person="${esc(p.id)}" aria-pressed="${state.mode==='include'&&state.personIds.includes(p.id)}" aria-label="${esc(p.title)}，相册中 ${p.library_photo_count} 张照片" title="${esc(p.title)} · 相册中 ${p.library_photo_count} 张"><img src="${esc(p.image)}" alt="" width="80" height="80" loading="lazy"></button>`).join('')}</div>${fixture.people.length>6?`<button class="quiet more-people" data-action="more-people" aria-expanded="${allPeople}">${allPeople?'收起更多人物':`查看全部 ${fixture.people.length} 个人物组`}</button>`:''}`;
  return html+`<p id="people-selection-summary" class="preference-hint" role="status">${esc(selectionNote())}</p></section>`;
}
function themeSection(){
  if(!fixture||fixtureError)return '';
  return `<section class="theme-section" aria-labelledby="theme-heading"><h3 id="theme-heading">想多看到哪些照片？</h3><p class="preference-hint">选中的主题优先安排，不选也会自然搭配。</p><div class="theme-options" role="group" aria-label="照片主题偏好">${fixture.themes.map(t=>`<button class="theme-option" data-theme="${esc(t.id)}" aria-pressed="${state.themeIds.includes(t.id)}" aria-label="${esc(t.label+'，'+t.detail)}"><span class="theme-symbol" aria-hidden="true">${esc(t.icon)}</span><span><strong>${esc(t.label)}</strong><small>${esc(t.detail)}</small></span><span class="theme-check" aria-hidden="true">✓</span></button>`).join('')}</div><p id="theme-selection-summary" class="preference-hint" role="status">${esc(themeNote())}</p></section>`;
}
function syncPreferenceControls(){
  // Keep avatar nodes mounted so scale(1.1) transitions instead of replacing the bubble.
  screen.querySelectorAll('[data-person]').forEach(el=>el.setAttribute('aria-pressed',state.mode==='include'&&state.personIds.includes(el.dataset.person)));
  screen.querySelectorAll('[data-theme]').forEach(el=>el.setAttribute('aria-pressed',state.themeIds.includes(el.dataset.theme)));
  const clear=screen.querySelector('[data-action="all-people"]');if(clear)clear.hidden=state.mode!=='include';
  const note=document.getElementById('people-selection-summary');if(note)note.textContent=selectionNote();
  const themes=document.getElementById('theme-selection-summary');if(themes)themes.textContent=themeNote();
  const confirm=screen.querySelector('[data-action="confirm-settings"]');
  if(confirm){confirm.disabled=settingsDisabled();confirm.textContent=settingsLabel();}
}

function footer(){
  const index=M.guideIndex(state);
  document.getElementById('step-progress').style.width=`${Math.min(100,(index+1)*100/M.guideSteps.length)}%`;
  document.querySelectorAll('#journey li').forEach((el,i)=>{el.classList.toggle('active',i===index);el.classList.toggle('done',i<index);});
  document.getElementById('back').hidden=['welcome','permission','current'].includes(state.step);
}
function render(){
  const oldPage=screen.dataset.step,focused=document.activeElement;
  const focusKey=focused?.dataset?.theme?['theme',focused.dataset.theme]:focused?.dataset?.person?['person',focused.dataset.person]:focused?.dataset?.action?['action',focused.dataset.action]:focused?.id?['id',focused.id]:null;
  const previousDetails=new Set([...screen.querySelectorAll('details[open]')].map(d=>d.id));
  const page=state.step==='permission'?'welcome':state.step;
  screen.dataset.step=page;
  let html='';
  if(page==='welcome'){
    html=`<section class="welcome v2-welcome">${title(1,'让回忆，<br>自然回到生活里。','允许访问相册，自动搭配照片墙。<br>不用逐张挑选，展示前先给你看。')}<div class="wall-scene"><img class="hero-wall" src="/sample-wall" alt="本地精选照片组成的完整照片墙样本"><span class="photo-caption">已保存的照片墙样本</span></div><p class="permission-summary">相册授权 ≠ 立即上墙。你确认后才展示。</p>${errorBox()}${button('开始并授权相册','start')}<details class="privacy" id="privacy"><summary>照片隐私与演示说明</summary><p>本 Demo 只读取已有本地素材，不访问手机相册、不上传照片、不连接真实设备。</p><p>正式 App 的候选照片可能仍需上传。接入前须准确说明上传内容与保留时间，不能把本 Demo 的本地处理说明当作线上隐私承诺。</p></details></section>`;
  }else if(page==='device'){
    const searching=state.deviceStatus==='searching',connecting=state.deviceStatus==='connecting';
    html=`${title(2,'连接照片墙','请给照片墙通电，并把手机放在附近。')}<div class="device-card"><div><span class="micro">演示设备</span><h3>Echooo 照片墙</h3><p role="status">${searching?'正在查找附近设备…':connecting?'正在连接，请稍候…':state.deviceStatus==='error'?'上次连接未完成':'已找到，可以连接'}</p></div><span class="${searching||connecting?'spinner':'status-mark'}">${searching||connecting?'':'✓'}</span></div><div class="network-summary"><span>使用网络</span><strong>Echooo Demo Wi-Fi</strong><p>本次模拟配网，无需输入密码。</p></div>${errorBox()}<div class="actions">${button(connecting?'正在连接…':searching?'正在查找…':state.deviceStatus==='error'?'重新连接':'连接这面照片墙','connect','primary',searching||connecting)}</div><p class="fine center">连接成功后会自动进入展示设置。</p>`;
  }else if(page==='settings'){
    html=`${title(3,'展示哪些照片？','选人物、选主题，都在这一页。')}${progress()}${peopleSection()}${themeSection()}`;
    html+=`<div class="update-setting"><label class="switch-row" for="auto-update"><span><strong>自动更新照片墙</strong><small>${state.schedule==='daily'?'已开启，按以下时间换组':'未开启 · 先保留第一面'}</small></span><input id="auto-update" type="checkbox" role="switch" ${state.schedule==='daily'?'checked':''}></label>${state.schedule==='daily'?`<div class="time-setting"><label for="update-time">每天更新时间</label><input id="update-time" type="time" value="${esc(state.time)}" required></div><p class="boundary-note">之后会在这个时间自动换组，不再逐组确认。</p>`:'<p class="fine">想换时再手动换，不会突然出现新照片。</p>'}</div>${errorBox()}<div class="actions">${button(settingsLabel(),'confirm-settings','primary',settingsDisabled())}</div><p class="fine center">点击即确认人物范围、主题偏好和更新方式。</p>`;
  }else if(page==='preview'){
    const w=state.wall,failed=Boolean(state.error)||state.processing==='failed';
    html=`${title(4,'确认你的第一面照片墙',w?'喜欢这组，再让它出现在照片墙上。':'正在准备预览，不需要继续操作。')}<figure class="wall-preview v2-wall">${w?`<img id="wall-image" src="${esc(w.image)}" alt="${esc(w.title)}完整照片墙">`:`<div class="wall-placeholder"><span class="${failed?'status-mark':'spinner'}">${failed?'!':''}</span><strong>${failed?'暂时无法准备预览':loadingWall?'正在搭配照片墙':'正在整理照片'}</strong><p>${failed?'设置已保留，没有照片上墙':'准备好后，照片墙会直接显示在这里'}</p></div>`}<figcaption>${w?`${esc(w.title)} · ${w.photo_ids.length} 张照片`:'演示进度 · 不是实际识别测速'}</figcaption></figure><div class="preview-boundary"><p>${esc(scopeText())}</p><p>${esc(themeText())}</p><strong>${esc(scheduleText())}</strong></div>${errorBox()}<div class="actions">${state.processing==='failed'?button('保留设置，重试整理','retry','secondary'):state.error?button('重试预览','retry-wall','secondary'):''}${button(state.publishing?'正在模拟上屏…':'确认并展示这组照片','publish','primary',!w||failed||state.publishing)}${w?button('看看另一组','next','quiet'):''}${button('修改展示设置','edit','quiet')}</div>${!w&&state.processing==='running'?`<details class="demo-shortcut"><summary>演示控制</summary>${button('模拟：立即完成整理','finish-now','quiet')}</details>`:''}`;
  }else if(page==='current'){
    html=`<div class="live-label"><span></span>当前展示 · 本地模拟</div><h2 tabindex="-1">${state.held?'让喜欢的，多留一会儿。':'这一面，先陪你过今天。'}</h2><figure class="wall-preview v2-wall"><img src="${esc(state.current.image)}" alt="本次确认的完整照片墙"><figcaption>${esc(state.current.title)} · 模拟展示成功</figcaption></figure><div class="preview-boundary"><p>${esc(scopeText())}</p><p>${esc(themeText())}</p><strong>${state.held?'暂停更新，恢复前不自动换组':esc(scheduleText())}</strong></div><div class="actions">${button(state.held?'恢复更新安排':'多留一会儿',state.held?'resume':'hold','secondary')}${button('看看下一组','next')}${button('修改展示设置','edit','quiet')}</div><p class="fine center">没有向真实设备发送照片。</p>`;
  }
  screen.innerHTML=html;footer();
  if(oldPage===page){
    for(const id of previousDetails){const d=document.getElementById(id);if(d)d.open=true;}
    if(focusKey){const [kind,value]=focusKey;const target=kind==='id'?document.getElementById(value):screen.querySelector(`[data-${kind}="${CSS.escape(value)}"]`);target?.focus({preventScroll:true});}
  }else{screen.scrollTop=0;screen.querySelector('h2')?.focus({preventScroll:true});}
  const wallImage=document.getElementById('wall-image');
  if(wallImage)wallImage.addEventListener('error',()=>{
    invalidateRequest();state=M.reduce(state,{type:'ERROR',message:'照片墙图片无法读取，请重试。尚未上墙。'},fixture);state.wall=null;render();
  },{once:true});
}
function dispatch(event){
  state=M.reduce(state,event,fixture);
  // Keep the time input stable while the background job updates.
  if(['PERSON','THEME','MODE'].includes(event.type)&&state.step==='settings'){
    syncPreferenceControls();
  }else if(event.type==='READY'&&state.step==='settings'&&screen.querySelector('.avatar-bubbles')){
    screen.querySelector('.progress-card').outerHTML=progress();footer();
  }else render();
  if(state.step==='preview'&&M.canPreview(state)&&!state.wall&&!loadingWall&&!state.error)loadWall();
}
const later=(fn,ms)=>timers.push(setTimeout(fn,ms));
function clearTimers(){timers.forEach(clearTimeout);timers=[];}
function invalidateRequest(){requestVersion++;loadingWall=false;}
function beginProcessing(retry=false){
  clearTimers();
  later(()=>dispatch({type:'PHASE',phase:2}),scenario==='fast'?100:1200);
  later(()=>{
    if(!fixture||fixtureError){dispatch({type:'FAILED',message:fixtureError||'本地样本未就绪，请重试。'});return;}
    dispatch({type:scenario==='processing-error'&&!retry?'FAILED':'READY'});
  },scenario==='fast'?300:scenario==='slow'?60000:6500);
}
async function loadFixture(){
  try{
    const response=await fetch('/api/fixture',{cache:'no-store'}),data=await response.json();
    if(!response.ok)throw Error(data.error||'暂时无法读取本地样本。');
    if(fixture&&fixture.scope!==data.scope){reset(scenario);fixture=data;throw Error('照片版本已变化，请重新确认设置。');}
    fixture=data;fixtureError='';render();
  }catch(e){fixtureError=e.message;render();}
}
async function loadWall(){
  if(!fixture||loadingWall||!M.canPreview(state)||state.step!=='preview')return;
  const token=++requestVersion,requestScope={mode:state.mode,person_ids:[...state.personIds],theme_ids:[...state.themeIds]};loadingWall=true;render();
  try{
    const check=await fetch('/api/fixture',{cache:'no-store'}),current=await check.json();
    if(!check.ok||current.scope!==fixture.scope)throw Error(current.error||'照片版本已变化，请重新确认。');
    if(token!==requestVersion)return;
    const response=await fetch('/api/walls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:fixture.scope,...requestScope,variant})});
    const w=await response.json();if(token!==requestVersion)return;
    if(!response.ok)throw Error(w.error||'预览准备失败。');
    if(w.status==='insufficient')throw Error(`所选范围只有 ${w.visible_count} 张照片，模板需要 ${w.required_count} 张。请修改范围；不会补入其他照片。`);
    if(!M.validWall(state,fixture,w))throw Error('照片超出展示范围，预览已停止。');
    await new Promise((resolve,reject)=>{const img=new Image();img.onload=resolve;img.onerror=()=>reject(Error('照片墙图片未加载，请重试。'));img.src=w.image;});
    if(token!==requestVersion)return;loadingWall=false;dispatch({type:'WALL',wall:w});
  }catch(e){if(token===requestVersion){loadingWall=false;dispatch({type:'ERROR',message:e.message});}}
}
function reset(next='normal'){clearTimers();invalidateRequest();scenario=next;state=M.initial(next);variant=0;allPeople=false;retriedConnection=false;if(dialog.open)dialog.close();render();}
function showDialog(html){dialog.innerHTML=html;const heading=dialog.querySelector('h2');if(heading)heading.id='dialog-title';dialog.showModal();}
function permissionDialog(){
  dispatch({type:'START'});
  showDialog(`<h2>允许访问相册？</h2><p class="intro">用于自动整理照片、搭配照片墙。<br>不会因为授权就立即上墙。</p>${button('允许访问（模拟）','grant')}${button('暂不允许','deny','quiet')}<p class="fine">这是权限弹窗模拟，不请求真实系统权限。</p>`);
}
function demoInfo(){showDialog(`<h2 id="dialog-title">四步引导 · Demo v2.2</h2><p>授权相册 → 连接照片墙 → 展示设置 → 预览上墙。</p><p>权限弹窗属于第一步，不另算一步；查找和连接留在第二步。整理过程中可以先设置，预览就绪后原页显示结果，不新增等待页。</p><p>默认不自动更新，范围和上墙都由你确认。四步是任务分组，默认顺利路径仍需 5 次点击，包含权限确认；指定人物、定时更新和失败重试按需操作。正式 App 的系统权限、网络与密码输入也可能增加操作。</p><p>人物头像来自整个图库的已有识别分组；未归组人脸不会当作确定人物，已确认合并保留。照片墙仍从已保存精选中匹配，主题只调整预览安排顺序，不修改精选规则。授权、配网、整理耗时和上屏均为模拟，不上传照片、不改 App 或原有偏好。</p><label for="mobile-scenario">体验其他情况</label><select id="mobile-scenario"><option value="normal">正常整理</option><option value="fast">照片先准备好</option><option value="slow">设置先完成</option><option value="processing-error">整理失败后重试</option><option value="connection-error">连接失败后重试</option></select>${button('按此情况重新体验','mobile-restart','secondary')}${button('返回体验','close-dialog')}<p class="fine">${fixture?`${fixture.album_count} 个已保存精选集 · ${fixture.first_layer_count} 张唯一照片`:'样本读取中'}</p>`);}
document.addEventListener('click',async e=>{
  const person=e.target.closest('[data-person]');if(person){invalidateRequest();dispatch({type:'PERSON',id:person.dataset.person});return;}
  const theme=e.target.closest('[data-theme]');if(theme){invalidateRequest();dispatch({type:'THEME',id:theme.dataset.theme});return;}
  const el=e.target.closest('[data-action]');if(!el||el.disabled)return;
  const a=el.dataset.action;
  if(a==='start')permissionDialog();
  if(a==='grant'){dialog.close();dispatch({type:'GRANT'});later(()=>dispatch({type:'DEVICE_FOUND'}),500);}
  if(a==='deny'){dialog.close();clearTimers();invalidateRequest();dispatch({type:'DENY'});}
  if(a==='connect'){
    dispatch({type:'CONNECT'});if(state.deviceStatus!=='connecting')return;
    later(()=>{
      if(scenario==='connection-error'&&!retriedConnection){retriedConnection=true;dispatch({type:'CONNECTION_FAILED'});return;}
      const wasIdle=state.processing==='idle';dispatch({type:'CONNECTED'});if(wasIdle)beginProcessing();
    },1100);
  }
  if(a==='all-people'){invalidateRequest();dispatch({type:'MODE',mode:'all'});}
  if(a==='more-people'){allPeople=!allPeople;render();}
  if(a==='confirm-settings'){invalidateRequest();variant=0;dispatch({type:'CONFIRM_SETTINGS'});}
  if(a==='edit'){invalidateRequest();dispatch({type:'EDIT'});}
  if(a==='next'){invalidateRequest();variant++;dispatch({type:'NEXT'});}
  if(a==='publish'){
    dispatch({type:'CONFIRM_WALL'});if(!state.publishing)return;
    const token=requestVersion,wallId=state.wall.id;
    try{
      const response=await fetch('/api/fixture',{cache:'no-store'}),latest=await response.json();
      if(token!==requestVersion||wallId!==state.wall?.id)return;
      if(!response.ok||latest.scope!==fixture.scope)throw Error(latest.error||'照片版本已变化，请重新确认范围。');
      dispatch({type:'PUBLISHED',wallId});
    }catch(e){if(token===requestVersion)dispatch({type:'ERROR',message:e.message});}
  }
  if(a==='retry'){await loadFixture();dispatch({type:'RETRY'});beginProcessing(true);}
  if(a==='retry-wall'){invalidateRequest();state.wall=null;dispatch({type:'CLEAR_ERROR'});}
  if(a==='reload-data')loadFixture();
  if(a==='finish-now'){clearTimers();if(fixture&&!fixtureError)dispatch({type:'READY'});else dispatch({type:'FAILED',message:fixtureError||'样本未就绪。'});}
  if(a==='hold')dispatch({type:'HOLD'});if(a==='resume')dispatch({type:'RESUME'});
  if(a==='close-dialog')dialog.close();if(a==='mobile-restart')reset(document.getElementById('mobile-scenario').value);
});
document.addEventListener('change',e=>{
  if(e.target.id==='auto-update'){invalidateRequest();dispatch({type:'SCHEDULE',value:e.target.checked?'daily':'off'});}
  if(e.target.id==='update-time'){invalidateRequest();dispatch({type:'TIME',value:e.target.value});}
});
dialog.addEventListener('cancel',()=>{if(state.step==='permission')dispatch({type:'CANCEL_PERMISSION'});});
document.getElementById('restart').onclick=()=>reset(scenario);
document.getElementById('apply-scenario').onclick=()=>reset(document.getElementById('scenario').value);
document.getElementById('demo-info').onclick=demoInfo;
document.getElementById('back').onclick=()=>{invalidateRequest();if(state.step==='device')clearTimers();dispatch({type:'BACK'});};
render();loadFixture();
