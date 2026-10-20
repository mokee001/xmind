// UI logic checks without a browser, image loading, URL navigation or network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const template = fs.readFileSync(path.join(__dirname, '../gateway/echoo_gateway/calibration.html'), 'utf8');
const keys = ['sharpness','exposure','colorNaturalness','cutoutFeasibility','expression','lifelikeness','interest'];
const reasons = ['detailed','balanced','natural','separated','engaging','spontaneous','ordinary'];
const ids = [1,2,3,4,5].map(n => String(n).repeat(64));
const manifest = {photos:ids.map((id,i)=>({photoID:id,sourceName:'sample-'+i+'.jpg',previewFilename:'verified/'+id+'.jpg',width:512,height:400})),proposedIDs:[],nativeStatus:'unavailable',previewVersion:'imageio-verified-pixels-v2'};
function harness(report = null, options = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',style:{},checked:false});
    return elements.get(id);
  }
  const alerts = [];
  const context = vm.createContext({
    URLSearchParams, Map, Set, Number, Object, String, Array, Promise, encodeURIComponent,
    location:{protocol:options.protocol||'file:',search:''},
    fetch:options.fetch,
    document:{getElementById:element,querySelectorAll:options.querySelectorAll||(()=>[])},
    alert:(message)=>alerts.push(message)
  });
  const initial = JSON.stringify({manifest,report,features:{cutoutVerification:options.processingSupport!==false,
    retryEvaluation:options.retrySupport!==false,reselect:options.reselectSupport!==false,selectionStrategyVersion:'blue-sky-selection-v3'}});
  const code = template.split('<script>')[1].split('</script>')[0].replace('/*ECHOO_INITIAL_DATA*/null', initial);
  new vm.Script(code).runInContext(context);
  return {context, elements, alerts, run:code=>vm.runInContext(code, context)};
}
let h = harness();
assert.equal((h.elements.get('app').innerHTML.match(/type="checkbox"/g)||[]).length, 5);
assert.equal(h.elements.get('count').textContent, '已选 0 / 20 张');
assert(h.elements.get('app').innerHTML.includes('原生宠物候选识别'));
assert(h.elements.get('app').innerHTML.includes('尚未按模板筛选'));
assert(h.elements.get('app').innerHTML.includes('verified/'+ids[0]+'.jpg'));
h.run("chosen.add('"+ids[0]+"');renderGallery()");
assert.equal(h.elements.get('count').textContent, '已选 1 / 20 张');
h.run('chosen=new Set(Array.from({length:20},(_,i)=>String(i)))');
const input = {checked:true,closest:()=>({classList:{toggle(){}}})};
h.context.input = input;
h.run("toggle('extra',input)");
assert.equal(input.checked,false);
assert.equal(h.run('chosen.size'),20);
h.run('active={ids:[manifest.photos[0].photoID],detailPrefix:"run-test/"};renderSampleReview()');
assert(h.elements.get('app').innerHTML.includes('宠物分组'));
assert(h.elements.get('app').innerHTML.includes('run-test/'+ids[0]+'.jpg'));
const resumed = harness({ids:[ids[0]],detailPrefix:'run-recovered/',humanGroups:{[ids[0]]:'7'}});
assert(resumed.elements.get('app').innerHTML.includes('确认本轮样本'));
assert(resumed.elements.get('app').innerHTML.includes('value="7"'));
assert(resumed.elements.get('app').innerHTML.includes('run-recovered/'+ids[0]+'.jpg'));
assert.equal(resumed.run('chosen.size'),1);
assert(resumed.elements.get('app').innerHTML.includes('id="reviewed" type="checkbox">'));
const response={evaluations:ids.map(photoID=>({photoID,
  facts:{isPet:'present'},scores:Object.fromEntries(keys.map((k,i)=>[k,{value:3,reason:reasons[i]}]))
})),identity:[],calls:[],cacheHit:false};
const selections=ids.map((photoID,i)=>({photoID,slot:'photo'+(i+1),score:60,preferred:i>0&&i<4}));
const report={response,plan:{state:'selected',selections,rankings:[],preferredCount:3,totalScore:300},
  cutouts:selections.map(p=>({...p,state:'extractionUnavailable'})),identityComparison:{confirmedPairs:0,agree:0,disagree:0,unknown:0},
  humanGroups:{},ids,detailPrefix:'run-test/'};
