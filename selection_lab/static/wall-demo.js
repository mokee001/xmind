'use strict';
const $=id=>document.getElementById(id);
let data,state,key,busy=false;
const current=()=>data.walls.find(w=>w.id===state.currentId);
function render(){
  const wall=current(),candidate=wall||data.walls[state.candidateIndex],held=wall&&state.holdUntil>Date.now();
  $('heading').textContent=wall?'此刻，墙上的小美好。':'先看看，第一面照片墙。';
  $('description').textContent=wall?'喜欢，就多停留一会儿。想换个心情，也随时可以。':'模板和照片已经搭配好了。喜欢这一组，就让它成为第一次相遇。';
  $('wall').src=candidate.image;$('wall').alt=(wall?'当前模拟展示':'首次预览')+'：'+candidate.title+'，完整照片墙';
  $('wall-title').textContent=candidate.title;
  $('caption').textContent=wall?'当前展示 · Demo 模拟':'首次预览 · 尚未开始展示';
  $('badge').textContent=held?'喜欢的搭配，再留一天':wall?'当前展示':'准备与你见面';
  $('first-actions').hidden=!!wall;$('daily-actions').hidden=!wall;
  $('hold').disabled=busy||held;$('hold').textContent=held?'正在多留一会儿':'多留一会儿';
  $('resume').hidden=!held;
  $('hold-hint').textContent=held?'这面照片墙保留至 '+new Date(state.holdUntil).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})+'。也可以随时换一组。':'喜欢这次搭配，就让整面照片墙再陪你一天。';
  $('preview-next').disabled=busy||data.walls.length<2;$('next').disabled=busy||data.walls.length<2;$('start').disabled=busy;
  $('experience').hidden=false;
}
async function act(action){
  if(busy)return;busy=true;render();$('error').hidden=true;
  try{
    const next=WallDemoState.transition(state,action,data.walls);
    const candidate=data.walls.find(w=>w.id===next.currentId)||data.walls[next.candidateIndex];
    // Finish loading the complete wall before changing the simulated display.
    const image=new Image();image.src=candidate.image;await image.decode();
    localStorage.setItem(key,JSON.stringify(next));state=next;
    const messages={'hold':'已记下你对这次搭配的喜欢，让它多陪你一天。','resume':'已恢复正常更新，喜欢的记录会保留。','next':'已经换好一整组。','start':'第一面照片墙已开始模拟展示。','preview-next':''};
    $('notice').textContent=messages[action];
  }catch(e){$('error').hidden=false;$('error').textContent='操作未完成：'+e.message;}
  finally{busy=false;render();}
}
for(const action of ['start','preview-next','next','hold','resume'])$(action).onclick=()=>act(action);
(async()=>{try{
  const response=await fetch('/api/wall-demo');data=await response.json();if(!response.ok)throw Error(data.error);
  key='wall-interaction-demo-v1:'+data.scope;state=WallDemoState.initial();
  const saved=JSON.parse(localStorage.getItem(key)||'null');
  if(saved&&Number.isInteger(saved.candidateIndex)&&saved.candidateIndex>=0&&saved.candidateIndex<data.walls.length&&Array.isArray(saved.events)&&(!saved.currentId||data.walls.some(w=>w.id===saved.currentId)))state=saved;
  render();
}catch(e){$('error').hidden=false;$('error').textContent=e.message;}})();
