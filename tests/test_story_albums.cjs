"use strict";
// Pure rendering tests: no browser, screenshots, private images or model calls.
const assert = require("node:assert/strict");
const {test} = require("node:test");
const view = require("../selection_lab/static/story-albums.js");
const album = (kind, id) => ({id, kind, candidate_count: 6, photo_ids: ["a", "b", "c"], evidence: {
  face_similarity_min: .8, gps_photos: 6, distinct_dates: 2, span_hours: 18,
  minimum_away_km: 100, visual_similarity_min: .78, date_precision: "timestamp"}});

test("renders three distinct sections using only saved groups", () => {
  const source={albums:[album("person","p"),album("trip","t"),album("event","e")]};
  const calls=[];
  const html=view.sections(source,groups=>{calls.push(groups.map(g=>g.id));return "actual cards";});
  assert.deepEqual(calls,[["p"],["t"],["e"]]);
  for(const name of ["story-person","story-trip","story-event"])assert.match(html,new RegExp(name));
  assert.equal((html.match(/1 组/g)||[]).length,3);
});
test("missing and empty results are distinct, no example cards fill gaps", () => {
  const render=()=>{throw new Error("no cards should be rendered");};
  assert.match(view.sections(null,render),/尚未生成/);
  const html=view.sections({albums:[]},render);
  assert.match(html,/没有至少 3 张/);assert.match(html,/没有足够定位和日期/);
  assert.equal((html.match(/0 组/g)||[]).length,5);
});
test("person facts do not confuse similarity with recognition accuracy", () => {
  const text=view.facts(album("person","p"));
  assert.match(text,/不是正确率/);assert.match(text,/待确认身份/);
  assert.match(text,/候选 6 张 → 去重选片后 3 张/);
});
test("before/after compares memberships without confusing repeats with file deletion", () => {
  const before={albums:[{photo_ids:["a","b"]},{photo_ids:["b","c"]}],photo_count:3};
  const after={albums:[{photo_ids:["a","b"]},{photo_ids:["c","d"]}],photo_count:4};
  assert.match(view.comparison(before,after,false),/重复展示 1 → 0 次/);
  assert.match(view.comparison(before,after,true),/正在看调整前/);
  const changes=view.albumChange({photo_ids:["b","c"]},{photo_ids:["a","b"]},false);
  assert.match(changes,/保留 1 张，补入 1 张，移出精选 1 张/);
  assert.match(changes,/原照片保留/);
});
test("trip evidence distinguishes candidate GPS counts from selected members", () => {
  const text=view.facts(album("trip","t"));
  assert.match(text,/候选中 6 张有定位/);assert.match(text,/完整性未确认/);
});
test("day-only event is not described as an exact time activity", () => {
  const a=album("event","e");a.evidence.date_precision="day";a.evidence.span_hours=null;
  const text=view.facts(a);
  assert.match(text,/时间仅精确到日/);assert.doesNotMatch(text,/null 小时/);
});

test("live snapshots maintain separate engines, accurate unions and private previews", {skip:!process.env.LAB_COMPARISON_LIVE}, async()=>{
  const base="http://127.0.0.1:8766";
  const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200);return r.json();};
  const [{record},hybrid,natural]=await Promise.all([get("/api/stories"),get("/api/hybrid"),get("/api/ente")]);
  assert.equal(record.result.engine,"photo-wall-stories");
  assert.notEqual(record.id,hybrid.record.id);assert.notEqual(record.id,natural.record.id);
  const source=record.result.collection_snapshot;
  const ids=new Set(source.albums.flatMap(a=>a.photo_ids));
  assert.equal(ids.size,source.photo_count);
  assert.deepEqual(new Set(source.photos.map(p=>p.id)),ids);
  for(const a of source.albums){
    assert.ok(a.photo_ids.length>=3&&a.photo_ids.length<=12);
    assert.ok(a.photo_ids.includes(a.cover));
    assert.equal(new Set(a.photo_ids).size,a.photo_ids.length);
    if(a.kind==="person")for(const id of a.photo_ids)assert.equal(a.faces[id].length,1);
  }
  for(const kind of ["person","trip","event"])assert.equal(source.diagnostics.album_counts[kind],source.albums.filter(a=>a.kind===kind).length);
  const body=JSON.stringify(source);
  for(const key of ['"embedding"','"latitude"','"longitude"','"vector"','"path"'])assert.ok(!body.includes(key));
  const image=await fetch(base+source.photos[0].image);
  assert.equal(image.status,200);assert.equal(image.headers.get("Content-Type"),"image/jpeg");
});