h = harness(report);
assert.equal((h.elements.get('app').innerHTML.match(/data-cutout=/g)||[]).length,5);
assert.equal((h.elements.get('app').innerHTML.match(/data-score-id=/g)||[]).length,35);
assert(h.elements.get('app').innerHTML.includes('抠图可行性'));
assert(!h.elements.get('app').innerHTML.includes('NaN'));
assert(!h.elements.get('app').innerHTML.includes('undefined'));
const reviewedReport=JSON.parse(JSON.stringify(report));
reviewedReport.cutouts=selections.map(p=>({...p,state:'awaitingHumanVerification',filename:p.photoID+'.png'}));
reviewedReport.cutoutReview=Object.fromEntries(ids.map(id=>[id,'pass']));
reviewedReport.cutoutsVerified=true;
const currentReport=JSON.parse(JSON.stringify(reviewedReport));
currentReport.plan.strategyVersion='blue-sky-selection-v3';
currentReport.plan.selections[1].matchedPreferences=['topDown','curled'];
currentReport.reselection={originalAnalysisReused:true};
const currentPage=harness(currentReport);
assert(currentPage.elements.get('app').innerHTML.includes('俯拍视角、蜷曲姿态'));
assert(currentPage.elements.get('app').innerHTML.includes('未知或不适用的偏好不阻止入选'));
assert(currentPage.elements.get('app').innerHTML.includes('未重新判断俯拍'));
assert(!currentPage.elements.get('app').innerHTML.includes('onclick="reselect()"'));
const staleReport=JSON.parse(JSON.stringify(reviewedReport));
staleReport.response.calls=[{model:'qwen3.8-flash',status:'completed',usage:{},elapsedMS:100}];
assert(harness(staleReport).elements.get('app').innerHTML.includes('按最新规则重新选片（沿用评分）'));
const oldSelectionProcess=harness(staleReport,{reselectSupport:false});
assert(oldSelectionProcess.elements.get('app').innerHTML.includes('更新选片入口需要重启测试终端'));
assert(!oldSelectionProcess.elements.get('app').innerHTML.includes('onclick="reselect()"'));
const saved=harness(reviewedReport);
manifest.targetPetPhotoID=ids[0];manifest.targetProposalNativeStatus='unavailable';
const targetPage=harness();
assert(targetPage.elements.get('app').innerHTML.includes('本轮固定测试 sample-0.jpg 中的目标宠物'));
assert(targetPage.elements.get('app').innerHTML.includes('未能生成相似度建议'));
delete manifest.targetPetPhotoID;delete manifest.targetProposalNativeStatus;
assert(saved.elements.get('app').innerHTML.includes('自动验收并生成预览'));
const oldProcess=harness(reviewedReport,{processingSupport:false});
assert(oldProcess.elements.get('app').innerHTML.includes('需要新版启动进程'));
assert(!oldProcess.elements.get('app').innerHTML.includes('onclick="processArtwork()"'));
assert.equal((saved.elements.get('app').innerHTML.match(/value="pass" selected/g)||[]).length,5);
assert(saved.elements.get('app').innerHTML.includes('本轮 5 张抠图已确认通过'));
assert(!saved.elements.get('app').innerHTML.includes('本轮样本已选出五张'));
saved.run("active.humanScores={};renderResults()");
assert.equal((saved.elements.get('app').innerHTML.match(/value="pass" selected/g)||[]).length,5);
const draft=harness(report);
draft.run("rememberCutout({dataset:{slot:'photo1',cutout:manifest.photos[0].photoID},value:'pass'});rememberScore({dataset:{scoreId:manifest.photos[0].photoID,dimension:'exposure'},value:'2'});renderResults()");
assert(draft.elements.get('app').innerHTML.includes('value="pass" selected'));
assert(draft.elements.get('app').innerHTML.includes('value="2" data-score-id="'+ids[0]+'" data-dimension="exposure"'));
assert(draft.run("cutoutOptions({slot:'photo5',photoID:manifest.photos[0].photoID})").includes('value="unknown" selected'));
const pendingProcessing=JSON.parse(JSON.stringify(reviewedReport));
pendingProcessing.processing={state:'pending',artifactPrefix:'run-test/processing-test/',cutouts:reviewedReport.cutouts,
  verdicts:selections.map(p=>({...p,state:'pending',failed:[],unresolved:['verificationEvidence']})),attempts:[]};
