const RANGE_MODES = ['all', 'year', 'since'];
const TEMPORAL_PREFERENCES = ['balanced', 'recent', 'past'];

function normalizePhotoRange(value) {
  return {
    mode: RANGE_MODES.includes(value?.mode) ? value.mode : 'all',
    since: typeof value?.since === 'string' ? value.since.trim() : '',
  };
}

function localDateString(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidPhotoRange(value, today = new Date()) {
  if (!RANGE_MODES.includes(value?.mode)) return false;
  if (value.mode !== 'since') return true;
  const since = typeof value.since === 'string' ? value.since.trim() : '';
  const end = today instanceof Date ? localDateString(today) : today;
  return validCalendarDate(since) && validCalendarDate(end) && since <= end;
}

function photoRangeLabel(value) {
  const range = normalizePhotoRange(value);
  if (range.mode === 'year') return '最近一年的照片';
  if (range.mode === 'since') return range.since ? `从 ${range.since} 开始` : '从指定日期开始';
  return '全部已授权照片';
}

function normalizeTemporalPreference(value) {
  return TEMPORAL_PREFERENCES.includes(value) ? value : 'balanced';
}

function temporalPreferenceLabel(value) {
  return {
    balanced: '最近与过往均衡安排',
    recent: '更多最近的生活',
    past: '多看看从前',
  }[normalizeTemporalPreference(value)];
}

module.exports = {
  normalizePhotoRange,
  isValidPhotoRange,
  photoRangeLabel,
  normalizeTemporalPreference,
  temporalPreferenceLabel,
};
