/* Pure demo state. Nothing here grants OS permissions or publishes to a device. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OnboardingState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const steps = ['welcome', 'permission', 'device', 'wifi', 'scope', 'schedule', 'waiting', 'preview', 'current'];
  const initial = (scenario='normal') => ({step:'welcome', scenario, permission:false, connected:false,
    processing:'idle', phase:0, mode:null, personIds:[], scopeConfirmed:false,
    schedule:null, time:'20:00', scheduleConfirmed:false, wall:null, current:null,
    held:false, settingsOnly:false, error:'', consent:false});
  const allowedIds = (s, f) => {
    if (!f || !s.mode) return [];
    if (s.mode === 'all') return [...f.photo_ids];
    const choices = new Set(s.personIds);
    const matched = new Set(f.people.filter(p=>choices.has(p.id)).flatMap(p=>p.photo_ids));
    return f.photo_ids.filter(id=>matched.has(id));
  };
  const validScope = (s, f) => Boolean(f && (s.mode === 'all' || (s.mode === 'include' &&
    s.personIds.length && s.personIds.every(id=>f.people.some(p=>p.id===id)))));
  const canPreview = s => s.permission && s.connected && s.processing==='ready' && s.scopeConfirmed && s.scheduleConfirmed;
  const validWall = (s, f, w) => w && w.status==='ready' && w.scope===f.scope &&
    w.photo_ids.length===f.photos_per_wall && new Set(w.photo_ids).size===w.photo_ids.length &&
    w.photo_ids.every(id=>allowedIds(s,f).includes(id));
  function reduce(state, event, f) {
    let s={...state};
    switch(event.type) {
      case 'START': s.step='permission'; break;
      case 'GRANT': s.permission=true;s.step='device';s.error='';break;
      case 'DENY': s.permission=false;s.error='还没有允许访问照片。你可以稍后再试，不会读取相册或开始展示。';break;
      case 'DEVICE_FOUND': if(s.permission){s.step='wifi';s.error='';}break;
      case 'CONNECTED': if(s.permission){s.connected=true;s.step='scope';s.processing='running';s.phase=1;s.error='';}break;
      case 'PHASE': if(s.processing==='running')s.phase=Math.max(s.phase,event.phase);break;
      case 'READY': if(s.connected && s.permission){s.processing='ready';s.phase=3;s.error='';}break;
      case 'FAILED': s.processing='failed';s.error=event.message||'整理暂时停住了。你的设置已保留，也没有照片上墙。';break;
      case 'RETRY': if(s.connected){s.processing='running';s.phase=1;s.error='';}break;
      case 'MODE': if(['all','include'].includes(event.mode)){s.mode=event.mode;s.scopeConfirmed=false;s.wall=null;s.consent=false;}break;
      case 'PERSON': if(f?.people.some(p=>p.id===event.id)){
        s.personIds=s.personIds.includes(event.id)?s.personIds.filter(id=>id!==event.id):[...s.personIds,event.id];
        s.scopeConfirmed=false;s.wall=null;s.consent=false;
      }break;
      case 'CONFIRM_SCOPE': if(validScope(s,f)){s.scopeConfirmed=true;s.step='schedule';s.error='';}break;
      case 'SCHEDULE': if(['off','daily'].includes(event.value)){s.schedule=event.value;s.scheduleConfirmed=false;s.consent=false;}break;
      case 'TIME': if(/^([01]\d|2[0-3]):[0-5]\d$/.test(event.value)){s.time=event.value;s.scheduleConfirmed=false;s.consent=false;}break;
      case 'CONFIRM_SCHEDULE': if(s.scopeConfirmed && ['off','daily'].includes(s.schedule)){
        s.scheduleConfirmed=true;s.step='waiting';s.error='';
      }break;
      case 'WALL': if(canPreview(s) && validWall(s,f,event.wall)){s.wall=event.wall;s.step='preview';s.error='';s.consent=false;}break;
      case 'CONSENT': s.consent=event.value===true;break;
      case 'PUBLISH': if(canPreview(s) && s.consent && validWall(s,f,s.wall)){
        s.current=s.wall;s.step='current';s.held=false;s.error='';
      }break;
      case 'NEXT': if(canPreview(s)){s.wall=null;s.step='waiting';s.consent=false;}break;
      case 'HOLD': if(s.current)s.held=true;break;
      case 'RESUME': if(s.current)s.held=false;break;
      case 'EDIT': s.step='scope';s.wall=null;s.consent=false;s.error='';break;
      case 'ERROR': s.error=event.message;break;
      case 'BACK': {
        const back={permission:'welcome',device:'permission',wifi:'device',scope:'wifi',schedule:'scope',waiting:'schedule',preview:'schedule',current:'preview'};
        s.step=back[s.step]||'welcome';s.error='';
        break;
      }
    }
    return s;
  }
  return {initial, reduce, allowedIds, validScope, canPreview, validWall, steps};
});
