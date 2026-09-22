"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const view=require("../selection_lab/static/memory-albums.js");
test("summary reports unique photos rather than album memberships",()=>{
  const summary=view.summary({albums:[{},{}],photo_count:15,diagnostics:{input_count:40}});
  assert.match(summary,/2 个主题相册/);assert.match(summary,/15 张不同照片/);assert.match(summary,/40 张已识别/);
  assert.match(view.summary(null),/正在读取/);
});
test("selection evidence distinguishes anchors, recall, dedup and the final cap",()=>{
  const a={candidate_count:30,available_count:26,photo_ids:Array(24),anchor_count:12,sources:["trip","event"],absorbed:[{}],kind:"trip",
    photo_reasons:{p:{theme_support:{people:["ente","vision"]},has_location:true}}};
  const text=view.facts(a,{id:"p"});
  assert.match(text,/30 张主题候选 → 去重后 26 张 → 本册 24 张/);
  assert.match(text,/补充召回 18 张/);assert.match(text,/Ente＋本机 Vision/);assert.match(text,/已折叠 1 个/);
});
test("no content match can be described as time/location evidence without claiming identity",()=>{
  const text=view.facts({candidate_count:10,available_count:10,photo_ids:Array(10),sources:["place"],photo_reasons:{},kind:"place"},{id:"x"});
  assert.match(text,/凭本组时间和地点证据/);assert.match(text,/无照片定位/);
});
test("local API preserves old snapshots, canonical union and actual capacity",{skip:!process.env.LAB_COMPARISON_LIVE},async()=>{
  const base="http://127.0.0.1:8766";
  const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200);return r.json();};
  const [m,s,h,e]=await Promise.all([get("/api/memories"),get("/api/stories"),get("/api/hybrid"),get("/api/ente")]);
  assert.equal(m.record.result.engine,"photo-wall-memories");
  assert.equal(new Set([m.record.id,s.record.id,h.record.id,e.record.id]).size,4);
  const source=m.record.result.collection_snapshot;
  const ids=new Set(source.albums.flatMap(a=>a.photo_ids));
  assert.equal(ids.size,source.photo_count);assert.deepEqual(new Set(source.photos.map(p=>p.id)),ids);
  assert.ok(source.albums.length<=source.album_settings.max_albums);
  for(const a of source.albums){
    assert.ok(a.photo_ids.length>=8&&a.photo_ids.length<=source.album_settings.max_photos);
    assert.equal(new Set(a.photo_ids).size,a.photo_ids.length);assert.ok(a.photo_ids.includes(a.cover));
    assert.equal(a.photo_ids.length,Object.keys(a.photo_reasons).length);
  }
  for(const key of ['"latitude"','"longitude"','"embedding"','"vector"','"path"'])assert.ok(!JSON.stringify(source).includes(key));
  const media=await fetch(base+source.photos[0].image);assert.equal(media.status,200);assert.equal(media.headers.get("Content-Type"),"image/jpeg");
  console.log(JSON.stringify({input:source.diagnostics.input_count,albums:source.albums.length,unique:source.photo_count,sizes:source.albums.map(a=>a.photo_ids.length)}));
});
