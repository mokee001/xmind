/* Pure view helpers. Only real, saved albums are rendered; no example photos. */
(function(root) {
  "use strict";
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const categories=[
    ["person","同一人物候选","按人脸特征分组，不再把所有人像混成一册。绿色框标出目标人物，身份尚未确认。","没有至少 3 张通过人脸质量、相似性和去重条件的照片，不强行凑成人物组。"],
    ["place","在这里的时光","按地点和年份串联不同日期的照片，回看在同一城市留下的片段。","尚无至少两个拍摄日期的同城照片。"],
    ["theme","主题时光","将同一年、不同日期的宠物、舞台或美食照片串成主题；日期缺失的照片单列。","尚无足够照片形成跨日期主题。"],
    ["trip","出行候选","按定位、日期和连续性串联；回到主要拍摄区域或出现长时间空档会分开。不是按城市简单汇总。","目前没有足够定位和日期证据组成出行候选，不把无定位照片猜成旅行。"],
    ["event","活动片段与相似场景","同日只是起点，还需内容相似，结合可用地点与人物信息；只有日期的组不宣称同一次活动。","目前没有至少 3 张内容与时间证据一致的照片组成活动片段。"]
  ];
  function facts(album) {
    const e=album.evidence||{}, lead=`分组候选 ${album.candidate_count} 张 → 去重选片后 ${album.photo_ids.length} 张。`;
    if(album.kind==="person")return `${lead}候选组最低人脸余弦相似度 ${e.face_similarity_min}（不是正确率）。所有成员两两通过门槛；待确认身份。`;
    if(album.kind==="place"||album.kind==="theme")return `${lead}${e.year?`${e.year} 年，候选覆盖 ${e.distinct_dates} 个拍摄日期。`:"拍摄日期未知，未归入任何年份。"}${album.selection_evidence?`本册保留 ${album.selection_evidence.selected_dates} 个拍摄日期。`:""}${album.kind==="place"?"城市来自照片定位，不代表同一次旅行。":"按内容主题归类，不表示同一只宠物或同一次活动。"}`;
    if(album.kind==="trip")return `${lead}候选中 ${e.gps_photos} 张有定位，跨 ${e.distinct_dates} 个日期、约 ${e.span_hours} 小时；距样本主要拍摄区域至少 ${e.minimum_away_km} 公里。出行归属及完整性未确认。`;
    return `${lead}候选最低内容余弦相似度 ${e.visual_similarity_min}（不是正确率），${e.gps_photos} 张有定位。${e.date_precision==="day"?"时间仅精确到日，只能判断同日相似场景。":`跨度约 ${e.span_hours} 小时，暂作为活动片段。`}`;
  }
  function sections(source,renderCards) {
    return categories.map(([kind,title,description,noResult])=>{
      const albums=(source?.albums||[]).filter(a=>a.kind===kind);
      return `<section class="story-section" aria-labelledby="story-${kind}"><div class="story-heading"><h3 id="story-${kind}">${title}</h3><span>${albums.length} 组</span></div><p class="story-explanation">${description}</p><div class="collection-grid">${albums.length?renderCards(albums):`<p class="empty">${esc(source?noResult:"尚未生成这批照片的新聚合结果。")}</p>`}</div></section>`;
    }).join("");
  }
  function notes(source,snapshotId) {
    if(!source)return "";
    const p=source.provenance,r=p.rules,d=source.diagnostics;
    return `${p.note} 分组使用 Ente 特征＋本项目规则，不是 Apple 或 Ente 原版回忆。人物：检测分 ≥ ${r.face_score_min}，清晰度 ≥ ${r.face_blur_min}，人脸相似度 ≥ ${r.face_similarity_min}；活动：内容相似度基础 ${r.event_visual_min}、有共同地点或人物证据时 ${r.event_context_visual_min}、仅日期时 ${r.day_visual_min}，地点冲突超过 ${r.event_radius_km} 公里拆分；出行：距样本主要区域 ≥ ${r.trip_away_km} 公里，空档超过 ${r.trip_gap_hours} 小时拆分。每组至少 ${r.minimum_photos} 张、至多 ${r.maximum_photos} 张；每类最多 ${r.maximum_albums_per_kind} 组，非全局 Top N。当前候选池：人物 ${d.pool_counts.person}、出行 ${d.pool_counts.trip}、活动 ${d.pool_counts.event}；去重选片后不足成册 ${d.selection.too_small_after_selection||0} 组、因每类上限未展示 ${d.selection.category_limit||0} 组。缺少日期的 ${d.date_sources.unknown||0} 张合格照片仍可参与人物和原有主题相册，不拼入活动或旅行。主要区域仅为样本高频拍摄区域，不是居住地。快照 ${snapshotId}。`;
  }
  function comparison(before,after,showBefore) {
    const repeated=s=>{const ids=s.albums.flatMap(a=>a.photo_ids);return ids.length-new Set(ids).size;};
    if(!after)return "尚未生成相册。";
    if(!before)return "当前为已保存结果；下次生成后可查看前后对照。";
    return `正在看${showBefore?"调整前":"调整后"}。相册 ${before.albums.length} → ${after.albums.length} 本，覆盖 ${before.photo_count} → ${after.photo_count} 张不同照片；跨册重复展示 ${repeated(before)} → ${repeated(after)} 次。点击封面查看，切换按钮对照上轮照片。`;
  }
  function albumChange(current,other,showBefore) {
    if(!other)return showBefore?"这本相册未保留在本轮结果中，可在这里查看上轮完整照片。":"本轮新增的相册。";
    const before=showBefore?current:other, after=showBefore?other:current;
    const old=new Set(before.photo_ids),now=new Set(after.photo_ids);
    return `与上轮比较：保留 ${[...now].filter(i=>old.has(i)).length} 张，补入 ${[...now].filter(i=>!old.has(i)).length} 张，移出精选 ${[...old].filter(i=>!now.has(i)).length} 张；原照片保留。`;
  }
  const api={sections,facts,notes,comparison,albumChange};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.StoryAlbums=api;
})(globalThis);
