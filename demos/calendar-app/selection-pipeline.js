/*
 * Unified selection lifecycle — Demo-only state.
 *
 * This intentionally models a single candidate-set lifecycle instead of a
 * second "quick picker": iPhone's bounded first pass is the temporary active
 * set, and the later canonical snapshot replaces it for future walls. It
 * never claims that this browser demo has read photos, run a model, or
 * received a device display receipt.
 */

export const SELECTION_PIPELINE_STORAGE_KEY = 'echooo-calendar-selection-demo-v1';
export const FAST_PASS_LIMIT = 300;
export const FAST_PASS_CANDIDATE_LIMIT = 72;

const clone = value => JSON.parse(JSON.stringify(value));

function nowValue(now = new Date()) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function emptyPipeline() {
  return {
    version: 1,
    stage: 'idle',
    activeSource: 'none',
    firstPass: {
      status: 'idle',
      inspected: 0,
      candidates: 0,
      source: 'iPhone local rules',
      completedAt: null,
    },
    canonical: {
      status: 'idle',
      snapshotId: '',
      source: 'recollections-rules-v1.0.0',
      readyAt: null,
    },
    updatedAt: null,
  };
}

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function normalize(raw) {
  const initial = emptyPipeline();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return initial;
  const stage = ['idle', 'first-pass-ready', 'canonical-building', 'canonical-ready'].includes(raw.stage)
    ? raw.stage
    : initial.stage;
  const activeSource = ['none', 'first-pass', 'canonical'].includes(raw.activeSource)
    ? raw.activeSource
    : initial.activeSource;
  const firstPass = raw.firstPass && typeof raw.firstPass === 'object' ? raw.firstPass : {};
  const canonical = raw.canonical && typeof raw.canonical === 'object' ? raw.canonical : {};
  return {
    ...initial,
    stage,
    activeSource,
    firstPass: {
      ...initial.firstPass,
      status: ['idle', 'ready'].includes(firstPass.status) ? firstPass.status : initial.firstPass.status,
      inspected: safeNumber(firstPass.inspected, initial.firstPass.inspected),
      candidates: safeNumber(firstPass.candidates, initial.firstPass.candidates),
      completedAt: typeof firstPass.completedAt === 'string' ? firstPass.completedAt : null,
    },
    canonical: {
      ...initial.canonical,
      status: ['idle', 'building', 'ready'].includes(canonical.status) ? canonical.status : initial.canonical.status,
      snapshotId: typeof canonical.snapshotId === 'string' ? canonical.snapshotId.slice(0, 80) : '',
      readyAt: typeof canonical.readyAt === 'string' ? canonical.readyAt : null,
    },
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function loadSelectionPipeline(storage = globalThis.localStorage) {
  try {
    return normalize(JSON.parse(storage?.getItem(SELECTION_PIPELINE_STORAGE_KEY) || 'null'));
  } catch {
    return emptyPipeline();
  }
}

export function saveSelectionPipeline(pipeline, storage = globalThis.localStorage) {
  const normalized = normalize(pipeline);
  try { storage?.setItem(SELECTION_PIPELINE_STORAGE_KEY, JSON.stringify(normalized)); }
  catch { /* The visual walkthrough remains usable without storage. */ }
  return normalized;
}

export function startFirstPass(pipeline, { now, inspected = FAST_PASS_LIMIT, candidates = FAST_PASS_CANDIDATE_LIMIT } = {}) {
  const previous = normalize(pipeline);
  const timestamp = nowValue(now);
  return {
    ...previous,
    // The initial local pass is independently usable. Keeping it visible as
    // its own state makes the transition honest: a fast first wall is not
    // presented as if the formal candidate snapshot already existed.
    stage: 'first-pass-ready',
    activeSource: 'first-pass',
    firstPass: {
      ...previous.firstPass,
      status: 'ready',
      inspected: safeNumber(inspected, FAST_PASS_LIMIT),
      candidates: safeNumber(candidates, FAST_PASS_CANDIDATE_LIMIT),
      completedAt: timestamp,
    },
    canonical: {
      ...previous.canonical,
      status: 'idle',
      snapshotId: '',
      readyAt: null,
    },
    updatedAt: timestamp,
  };
}

export function beginCanonicalPass(pipeline, { now } = {}) {
  const previous = normalize(pipeline);
  if (previous.firstPass.status !== 'ready' || previous.canonical.status === 'ready') return previous;
  const timestamp = nowValue(now);
  return {
    ...previous,
    stage: 'canonical-building',
    // The first pass remains active while a later snapshot is being prepared;
    // there is no second, unrelated photo pool.
    activeSource: 'first-pass',
    canonical: {
      ...previous.canonical,
      status: 'building',
      snapshotId: '',
      readyAt: null,
    },
    updatedAt: timestamp,
  };
}

export function finishCanonicalPass(pipeline, { now, snapshotId = 'demo-recollections-v1' } = {}) {
  const previous = normalize(pipeline);
  // A canonical snapshot cannot leapfrog the bounded first pass. This guard
  // prevents a raw upload pool from being presented as the official source.
  if (previous.firstPass.status !== 'ready' || previous.canonical.status !== 'building') return previous;
  const timestamp = nowValue(now);
  return {
    ...previous,
    stage: 'canonical-ready',
    activeSource: 'canonical',
    canonical: {
      ...previous.canonical,
      status: 'ready',
      snapshotId: String(snapshotId || 'demo-recollections-v1').slice(0, 80),
      readyAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

export function resetSelectionPipeline() {
  return emptyPipeline();
}

export function pipelineSummary(pipeline) {
  const value = normalize(pipeline);
  if (value.stage === 'canonical-ready') {
    return {
      title: '正式候选集已准备',
      detail: '之后的照片墙会从同一份正式候选集取图。',
      badge: '正式候选集',
      tone: 'ready',
    };
  }
  if (value.stage === 'canonical-building') {
    return {
      title: '正在后台完善候选集',
      detail: `已先保留 ${value.firstPass.candidates || FAST_PASS_CANDIDATE_LIMIT} 张候选，后台正增量复核。`,
      badge: '后台完善中',
      tone: 'working',
    };
  }
  if (value.stage === 'first-pass-ready') {
    return {
      title: '先从近期照片开始整理',
      detail: `iPhone 已先检查 ${value.firstPass.inspected || FAST_PASS_LIMIT} 张，准备了 ${value.firstPass.candidates || FAST_PASS_CANDIDATE_LIMIT} 张候选。`,
      badge: '首轮可用',
      tone: 'fast',
    };
  }
  return {
    title: '尚未开始整理照片',
    detail: '连接照片墙后，会先在 iPhone 本机进行快速整理。',
    badge: '等待开始',
    tone: 'idle',
  };
}

export function cloneSelectionPipeline(pipeline) {
  return clone(normalize(pipeline));
}
