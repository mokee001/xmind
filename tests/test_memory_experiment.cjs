const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bestMatch,overlap,esc}=require('../selection_lab/static/memory-experiment.js');
const a=(id,ids,kind='event')=>({id,kind,photo_ids:ids,candidate_ids:ids});
test('matching uses candidate overlap and keeps empty or unrelated results empty',()=>{
  const right=a('right',['1','2','3','4']);
  assert.equal(bestMatch(right,[]),null);
  assert.equal(bestMatch(right,[a('unrelated',['5'])]),null);
  assert.equal(bestMatch(right,[a('trip',['1','2','3','4'],'trip')]),null);
  assert.equal(bestMatch(right,[a('small',['1']),a('better',['1','2','3'])]).id,'better');
  assert.equal(overlap(right,a('same',['1','2','3','4'])),1);
});
test('matching ties are deterministic and titles are escaped',()=>{
  assert.equal(bestMatch(a('r',['1']),[a('b',['1']),a('a',['1'])]).id,'a');
  assert.equal(esc('<img src="x" onerror="bad">'),'&lt;img src=&quot;x&quot; onerror=&quot;bad&quot;&gt;');
});
