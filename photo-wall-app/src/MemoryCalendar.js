import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import calendar from './memoryCalendar.cjs';

const {
  calendarMonth,
  confirmedTimeLabel,
  extendMonthRange,
  groupMemoryRecords,
  initialMonthRange,
  localDateKey,
  monthNumber,
} = calendar;
const EMPTY_RECORDS = [];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const PAPER = '#faf9f6';
const INK = '#262725';
const SERIF = Platform.select({ ios: 'Songti SC', android: 'serif', default: 'Songti SC, STSong, serif' });
const SYSTEM = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;

function dateLabel(key) {
  const [year, month, day] = key.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function PaperRecord({ count = 1, alternate = false }) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.recordPaper, alternate && styles.recordPaperAlternate]}>
      <View style={styles.recordFold} />
      <View style={styles.recordLine} />
      <View style={[styles.recordLine, styles.recordLineShort]} />
      <Text maxFontSizeMultiplier={1} style={styles.recordCount}>{count > 1 ? `${count} 次` : '已展示'}</Text>
    </View>
  );
}

const Month = memo(function Month({ month, byDay, todayKey, firstUse, onOpenDay, onLayout, gutter }) {
  const recordedDays = month.cells.filter(day => day && byDay[day.key]?.length).length;
  const futureMonth = month.key > todayKey.slice(0, 7);
  return (
    <View onLayout={event => onLayout(month.serial, event.nativeEvent.layout.y)} style={[styles.month, { paddingHorizontal: gutter }]}>
      <View style={styles.monthHeader}>
        <View style={styles.monthName}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={styles.monthTitle}>{month.title}</Text>
          <Text style={styles.year}>{month.year}</Text>
        </View>
        <Text style={styles.monthMeta}>{recordedDays ? `${recordedDays} 天 · 已展示` : futureMonth ? '留一点期待' : ''}</Text>
      </View>
      {firstUse ? (
        <View style={styles.firstUse}>
          <View style={styles.firstUseMark} accessible={false}><View style={styles.sprout} /><View style={styles.sproutLeaf} /></View>
          <View style={styles.firstUseCopy}>
            <Text style={styles.firstUseTitle}>回忆，会从今天开始。</Text>
            <Text style={styles.firstUseBody}>照片墙展示过的内容，会留在对应的日子里。{ '\n' }第一次相遇，留给生活中的惊喜。</Text>
          </View>
        </View>
      ) : null}
      <View style={styles.grid}>
        {month.cells.map((day, index) => {
          if (!day) return <View key={`blank-${index}`} style={styles.blankDay} accessible={false} />;
          const records = byDay[day.key] || EMPTY_RECORDS;
          const today = day.key === todayKey;
          const future = day.key > todayKey;
          return (
            <Pressable
              key={day.key}
              accessibilityRole="button"
              accessibilityLabel={`${dateLabel(day.key)}${today ? '，今天' : ''}，${records.length ? `${records.length} 条已确认展示记录` : future ? '尚未到来' : '暂无展示记录'}`}
              accessibilityHint={records.length ? '查看这一天的展示标题与时间' : '查看这一天的状态'}
              accessibilityState={{ selected: today }}
              onPress={() => onOpenDay(day.key)}
              style={({ pressed }) => [styles.day, pressed && styles.dayPressed]}
            >
              <View style={[styles.dayNumber, today && styles.todayNumber]}>
                <Text maxFontSizeMultiplier={1.5} style={[styles.dayText, future && styles.futureDay, today && styles.todayText]}>{day.day}</Text>
              </View>
              <View style={styles.dayRecordArea} accessible={false}>
                {records.length ? <PaperRecord count={records.length} alternate={day.day % 2 === 0} /> : !future && !today ? <View style={styles.emptyDot} /> : null}
              </View>
              <View style={styles.todayCaptionArea} accessible={false}>{today ? <Text maxFontSizeMultiplier={1} style={styles.todayCaption}>今天</Text> : null}</View>
            </Pressable>
          );
        })}
      </View>
      {futureMonth ? <Text style={styles.futureNote}>下一段日常，会慢慢来到。</Text> : null}
    </View>
  );
});

