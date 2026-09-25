// Local interaction simulation only. Never represents a hardware acknowledgement.
export function mountFirstWall({ host, header, onDone }) {
  let timer, stopped = false, attempt = 0;
  const scenario = document.querySelector('#first-wall-scenario')?.value || 'success';
  const stages = [
    ['正在准备第一幅回忆', '从手机里已有的照片开始，不必等整个相册。'],
    ['正在准备第一幅回忆', '照片正在慢慢组成一幅画面。'],
    ['回忆即将抵达', '照片墙正在接收这次的画面。'],
    ['回忆即将抵达', '正在等待照片墙完成刷新。'],
  ];
  header.innerHTML = '<span class="flow-brand">echooo<span>®</span></span>';
  function render(title, copy, mode = 'waiting') {
    host.innerHTML = `<div class="flow-shell first-wall"><div class="flow-scroll"><div class="first-wall-art ${mode}" aria-hidden="true"><i></i><i></i><i></i><i></i><span>${mode === 'done' ? '✓' : ''}</span></div><div role="status" aria-live="polite"><h1>${title}</h1><p class="flow-lead">${copy}</p></div></div><footer class="flow-footer">${mode === 'failed' ? '<button class="flow-primary" data-first-retry>再试一次</button>' : mode === 'done' ? '<button class="flow-primary" data-first-done>进入日历</button>' : '<p>首次准备中，请暂时保持 App 打开。</p>'}<p>Demo · 选片、生成、投送与设备回执均为模拟</p></footer></div>`;
    host.querySelector('[data-first-retry]')?.addEventListener('click', () => { attempt++; run(0); });
    host.querySelector('[data-first-done]')?.addEventListener('click', onDone);
  }
  function run(index) {
    if (stopped) return;
    clearTimeout(timer);
    if (index === 4) { render('第一幅回忆，已在照片墙。', '以后的日子，也会有新的相遇。', 'done'); return; }
    render(...stages[index]);
    timer = setTimeout(() => {
      if (stopped) return;
      if (!attempt && scenario === 'empty' && index === 0) render('还需要几张照片', '当前授权范围内没有足够的可用照片。<br>正式 App 可在这里补充照片授权后继续。', 'failed');
      else if (!attempt && scenario === 'upload' && index === 1) render('这次准备暂时中断了', '请检查网络后重试。<br>照片墙已连接，无需重新设置。', 'failed');
      else if (!attempt && scenario === 'receipt' && index === 3) render('还未收到屏幕的回应', '照片已送出，但暂未确认显示。<br>请检查照片墙的电源与网络。', 'failed');
      else run(index + 1);
    }, index === 3 ? 2400 : 1800);
  }
  run(0);
  return () => { stopped = true; clearTimeout(timer); };
}
