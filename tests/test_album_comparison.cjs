"use strict";
// Pure presentation tests. No browser, model execution, private image copies or uploads.
const assert = require("node:assert/strict");
const {test} = require("node:test");
const comparison = require("../selection_lab/static/album-comparison.js");
const meta = {dataset: {id: "fixture-dataset", count: 4}, clip: {cached: 2}};
const photos = ["a", "b", "c", "d"].map(id => ({id, filename: `${id}.jpg`, image: `/media/${id}`}));
const album = (id, ids, title = id) => ({id, title, photo_ids: ids, cover: ids[0]});
function fixture() {
  return {meta,
    local: {id: "local-result", provenance: {dataset_id: meta.dataset.id},
      albums: [album("local-one", ["a", "b"]), album("local-two", ["b", "c"])], photos: structuredClone(photos)},
    record: {id: "ente-snapshot", dataset_id: meta.dataset.id, result: {
      engine: "ente-import", signature: {dataset: meta.dataset.id}, provenance: {mode: "natural", commit: "a".repeat(40)},
      events: [album("ente-one", ["b", "d"])], selected_ids: ["b", "d"], photos: structuredClone(photos),
      // These extra groups must NEVER become natural output merely to fill the right column.
      ente_recognition: {albums: [album("recognition-only", ["a", "c"])]},
    }}, state: {state: "complete"}};
}
function mount(payload) {
  const handlers = {};
  const opened = [];
  const container = {innerHTML: "", addEventListener: (name, cb) => {handlers[name] = cb;},
    contains: () => true, querySelector: () => null, scrollIntoView: () => {}};
  const view = comparison.create(container, (...args) => opened.push(args));
  view.update(payload);
  const click = dataset => handlers.click({target: {closest: () => ({dataset})}});
  const change = (kind, dataset, value) => handlers.change({target: {
    id: "fixture", value, dataset, matches: selector => selector === kind}});
  return {container, view, opened, click, change};
}

test("counts union across albums, not summed memberships or the global Top 20", () => {
  const f = fixture(); f.record.result.selected_ids = ["a"]; // actual comparison derives from album members
  const data = comparison.model(f.local, f.record, meta);
  assert.equal(data.left.ids.size, 3);
  assert.equal(data.right.ids.size, 2);
  assert.deepEqual(data.totals, {shared: ["b"], leftOnly: ["a", "c"], rightOnly: ["d"]});
  assert.equal(data.right.albums.length, 1);
});
test("comparison keeps album order, cover and image order without mutating inputs", () => {
  const f = fixture(), before = JSON.stringify(f);
  const data = comparison.model(f.local, f.record, meta);
  assert.deepEqual(data.right.albums[0].photo_ids, ["b", "d"]);
  assert.equal(data.right.albums[0].cover, "b");
  assert.equal(JSON.stringify(f), before);
});
test("empty natural output is not a missing result or replaced by recognition themes", () => {
  const f = fixture(); f.record.result.events = [];
  const data = comparison.model(f.local, f.record, meta);
  assert.equal(data.right.albums.length, 0);
  assert.deepEqual(data.totals.leftOnly, ["a", "b", "c"]);
  assert.equal(comparison.model(f.local, null, meta).totals, null);
  assert.equal(comparison.model(null, f.record, meta).totals, null);
});
test("rejects mismatched dataset, non-Ente result and debug output", () => {
  for (const mutate of [f => f.local.provenance.dataset_id = "other",
    f => f.record.dataset_id = "other", f => f.record.result.signature.dataset = "other",
    f => f.record.result.provenance.mode = "debug_all_candidates", f => f.record.result.engine = "photo-wall"]) {
    const f = fixture(); mutate(f);
    assert.throws(() => comparison.model(f.local, f.record, meta));
  }
});
test("rejects broken cover, missing members and duplicate album IDs/members", () => {
  for (const mutate of [f => f.local.albums[0].cover = "missing",
    f => f.local.albums[0].photo_ids.push("missing"), f => f.local.albums[0].photo_ids.push("a"),
    f => f.local.albums.push(f.local.albums[0])]) {
    const f = fixture(); mutate(f);
    assert.throws(() => comparison.model(f.local, f.record, meta));
  }
});
test("does not force a match when no photos overlap", () => {
  assert.equal(comparison.closestAlbum(album("a", ["a"]), [album("b", ["b"])]), null);
});
test("suggests highest membership Jaccard, not largest or similarly titled album", () => {
  const a = album("a", ["a", "b"]);
  const big = album("big", ["a", "b", "c", "d", "e"]), small = album("small", ["b"]);
  assert.equal(comparison.closestAlbum(a, [big, small]).id, "small");
});
test("render escapes untrusted album names and filenames", () => {
  const f = fixture(); f.local.albums[0].title = '<img src=x onerror="bad">';
  f.local.photos[0].filename = '<script>bad</script>';
  const {container} = mount(f);
  assert.ok(!container.innerHTML.includes('<img src=x'));
  assert.ok(!container.innerHTML.includes('<script>bad'));
  assert.ok(container.innerHTML.includes('&lt;img'));
});
test("two columns include only natural albums, with real common/unique counts", () => {
  const {container, view} = mount(fixture());
  assert.match(container.innerHTML, /cmp-left/);
  assert.match(container.innerHTML, /cmp-right/);
  assert.ok(!container.innerHTML.includes("recognition-only"));
  assert.equal(view.read().right.albums.length, 1);
  assert.deepEqual(view.read().differences.shared, ["b"]);
});
test("card enters pair view, filters by that pair, and opens the correct engine photo index", () => {
  const {container, view, click, change, opened} = mount(fixture());
  click({cmpAction: "pair", side: "left", id: "local-one"});
  assert.deepEqual(view.read().pair, {left: "local-one", right: "ente-one", filter: "all"});
  assert.match(container.innerHTML, /本对共同 1 张/);
  change("[data-cmp-filter]", {}, "exclusive");
  assert.ok(!container.innerHTML.includes('alt="b.jpg"'));
  assert.ok(container.innerHTML.includes('alt="a.jpg"'));
  assert.ok(container.innerHTML.includes('alt="d.jpg"'));
  click({cmpAction: "photo", side: "right", id: "ente-one", index: "1"});
  assert.equal(opened[0][0].engine, "ente");
  assert.equal(opened[0][1], "ente-one");
  assert.equal(opened[0][2], 1);
  change("[data-cmp-filter]", {}, "shared");
  assert.ok(!container.innerHTML.includes('alt="a.jpg"'));
  assert.equal((container.innerHTML.match(/alt="b.jpg"/g) || []).length, 2);
});
test("unmatched album leaves other side blank, manual choices and filters survive refresh", () => {
  const f = fixture(); f.record.result.events = [album("ente-one", ["d"])];
  const {view, click, change} = mount(f);
  click({cmpAction: "pair", side: "left", id: "local-one"});
  assert.equal(view.read().pair.right, "");
  change("[data-cmp-select]", {cmpSelect: "right"}, "ente-one");
  change("[data-cmp-filter]", {}, "exclusive");
  view.update(f);
  assert.deepEqual(view.read().pair, {left: "local-one", right: "ente-one", filter: "exclusive"});
});

