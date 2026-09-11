import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
const { initial, transition } = require('./wallExperienceState.cjs');

function Button({ children, secondary, disabled, onPress }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, secondary && s.secondary, disabled && s.disabled, pressed && { opacity: .8 }]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{children}</Text>
  </Pressable>;
}

// Web uses a same-origin, local-only preview adapter. Native never consumes that fixture.
export default function WallExperience({ deviceKey, connected, onConnect, candidate, confirmedImage,
  pending, awaitingReceipt = false, onPrepare, onPublish, canPublish = true, previewFirst = false, onStarted }) {
  const web = Platform.OS === 'web';
  const [data, setData] = useState(null);
  const [state, setState] = useState(initial);
  const [loading, setLoading] = useState(web);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadedUri, setLoadedUri] = useState(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const storageKey = data ? `echooo-wall-preview:${deviceKey || 'demo'}:${data.scope}` : null;
  useEffect(() => {
    const epoch = ++generation.current;
    if (!web) return undefined;
    setLoading(true); setData(null); setState(initial()); setError(''); setNotice(''); setLoadedUri(null);
    fetch('/api/wall-demo').then(async response => {
      const value = await response.json();
      if (!response.ok || !value.walls?.length) throw Error(value.error || '暂时没有完整的照片墙预览');
      if (generation.current !== epoch) return;
      const key = `echooo-wall-preview:${deviceKey || 'demo'}:${value.scope}`;
      let saved;
      try { saved = JSON.parse(globalThis.localStorage.getItem(key) || 'null'); } catch { saved = null; }
      if (saved && Number.isInteger(saved.candidateIndex) && saved.candidateIndex >= 0 && saved.candidateIndex < value.walls.length
        && Array.isArray(saved.events) && (!saved.currentId || value.walls.some(w => w.id === saved.currentId))) {
        setState(previewFirst ? { ...saved, currentId: null, holdUntil: null,
          candidateIndex: Math.max(0, value.walls.findIndex(w => w.id === saved.currentId)) } : saved);
      }
      setData(value);
    }).catch(e => { if (generation.current === epoch) setError(e.message); })
      .finally(() => { if (generation.current === epoch) setLoading(false); });
    return () => { generation.current++; };
  }, [web, deviceKey]);

  async function act(action) {
    if (inFlight.current || !data) return;
    const epoch = generation.current;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const next = transition(state, action, data.walls);
      const wall = data.walls.find(w => w.id === next.currentId) || data.walls[next.candidateIndex];
      // react-native-web resolves successful prefetch with undefined; failures reject.
      await Image.prefetch(wall.image);
      if (epoch !== generation.current) return;
      globalThis.localStorage.setItem(storageKey, JSON.stringify(next));
      setState(next);
      if (action === 'start') onStarted?.();
      setNotice({ start: '这面照片墙已开始模拟展示。', next: '已经换好一整组。',
        hold: '已记下你对这次搭配的喜欢。', resume: '已恢复正常更新，喜欢的记录会保留。', 'preview-next': '' }[action]);
    } catch (e) { if (epoch === generation.current) setError(e.message); }
    finally { inFlight.current = false; if (epoch === generation.current) setBusy(false); }
  }

  const wall = data?.walls.find(w => w.id === state.currentId);
  const preview = wall || data?.walls[state.candidateIndex];
  const isCurrent = web ? !!wall : !!confirmedImage;
  const uri = web ? preview?.image : candidate?.image || confirmedImage;
  // App resolves candidates against the device/revision receipt, never image URLs.
  const nativeCandidate = !web && !!candidate?.image;
  const held = web && state.holdUntil > Date.now();
  const imageReady = !!uri && loadedUri === uri;
  const first = !isCurrent;
  return <View style={s.root}>
    <Text style={s.eyebrow}>{first ? 'YOUR FIRST WALL' : 'ON YOUR WALL'}</Text>
    <Text style={s.title}>{first ? '先看看，第一面照片墙。' : '此刻，墙上的小美好。'}</Text>
    <Text style={s.description}>{first ? '模板和照片已经搭配好了，确认后再开始展示。' : '喜欢，就多停留一会儿。想换个心情，也随时可以。'}</Text>
    {web ? <Text style={s.demo}>App 网页预览 · 模拟设备展示</Text> : null}
    {loading ? <ActivityIndicator accessibilityLabel="正在准备整墙预览" style={s.loading} /> : uri ? <View style={s.stage}>
      <View style={s.frame}><Image key={uri} source={{ uri }} resizeMode="contain" style={s.image}
        accessibilityLabel={first || nativeCandidate ? '首次或待展示的完整照片墙' : '当前完整照片墙'}
        onLoad={() => setLoadedUri(uri)} onError={() => { setLoadedUri(null); setError('照片墙加载失败，请稍后重试'); }} /></View>
      <Text style={s.caption}>{nativeCandidate ? awaitingReceipt ? '已发送 · 等待设备确认' : '待确认的新照片墙' : first ? '首次预览 · 尚未开始展示' : web ? '当前展示 · 模拟画面' : '当前展示 · 设备已确认'}</Text>
    </View> : <View style={s.empty}><Text style={s.description}>{awaitingReceipt ? '照片墙已发送，正在等待设备确认展示。' : connected ? '照片墙正在等待首次整墙预览。' : '连接照片墙后，就能准备第一次展示。'}</Text></View>}
    {preview ? <Text style={s.wallTitle}>{preview.title}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {web && data ? <View style={s.actions}>
      {first ? <View style={s.actionRow}>
        <View style={s.actionCell}><Button disabled={busy || !imageReady} onPress={() => act('start')}>就让这一组开始</Button></View>
        <View style={s.actionCell}><Button secondary disabled={busy || data.walls.length < 2} onPress={() => act('preview-next')}>看看另一组</Button></View>
      </View> : <>
        <View style={s.actionRow}><View style={s.actionCell}>
        <Button disabled={busy || held || !imageReady} onPress={() => act('hold')}>{held ? '正在多留一会儿' : '多留一会儿'}</Button></View>
        <View style={s.actionCell}><Button secondary disabled={busy || data.walls.length < 2} onPress={() => act('next')}>换一组</Button></View></View>
        {held ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => act('resume')} style={s.link}><Text style={s.linkText}>恢复正常更新</Text></Pressable> : null}
        <Text style={s.hint}>{held ? `这次搭配保留至 ${new Date(state.holdUntil).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}。` : '喜欢这次搭配，就让整面照片墙再陪你一天。'}</Text>
      </>}
      {notice ? <Text accessibilityLiveRegion="polite" style={s.notice}>{notice}</Text> : null}
    </View> : !web ? <View style={s.actions}>
      {!connected ? <Button onPress={onConnect}>连接照片墙</Button> : <>
        {nativeCandidate ? <Button disabled={pending || awaitingReceipt || !canPublish || !imageReady} onPress={onPublish}>{pending || awaitingReceipt ? '等待设备确认' : '展示这一组'}</Button> : null}
        <Button secondary disabled={pending || awaitingReceipt || !canPublish} onPress={onPrepare}>{first ? '准备首次预览' : '准备另一组'}</Button>
        {isCurrent ? <><Button disabled>多留一会儿</Button><Text style={s.hint}>当前设备服务暂未支持延长停留。</Text></> : null}
      </>}
    </View> : null}
    <Text style={s.foot}>喜欢这次搭配，便多停留一下。</Text>
  </View>;
}
const s = StyleSheet.create({
  root: { paddingBottom: 20 }, eyebrow: { color: '#788174', fontSize: 11, letterSpacing: 2, marginBottom: 12 },
  title: { fontSize: 27, fontWeight: '600', color: '#27372c', lineHeight: 36 },
  description: { fontSize: 14, color: '#75816f', lineHeight: 23, marginTop: 10 },
  demo: { color: '#76816f', fontSize: 11, marginTop: 14 }, loading: { padding: 60 },
  stage: { backgroundColor: '#eef0e7', borderRadius: 24, padding: 16, marginTop: 16, alignItems: 'center' },
  frame: { backgroundColor: '#fcf9ef', padding: 8, borderWidth: 1, borderColor: '#e1dfd3', width: '100%', maxWidth: 220 },
  image: { width: '100%', aspectRatio: 500 / 667 }, caption: { color: '#808878', fontSize: 11, marginTop: 14 },
  wallTitle: { color: '#344531', fontSize: 17, fontWeight: '500', textAlign: 'center', marginTop: 18 },
  actionRow: { flexDirection: 'row', gap: 10 }, actionCell: { flex: 1 }, actions: { gap: 10, marginTop: 16 }, button: { borderRadius: 15, backgroundColor: '#576f49', padding: 16, alignItems: 'center' },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#dce3d4' },
  buttonText: { fontSize: 14, fontWeight: '500', color: '#fff' }, secondaryText: { color: '#516647' }, disabled: { opacity: .48 },
  hint: { fontSize: 12, color: '#7c8576', lineHeight: 20, textAlign: 'center' },
  notice: { color: '#587249', fontSize: 13, lineHeight: 22, textAlign: 'center' },
  link: { alignItems: 'center', padding: 8 }, linkText: { color: '#677e58', fontSize: 12 },
  foot: { color: '#88917f', fontSize: 12, textAlign: 'center', marginTop: 22 },
  error: { fontSize: 13, color: '#a6422a', marginVertical: 12 }, empty: { padding: 30, backgroundColor: '#f1f2ed', borderRadius: 20, marginTop: 20 },
});
