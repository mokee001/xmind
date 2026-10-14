const { hasDisplayReceipt } = require('./wallExperienceState.cjs');

const LEGACY_PENDING_REASONS = new Set([
  '尚无当前账户的合格照片',
  '照片尚未完成初筛，请稍后重试',
  '当前展示范围内合格照片不足；不会补入未入选或被排除的照片',
]);

function canRetryGeneration(error) {
  if (error.status !== 409) return false;
  // deviceApi preserves the server response in error.data, including false.
  if (error.data?.retryable !== undefined) return error.data.retryable === true;
  return LEGACY_PENDING_REASONS.has(error.message);
}

function needsMoreCandidates(error) {
  return error.data?.code === 'insufficient_candidates' || (!error.data?.code && [
    '尚无当前账户的合格照片',
    '当前展示范围内合格照片不足；不会补入未入选或被排除的照片',
  ].includes(error.message));
}

function readinessError(result) {
  return Object.assign(new Error(result.reason || '当前照片范围暂时不能生成，请检查偏好。'), {
    status:409, code:result.code, retryable:false, data:{...result, retryable:false},
  });
}

async function generateWhenReady({ readiness, resume, prepare, generate, check, sleep, stage,
  preparationPolls, maxPreparationBatches }) {
  let batches = 0, resumed = false;
  for (let attempt = 0; attempt < preparationPolls; attempt++) {
    check();
    const result = await readiness(); check();
    // An older backend can omit the action contract or the readiness route.
    if (!result?.action) return null;
    if (result.action === 'review' || (result.retryable === false && !result.ready)) throw readinessError(result);
    if (result.action === 'upload') {
      if (batches >= maxPreparationBatches) throw readinessError({code:'insufficient_candidates',
        reason:'当前可用照片还不足以完成这幅回忆，请检查照片权限或展示偏好后继续。已完成的步骤会保留。'});
      stage('preparing');
      await prepare({additional:batches > 0}); batches++; check();
      continue;
    }
    if (result.action === 'wait') {
      stage('generating');
      if (result.resumeRequired && !resumed && resume) {
        await resume(); resumed = true; check();
      }
    } else if (result.action === 'generate' && result.ready === true) {
      stage('generating');
      try { const wall = await generate(); check(); return {wall}; }
      catch (error) {
        if (!canRetryGeneration(error)) throw error;
        // A concurrent worker update can invalidate readiness. Re-read it;
        // generation failures themselves never schedule more photo uploads.
      }
    } else throw new Error('选片服务返回了无效状态，请稍后继续。');
    await sleep(5000); check();
  }
  throw Object.assign(new Error('照片仍在处理中，请稍后继续检查。已完成的步骤会保留，无需重新连接照片墙。'),
    {code:'selection_timed_out'});
}

function needsFirstWallRun({ visibleState, savedState, device }) {
  // A suspended visible attempt must reconcile its persisted revision even if
  // regular device polling received a display receipt while it was paused.
  if (visibleState && !['done','failed'].includes(visibleState)) return true;
  return savedState !== 'done' && !hasDisplayReceipt(device);
}

// A failed/uncertain publish is reconciled before any further write. Persist its
// intent before dispatch so terminating the app cannot silently duplicate it.
async function runFirstWall({ load, save, readDevice, prepare, generate, publish, stage,
  active = () => true, sleep = ms => new Promise(r => setTimeout(r, ms)), polls = 60, retryUncertain = false,
  readiness, resume, preparationPolls = 120, maxPreparationBatches = 4 }) {
  const check = () => { if (!active()) throw new Error('准备已暂停，请回到 App 后继续。'); };
  let saved = await load() || {};
  check(); stage('preparing');
  let device = await readDevice(); check();
  if (saved.state === 'done') { stage('done'); return; }
  const restartFailed = retryUncertain && (device.error || ['error', 'failed'].includes(device.state));
  if (retryUncertain && (restartFailed || (saved.revision && saved.revision !== String(device.revision || '')))) {
    saved = {}; await save(saved);
  }
  if (saved.state === 'publishing' && !saved.revision) {
    if (device.revision && String(device.revision) !== String(saved.beforeRevision || '')) {
      saved = { ...saved, revision: String(device.revision), state: 'waiting' };
      await save(saved);
    } else if (retryUncertain) {
      saved = {}; await save(saved);
    } else throw Object.assign(new Error('上次发送结果未确认，屏幕也还没有新画面。可以重新检查；若屏幕仍为空白，可重新准备并发送。'), { canRestart: true });
  }
  if (!saved.revision && device.revision && !restartFailed) {
    saved = { state: 'waiting', revision: String(device.revision) };
    await save(saved);
  }
  if (!saved.revision) {
    const prepared = readiness ? await generateWhenReady({readiness,resume,prepare,generate,check,sleep,stage,
      preparationPolls,maxPreparationBatches}) : null;
    let wall = prepared?.wall;
    if (!prepared) {
      // Bounded compatibility for servers that predate the action contract.
      await prepare(); check(); stage('generating');
      for (let i = 0; i < 24; i++) {
        check();
        try { wall = await generate(); break; }
        catch (error) {
          if (!canRetryGeneration(error) || i === 23) throw error;
          if (i === 6 && needsMoreCandidates(error)) await prepare({ additional: true });
          await sleep(5000);
        }
      }
    }
    check();
    if (!wall?.wall_id || !wall?.image_url) throw new Error('未收到有效画面，请重试。');
    stage('publishing');
    saved = { state: 'publishing', wallId: wall.wall_id, beforeRevision: device.revision || '' };
    await save(saved); check();
    const result = await publish(wall); check();
    device = result.device;
    saved = { ...saved, state: 'waiting', revision: result.revision };
    await save(saved);
  }
  stage('waiting');
  for (let i = 0; i < polls; i++) {
    check();
    if (String(device.revision || '') !== saved.revision) throw Object.assign(new Error('照片墙的画面已变化，请重新查看设备状态。'), { canRestart: true });
    if (hasDisplayReceipt(device)) {
      await save({ ...saved, state: 'done' }); check(); stage('done'); return;
    }
    if (device.error || ['error','failed'].includes(device.state)) throw Object.assign(new Error('照片墙刷新失败，请检查设备后重新准备并发送。'), { canRestart: true });
    await sleep(5000); check(); device = await readDevice();
  }
  throw new Error('照片已送出，但还未收到屏幕完成刷新的回应。请检查设备电源和网络后重新检查。');
}
module.exports = { runFirstWall, needsFirstWallRun };
