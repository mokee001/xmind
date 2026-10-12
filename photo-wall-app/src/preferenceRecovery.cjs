const { sameDeviceBinding } = require('./deviceStatus.cjs');
const { extendPreferenceSnapshot, snapshotsEqual } = require('./preferenceSnapshot.cjs');

const LEGACY_PEOPLE_ERROR = '人物识别分组已变化或尚未完成，请重新确认人物偏好；未忽略原有范围';

function firstWallFailure(error, binding) {
  const code = error.data?.code ?? error.code;
  const retryable = error.data?.retryable ?? error.retryable;
  return { binding, state:'failed', message:error.message, canRestart:error.canRestart === true,
    ...(typeof code === 'string' ? {code} : {}),
    ...(typeof retryable === 'boolean' ? {retryable} : {}) };
}

function isPeoplePreferenceError(error) {
  return ['people_selection_changed','people_pending'].includes(error?.code)
    || error?.message === LEGACY_PEOPLE_ERROR;
}

function unresolvedPersonRules(rules, content) {
  const people = (content?.people || []).filter(item => Array.isArray(item.filters) && item.filters.length);
  return Object.entries(rules || {}).filter(([id, rule]) => id.startsWith('person-person_')
    && ['more','hide'].includes(rule) && !people.some(person => person.id === id));
}

function preferenceFilters(content, rules, unified = true) {
  const people = (content.people || []).filter(item => Array.isArray(item.filters) && item.filters.length);
  const themes = [...(content.topics || []), ...(content.albums || [])].filter(item => Array.isArray(item.filters) && item.filters.length);
  const unresolved = unified ? unresolvedPersonRules(rules, content) : [];
  return {
    prefer:[...new Set([...people, ...themes].filter(item => rules[item.id] === 'more')
      .flatMap(item => item.filters).concat(unresolved.filter(([,rule]) => rule === 'more').map(([id]) => id.slice(7))))],
    exclude:[...new Set(people.filter(item => rules[item.id] === 'hide')
      .flatMap(item => item.filters).concat(unresolved.filter(([,rule]) => rule === 'hide').map(([id]) => id.slice(7))))],
  };
}

async function savePreferenceWithFallback({ remote, cache, local, current }) {
  let profile, localOnly = false;
  if (!current()) return null;
  if (remote) {
    try {
      profile = await remote();
    } catch (error) {
      if ([401,403,409].includes(Number(error?.status))) throw error;
      localOnly = true;
    }
    if (!current()) return null;
    if (profile) await cache(profile);
  }
  if (!current()) return null;
  if (!profile) profile = await local();
  return current() ? { profile, localOnly } : null;
}

async function commitManagedPreferenceDraft({ draft, profile, baseSnapshot, recoveryContent = null, current, persist, apply }) {
  if (!current()) return null;
  if (recoveryContent && unresolvedPersonRules(draft.rules, recoveryContent).length) {
    throw new Error('还有待确认的旧人物选择。请逐项取消旧选择，或返回保留原偏好；当前可选人物恢复后也可重新确认。');
  }
  const snapshot = extendPreferenceSnapshot(baseSnapshot, {
    rules:draft.rules, photoRange:draft.photoRange, temporalPreference:draft.temporalPreference,
  });
  const active = profile?.revisions?.find(item => item.id === profile.activeRevisionId);
  const saved = active && snapshotsEqual(active.snapshot, snapshot) ? profile : await persist(snapshot);
  if (!saved || !current()) return null;
  const revision = saved.revisions?.find(item => item.id === saved.activeRevisionId);
  if (!revision?.snapshot) throw new Error('没有读到保存的偏好，请重试。');
  apply(revision.snapshot);
  return { snapshot:revision.snapshot, revisionId:saved.activeRevisionId };
}

function resumePreferenceRecovery(pending, scope, start) {
  if (!sameDeviceBinding(pending, scope)) return false;
  start(false, { snapshot:pending.snapshot, revisionId:pending.revisionId, content:pending.content });
  return true;
}

async function readRecoveryContent(read, timeoutMs = 8000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([read(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取人物偏好超时，请重试。')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}

module.exports = { firstWallFailure, isPeoplePreferenceError, unresolvedPersonRules, preferenceFilters,
  savePreferenceWithFallback, commitManagedPreferenceDraft, resumePreferenceRecovery, readRecoveryContent };
