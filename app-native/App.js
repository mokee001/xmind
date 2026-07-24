import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  Image, ScrollView, ActivityIndicator, Alert, Switch,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as MediaLibrary from 'expo-media-library';

// 三套模板，和后端 templates/*.json 对应
const TEMPLATES = [
  { id: 'daily_polaroid', name: '每日拍立得' },
  { id: 'travel_grid', name: '旅行方格' },
  { id: 'monthly_collage', name: '月度手帐' },
  { id: 'grid_5', name: '精选5张' },
  { id: 'grid_10', name: '拾光10张' },
  { id: 'grid_15', name: '手刐15张' },
  { id: 'grid_20', name: '满屏20张' },
  { id: 'grid_24', name: '拼贴24张' },
];

// 每次自动挑选的候选照片数量（后端再从中选画质最高的几张填模板）
const CANDIDATE_COUNT = 24;
// 自动模式的轮询间隔（毫秒）
const AUTO_INTERVAL_MS = 5 * 60 * 1000;

export default function App() {
  const [server, setServer] = useState('http://HJFG3FGM46.local:8000');
  const [template, setTemplate] = useState('daily_polaroid');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('未授权');
  const [wallUrl, setWallUrl] = useState(null);
  const [autoMode, setAutoMode] = useState(false);
  const timerRef = useRef(null);
  const lastSyncedId = useRef(null); // 记录上次同步过的最新照片id，自动模式只在有新照片时才刷新

  // 授权 + 读取最近照片 + 上传 + 触发后端自动生成上屏
  async function syncNow(silent = false) {
    if (busy) return;
    try {
      setBusy(true);
      if (!silent) setStatus('请求相册权限…');
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (perm.status !== 'granted') {
        setStatus('相册权限被拒绝，请到系统设置里允许访问照片');
        if (!silent) Alert.alert('需要相册权限', '请在系统设置 → 本App → 照片 里允许访问');
        return;
      }

      if (!silent) setStatus('读取最近照片…');
      const page = await MediaLibrary.getAssetsAsync({
        first: CANDIDATE_COUNT,
        mediaType: 'photo',
        sortBy: [[MediaLibrary.SortBy.creationTime, false]], // 最新在前
      });
      if (!page.assets.length) {
        setStatus('相册里没有照片');
        return;
      }

      // 自动模式：没有新照片就跳过，避免重复刷屏
      const newestId = page.assets[0].id;
      if (silent && lastSyncedId.current === newestId) {
        setStatus((s) => s.startsWith('自动') ? s : '自动模式运行中（暂无新照片）');
        return;
      }

      setStatus(`上传 ${page.assets.length} 张并 AI 识别…`);
      const form = new FormData();
      for (const a of page.assets) {
        const info = await MediaLibrary.getAssetInfoAsync(a);
        const uri = info.localUri || a.uri; // iOS 的 ph:// 要用 localUri 才能上传
        const name = a.filename || `photo_${a.id}.jpg`;
        form.append('files', { uri, name, type: 'image/jpeg' });
      }

      const url =
        `${server}/api/upload?auto=1&template=${template}` +
        `&title=${encodeURIComponent('我的一天')}`;
      const res = await fetch(url, { method: 'POST', body: form });
      const data = await res.json();

      if (data.wall && data.wall.image_url) {
        lastSyncedId.current = newestId;
        setWallUrl(`${server}${data.wall.image_url}?t=${Date.now()}`);
        setStatus(
          `✅ 已上屏｜识别 ${data.count} 张，选用 ${data.wall.chosen.length} 张` +
          (autoMode ? '（自动模式运行中）' : '')
        );
      } else {
        setStatus('生成失败：' + JSON.stringify(data));
      }
    } catch (e) {
      setStatus('出错：' + (e && e.message ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  // 自动模式：定时静默同步
  useEffect(() => {
    if (autoMode) {
      syncNow(false); // 打开时先立即同步一次
      timerRef.current = setInterval(() => syncNow(true), AUTO_INTERVAL_MS);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode]);

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <StatusBar style="dark" />
      <Text style={styles.h1}>手帐照片墙</Text>
      <Text style={styles.sub}>授权相册后自动挑图 · 识别 · 套模板 · 投屏</Text>

      <Text style={styles.label}>后端地址（跑服务的电脑）</Text>
      <TextInput
        style={styles.input}
        value={server}
        onChangeText={setServer}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://192.168.0.102:8000"
      />

      <Text style={styles.label}>模板</Text>
      <View style={styles.row}>
        {TEMPLATES.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.chip, template === t.id && styles.chipOn]}
            onPress={() => setTemplate(t.id)}
          >
            <Text style={[styles.chipTxt, template === t.id && styles.chipTxtOn]}>{t.name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={[styles.btn, busy && { opacity: 0.6 }]}
        disabled={busy}
        onPress={() => syncNow(false)}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>授权并自动同步上屏</Text>}
      </TouchableOpacity>

      <View style={styles.autoRow}>
        <Text style={styles.label}>自动模式（每 5 分钟检测新照片自动换屏）</Text>
        <Switch value={autoMode} onValueChange={setAutoMode} />
      </View>

      <Text style={styles.status}>{status}</Text>

      {wallUrl && (
        <>
          <Text style={styles.label}>当前上屏画面</Text>
          <Image source={{ uri: wallUrl }} style={styles.preview} resizeMode="contain" />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 60, backgroundColor: '#faf7f2', minHeight: '100%' },
  h1: { fontSize: 26, fontWeight: '800', color: '#3a3a3a' },
  sub: { color: '#8a8a8a', marginTop: 4, marginBottom: 16 },
  label: { fontSize: 13, color: '#7a7a7a', marginTop: 14, marginBottom: 6 },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5ded3',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5ded3',
  },
  chipOn: { backgroundColor: '#d98c5f', borderColor: '#d98c5f' },
  chipTxt: { color: '#6a6a6a', fontSize: 14 },
  chipTxtOn: { color: '#fff', fontWeight: '700' },
  btn: {
    marginTop: 20, backgroundColor: '#d98c5f', borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
  },
  btnTxt: { color: '#fff', fontSize: 17, fontWeight: '700' },
  autoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 18, gap: 10,
  },
  status: { marginTop: 16, color: '#5a5a5a', fontSize: 14, lineHeight: 20 },
  preview: {
    width: '100%', aspectRatio: 5 / 3, marginTop: 10,
    borderRadius: 12, backgroundColor: '#000',
  },
});
