/* Four guide stages, five default clicks; automatic progress is never consent. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OnboardingV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const initial = (scenario='normal') => ({step:'welcome',scenario,permission:false,deviceStatus:'idle',connected:false,
    processing:'idle',phase:0,mode:null,personIds:[],themeIds:[],scopeConfirmed:false,schedule:'off',time:'20:00',
    scheduleConfirmed:false,wall:null,current:null,held:false,error:'',publishing:false,actionCount:0});
  const allowedIds = (s,f) => {
    if(!f || !s.mode)return [];
    if(s.mode==='all')return [...f.photo_ids];
    const matched=new Set(f.people.filter(p=>s.personIds.includes(p.id)).flatMap(p=>p.photo_ids));
    return f.photo_ids.filter(id=>matched.has(id));
  };
  const validScope = (s,f) => Boolean(f && (s.mode==='all'||(s.mode==='include'&&s.personIds.length&&s.personIds.every(id=>f.people.some(p=>p.id===id)))));
  const validThemes = (s,f) => Boolean(f && Array.isArray(s.themeIds) && s.themeIds.every(id=>(f.themes||[]).some(t=>t.id===id)));
  const validTime = value => typeof value==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const canPreview = s => s.permission&&s.connected&&s.processing==='ready'&&s.scopeConfirmed&&s.scheduleConfirmed;
  const validWall = (s,f,w) => Boolean(f && w?.status==='ready'&&w.scope===f.scope&&Array.isArray(w.photo_ids)&&
    w.photo_ids.length===f.photos_per_wall&&new Set(w.photo_ids).size===w.photo_ids.length&&w.photo_ids.every(id=>allowedIds(s,f).includes(id))&&
    Array.isArray(w.theme_ids||[])&&JSON.stringify([...(w.theme_ids||[])].sort())===JSON.stringify([...s.themeIds].sort()));
  const invalidate = s => ({...s,wall:null,scopeConfirmed:false,scheduleConfirmed:false,publishing:false,error:''});
  const guideSteps = Object.freeze(['授权相册','连接照片墙','展示设置','预览上墙']);
  const guideIndex = s => ({welcome:0,permission:0,device:1,settings:2,preview:3,current:4}[s.step]);
  function reduce(state,e,f){
    let s={...state};
    switch(e.type){
      case 'START': if(s.step==='welcome'){s.step='permission';s.error='';s.actionCount++;}break;
      case 'CANCEL_PERMISSION': s.step='welcome';break;
      case 'GRANT': if(s.step==='permission'){s.permission=true;s.step='device';s.deviceStatus='searching';s.error='';s.actionCount++;}break;
      case 'DENY': s=initial(s.scenario);s.error='尚未授权手机相册，也不会向照片墙发送内容。你可以稍后再试。';break;
      case 'DEVICE_FOUND': if(s.permission&&s.step==='device'&&s.deviceStatus==='searching')s.deviceStatus='found';break;
      case 'CONNECT': if(s.permission&&s.step==='device'&&['found','error'].includes(s.deviceStatus)){s.deviceStatus='connecting';s.error='';s.actionCount++;}break;
      case 'CONNECTION_FAILED': if(s.deviceStatus==='connecting'){s.deviceStatus='error';s.error='连接未完成。请检查电源和网络，再重试。';}break;
      case 'CONNECTED': if(s.permission&&s.deviceStatus==='connecting'){
        s.connected=true;s.deviceStatus='connected';s.step='settings';s.error='';
        if(s.processing==='idle'){s.processing='running';s.phase=1;}
      }break;
      case 'PHASE': if(s.processing==='running')s.phase=Math.max(s.phase,e.phase);break;
      case 'READY': if(s.permission&&s.connected&&s.processing==='running'){s.processing='ready';s.phase=3;s.error='';}break;
      case 'FAILED': if(s.processing==='running'){s.processing='failed';s.error=e.message||'整理暂时失败，设置已保留，尚未上墙。';}break;
      case 'RETRY': if(s.permission&&s.connected){s.processing='running';s.phase=1;s.error='';}break;
      case 'MODE': if(s.step==='settings'&&['all','include'].includes(e.mode))s=invalidate({...s,mode:e.mode,personIds:e.mode==='all'?[]:s.personIds});break;
      case 'PERSON': if(s.step==='settings'&&s.phase>=2&&f?.people.some(p=>p.id===e.id)){
        s=invalidate({...s,mode:'include',personIds:s.personIds.includes(e.id)?s.personIds.filter(id=>id!==e.id):[...s.personIds,e.id]});
      }break;
      case 'THEME': if(s.step==='settings'&&f?.themes?.some(t=>t.id===e.id)){
        s=invalidate({...s,themeIds:s.themeIds.includes(e.id)?s.themeIds.filter(id=>id!==e.id):[...s.themeIds,e.id]});
      }break;
      case 'SCHEDULE': if(s.step==='settings'&&['off','daily'].includes(e.value))s=invalidate({...s,schedule:e.value});break;
      case 'TIME': if(s.step==='settings'&&typeof e.value==='string')s=invalidate({...s,time:e.value});break;
      case 'CONFIRM_SETTINGS': {
        if(s.step!=='settings'||!s.permission||!s.connected)break;
        // Only this explicitly labelled click may opt into all selected photos.
        const mode=s.mode==='include'?'include':'all';
        const next={...s,mode};
        if(!validScope(next,f)||!validThemes(next,f)||(mode==='include'&&(s.phase<2||allowedIds(next,f).length<f.photos_per_wall))||(s.schedule==='daily'&&!validTime(s.time)))break;
        s={...next,scopeConfirmed:true,scheduleConfirmed:true,step:'preview',wall:null,error:'',actionCount:s.actionCount+1};break;
      }
      case 'WALL': if(s.step==='preview'&&canPreview(s)&&validWall(s,f,e.wall)){s.wall=e.wall;s.error='';}break;
      case 'CONFIRM_WALL': if(s.step==='preview'&&canPreview(s)&&validWall(s,f,s.wall)&&!s.error&&!s.publishing){s.publishing=true;s.actionCount++;}break;
      case 'PUBLISHED': if(s.publishing&&e.wallId===s.wall?.id&&canPreview(s)&&validWall(s,f,s.wall)){
        s.current=s.wall;s.step='current';s.publishing=false;s.held=false;
      }break;
      case 'NEXT': if(s.step==='current'||(s.step==='preview'&&s.wall))s={...s,step:'preview',wall:null,error:'',publishing:false};break;
      case 'HOLD': if(s.current)s.held=true;break;
      case 'RESUME': if(s.current)s.held=false;break;
      case 'EDIT': if(s.connected)s={...invalidate(s),step:'settings'};break;
      case 'ERROR': s.error=e.message;s.publishing=false;break;
      case 'CLEAR_ERROR': s.error='';break;
      case 'BACK':
        if(s.step==='preview')s={...invalidate(s),step:'settings'};
        else if(s.step==='settings'){s=invalidate(s);s.step='device';s.deviceStatus='found';}
        else if(s.step==='device'){s=initial(s.scenario);}
        else if(s.step==='permission')s.step='welcome';
        break;
    }
    return s;
  }
  return {initial,reduce,allowedIds,validScope,validThemes,validTime,validWall,canPreview,guideSteps,guideIndex};
});
