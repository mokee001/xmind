/* Local-only prototype. Hardware, permissions and analysis timing are simulated. */
const M = window.OnboardingState;
let state = M.initial(), fixture = null, fixtureError = '', variant = 0;
let timers = [], requestVersion = 0, connecting = false, retriedConnection = false;
let wallLoading = false, allPeople = false, scenario = 'normal';
const screen = document.getElementById('screen'), dialog = document.getElementById('dialog');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (text, action, cls='primary', disabled=false) => `<button class="${cls}" data-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
const count = () => M.allowedIds(state,fixture).length;
const scopeText = () => state.mode==='all'?'全部精选照片':`包含所选 ${state.personIds.length} 位人物的精选照片`;
const scheduleText = () => state.schedule==='daily'?`每天 ${state.time} 自动换一组`:'先保留这一面，不自动更换';
const heading = (eyebrow,title,intro='') => `<p class="eyebrow">${eyebrow}</p><h2 tabindex="-1">${title}</h2>${intro?`<p class="intro">${intro}</p>`:''}`;
const errorBox = () => state.error?`<div class="notice error" role="alert">${esc(state.error)}</div>`:'';
const row = (label,value) => `<div class="summary-row"><span>${label}</span><strong>${esc(value)}</strong></div>`;
function progress() {
  const ready=state.processing==='ready', failed=state.processing==='failed';
  const title=failed?'整理暂时停住了':ready?'第一批照片准备好了':state.phase<2?'正在整理相册中的片段':'正在搭配第一面照片墙';
  return `<div class="progress-card ${ready?'ready':''}" role="status"><span class="${ready||failed?'status-mark':'spinner'}">${ready?'✓':failed?'!':''}</span><div><strong>${title}</strong><small>${ready?'按你的节奏完成设置，照片不会自行上墙':failed?'设置已保留，没有照片上墙':'你可以先设置，准备好后再看完整预览'}</small></div><span class="micro">模拟</span></div>`;
}
const actions = content => `<div class="actions">${content}</div>`;
function render() {
  const previousStep=screen.dataset.step;
  screen.dataset.step=state.step;
  let html='';
  if(state.step==='welcome') {
    html=`<section class="welcome">${heading('给生活，留一面回忆','让回忆，<br>自然回到生活里。','不用逐张挑选。那些值得再看一眼的片段，<br>会被整理、搭配成一面墙。')}<div class="wall-scene"><img src="/sample-wall" alt="已保存的真实照片搭配成的整面照片墙" class="hero-wall"><span class="photo-caption">一面墙，装下生活里的小片段</span></div>${button('开始我的照片墙 <span>→</span>','start')}<p class="fine center">这里的照片来自已保存的本地精选结果</p></section>`;
  } else if(state.step==='permission') {
    html=`${heading('01 / 从相册开始','找回那些<br>想再看一眼的片段。','允许我们整理相册，不用你逐张挑选。<br>第一面照片墙会先在手机上给你预览。')}<div class="permission-visual"><img src="/sample-wall" alt="本地照片墙样本"/><div><span class="tiny-seal">先预览，再展示</span><h3>看见喜欢的，<br>再让它留在墙上。</h3></div></div><div class="fact-list"><div><span>01</span><p>相册访问只用于寻找和搭配照片。</p></div><div><span>02</span><p>允许访问，不等于允许立即上墙。</p></div><div><span>03</span><p>展示范围与更新方式，由你先确认。</p></div></div><details class="privacy"><summary>照片会怎样被使用？</summary><p>这个网页只读取已有的本地演示素材，不访问手机相册、不上传照片，也不连接任何硬件。</p><p>正式 App 接入时，必须在真实授权前说明哪些处理在本机完成、是否需要上传、上传哪些内容及保留多久。当前线上链路仍可能上传候选照片，不能用本演示替代隐私披露。</p></details>${errorBox()}${actions(button('允许访问照片','permission')+button('暂时不授权','deny','quiet'))}<p class="fine center">下一步是权限弹窗的模拟，不会请求真实权限</p>`;
  } else if(state.step==='device') {
    html=`${heading('02 / 让回忆有个位置','把这些回忆，<br>带到这面墙上。','让照片墙通电，并把手机放在附近。')}<div class="device-scene"><img src="/sample-wall" alt="照片墙演示设备"/><span>Echooo · 演示照片墙</span></div><div class="connection-list"><div><span class="checkmark">✓</span><div><strong>照片墙已通电</strong><small>此处使用演示设备，无需真实硬件</small></div></div><div><span class="checkmark">↔</span><div><strong>连接附近的照片墙</strong><small>正式 App 会说明蓝牙与本地网络的用途</small></div></div></div>${actions(button('查找并连接照片墙','find-device'))}<p class="fine center">本 Demo 不会搜索或连接你的真实设备</p>`;
  } else if(state.step==='wifi') {
    html=`${heading('02 / 连接照片墙','给回忆，<br>留一条回家的路。','手机整理好照片后，照片墙需要连接网络，<br>才能接收你确认过的内容。')}<div class="connection-card"><span class="large-check">${connecting?'↻':'✓'}</span><div><h3>已找到演示照片墙</h3><p>Echooo Demo · 近在身边</p></div></div><div class="wifi-card"><span class="micro">模拟网络</span><strong>Echooo Demo Wi-Fi</strong><p>不需要输入真实 Wi-Fi 名称或密码。</p></div>${errorBox()}${actions(button(connecting?'正在模拟连接…':state.error?'重新连接':'连接并开始整理','connect','primary',connecting))}<p class="fine center">${connecting?'连接完成后即可边整理边设置，不必停在这里等待。':'联网不等于立即展示；第一面仍需你确认。'}</p>`;
  } else if(state.step==='scope') {
    html=`${progress()}${heading('03 / 先定好展示范围','这面墙，<br>先留给哪些片段？','整理已经开始。先确定哪些精选照片<br>可以用来搭配，不需要逐张挑选。')}<div class="choice-stack" role="group" aria-label="展示范围"><button class="choice ${state.mode==='all'?'chosen':''}" data-action="mode-all" aria-pressed="${state.mode==='all'}"><span class="radio-dot"></span><span><strong>从全部精选里搭配</strong><small>不限定人物，让不同主题自然出现</small></span></button><button class="choice ${state.mode==='include'?'chosen':''}" data-action="mode-include" aria-pressed="${state.mode==='include'}"><span class="radio-dot"></span><span><strong>包含我选择的人物</strong><small>只从已入选、且包含所选人物的照片里搭配</small></span></button></div>`;
    if(state.mode==='include') {
      if(fixtureError) html+=`<div class="notice error">${esc(fixtureError)}</div>${button('重新读取本地样本','reload-data','secondary')}`;
      else if(!fixture || state.phase<2) html+=`<div class="people-pending"><span class="spinner"></span><p>人物还在整理中。<br><small>准备好后会出现在这里，不会默认替你选人。</small></p></div>`;
      else {
        const people=allPeople?fixture.people:fixture.people.slice(0,6);
        html+=`<div class="people-grid">${people.map(p=>`<button class="person ${state.personIds.includes(p.id)?'selected':''}" aria-pressed="${state.personIds.includes(p.id)}" data-person="${esc(p.id)}">${p.image?`<img src="${esc(p.image)}" alt="${esc(p.title)}的候选头像">`:'<span class="avatar-fallback">待确认</span>'}<span class="person-check">✓</span><strong>${esc(p.title.split(' · ')[0])}</strong><small>${p.selected_photo_count} 张精选</small></button>`).join('')}</div>${fixture.people.length>6?button(allPeople?'收起人物':'查看其余人物','toggle-people','quiet'):''}<p class="fine">仅列出精选中有照片的人物；编号不代表已识别姓名。</p>`;
      }
      html+='<p class="boundary-note">多选时匹配任意一人；合照中也可能有其他人，不能保证画面里只有所选人物。第一面仍需你确认。</p>';
    }
    if(fixture && state.mode && (state.mode==='all'||state.phase>=2)) html+=`<div class="match-count"><strong>${count()}</strong><span>张精选在此范围内</span></div>${count()<8?'<p class="fine">当前模板需要 8 张不同照片，数量不足时不会补入范围外照片。</p>':''}`;
    html+=errorBox()+actions(button('确认范围，设置更新','confirm-scope','primary',!M.validScope(state,fixture)||(state.mode==='include'&&state.phase<2)))+'<p class="fine center">这些选择只作用于本次演示，不改已有偏好</p>';
  } else if(state.step==='schedule') {
    html=`${progress()}${heading('03 / 按你的节奏','让回忆，<br>按你的节奏出现。','喜欢的一面可以多留一阵。<br>什么时候更新，也由你决定。')}<div class="choice-stack" role="group" aria-label="更新方式"><button class="choice ${state.schedule==='off'?'chosen':''}" data-action="schedule-off" aria-pressed="${state.schedule==='off'}"><span class="radio-dot"></span><span><strong>先保留第一面</strong><small>不会自动换照片，想换时再看看下一组</small></span><span class="micro recommended">安心开始</span></button><button class="choice ${state.schedule==='daily'?'chosen':''}" data-action="schedule-daily" aria-pressed="${state.schedule==='daily'}"><span class="radio-dot"></span><span><strong>每天，定时换一组</strong><small>在已确认的展示范围内自动搭配</small></span></button></div>${state.schedule==='daily'?`<div class="time-setting"><label for="update-time">每天的更新时间</label><input id="update-time" type="time" value="${esc(state.time)}" required></div><div class="notice">后续会在每天 ${esc(state.time)} 自动换成新的一整面，不会每组都先征求确认。如果还不放心，可以先保留第一面。</div>`:''}<div class="summary-card">${row('展示范围',scopeText())}<button class="inline-link" data-action="edit-scope">修改范围</button></div>${errorBox()}${actions(button('确认设置，看看第一面','confirm-schedule','primary',!state.schedule))}<p class="fine center">明确确认后才启用更新；不会默认自动开启</p>`;
  } else if(state.step==='waiting') {
    const failed=state.processing==='failed',ready=state.processing==='ready';
    html=`${heading('04 / 第一面正在靠近',failed?'稍等一下，<br>这次整理暂停了。':ready?'片段已经找好，<br>正在放进这面墙。':'设置好了，<br>再给回忆一点时间。',failed?'设置已保留，也没有内容上墙。<br>重试即可，不用重新配置。':ready?'正在按你确认的范围搭配完整画面。<br>这一步完成后，先给你看。':'正在搭配你的第一面照片墙。<br>不用再做其他选择，准备好后会在这里呈现。')}<div class="waiting-visual"><div class="waiting-frame"><span class="${failed?'status-mark':'spinner'}">${failed?'!':''}</span><strong>${failed?'等待重试':wallLoading?'正在生成整墙预览':'整理照片中'}</strong><small>不上传 · 不上屏 · 仅演示</small></div></div><div class="stage-list"><div class="done">✓ <span>展示范围已确认</span><small>${count()} 张匹配</small></div><div class="done">✓ <span>更新方式已确认</span><small>${state.schedule==='off'?'不自动更新':state.time}</small></div><div>◌ <span>${ready?'搭配完整照片墙':'整理主题与人物'}</span><small>模拟流程</small></div></div>${errorBox()}${failed?button('保留设置，重新整理','retry'):state.error?button('重新生成预览','retry-wall'):''}${!ready&&!failed?button('演示：现在完成整理','finish-now','quiet'):''}${button('返回修改设置','edit-schedule','quiet')}`;
  } else if(state.step==='preview') {
    const w=state.wall;
    html=`${heading('04 / 先给你看','第一面，<br>先从这些片段开始。','照片已经搭配好了。确认喜欢，再让这一整面<br>出现在你的照片墙上。')}<figure class="wall-preview"><img id="wall-image" src="${esc(w.image)}" alt="${esc(w.title)}：${w.photo_ids.length} 张照片组成的完整照片墙"><figcaption>${esc(w.title)} · ${w.photo_ids.length} 张照片 · 待确认</figcaption></figure><div class="summary-card compact">${row('展示范围',scopeText())}${row('之后怎么更新',scheduleText())}</div><p class="fine">点击“就让这一组开始”，即确认展示这组照片${state.schedule==='daily'?`，并按每天 ${esc(state.time)} 在此范围内自动更新`:'；之后先保留这一面，不自动换组'}。</p>${errorBox()}${actions(button('就让这一组开始','publish','primary',Boolean(state.error))+button('看看另一组','next','secondary')+button('调整展示范围和更新方式','edit-scope','quiet'))}<p class="fine center">这里会模拟上屏，不会向真实设备发送照片</p>`;
  } else if(state.step==='current') {
    html=`<div class="live-label"><span></span>当前展示 · 本地模拟</div>${heading('让回忆，留在生活里',state.held?'喜欢这一面，<br>就让它多留一会儿。':'这一面，<br>先陪你过今天。')}<figure class="wall-preview current-wall"><img src="${esc(state.current.image)}" alt="本次已确认的完整照片墙"><figcaption>${esc(state.current.title)} · 模拟展示成功</figcaption></figure><div class="summary-card">${row('展示范围',scopeText())}${row('更新安排',state.held?'已暂停，恢复前不自动更换':scheduleText())}</div>${actions(button(state.held?'恢复原来的更新安排':'多留一会儿',state.held?'resume':'hold','secondary')+button('看看下一组','next','primary')+button('调整展示设置','edit-scope','quiet'))}<p class="fine center">只模拟这面墙的状态，不代表硬件已收到画面。<br>“看看下一组”不会产生不喜欢或人物排除记录。</p>`;
  }
  screen.innerHTML=html;
  const index=M.steps.indexOf(state.step);
  document.getElementById('step-progress').style.width=`${Math.max(10,(index+1)/M.steps.length*100)}%`;
  document.getElementById('back').hidden=state.step==='welcome'||state.step==='current';
  document.querySelectorAll('#journey li').forEach((el,i)=>el.classList.toggle('active',i===(index<1?0:index<4?1:index<6?2:3)));
  if(previousStep!==state.step){screen.scrollTop=0;screen.querySelector('h2')?.focus({preventScroll:true});}
  if(state.step==='preview') screen.querySelector('#wall-image').addEventListener('error',()=>{
    state.error='整墙图片无法读取，请返回重试；没有任何照片上墙。';state.consent=false;
    screen.querySelector('[data-action="publish"]').disabled=true;
    const notice=document.createElement('p');notice.className='notice error';notice.setAttribute('role','alert');notice.textContent=state.error;screen.querySelector('.wall-preview').after(notice);
  },{once:true});
}
function dispatch(event){
  state=M.reduce(state,event,fixture);
  // Background progress must not interrupt editing the time input.
  if(['PHASE','READY'].includes(event.type)&&state.step==='schedule')screen.querySelector('.progress-card').outerHTML=progress();
  else render();
  if(state.step==='waiting'&&M.canPreview(state)&&!wallLoading&&!state.error)loadWall();
}
function clearTimers(){timers.forEach(clearTimeout);timers=[];}
function later(fn,ms){timers.push(setTimeout(fn,ms));}
function beginProcessing(retry=false){
  clearTimers();
  const fast=scenario==='fast',slow=scenario==='slow';
  later(()=>dispatch({type:'PHASE',phase:2}),fast?150:3500);
  later(()=>{
    if(!fixture){dispatch({type:'FAILED',message:fixtureError||'本地样本还没有准备好，请重试。'});return;}
    if(scenario==='processing-error'&&!retry)dispatch({type:'FAILED'});
    else dispatch({type:'READY'});
  },fast?600:slow?60000:15000);
}
async function loadFixture(){
  try {
    const r=await fetch('/api/fixture',{cache:'no-store'}),data=await r.json();
    if(!r.ok)throw Error(data.error||'无法读取本地样本');
    if(fixture&&fixture.scope!==data.scope){reset(scenario);throw Error('精选版本变了，请重新确认设置。');}
    fixture=data;fixtureError='';render();
  }catch(e){fixtureError=e.message;render();}
}
async function loadWall(){
  if(!fixture||wallLoading||!M.canPreview(state))return;
  wallLoading=true;const token=++requestVersion;render();
  try{
    const check=await fetch('/api/fixture',{cache:'no-store'}),current=await check.json();
    if(!check.ok||current.scope!==fixture.scope)throw Error(current.error||'精选版本已变化，请重新确认展示范围。');
    const response=await fetch('/api/walls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:fixture.scope,mode:state.mode,person_ids:state.personIds,variant})});
    const wall=await response.json();
    if(token!==requestVersion)return;
    if(!response.ok)throw Error(wall.error||'暂时没能生成预览。');
    if(wall.status==='insufficient')throw Error(`当前范围只有 ${wall.visible_count} 张照片，现有模板需要 ${wall.required_count} 张。请返回调整范围；不会补入其他照片。`);
    if(!M.validWall(state,fixture,wall))throw Error('预览与当前展示范围不一致，已停止展示。');
    await new Promise((resolve,reject)=>{const img=new Image();img.onload=resolve;img.onerror=()=>reject(Error('整墙图片加载失败，请重试。'));img.src=wall.image;});
    if(token!==requestVersion)return;
    wallLoading=false;dispatch({type:'WALL',wall});
  }catch(e){if(token===requestVersion){wallLoading=false;dispatch({type:'ERROR',message:e.message});}}
}
function invalidateRequest(){requestVersion++;wallLoading=false;}
function reset(next='normal'){
  clearTimers();invalidateRequest();scenario=next;state=M.initial(next);variant=0;connecting=false;allPeople=false;retriedConnection=false;
  if(dialog.open)dialog.close();render();
}
function showDialog(content){dialog.innerHTML=content;dialog.showModal();}
function demoInfo(){
  showDialog(`<h2 id="dialog-title">这是可点击的流程演示</h2><p>照片与人物来自已保存的本地精选。授权、设备连接、整理时间和上屏均为模拟。</p><p>不会上传照片，不会修改 App、既有选片结果或正式偏好。人物设置只缩小第一层精选范围。</p><label for="mobile-scenario">也可以体验另一种情况</label><select id="mobile-scenario"><option value="normal">正常整理</option><option value="fast">照片先准备好</option><option value="slow">设置先完成</option><option value="processing-error">整理失败后重试</option><option value="connection-error">连接失败后重试</option></select>${button('按此情况重新体验','mobile-restart','secondary')}${button('继续体验','close-dialog')}<p class="fine">本地样本：${fixture?`${fixture.album_count} 个精选集 · ${fixture.first_layer_count} 张唯一照片`:'正在读取'}。不是本次重新识别的结果。</p>`);
}
document.addEventListener('click',async e=>{
  const person=e.target.closest('[data-person]');
  if(person){invalidateRequest();dispatch({type:'PERSON',id:person.dataset.person});return;}
  const el=e.target.closest('[data-action]');if(!el||el.disabled)return;
  const a=el.dataset.action;
  if(a==='start')dispatch({type:'START'});
  if(a==='permission')showDialog(`<p class="eyebrow">权限弹窗模拟</p><h2 id="dialog-title">允许 Echooo 访问照片？</h2><p>用于自动整理和搭配你的第一面照片墙。这里不会请求真实系统权限，也不需要逐张选择。</p>${button('允许访问（模拟）','grant')}${button('暂不允许','deny-dialog','secondary')}`);
  if(a==='grant'){dialog.close();dispatch({type:'GRANT'});}
  if(a==='deny-dialog'){dialog.close();dispatch({type:'DENY'});}
  if(a==='deny')dispatch({type:'DENY'});
  if(a==='find-device')dispatch({type:'DEVICE_FOUND'});
  if(a==='connect'){
    if(connecting)return;connecting=true;state.error='';render();
    later(()=>{
      connecting=false;if(state.step!=='wifi')return;
      if(scenario==='connection-error'&&!retriedConnection){retriedConnection=true;dispatch({type:'ERROR',message:'演示连接失败：检查照片墙是否通电，或重试。尚未开始整理。'});return;}
      dispatch({type:'CONNECTED'});beginProcessing();
    },1600);
  }
  if(a.startsWith('mode-')){invalidateRequest();dispatch({type:'MODE',mode:a.slice(5)});}
  if(a==='toggle-people'){allPeople=!allPeople;render();}
  if(a==='confirm-scope'){variant=0;dispatch({type:'CONFIRM_SCOPE'});}
  if(a.startsWith('schedule-'))dispatch({type:'SCHEDULE',value:a.slice(9)});
  if(a==='confirm-schedule')dispatch({type:'CONFIRM_SCHEDULE'});
  if(a==='finish-now'){clearTimers();if(fixture)dispatch({type:'READY'});else dispatch({type:'FAILED',message:fixtureError||'本地样本尚未准备好。'});}
  if(a==='retry'){await loadFixture();dispatch({type:'RETRY'});beginProcessing(true);}
  if(a==='retry-wall'){state.error='';render();loadWall();}
  if(a==='reload-data')loadFixture();
  if(a==='publish'){
    // The clearly labelled CTA is the explicit whole-wall confirmation; no extra checkbox.
    state=M.reduce(state,{type:'CONSENT',value:true},fixture);
    el.disabled=true;
    const token=requestVersion,wallId=state.wall?.id;
    try{const response=await fetch('/api/fixture',{cache:'no-store'}),latest=await response.json();
      if(!response.ok||latest.scope!==fixture.scope)throw Error(latest.error||'数据版本已变化，请重新确认。');
      if(token!==requestVersion||wallId!==state.wall?.id||state.step!=='preview')return;
      dispatch({type:'PUBLISH'});
    }catch(err){dispatch({type:'ERROR',message:err.message});}
  }
  if(a==='next'){invalidateRequest();variant++;dispatch({type:'NEXT'});}
  if(a==='hold')dispatch({type:'HOLD'});
  if(a==='resume')dispatch({type:'RESUME'});
  if(a==='edit-scope'){invalidateRequest();dispatch({type:'EDIT'});}
  if(a==='edit-schedule'){invalidateRequest();state.error='';state.step='schedule';render();}
  if(a==='close-dialog')dialog.close();
  if(a==='mobile-restart')reset(document.getElementById('mobile-scenario').value);
});
document.addEventListener('change',e=>{
  if(e.target.id==='update-time')dispatch({type:'TIME',value:e.target.value});
});
document.getElementById('restart').onclick=()=>reset(scenario);
document.getElementById('apply-scenario').onclick=()=>reset(document.getElementById('scenario').value);
document.getElementById('demo-info').onclick=demoInfo;
document.getElementById('back').onclick=()=>{invalidateRequest();if(state.step==='wifi'){clearTimers();connecting=false;}dispatch({type:'BACK'});};
render();loadFixture();
