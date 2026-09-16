const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const MAX_RENDERED_MONTHS = 12;

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Receipt timestamps must identify an instant. Date-only or timezone-less values
// would silently move records between days on different devices.
function parseConfirmedAt(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return NaN;
  let offset = 0;
  if (zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 23 || zoneMinutes > 59) return NaN;
    offset = (zoneHours * 60 + zoneMinutes) * (zone[0] === '+' ? 1 : -1);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)));
  const timestamp = date.getTime() - offset * 60_000;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeMemoryRecords(records, now = Date.now()) {
  const cutoff = now instanceof Date ? now.getTime() : now;
  if (!Array.isArray(records) || !Number.isFinite(cutoff)) return [];
  const unique = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) continue;
    const timestamp = parseConfirmedAt(record.confirmedAt);
    if (!Number.isFinite(timestamp) || timestamp > cutoff) continue;
    const id = record.id.trim();
    const previous = unique.get(id);
    if (previous && previous.timestamp >= timestamp) continue;
    unique.set(id, {
      id,
      revision: typeof record.revision === 'string' ? record.revision : '',
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '照片墙展示记录',
      confirmedAt: record.confirmedAt.trim(),
      timestamp,
      dayKey: localDateKey(timestamp),
    });
  }
  return [...unique.values()].sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id));
}

function groupMemoryRecords(records, now = Date.now()) {
  const validRecords = normalizeMemoryRecords(records, now);
  const byDay = Object.create(null);
  validRecords.forEach(record => {
    if (!byDay[record.dayKey]) byDay[record.dayKey] = [];
    byDay[record.dayKey].push(record);
  });
  return { records: validRecords, byDay };
}

function monthNumber(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getFullYear() * 12 + date.getMonth() : NaN;
}

function calendarMonth(serial) {
  if (!Number.isInteger(serial)) return null;
  const year = Math.floor(serial / 12);
  const monthIndex = ((serial % 12) + 12) % 12;
  if (year < 1 || year > 9999) return null;
  const first = new Date(0);
  first.setFullYear(year, monthIndex, 1);
  first.setHours(12, 0, 0, 0);
  const leading = (first.getDay() + 6) % 7;
  const total = daysInMonth(year, monthIndex + 1);
  const key = `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}`;
  const cells = Array.from({ length: Math.ceil((leading + total) / 7) * 7 }, (_, index) => {
    const day = index - leading + 1;
    return day < 1 || day > total ? null : { day, key: `${key}-${String(day).padStart(2, '0')}` };
  });
  return { serial, year, monthIndex, key, title: MONTH_NAMES[monthIndex], cells };
}

function initialMonthRange(now = Date.now()) {
  const month = monthNumber(now);
  return { first: month - 3, last: month + 3 };
}

function extendMonthRange(range, direction) {
  if (direction === 'earlier') {
    const first = range.first - 3;
    return { first, last: Math.min(range.last, first + MAX_RENDERED_MONTHS - 1) };
  }
  if (direction === 'later') {
    const last = range.last + 3;
    return { first: Math.max(range.first, last - MAX_RENDERED_MONTHS + 1), last };
  }
  return { ...range };
}

function confirmedTimeLabel(value) {
  const timestamp = parseConfirmedAt(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

module.exports = {
  MAX_RENDERED_MONTHS,
  parseConfirmedAt,
  localDateKey,
  normalizeMemoryRecords,
  groupMemoryRecords,
  monthNumber,
  calendarMonth,
  initialMonthRange,
  extendMonthRange,
  confirmedTimeLabel,
};
