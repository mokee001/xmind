/* The unit of interaction is an immutable wall, never an individual photo. */
(function(root){
  const DAY=86400000;
  function initial(){return {currentId:null,candidateIndex:0,holdUntil:null,events:[]};}
  function transition(state,action,walls,now=Date.now()){
    if(!walls.length)throw Error('没有可展示的照片墙');
    const s=JSON.parse(JSON.stringify(state));
    const current=walls.find(w=>w.id===s.currentId);
    if(action==='preview-next'){
      s.candidateIndex=(s.candidateIndex+1)%walls.length;
    }else if(action==='start'){
      if(current)return s;
      s.currentId=walls[s.candidateIndex].id;
      s.holdUntil=null;
    }else if(action==='next'){
      if(!current)throw Error('请先确认首次展示');
      s.currentId=walls[(walls.indexOf(current)+1)%walls.length].id;
      s.holdUntil=null;
      // Advancing is an operational event, with no negative preference signal.
      s.events.push({type:'advance',wall_id:current.id,at:now});
    }else if(action==='hold'){
      if(!current)throw Error('请先确认首次展示');
      if(s.holdUntil>now)return s;
      s.holdUntil=now+DAY;
      // Keep the compound evidence. Do not infer preferences for every person/photo.
      s.events.push({type:'positive_wall_hold',wall_id:current.id,template_id:current.template_id,
                    photo_ids:[...current.photo_ids],at:now,hold_until:s.holdUntil});
    }else if(action==='resume'){
      s.holdUntil=null; // Resuming does not reverse the earlier positive signal.
    }else throw Error('未知操作');
    return s;
  }
  const api={initial,transition,DAY};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.WallDemoState=api;
})(globalThis);