const pendingPage=harness(pendingProcessing);
assert(pendingPage.elements.get('app').innerHTML.includes('存在待确认项'));
assert(!pendingPage.elements.get('app').innerHTML.includes('alt="自动验收后的蓝天绿地拼贴预览"'));
assert(pendingPage.elements.get('app').innerHTML.includes(ids[0]+'.masked.jpg'));
assert(pendingPage.elements.get('app').innerHTML.includes('本轮 5 张抠图已确认通过'));
const passedProcessing=JSON.parse(JSON.stringify(pendingProcessing));
passedProcessing.processing.state='passed';passedProcessing.processing.artifact='artwork-test.png';
const passedPage=harness(passedProcessing);
assert(passedPage.elements.get('app').innerHTML.includes('run-test/processing-test/artwork-test.png'));
assert(passedPage.elements.get('app').innerHTML.includes('模板视觉参数已定稿'));
report.plan={state:'pendingEvidence',selections:[],rankings:[],preferredCount:0,totalScore:0};
report.cutouts=[];
report.response.evaluations[0].scores.sharpness={value:null,reason:'unresolved'};
h = harness(report);
assert(h.elements.get('app').innerHTML.includes('历史结果：证据待确认'));
assert(h.elements.get('app').innerHTML.includes('待确认'));
assert(!h.elements.get('app').innerHTML.includes('data-cutout='));
h.run("post('/evaluate',{},'test')");
assert(h.alerts[0].includes('只读预览'));
const failedReport=JSON.parse(JSON.stringify(report));
failedReport.response.calls=[{status:'failed',model:'qwen3.8-flash',errorCode:'qwen_transport_failed',usage:{},elapsedMS:121900}];
const failedPage=harness(failedReport);
assert(failedPage.elements.get('app').innerHTML.includes('重试本轮模型调用'));
assert(failedPage.elements.get('app').innerHTML.includes('无法据此判断是超时'));
assert(!failedPage.elements.get('app').innerHTML.includes('请核对 API key'));
const oldFailedPage=harness(failedReport,{retrySupport:false});
assert(oldFailedPage.elements.get('app').innerHTML.includes('重试入口需要新版启动进程'));
assert(!oldFailedPage.elements.get('app').innerHTML.includes('onclick="retryEvaluation()"'));
failedPage.run("active.response.calls[0].errorCode='qwen_timeout';renderResults()");
assert(failedPage.elements.get('app').innerHTML.includes('等待超时'));
delete manifest.previewVersion;
h = harness();
assert(h.elements.get('app').innerHTML.includes('旧版预览缓存需要重建'));
h.run("post('/evaluate',{},'test')");
assert(h.alerts[0].includes('旧版预览缓存尚未重建'));
for(let count=0;count<5;count++) {
  const reduced=JSON.parse(JSON.stringify(currentReport));
  const hidden=['photo4','photo3','photo2','photo1','photo5'].slice(0,5-count);
  reduced.plan.selections=reduced.plan.selections.filter(p=>!hidden.includes(p.slot));
  reduced.plan.hiddenSlots=hidden;
  reduced.plan.mode=count?'fallback':'backgroundOnly';
  reduced.cutouts=reduced.cutouts.filter(p=>!hidden.includes(p.slot));
  const page=harness(reduced);
  assert.equal((page.elements.get('app').innerHTML.match(/data-cutout=/g)||[]).length,count);
  assert(page.elements.get('app').innerHTML.includes('本轮隐去槽位'));
  assert(!page.elements.get('app').innerHTML.includes('undefined'));
  if(!count)assert(page.elements.get('app').innerHTML.includes('无照片背景方案'));
}
async function checkErrorMessage() {
  manifest.previewVersion='imageio-verified-pixels-v2';
  const page=harness(null,{protocol:'http:',fetch:async()=>({ok:false,status:400,
    json:async()=>({error:'batch_preview_limit',message:'本轮详细预览合计超过6 MiB，尚未调用模型。'})})});
  await page.run("post('/evaluate',{},'test')");
  assert(page.alerts[0].includes('超过6 MiB'));
  assert.equal(page.run('busy'),false);
  let requests=0;
  const allUnknown=harness(reviewedReport,{protocol:'http:',
    querySelectorAll:selector=>selector==='[data-cutout]'?ids.map(id=>({dataset:{cutout:id},value:'unknown'})):[],
    fetch:async()=>{requests++;throw Error('Must not send all unknown')}});
  await allUnknown.run('saveCutoutFeedback()');
  assert.equal(requests,0);
  assert(allUnknown.alerts[0].includes('仍为待确认'));
  const newRound=harness(reviewedReport,{protocol:'http:',fetch:async path=>{
    assert.equal(path,'/new-round');
    return {ok:true,json:async()=>({ids,detailPrefix:'run-next/',humanGroups:{[ids[0]]:'2'}})};
  }});
  newRound.run("cutoutDraft.set('old','pass');scoreDraft.set('old','2')");
  await newRound.run('prepareNextRound()');
  assert(newRound.elements.get('app').innerHTML.includes('确认本轮样本'));
  assert(newRound.elements.get('app').innerHTML.includes('value="2"'));
  assert.equal(newRound.run('cutoutDraft.size'),0);
  assert.equal(newRound.run('scoreDraft.size'),0);
  const retryPage=harness(failedReport,{protocol:'http:',fetch:async path=>{
    assert.equal(path,'/retry-evaluate');
    return {ok:true,json:async()=>reviewedReport};
  }});
  await retryPage.run('retryEvaluation()');
  assert(retryPage.elements.get('app').innerHTML.includes('本轮 5 张抠图已确认通过'));
  const reselectPage=harness(staleReport,{protocol:'http:',fetch:async path=>{
    assert.equal(path,'/reselect');
    return {ok:true,json:async()=>currentReport};
  }});
  await reselectPage.run('reselect()');
  assert(reselectPage.elements.get('app').innerHTML.includes('未新增原片评分调用'));
  assert(!reselectPage.elements.get('app').innerHTML.includes('onclick="reselect()"'));
  const processingAction=harness(reviewedReport,{protocol:'http:',fetch:async path=>{
    assert.equal(path,'/process-artwork');
    return {ok:true,json:async()=>passedProcessing};
  }});
  await processingAction.run('processArtwork()');
  assert(processingAction.elements.get('app').innerHTML.includes('/artwork/current?token='));
  assert(processingAction.elements.get('app').innerHTML.includes('验收通过，成品已生成'));
  console.log('Calibration UI logic checks passed (no browser/network).');
}
checkErrorMessage().catch(error=>{console.error(error);process.exitCode=1});
