(function(root){
  "use strict";
  const names={theme:"内容主题",person:"人脸分组",place:"地点时光",trip:"出行片段",event:"活动片段"};
  function summary(source){
    if(!source)return "正在读取回忆精选…";
    return `${source.albums.length} 个主题相册 · ${source.photo_count} 张不同照片 · ${source.diagnostics.input_count} 张已识别`;
  }
  function facts(album,photo){
    const evidence=album.photo_reasons?.[photo.id];
    const subject=evidence?.theme_support||{};
    const topics={people:"人像",pet:"宠物",food:"美食",scene:"风景与城市",stage:"舞台"};
    const support=Object.entries(subject).map(([k,v])=>`${topics[k]||k}（${v.map(s=>s==="vision"?"本机 Vision":"Ente").join("＋")}）`).join("、");
    const folded=album.absorbed?.length?`已折叠 ${album.absorbed.length} 个高度重叠的小组；不会将缺少关联证据的照片硬塞进来。`:"";
    return `${album.candidate_count} 张主题候选 → 去重后 ${album.available_count} 张 → 本册 ${album.photo_ids.length} 张。${album.anchor_count?`原始片段 ${album.anchor_count} 张，补充召回 ${album.candidate_count-album.anchor_count} 张。`:""}综合依据：${album.sources.map(s=>names[s]||s).join("、")}。${folded}本张内容支持：${support||"未命中明确内容标签，凭本组时间和地点证据入选"}；${evidence?.has_location?"有照片定位":"无照片定位"}。${album.kind==="person"?"绿色框是目标人脸，身份待确认。":""}`;
  }
  function notes(source,recordId){
    if(!source)return "尚无这一批照片的统一精选，不用旧相册代替。";
    const d=source.diagnostics,s=d.suppressed_counts,r=source.provenance.rules;
    return `${source.provenance.note} ${source.eligible_count} 张通过原有照片与质量过滤；内容主题取 Ente 与 Vision 各自达标结果的并集，不混算两者置信度。人物、主题、地点、旅程和活动进入同一成册流程：召回相关照片、去重、主题内选片，再折叠重叠小组。共 ${d.proposal_count} 个候选主题；${s.too_small||0} 个去重后不足 ${r.min_photos} 张，不单独占精选卡片，相关照片仍可进入更宽主题；${s.covered_fragment||0} 个重叠小组折叠；${s.wall_limit||0} 个受首页册数上限未展示。每册最多 ${source.album_settings.max_photos} 张，首页最多 ${source.album_settings.max_albums} 册，可重复引用照片但不按引用次数计算照片总量。通用实验台的“最终张数”是旧 Top N；本页使用独立每册上限。无日期不编造年份；不根据日期推断节日，不根据人脸推断亲属。快照 ${recordId}。`;
  }
  const api={summary,facts,notes};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.MemoriesView=api;
})(globalThis);
