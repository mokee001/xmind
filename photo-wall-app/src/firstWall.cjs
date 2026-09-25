const { hasDisplayReceipt } = require('./wallExperienceState.cjs');

// A failed/uncertain publish is reconciled before any further write. Persist its
// intent before dispatch so terminating the app cannot silently duplicate it.
async function runFirstWall({ load, save, readDevice, prepare, generate, publish, stage,
  active = () => true, sleep = ms => new Promise(r => setTimeout(r, ms)), polls = 60, retryUncertain = false }) {
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
    await prepare(); check(); stage('generating');
    let wall;
    // The fixed-rule worker may still be producing its provisional snapshot.
    for (let i = 0; i < 24; i++) {
      check();
      try { wall = await generate(); break; }
      catch (error) {
        if (error.status !== 409 || !/尚未|初筛|合格照片不足/.test(error.message) || i === 23) throw error;
        // One extra bounded batch if the first set is still insufficient.
        if (i === 6) await prepare({ additional: true });
        await sleep(5000);
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
module.exports = { runFirstWall };