test("live local data passes comparison without rerunning either recognition engine", {skip: !process.env.LAB_COMPARISON_LIVE}, async () => {
  const base = "http://127.0.0.1:8766";
  const get = async path => {const r = await fetch(base + path); assert.equal(r.status, 200); return r.json();};
  const metadata = await get("/api/bootstrap");
  const response = await fetch(base + "/api/collections", {method: "POST",
    headers: {"Content-Type": "application/json", "X-Lab-Token": metadata.token}, body: JSON.stringify({config: metadata.defaults})});
  assert.equal(response.status, 200);
  const local = await response.json(), state = await get("/api/ente");
  const data = comparison.model(local, state.record, metadata);
  assert.equal(state.record.dataset_id, metadata.dataset.id);
  assert.equal(state.record.result.ente_diagnostics.photo_count, metadata.dataset.count);
  assert.equal(data.left.ids.size, new Set(local.albums.flatMap(a=>a.photo_ids)).size);
  assert.equal(data.right.ids.size, new Set(state.record.result.events.flatMap(a=>a.photo_ids)).size);
  // Retain the frozen 447-photo regression when that dataset is active; the
  // current complete shared album is larger and must not inherit its counts.
  if(metadata.dataset.id==="78b8a4d90d809fbbee2bbb2a891e663d8f47eea85a289303ec76d21963d34bf1"){
    assert.equal(metadata.dataset.count,447);
    assert.equal(data.left.albums.length,10);assert.equal(data.left.ids.size,92);
    assert.equal(data.right.albums.length,2);assert.equal(data.right.ids.size,18);
  }
  const view = mount({local, record: state.record, meta: metadata, state});
  assert.equal(view.view.read().right.snapshot_id, state.record.id);
  for (const path of ["/album-comparison.js", "/engines.css", "/app.js", "/media/" + data.left.albums[0].cover, "/media/" + data.right.albums[0].cover]) {
    const response = await fetch(base + path); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  console.log(JSON.stringify({candidate: metadata.dataset.count, leftAlbums: data.left.albums.length, leftUnique: data.left.ids.size,
    rightAlbums: data.right.albums.length, rightUnique: data.right.ids.size, shared: data.totals.shared.length,
    leftOnly: data.totals.leftOnly.length, rightOnly: data.totals.rightOnly.length,
    leftResult: local.id, rightSnapshot: state.record.id}));
});
