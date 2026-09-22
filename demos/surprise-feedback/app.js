const $=s=>document.querySelector(s),M=window.SurpriseState;
let state=M.initial(),page='welcome',scenario='normal',scope='全部已授权照片',themes=new Set(),auto=false,time='08:30',away=false,editing=false,connectionFailed=false,connecting=false,connectionError='',timers=[],epoch=0;
const names=['毛孩子','出去玩的照片','吃到的好东西','山海与风景','看过的演出','逛过的展览'];
const button=(label,action,cls='primary')=>`<button class="${cls}" data-action="${action}">${label}</button>`;
const art=()=>'<div class="still-life" aria-hidden="true"><div class="sunbeam"></div><div class="stem"></div><div class="vase"></div><div class="ledge"></div></div>';
const heading=(step,title,desc)=>`<p class="eyebrow">${step}</p><h2>${title}</h2><p>${desc}</p>`;
const themeSummary=()=>themes.size?[...themes].join('、'):'主题自然安排';
const schedule=()=>state.held?(auto?'已暂停 · 恢复前不自动换组':'自动更新未开启'):auto?`每天 ${time} 自动更新`:'不自动更新 · 手动换组';
const later=(fn,ms)=>{const version=epoch;timers.push(setTimeout(()=>{if(version===epoch)fn();},ms));};
function statusMarkup(){
  let title,detail,icon='<span class="status-icon spinner" aria-hidden="true"></span>',action='',cls='';
  if(state.phase==='preparing'){title=state.displayed?'正在准备下一面照片墙':'正在准备你的第一面照片墙';detail='准备好后，会自动送到照片墙。';}
  if(state.phase==='sending'){title='正在更新照片墙';detail='画面已准备好，正在等待屏幕确认。';}
  if(state.phase==='displayed'){title=state.displayed===1?'第一面照片墙，已更新':'照片墙，已更新';detail=`客厅照片墙 · ${state.updatedAt} 更新成功`;icon='<span class="status-icon" aria-hidden="true">✓</span>';cls='complete';}
  if(state.phase==='failed'){
    cls='error';icon='<span class="status-icon" aria-hidden="true">!</span>';
    if(state.error==='few'){title='还需要一些生活照片';detail='当前授权范围里的合适照片不足。设置已保留。';action=button('添加一些照片','expand','quiet');}
    else if(state.error==='offline'){title='照片墙暂时没有连上';detail='画面已准备好，还未确认上屏。请检查设备电源和网络。';action=button('重新连接并发送','retry','quiet');}
    else{title='这次还没有准备好';detail='设置已保留，稍后可以重新尝试。';action=button('重新准备','retry','quiet');}
  }
  return `<div class="status-card ${cls}" role="status">${icon}<div><strong>${title}</strong><small>${detail}</small>${action}</div></div>`;
}
function homeMarkup(){
  const done=state.phase==='displayed',failed=state.phase==='failed';
  return `<div class="home-heading">${heading('家里的照片墙',done?'让它，<br>慢慢成为日常。':failed?'设置还在，<br>稍后继续。':'一切，<br>都安排好了。',done?'偶尔抬头，遇见熟悉的时光。':'你的展示设置已保存。')}</div>${art()}${statusMarkup()}<p class="home-intro">${done?'往后的日常，就从这里慢慢发生。':failed?(state.displayed?'家里的照片墙仍保留上一面画面。':'第一面照片墙还未完成，请按上方提示继续。'):'你可以先去忙。<br>准备好会自动出现在照片墙上。'}</p><div class="bottom"><div class="saved"><span>已保存的展示安排</span><strong>${themeSummary()}</strong><span>${scope} · ${schedule()}</span></div>${done?`<div class="home-actions">${button('换一组','next','quiet')}${button(state.held?'恢复原来安排':'多留一会儿','hold','quiet')}</div>`:''}${state.held?`<p class="fine">${auto?'这面照片墙会保留到你恢复更新。':'已记下你想保留这面搭配。自动更新仍未开启。'}</p>`:''}${button('展示设置','edit','quiet')}</div>`;
}
function render(){
  const root=$('#screen'),old=root.dataset.page;root.dataset.page=away?'away':page;
  $('#back').style.visibility=!away&&['permission','device','settings'].includes(page)?'visible':'hidden';
  $('#leave').textContent=away?'返回 App':'模拟离开 App';
  if(away){root.innerHTML=`<div class="leave-screen"><p class="eyebrow">预览控制 · 已模拟离开 APP</p><h2>去过你的日常。</h2><p>照片墙会继续准备。<br>回到 App，仍能看到最新状态。</p>${button('返回 App','return','secondary')}</div>`;paintWall();return;}
  let html='';
  if(page==='welcome')html=heading('01 / 相册','让生活里的照片，<br>成为家里的风景。','那些熟悉的、忘记的日常，<br>会慢慢出现在家里。')+art()+`<div class="bottom">${button('开始设置','start')}<p class="fine center">演示体验 · 不读取手机相册<br>授权、整理和设备连接均为模拟</p></div>`;
  if(page==='permission')html=heading('01 / 相册','从你的相册，<br>开始。','只从你允许访问的范围里挑选。')+`<div class="permission"><h3>允许 Echooo 访问照片？</h3><p>选择部分照片，或允许访问全部照片。你可以随时调整。</p>${button('允许访问全部照片（模拟）','allow')}${button('选择部分照片（模拟）','limited','secondary')}</div><div class="bottom">${button('暂不允许','deny','quiet')}<p class="fine">这里模拟系统授权，不会读取或上传照片。</p></div>`;
  if(page==='device')html=heading('02 / 连接','让照片墙，<br>加入这个家。','给照片墙接上电源，手机放在附近。')+`<div class="device-card"><span class="device-outline" aria-hidden="true"></span><div><strong>客厅照片墙</strong><small>${connecting?'正在连接…':'已找到 · 演示设备'}</small></div></div><div class="setting-row">使用网络<span>Home · 演示网络</span></div><p class="fine">模拟配网，无需密码。</p>${connectionError?`<p role="alert" class="fine">${connectionError}</p>`:''}<div class="bottom"><button class="primary" data-action="connect" ${connecting?'disabled':''}>${connecting?'正在连接…':connectionError?'重新连接':'连接这面照片墙'}</button><p class="fine center">连接后，设置你喜欢的展示方式。</p></div>`;
  if(page==='settings')html=heading(editing?'展示设置':'03 / 展示设置','什么样的日常，<br>你想多看一点？','选中的主题优先安排，不选也会自然搭配。')+`<div class="themes" role="group" aria-label="主题偏好">${names.map(n=>`<button class="theme" data-theme="${n}" aria-pressed="${themes.has(n)}">${n}</button>`).join('')}</div><label class="setting-row" for="auto">每天自动更新<input id="auto" type="checkbox" ${auto?'checked':''}></label><label class="setting-row" for="time" ${auto?'':'hidden'}>更新时间<input id="time" type="time" value="${time}" required></label><p class="fine">${auto?'第一面准备好就展示，之后按这个时间更新。':'先保留第一面，想换的时候再换。'}</p><div class="setting-row">照片范围<span>${scope}</span></div><div class="bottom">${button(editing?'保存设置':'设置完成，开始准备',editing?'save':'finish')}<p class="fine center">准备好后自动出现在照片墙上。<br>你不需要一直等在这里。</p></div>`;
  if(page==='home')html=homeMarkup();
  root.innerHTML=html;paintWall();
  if(old!==page)root.querySelector('h2')?.setAttribute('tabindex','-1');
}
function paintWall(){
  const frame=$('#wall-art');frame.classList.toggle('alternate',state.displayed%2===0);
  frame.innerHTML=state.displayed?`<div class="landscape" role="img" aria-label="实体墙上的示意画面"></div><strong>${state.displayed%2?'一个有海风的下午':'慢慢走过的日子'}</strong><small>日常片段 · CSS 示意素材</small>`:'<span>等待第一面回忆</span>';
  $('#wall-status').textContent=({idle:'模拟设备 · 等待设置',preparing:'模拟设备 · 等待新画面',sending:'模拟设备 · 屏幕刷新中',displayed:'模拟设备回执 · 新画面已显示',failed:state.error==='offline'?'模拟设备 · 离线，尚未确认上屏':'模拟设备 · 暂无新画面'})[state.phase];
}
function dispatch(event){state=M.reduce(state,event);render();}
function receipt(job){dispatch({type:'RECEIPT',job,at:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})});}
function generate(retry=false){
  dispatch({type:'START'});const job=state.job,caseName=retry?'normal':scenario;
  later(()=>{
    if(caseName==='few'||caseName==='generation-error'){dispatch({type:'FAIL',job,reason:caseName});return;}
    dispatch({type:'PREPARED',job});
    later(()=>{if(caseName==='offline')dispatch({type:'FAIL',job,reason:'offline'});else receipt(job);},3000);
  },caseName==='slow'?22000:6000);
}
function reset(){epoch++;timers.forEach(clearTimeout);timers=[];state=M.initial();page='welcome';scope='全部已授权照片';themes=new Set();auto=false;time='08:30';away=false;editing=false;connecting=false;connectionFailed=false;connectionError='';render();}
document.addEventListener('click',e=>{
  const topic=e.target.closest('[data-theme]');if(topic){themes.has(topic.dataset.theme)?themes.delete(topic.dataset.theme):themes.add(topic.dataset.theme);topic.setAttribute('aria-pressed',themes.has(topic.dataset.theme));return;}
  const b=e.target.closest('[data-action]');if(!b||b.disabled)return;
  const a=b.dataset.action;
  if(a==='start')page='permission';
  if(a==='allow'||a==='limited'){scope=a==='allow'?'全部已授权照片':'所选照片';page='device';}
  if(a==='deny')page='welcome';
  if(a==='connect'){
    connecting=true;connectionError='';render();
    later(()=>{connecting=false;if(page!=='device')return;if(scenario==='offline'&&!connectionFailed){connectionFailed=true;connectionError='暂时未能连接，检查网络后可以重试。';}else page='settings';render();},1200);return;
  }
  if(a==='finish'||a==='save'){
    if(auto&&!$('#time').reportValidity())return;
    if(auto)time=$('#time').value;
    page='home';editing=false;if(a==='finish'){generate();return;}
  }
  if(a==='retry'||a==='expand'){if(a==='expand')scope='已补充照片的授权范围（模拟）';generate(true);return;}
  if(a==='edit'){editing=true;page='settings';}
  if(a==='next'){generate(true);return;}
  if(a==='hold'){dispatch({type:'HOLD'});return;}
  if(a==='return')away=false;
  render();
});
document.addEventListener('change',e=>{
  if(e.target.id==='auto'){auto=e.target.checked;render();}
  if(e.target.id==='time')time=e.target.value;
});
$('#back').onclick=()=>{if(connecting)return;page=page==='settings'?(editing?'home':'device'):page==='device'?'permission':'welcome';render();};
$('#restart').onclick=reset;
$('#quick').onclick=()=>{reset();themes=new Set(['出去玩的照片','山海与风景']);auto=true;page='home';generate();};
$('#scenario').onchange=e=>{scenario=e.target.value;reset();};
$('#leave').onclick=()=>{away=!away;render();};
render();
