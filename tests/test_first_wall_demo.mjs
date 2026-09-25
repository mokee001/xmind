import assert from 'node:assert/strict';
import fs from 'node:fs';
const { mountFirstWall } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/first-wall.js')).toString('base64')}`);
for (const scenario of ['success', 'empty', 'upload', 'receipt']) {
  const tasks = new Map(); let id = 0; const actions = {};
  globalThis.setTimeout = fn => { tasks.set(++id, fn); return id; };
  globalThis.clearTimeout = key => tasks.delete(key);
  globalThis.document = { querySelector: () => ({ value: scenario }) };
  const host = { innerHTML: '', querySelector: selector => host.innerHTML.includes(selector.slice(1,-1)) ? { addEventListener: (_, fn) => actions[selector] = fn } : null };
  let done = false;
  const stop = mountFirstWall({ host, header: {}, onDone: () => { done = true; } });
  const flush = () => { for (let n=0; tasks.size && n<20; n++) { const [key, fn] = tasks.entries().next().value; tasks.delete(key); fn(); } };
  flush();
  if (scenario !== 'success') { assert.match(host.innerHTML, /data-first-retry/); assert.doesNotMatch(host.innerHTML, /第一幅回忆，已在照片墙/); actions['[data-first-retry]'](); flush(); }
  assert.match(host.innerHTML, /第一幅回忆，已在照片墙/);
  actions['[data-first-done]'](); assert.ok(done); stop();
  mountFirstWall({ host, header:{}, onDone:()=>{} })(); const prior=host.innerHTML; flush(); assert.equal(host.innerHTML, prior);
}
console.log('PASS: success, three failures, recovery, cancellation');
