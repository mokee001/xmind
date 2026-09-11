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
  // A generated image, an accepted publication and a display receipt are distinct.
  // The e-ink pipeline changes the image URL and revision during publication.
  function publicationFromResponse(deviceId, wall, response) {
    const device = response?.device;
    const revision = String(response?.revision || device?.revision || '');
    if (!deviceId || device?.device_id !== deviceId || !wall?.wall_id || !wall?.image_url || !revision
      || (device.revision && String(device.revision) !== revision)
      || (response.wall?.wall_id && response.wall.wall_id !== wall.wall_id)) return null;
    return { deviceId, wallId: wall.wall_id, revision, image: wall.image_url };
  }
  function hasDisplayReceipt(device) {
    return !!device?.revision && !device.error
      && !['error', 'failed'].includes(String(device.state || '').toLowerCase())
      && String(device.displayed_revision || '') === String(device.revision);
  }
  function nativeWallPresentation(device, publication, candidate) {
    const deviceId = device?.device_id;
    const boundPublication = deviceId && publication?.deviceId === deviceId && publication.revision && publication.wallId && publication.image ? publication : null;
    const boundCandidate = deviceId && candidate?.deviceId === deviceId ? candidate : null;
    const received = hasDisplayReceipt(device);
    const matchingPublication = boundPublication && String(device?.revision || '') === boundPublication.revision;
    const confirmedImage = received ? device.preview_url || (matchingPublication ? boundPublication.image : null) : null;
    const candidateConfirmed = !!(received && matchingPublication && boundCandidate?.wallId === boundPublication.wallId);
    return {
      confirmedImage: confirmedImage || null,
      candidate: candidateConfirmed ? null : boundCandidate,
      awaitingReceipt: !!(matchingPublication && !received
        && !device.error && !['error', 'failed'].includes(String(device.state || '').toLowerCase())),
    };
  }
  function isCurrentWallRequest(request, current) {
    return !!(request && current && request.deviceId === current.deviceId && request.bindingEpoch === current.bindingEpoch
      && request.sequence === current.sequence);
  }
  const api={initial,transition,DAY,publicationFromResponse,hasDisplayReceipt,nativeWallPresentation,isCurrentWallRequest};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.WallDemoState=api;
})(globalThis);
