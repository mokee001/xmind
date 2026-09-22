(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SurpriseState=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  const initial=()=>({phase:'idle',job:0,displayed:0,updatedAt:null,error:'',held:false});
  function reduce(state,event){
    const s={...state};
    if(event.type==='START')return {...s,phase:'preparing',job:s.job+1,error:'',held:false};
    if(event.type==='HOLD'&&s.phase==='displayed')return {...s,held:!s.held};
    if(event.job!==s.job)return s;
    if(event.type==='PREPARED'&&s.phase==='preparing')return {...s,phase:'sending'};
    if(event.type==='RECEIPT'&&s.phase==='sending')return {...s,phase:'displayed',displayed:s.displayed+1,updatedAt:event.at,error:''};
    if(event.type==='FAIL'&&['preparing','sending'].includes(s.phase))return {...s,phase:'failed',error:event.reason};
    return s;
  }
  return {initial,reduce};
});
