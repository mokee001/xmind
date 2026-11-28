(function (root) {
  'use strict';
  const trackIds = ['hardware', 'software', 'template'];
  function upgrade(input, defaults) {
    const value = structuredClone(input);
    if (value.schemaVersion === 2) return validate(value);
    if (value.schemaVersion !== undefined) throw new Error('此数据版本需要更新看板后再打开');
    value.schemaVersion = 2;
    value.plan = structuredClone(defaults.plan);
    value.tasks = value.tasks.map(task => ({...task,
      milestoneId: defaults.taskLinks[task.id]?.milestoneId || '',
      outcome: defaults.taskLinks[task.id]?.outcome || ''
    }));
    value.focus = Object.fromEntries(trackIds.map(track => [track, {
      goal: defaults.focus[track].goal,
      taskIds: defaults.focus[track].taskIds.filter(id => value.tasks.some(task => task.id === id && task.track === track))
    }]));
    return validate(value);
  }
  function validate(value) {
    if (!value || value.schemaVersion !== 2 || !Number.isInteger(value.revision) || value.revision < 0 ||
        !value.owners || !trackIds.every(k => typeof value.owners[k] === 'string' && value.owners[k].trim()) ||
        !['tasks', 'ideas', 'updates', 'releases'].every(k => Array.isArray(value[k])) ||
        typeof value.plan?.goal !== 'string' || !value.plan.goal.trim() || !Array.isArray(value.plan.milestones) ||
        value.plan.milestones.length !== 3) throw new Error('看板数据结构不完整');
    const milestones = value.plan.milestones;
    if (new Set(milestones.map(m=>m.id)).size !== 3 || milestones.some(m =>
      !['baseline','validation','delivery'].includes(m.id) || typeof m.title !== 'string' || !m.title.trim() || typeof m.outcome !== 'string')) throw new Error('里程碑信息不完整');
    const ids = new Set();
    for (const task of value.tasks) {
      if (!task.id || ids.has(task.id) || !trackIds.includes(task.track) ||
          typeof task.title !== 'string' || !task.title.trim() || !['todo','doing','blocked','done'].includes(task.status) ||
          typeof task.milestoneId !== 'string' || (task.milestoneId && !milestones.some(m=>m.id===task.milestoneId)) ||
          typeof task.outcome !== 'string') throw new Error('任务或关联里程碑无效');
      ids.add(task.id);
    }
    for (const track of trackIds) {
      const focus = value.focus?.[track];
      if (!focus || typeof focus.goal !== 'string' || !focus.goal.trim() || !Array.isArray(focus.taskIds) ||
          focus.taskIds.length > 3 || new Set(focus.taskIds).size !== focus.taskIds.length ||
          focus.taskIds.some(id=>!value.tasks.some(t=>t.id===id && t.track===track))) throw new Error('当前重点需要关联本工作线的任务，最多 3 项');
    }
    return value;
  }
  function progress(tasks) {
    const done = tasks.filter(t=>t.status==='done').length;
    return {done, total:tasks.length, percent:tasks.length ? Math.round(done/tasks.length*100) : 0};
  }
  function currentMilestone(state) {
    return state.plan.milestones.find(m=>{
      const tasks=state.tasks.filter(t=>t.milestoneId===m.id);
      return !tasks.length || tasks.some(t=>t.status!=='done');
    }) || null;
  }
  const api = {upgrade, validate, progress, currentMilestone};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    const base = new URL('./', document.currentScript.src);
    api.ready = location.protocol === 'file:' ? Promise.resolve(null) : fetch(new URL('plan-defaults.json',base)).then(response=>{
      if(!response.ok) throw new Error('无法读取项目计划，请刷新重试');
      return response.json();
    });
    root.EchooPlan = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