// The caller owns device authorization and fetching. This view accepts receipt
// metadata only; it never infers photos or reads the user's local library.
export default function MemoryCalendar({ records = EMPTY_RECORDS, loading = false, error = '', onRetry }) {
  const dimensions = useWindowDimensions();
  const [width, setWidth] = useState(dimensions.width);
  const [now, setNow] = useState(Date.now);
  const [range, setRange] = useState(() => initialMonthRange());
  const [selectedDay, setSelectedDay] = useState(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const scroll = useRef(null);
  const positions = useRef(new Map());
  const headerHeight = useRef(0);
  const scrollY = useRef(0);
  const scrollFrame = useRef(null);
  const pendingScroll = useRef({ month: monthNumber(Date.now()), delta: 0, animated: false });
  const todayKey = localDateKey(now);
  const todayMonth = monthNumber(now);
  const gutter = Math.max(0, Math.min(20, (width - 308) / 2));
  const history = useMemo(() => groupMemoryRecords(records, now), [records, now]);
  const months = useMemo(() => Array.from({ length: range.last - range.first + 1 }, (_, index) => calendarMonth(range.first + index)).filter(Boolean), [range.first, range.last]);
  const errorMessage = typeof error === 'string' ? error.trim() : error ? '暂时无法读取展示记录。' : '';
  const canRetry = typeof onRetry === 'function';
  const firstUse = !loading && !errorMessage && history.records.length === 0;
  const selectedRecords = selectedDay ? history.byDay[selectedDay] || EMPTY_RECORDS : EMPTY_RECORDS;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReducedMotion(value); }).catch(() => {});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    const app = AppState.addEventListener('change', state => { if (state === 'active') setNow(Date.now()); });
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
      clearInterval(clock);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  const resolveScroll = useCallback(() => {
    const request = pendingScroll.current;
    if (!request || !headerHeight.current || !positions.current.has(request.month)) return;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (pendingScroll.current !== request || !positions.current.has(request.month)) return;
      const y = Math.max(0, positions.current.get(request.month) - headerHeight.current + request.delta);
      scroll.current?.scrollTo({ y, animated: request.animated });
      pendingScroll.current = null;
    });
  }, []);

  const recordMonthLayout = useCallback((serial, y) => {
    positions.current.set(serial, y);
    resolveScroll();
  }, [resolveScroll]);

  const extend = useCallback(direction => {
    const next = extendMonthRange(range, direction);
    if (direction === 'earlier') {
      const anchor = positions.current.get(range.first);
      pendingScroll.current = {
        month: range.first,
        delta: anchor === undefined ? 0 : scrollY.current - anchor + headerHeight.current,
        animated: false,
      };
    } else {
      pendingScroll.current = { month: range.last + 1, delta: 0, animated: false };
    }
    // A pure append does not relayout existing months. Preserve their positions
    // so Today can still return to a month that did not emit a new onLayout.
    if (next.first !== range.first) positions.current.clear();
    setRange(next);
  }, [range]);

  const goToday = useCallback(() => {
    const current = Date.now();
    const month = monthNumber(current);
    setNow(current);
    pendingScroll.current = { month, delta: 0, animated: !reducedMotion };
    if (month < range.first || month > range.last) {
      positions.current.clear();
      setRange(initialMonthRange(current));
    } else resolveScroll();
  }, [range, reducedMotion, resolveScroll]);

  const openDay = useCallback(key => setSelectedDay(key), []);
  const closeDay = useCallback(() => setSelectedDay(null), []);
  const retry = useCallback(() => { if (!loading && canRetry) onRetry(); }, [loading, canRetry, onRetry]);
  const futureSelection = selectedDay && selectedDay > todayKey;
  const todaySelection = selectedDay === todayKey;

  return (
    <>
      <View
        style={styles.container}
        onLayout={event => setWidth(event.nativeEvent.layout.width)}
        accessibilityElementsHidden={!!selectedDay}
        importantForAccessibility={selectedDay ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          ref={scroll}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          stickyHeaderIndices={[0]}
          showsVerticalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
          scrollEventThrottle={32}
          onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y; }}
        >
          <View style={styles.stickyHeader} onLayout={event => { headerHeight.current = event.nativeEvent.layout.height; resolveScroll(); }}>
            <View style={styles.hero}>
              <View style={styles.heroCopy}>
                <Text style={styles.eyebrow} maxFontSizeMultiplier={1.3}>THE DAYS WE KEEP</Text>
                <Text accessibilityRole="header" style={styles.title} maxFontSizeMultiplier={1.5}>回忆日历</Text>
                <Text style={styles.subtitle}>回看已经展示的日子，留住不经意的美好。</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="回到本月今天" onPress={goToday} style={({ pressed }) => [styles.todayButton, pressed && styles.dayPressed]}>
                <View accessible={false} style={styles.calendarGlyph}><View style={styles.calendarGlyphLine} /><View style={styles.calendarGlyphDot} /></View>
                <Text style={styles.todayButtonText}>今天</Text>
              </Pressable>
            </View>
            {loading ? (
              <View style={styles.statusRow} accessibilityLiveRegion="polite">
                <ActivityIndicator size="small" color="#7a8068" />
                <Text style={styles.statusCopy}>正在读取展示记录…</Text>
              </View>
            ) : errorMessage ? (
              <View style={styles.errorRow} accessibilityLiveRegion="polite">
                <View style={styles.errorCopy}><Text style={styles.errorTitle}>暂时无法读取展示记录</Text><Text style={styles.errorDetail}>{errorMessage}</Text></View>
                {canRetry ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取展示记录" onPress={retry} style={({ pressed }) => [styles.retryButton, pressed && styles.dayPressed]}><Text style={styles.retryText}>重试</Text></Pressable> : null}
              </View>
            ) : null}
            <View accessible accessibilityLabel="星期一、星期二、星期三、星期四、星期五、星期六、星期日" style={[styles.weekdays, { marginHorizontal: gutter }]}>
              {WEEKDAYS.map((day, index) => <Text key={day} style={[styles.weekday, index > 4 && styles.weekend]}>{day}</Text>)}
            </View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="加载更早的三个月" accessibilityHint="保留当前阅读位置，向上滑动查看" onPress={() => extend('earlier')} style={({ pressed }) => [styles.loadButton, pressed && styles.dayPressed]}>
            <Text accessible={false} style={styles.loadArrow}>↑</Text><Text style={styles.loadText}>更早的日子</Text>
          </Pressable>
          {months.map(month => (
            <Month
              key={month.serial}
              month={month}
              byDay={history.byDay}
              todayKey={todayKey}
              firstUse={firstUse && month.serial === todayMonth}
              gutter={gutter}
              onOpenDay={openDay}
              onLayout={recordMonthLayout}
            />
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="加载后面的三个月" onPress={() => extend('later')} style={({ pressed }) => [styles.loadButton, pressed && styles.dayPressed]}>
            <Text style={styles.loadText}>再往后看看</Text><Text accessible={false} style={styles.loadArrow}>›</Text>
          </Pressable>
          <View style={styles.hint}><View style={styles.hintLine} /><Text style={styles.hintText}>只回看已展示内容，未来保持留白</Text><View style={styles.hintLine} /></View>
          <Text style={styles.bottomNote}>纸片标记照片墙已确认的展示。{ '\n' }点开日期，查看当天的标题与时间。</Text>
        </ScrollView>
      </View>
      <Modal visible={!!selectedDay} transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={closeDay}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeDay} accessible={false} />
          <View style={styles.sheet} accessibilityViewIsModal onAccessibilityEscape={closeDay}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleCopy}>
                <Text accessibilityRole="header" style={styles.sheetTitle}>{selectedDay ? `${Number(selectedDay.slice(5, 7))}月${Number(selectedDay.slice(8, 10))}日` : ''}</Text>
                <Text style={styles.sheetYear}>{selectedDay?.slice(0, 4)}年 · 手机本地时间</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭当天记录，返回日历" onPress={closeDay} style={({ pressed }) => [styles.closeButton, pressed && styles.dayPressed]}><Text style={styles.closeText}>关闭</Text></Pressable>
            </View>
            <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
              {selectedRecords.length ? (
                <>
                  <Text style={styles.detailSummary}>{selectedRecords.length} 条已确认展示记录</Text>
                  {selectedRecords.map(record => (
                    <View key={record.id} style={styles.receipt}>
                      <View style={styles.receiptIcon}><PaperRecord /></View>
                      <View style={styles.receiptCopy}>
                        <Text style={styles.receiptTitle}>{record.title}</Text>
                        <Text style={styles.receiptTime}>{confirmedTimeLabel(record.confirmedAt)}</Text>
                      </View>
                    </View>
                  ))}
                </>
              ) : loading ? (
                <View style={styles.detailEmpty}><ActivityIndicator color="#7a8068" /><Text style={styles.detailBody}>正在读取这一天的展示记录…</Text></View>
              ) : errorMessage && !futureSelection ? (
                <View style={styles.detailEmpty}>
                  <Text style={styles.detailEmptyTitle}>暂时无法读取展示记录</Text>
                  <Text style={styles.detailBody}>{errorMessage}</Text>
                  {canRetry ? <Pressable accessibilityRole="button" onPress={retry} style={({ pressed }) => [styles.detailRetry, pressed && styles.dayPressed]}><Text style={styles.retryText}>重新读取</Text></Pressable> : null}
                </View>
              ) : (
                <View style={styles.detailEmpty}>
                  <View accessible={false} style={styles.emptyCalendar}><View style={styles.emptyCalendarLine} /><View style={styles.emptyCalendarDot} /></View>
                  <Text style={styles.detailEmptyTitle}>{futureSelection ? '这一天，留一点期待。' : todaySelection ? '今天的回忆，慢慢来。' : '这天还没有展示记录。'}</Text>
                  <Text style={styles.detailBody}>{futureSelection ? '未来的内容，会在展示后记在这里。' : todaySelection ? '照片墙展示完成后，会在日历留下记录。' : '不需要补上每一天，美好的日常自有节奏。'}</Text>
                </View>
              )}
              <Text style={styles.detailNote}>这里只回看已经发生的展示，未来的内容保持留白。</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PAPER },
  scroll: { flex: 1, backgroundColor: PAPER },
  scrollContent: { paddingBottom: 28 },
  stickyHeader: { backgroundColor: PAPER, zIndex: 2 },
  hero: { paddingHorizontal: 27, paddingTop: 12, paddingBottom: 22, flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  heroCopy: { flex: 1, minWidth: 0 },
  eyebrow: { fontFamily: SYSTEM, fontSize: 9, letterSpacing: 1.25, color: '#93958b', lineHeight: 16 },
  title: { fontFamily: SERIF, fontSize: 31, fontWeight: '500', lineHeight: 44, letterSpacing: 1, color: INK, marginTop: 7 },
  subtitle: { fontFamily: SYSTEM, fontSize: 11, lineHeight: 19, color: '#85857e', marginTop: 8 },
  todayButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, minWidth: 69, paddingHorizontal: 12, borderWidth: 1, borderColor: '#deded4', borderRadius: 24, marginBottom: 3 },
  todayButtonText: { fontFamily: SYSTEM, fontSize: 11, color: INK },
  calendarGlyph: { width: 13, height: 13, borderWidth: 1, borderColor: '#7a8068', borderRadius: 3 },
  calendarGlyphLine: { position: 'absolute', top: 3, left: 0, right: 0, height: 1, backgroundColor: '#7a8068' },
  calendarGlyphDot: { position: 'absolute', top: 7, left: 3, width: 2, height: 2, borderRadius: 1, backgroundColor: '#7a8068' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 27, paddingBottom: 12, minHeight: 36 },
  statusCopy: { fontFamily: SYSTEM, fontSize: 12, lineHeight: 19, color: '#737766', flex: 1 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 24, marginBottom: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: '#b8a68c' },
  errorCopy: { flex: 1, minWidth: 0 },
  errorTitle: { fontFamily: SYSTEM, fontSize: 12, lineHeight: 19, color: '#655d4f' },
  errorDetail: { fontFamily: SYSTEM, fontSize: 10, lineHeight: 17, color: '#858074', marginTop: 3 },
  retryButton: { minWidth: 48, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10 },
  retryText: { fontFamily: SYSTEM, fontSize: 12, color: '#60674e' },
  weekdays: { flexDirection: 'row', paddingTop: 15, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#e8e6df', backgroundColor: PAPER },
  weekday: { flex: 1, textAlign: 'center', fontFamily: SYSTEM, fontSize: 11, color: '#8c8a7f' },
  weekend: { color: '#a5a093' },
  loadButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 20, borderRadius: 10 },
  loadText: { fontFamily: SYSTEM, fontSize: 11, color: '#7d8270' },
  loadArrow: { fontSize: 15, color: '#8b917c' },
  month: { paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: '#e8e6df' },
  monthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingTop: 27, paddingBottom: 21, paddingHorizontal: 6 },
  monthName: { flexDirection: 'row', alignItems: 'baseline', gap: 9, flexShrink: 1 },
  monthTitle: { fontFamily: SERIF, fontSize: 26, fontWeight: '500', letterSpacing: 0.6, color: INK },
  year: { fontFamily: SYSTEM, fontSize: 10, letterSpacing: 0.5, color: '#989487' },
  monthMeta: { fontFamily: SYSTEM, fontSize: 10, color: '#928c7d', flexShrink: 1, textAlign: 'right' },
  firstUse: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginHorizontal: 6, marginBottom: 22, paddingVertical: 17, paddingHorizontal: 15, borderWidth: 1, borderColor: '#e8e6df', borderRadius: 14 },
  firstUseMark: { width: 19, height: 25, marginTop: 3 },
  sprout: { position: 'absolute', left: 8, top: 6, height: 17, width: 1, backgroundColor: '#7a8068', transform: [{ rotate: '12deg' }] },
  sproutLeaf: { position: 'absolute', left: 7, top: 1, width: 12, height: 8, borderWidth: 1, borderColor: '#7a8068', borderTopRightRadius: 10, borderBottomLeftRadius: 10, transform: [{ rotate: '-18deg' }] },
  firstUseCopy: { flex: 1 },
  firstUseTitle: { fontFamily: SERIF, fontSize: 17, lineHeight: 25, color: INK },
  firstUseBody: { fontFamily: SYSTEM, fontSize: 11, lineHeight: 21, color: '#85857e', marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  blankDay: { width: `${100 / 7}%`, minHeight: 78, marginBottom: 5 },
  day: { width: `${100 / 7}%`, minHeight: 78, paddingTop: 4, paddingBottom: 4, marginBottom: 5, alignItems: 'center', borderRadius: 11 },
  dayPressed: { backgroundColor: '#eeeee6' },
  dayNumber: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  dayText: { fontFamily: SYSTEM, fontSize: 12, color: INK, fontVariant: ['tabular-nums'] },
  todayNumber: { borderRadius: 13, backgroundColor: INK },
  todayText: { color: '#fff' },
  futureDay: { color: '#b6b0a2' },
  dayRecordArea: { height: 28, marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  recordPaper: { width: 34, height: 28, backgroundColor: '#eeefe5', borderWidth: 0.7, borderColor: '#d2d6c5', borderRadius: 4, paddingTop: 5, paddingLeft: 5, transform: [{ rotate: '-4deg' }] },
  recordPaperAlternate: { transform: [{ rotate: '3deg' }] },
  recordFold: { position: 'absolute', top: 0, right: 0, height: 7, width: 7, borderLeftWidth: 0.7, borderBottomWidth: 0.7, borderColor: '#d2d6c5', backgroundColor: PAPER, borderBottomLeftRadius: 2 },
  recordLine: { width: 15, height: 1, backgroundColor: '#a8b091', marginBottom: 3 },
  recordLineShort: { width: 10 },
  recordCount: { fontFamily: SYSTEM, fontSize: 7, lineHeight: 9, color: '#788365', marginTop: 0 },
  emptyDot: { height: 3, width: 3, borderRadius: 2, backgroundColor: '#d7d3c8' },
  todayCaptionArea: { height: 12, alignItems: 'center', justifyContent: 'flex-end' },
  todayCaption: { fontFamily: SYSTEM, fontSize: 8, lineHeight: 10, color: '#787e67', letterSpacing: 0.8 },
  futureNote: { fontFamily: SYSTEM, fontSize: 10, lineHeight: 18, color: '#a7a18f', textAlign: 'center', marginTop: 9 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingTop: 20 },
  hintLine: { height: 1, backgroundColor: '#e8e6df', flex: 1 },
  hintText: { fontFamily: SYSTEM, fontSize: 9, lineHeight: 16, color: '#999582', flexShrink: 1, textAlign: 'center' },
  bottomNote: { fontFamily: SYSTEM, fontSize: 10, lineHeight: 19, color: '#999587', textAlign: 'center', paddingHorizontal: 26, paddingTop: 17 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(37,42,35,0.36)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 30 },
  sheet: { width: '100%', maxWidth: 390, maxHeight: '85%', backgroundColor: PAPER, borderWidth: 1, borderColor: '#e8e6df', borderRadius: 25, paddingHorizontal: 24, paddingTop: 19, paddingBottom: 22 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 17 },
  sheetTitleCopy: { flex: 1 },
  sheetTitle: { fontFamily: SERIF, fontSize: 26, lineHeight: 36, color: INK },
  sheetYear: { fontFamily: SYSTEM, fontSize: 10, lineHeight: 17, color: '#939184', marginTop: 3 },
  closeButton: { minWidth: 44, minHeight: 44, borderRadius: 22, backgroundColor: '#edede5', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
  closeText: { fontFamily: SYSTEM, fontSize: 11, color: '#606454' },
  detailScroll: { flexGrow: 0, flexShrink: 1 },
  detailContent: { paddingBottom: 2 },
  detailSummary: { fontFamily: SYSTEM, fontSize: 11, color: '#858575', marginBottom: 9 },
  receipt: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: '#e8e6df' },
  receiptIcon: { paddingTop: 4 },
  receiptCopy: { flex: 1, minWidth: 0 },
  receiptTitle: { fontFamily: SYSTEM, fontSize: 15, lineHeight: 23, color: '#42493a' },
  receiptTime: { fontFamily: SYSTEM, fontSize: 11, lineHeight: 19, color: '#8b8e7e', marginTop: 5 },
  detailEmpty: { minHeight: 180, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, paddingVertical: 22 },
  detailEmptyTitle: { fontFamily: SERIF, fontSize: 19, lineHeight: 29, textAlign: 'center', color: '#555e47' },
  detailBody: { fontFamily: SYSTEM, fontSize: 12, lineHeight: 22, color: '#858a7a', textAlign: 'center', marginTop: 12 },
  detailRetry: { minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#d9ddcd', borderRadius: 12, marginTop: 18, paddingHorizontal: 15 },
  emptyCalendar: { height: 27, width: 27, borderWidth: 1, borderColor: '#a1a68f', borderRadius: 6, marginBottom: 18 },
  emptyCalendarLine: { height: 1, position: 'absolute', left: 0, right: 0, top: 8, backgroundColor: '#a1a68f' },
  emptyCalendarDot: { height: 4, width: 4, position: 'absolute', left: 7, top: 15, borderRadius: 2, backgroundColor: '#a1a68f' },
  detailNote: { fontFamily: SYSTEM, fontSize: 10, lineHeight: 19, textAlign: 'center', color: '#a09f91', marginTop: 21 },
});
