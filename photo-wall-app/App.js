import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  Image, ScrollView, ActivityIndicator, Alert, Switch, Linking,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as MediaLibrary from 'expo-media-library';

// 三套模板，和后端 templates/*.json 对应
const TEMPLATES = [
  { id: 'daily_polaroid', name: '每日拍立得' },
  { id: 'editorial_magazine', name: '杂志编辑风 ✨' },
  { id: 'minimal_gallery', name: '美术馆三联 ✨' },
  { id: 'film_strip', name: '胶片胶卷 ✨' },
  { id: 'collage_pop', name: '撞色拼贴 ✨' },
  { id: 'scrapbook_echoes', name: '手帐拼贴·城市回响 ✨' },
  { id: 'corkboard_recap', name: '软木板手帐·月度回顾 ✨' },
  { id: 'july_dumps', name: '深海拼贴·本周随记 ✨' },
  { id: 'travel_grid', name: '旅行方格' },
  { id: 'monthly_collage', name: '月度手帐' },
  { id: 'grid_5', name: '精选5张' },
  { id: 'grid_10', name: '拾光10张' },
  { id: 'grid_15', name: '手刐15张' },
  { id: 'grid_20', name: '满屏20张' },
  { id: 'grid_24', name: '拼贴24张' },
];

// 每次抓取上传的候选照片数量。注意：数字太大（如 300）会让手机逐张读取 HEIC + 打包上传
// 卡好几分钟、界面假死。后端会「累积入库」——每次传近期几十张，多次同步就能覆盖整个相册，
// 所以这里保持一个手机能快速处理的小批量即可。
// 说明：拉取 CANDIDATE_COUNT 张只是取「照片引用+文件名」很轻量；真正耗时的
// getAssetInfoAsync + 上传只对「后端没见过的新照片」做（增量上传）。因此可放大到 500，
// 让候选库覆盖更长时间跨度的照片，配合后端「历史上的今天/更久以前」惊喜规则更出彩。
const CANDIDATE_COUNT = 500;
// 自动模式的轮询间隔（毫秒）
const AUTO_INTERVAL_MS = 5 * 60 * 1000;

export default function App() {
  const [server, setServer] = useState('http://HJFG3FGM46.local:8000');
  const [template, setTemplate] = useState('daily_polaroid');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('准备中…');
  const [wallUrl, setWallUrl] = useState(null);
  const [autoMode, setAutoMode] = useState(true); // 默认全自动：打开即抓取
  const [filters, setFilters] = useState([]); // 当前生效的筛选标签（由所选相簿决定）
  const [albums, setAlbums] = useState([]); // AI 端出的智能相簿（人物/宠物/主题/精选）
  const [activeAlbum, setActiveAlbum] = useState(null); // 当前选中的相簿 id（单选）
  const [junkInfo, setJunkInfo] = useState({ good: 0, junk: 0 }); // 废片过滤统计
  const [photoAccess, setPhotoAccess] = useState(''); // 相册权限级别：all/limited/denied（可见诊断用）
  const timerRef = useRef(null);
  const lastSyncedId = useRef(null); // 记录上次同步过的最新照片id，自动模式只在有新照片时才刷新
  const filtersRef = useRef(filters); // 供轮询回调读取最新筛选值
  filtersRef.current = filters;
  const activeLabelRef = useRef('精选'); // 供轮询回调读取当前相簿名（闭包里 albums/activeAlbum 会过期）

  // 智能相簿：问后端「你的相册里都有什么」，AI 主动端出少数语义相簿（借鉴苹果 Photos）。
  async function fetchAlbums() {
    try {
      const res = await fetch(`${server}/api/smart_albums`);
      const data = await res.json();
      setAlbums(data.albums || []);
      setJunkInfo({ good: data.good_total || 0, junk: data.junk_total || 0 });
    } catch (e) {
      // 相簿获取失败不影响主流程
    }
  }

  // 人物聚合：让后端跑人脸聚类（较慢），完成后刷新相簿（此时才有「人物」相簿）。
  async function clusterPeople() {
    try {
      const res = await fetch(`${server}/api/cluster_people`, { method: 'POST' });
      await res.json();
      fetchAlbums();
    } catch (e) {
      // 人脸功能不可用不影响主流程
    }
  }

  // 自动换一批：不重新上传，只请求后端用当前模板+筛选再出一屏。
  // 后端每生成同一「模板|筛选」组合会让 rotate 计数自增 -> 子分类叉乘+游标轮换 -> 每次照片组合不同。
  // 用于自动模式定时刷新：即使没有新照片，也能保持画面新鲜、避免长期同质化。
  async function rotateWall(activeFilters) {
    const name = activeLabelRef.current || '精选';
    try {
      const res = await fetch(`${server}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, title: name === '精选' ? '我的一天' : name, filters: activeFilters || [] }),
      });
      const data = await res.json();
      if (data.image_url) {
        setWallUrl(`${server}${data.image_url}?t=${Date.now()}`);
        setStatus(`🔄 自动换一批｜${name}｜选用 ${data.chosen.length} 张（每5分钟刷新）`);
      }
    } catch (e) {
      // 轮换失败不影响下个周期
    }
  }

  // 只改了筛选（选了某个相簿）时：从已识别相册快速重出一屏（不重新上传，保留人物标签、更快）。
  async function regenerate(label, tplOverride) {
    if (busy) return;
    try {
      setBusy(true);
      const activeFilters = filtersRef.current;
      const tpl = tplOverride || template; // 相簿自动切模板时 setTemplate 还没生效，用显式覆盖值
      const name = label || '精选';
      setStatus(`AI 正在生成「${name}」这一屏…`);
      const res = await fetch(`${server}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: tpl, title: name === '精选' ? '我的一天' : name, filters: activeFilters }),
      });
      const data = await res.json();
      if (data.image_url) {
        setWallUrl(`${server}${data.image_url}?t=${Date.now()}`);
        const fb = data.filter_fallback ? '（该相簿照片太少，已回退全部）' : '';
        setStatus(`✅ 已上屏｜${name}｜选用 ${data.chosen.length} 张${fb}`);
      } else {
        setStatus('生成失败：' + JSON.stringify(data));
      }
    } catch (e) {
      setStatus('出错：' + (e && e.message ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  // 授权 + 读取最近照片 + 上传 + 触发后端自动生成上屏
  async function syncNow(silent = false, force = false) {
    if (busy) return;
    try {
      setBusy(true);
      if (!silent) setStatus('请求相册权限…');
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      setPhotoAccess(perm.accessPrivileges || perm.status || ''); // 记录权限级别供界面显示
      if (perm.status !== 'granted') {
        setStatus('相册权限被拒绝，请到系统设置里允许访问照片');
        if (!silent) Alert.alert('需要相册权限', '请在系统设置 → 本App → 照片 里允许访问');
        return;
      }

      // iOS「仅选中的照片」(Limited Access)：系统只让 App 看到你当初勾选的那几张，
      // 所以无论怎么刷新，getAssetsAsync 读到的永远是同一批照片。检测到就引导用户
      // 改成「所有照片」，或用系统面板补选更多照片（不用去设置里翻）。
      if (perm.accessPrivileges === 'limited') {
        if (!silent) {
          Alert.alert(
            '相册权限是「仅选中的照片」',
            '这样 App 只能看到你勾选过的那几张，所以每次刷新都是同一批。\n\n建议改成「所有照片」：系统设置 → 本App → 照片 → 所有照片；\n或点下面「补选照片」临时多选一些。',
            [
              {
                text: '补选照片',
                onPress: async () => {
                  try {
                    if (MediaLibrary.presentPermissionsPickerAsync) {
                      await MediaLibrary.presentPermissionsPickerAsync();
                    }
                  } catch (e) {}
                },
              },
              { text: '知道了', style: 'cancel' },
            ]
          );
        }
        // 不中断：仍用当前可见的照片继续出图，同时已提示用户为何总是同一批。
      }

      if (!silent) setStatus('AI 读取最近照片…');
      const page = await MediaLibrary.getAssetsAsync({
        first: CANDIDATE_COUNT,
        mediaType: 'photo',
        sortBy: [[MediaLibrary.SortBy.creationTime, false]], // 最新在前
      });
      if (!page.assets.length) {
        setStatus('相册里没有照片');
        return;
      }

      // 每张照片的稳定文件名（和上传时一致），用于判断后端是否已识别过
      const assetName = (a) => a.filename || `photo_${a.id}.jpg`;

      // 增量识别的核心：先问后端「你已经认识哪些照片」，只上传它没见过的新照片。
      // 这样第一次授权识别之后，后续同步几乎瞬间完成，不再重复上传/重复识别整批。
      let known = new Set();
      try {
        const kr = await fetch(`${server}/api/known_photos`);
        const kd = await kr.json();
        known = new Set(kd.names || []);
      } catch (e) {
        // 拿不到已知列表就退化为「全部当新照片」，功能不受影响，只是这次慢一点
      }
      const newAssets = page.assets.filter((a) => !known.has(assetName(a)));

      // 没有新照片：完全不上传/不重识别，直接用后端已有的整库出一屏（秒级）。
      if (newAssets.length === 0) {
        if (silent && !force && lastSyncedId.current === page.assets[0].id) {
          await rotateWall(filtersRef.current);  // 自动模式无新图 -> 轮换换一批
        } else {
          await regenerate(activeLabelRef.current);  // 首次打开/手动 -> 用现有库直接出图
          lastSyncedId.current = page.assets[0].id;
        }
        return;
      }

      const newestId = page.assets[0].id;
      const total = newAssets.length;
      setStatus(`发现 ${total} 张新照片，读取中 0/${total}…`);
      const form = new FormData();
      for (let i = 0; i < total; i++) {
        const a = newAssets[i];
        const info = await MediaLibrary.getAssetInfoAsync(a);
        const uri = info.localUri || a.uri; // iOS 的 ph:// 要用 localUri 才能上传
        form.append('files', { uri, name: assetName(a), type: 'image/jpeg' });
        if ((i + 1) % 5 === 0 || i + 1 === total) {
          setStatus(`发现 ${total} 张新照片，读取中 ${i + 1}/${total}…`);
        }
      }
      setStatus(`AI 识别 ${total} 张新照片（上传中…）`);

      // 抓取识别一律不带筛选：先出一屏「精选」全貌，之后用户点相簿再快速切换。
      const url =
        `${server}/api/upload?auto=1&template=${template}` +
        `&title=${encodeURIComponent('我的一天')}`;
      const res = await fetch(url, { method: 'POST', body: form });
      const data = await res.json();

      if (data.wall && data.wall.image_url) {
        lastSyncedId.current = newestId;
        setWallUrl(`${server}${data.wall.image_url}?t=${Date.now()}`);
        // 抓到新照片 -> 回到「精选」全貌，清掉旧相簿选择（避免残留过期筛选）
        setActiveAlbum(null);
        setFilters([]);
        filtersRef.current = [];
        activeLabelRef.current = '精选';
        setStatus(
          `✅ 已上屏｜新增识别 ${total} 张，选用 ${data.wall.chosen.length} 张` +
          (autoMode ? '（自动运行中）' : '')
        );
        fetchAlbums();      // 先刷新非人物相簿（宠物/主题/精选）
        clusterPeople();    // 人脸聚类，完成后再刷新出「人物」相簿（较慢，后台跑）
      } else {
        setStatus('生成失败：' + JSON.stringify(data));
      }
    } catch (e) {
      setStatus('出错：' + (e && e.message ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  // 相册权限管理：让用户直接查看/扩展可访问的照片（iOS「仅选中」→ 补选或改所有照片）。
  async function managePhotoAccess() {
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      const level = perm.accessPrivileges || perm.status || '';
      setPhotoAccess(level);
      if (level === 'limited') {
        Alert.alert(
          '相册权限：仅选中的照片',
          '只能看到你勾选的那几张，所以每次刷新都是同一批。\n\n点「补选照片」多选一些；或点「去设置」改成「所有照片」（推荐）。',
          [
            {
              text: '补选照片',
              onPress: async () => {
                try {
                  if (MediaLibrary.presentPermissionsPickerAsync) {
                    await MediaLibrary.presentPermissionsPickerAsync();
                  }
                } catch (e) {}
              },
            },
            { text: '去设置', onPress: () => Linking.openSettings() },
            { text: '取消', style: 'cancel' },
          ]
        );
      } else if (level === 'all') {
        Alert.alert('相册权限：所有照片 ✅', '已是完整访问。若刷新仍像同一批，多为选图轮换问题而非权限。');
      } else {
        Alert.alert('相册权限：' + (level || '未授权'), '请到 系统设置 → 本App → 照片 里允许访问。', [
          { text: '去设置', onPress: () => Linking.openSettings() },
          { text: '取消', style: 'cancel' },
        ]);
      }
    } catch (e) {
      setStatus('权限检查出错：' + (e && e.message ? e.message : String(e)));
    }
  }

  // 选择某个智能相簿（单选）：点一下 -> 只看这个相簿的照片墙；再点一次 -> 回到「精选」全貌。
  function selectAlbum(album) {
    const isOn = activeAlbum === album.id;
    const nextId = isOn ? null : album.id;
    const nextFilters = isOn ? [] : (album.filter || []);
    setActiveAlbum(nextId);
    setFilters(nextFilters);
    filtersRef.current = nextFilters;
    activeLabelRef.current = nextId ? album.label : '精选';
    // 自动套用该相簿的推荐模板（人物→拍立得 / 美食→网格10 / 情绪→月度手帐…），保持与网页端一致
    const nextTpl = nextId && album.template ? album.template : template;
    if (nextId && album.template) setTemplate(album.template);
    // 从已识别相册快速重出一屏（不重新上传，保留人物标签）
    setTimeout(() => regenerate(nextId ? album.label : '精选', nextTpl), 0);
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

  // 启动时先把已识别的智能相簿拉回来（无需等一次新同步）
  useEffect(() => {
    fetchAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <StatusBar style="dark" />
      <Text style={styles.h1}>手帐照片墙</Text>
      <Text style={styles.sub}>授权相册即可 · AI 自动抓取识别 · 挑图套模板 · 投屏</Text>

      <TouchableOpacity style={styles.permRow} onPress={managePhotoAccess}>
        <Text style={styles.permTxt}>
          相册权限：{photoAccess === 'all' ? '所有照片 ✅' : photoAccess === 'limited' ? '仅选中的照片 ⚠️（点此扩展）' : photoAccess === 'denied' ? '已拒绝 ❌（点此开启）' : '未检测（点此检查）'}
        </Text>
      </TouchableOpacity>

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

      <Text style={styles.label}>智能相簿（AI 已读懂你的相册，点一下只看这一类）</Text>

      {junkInfo.junk > 0 && (
        <Text style={styles.junkHint}>
          🧹 已自动剔除 {junkInfo.junk} 张废片（截图/文档/模糊/过曝），只保留 {junkInfo.good} 张好片上墙
        </Text>
      )}

      {albums.length === 0 ? (
        <Text style={styles.emptyHint}>还没识别到内容，正在分析你的相册…</Text>
      ) : (
        ['人物', '宠物', '主题', '精选'].map((groupName) => {
          const groupAlbums = albums.filter((a) => a.group === groupName);
          if (groupAlbums.length === 0) return null;
          return (
            <View key={groupName} style={styles.filterGroup}>
              <Text style={styles.groupLabel}>{groupName}</Text>
              <View style={styles.row}>
                {groupAlbums.map((a) => {
                  const on = activeAlbum === a.id;
                  return (
                    <TouchableOpacity
                      key={a.id}
                      style={[styles.albumChip, on && styles.albumChipOn]}
                      onPress={() => selectAlbum(a)}
                    >
                      <Text style={[styles.albumTxt, on && styles.albumTxtOn]}>
                        {a.label}
                      </Text>
                      <Text style={[styles.albumCount, on && styles.albumCountOn]}>
                        {a.count}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        })
      )}

      {activeAlbum && (
        <TouchableOpacity onPress={() => { setActiveAlbum(null); setFilters([]); filtersRef.current = []; setTimeout(() => regenerate('精选'), 0); }}>
          <Text style={styles.clearTxt}>← 返回「精选」全貌</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.btn, busy && { opacity: 0.6 }]}
        disabled={busy}
        onPress={() => syncNow(false, true)}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>立即刷新一屏</Text>}
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
  permRow: {
    backgroundColor: '#fbf3e9', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: '#efdcc4', marginBottom: 6,
  },
  permTxt: { color: '#a56a3a', fontSize: 13, fontWeight: '600' },
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
  filterGroup: { marginTop: 8 },
  groupLabel: { fontSize: 12, color: '#a58b6f', marginBottom: 6, marginTop: 4 },
  suggestBox: {
    backgroundColor: '#fbf3e9', borderRadius: 12, padding: 12, marginTop: 6,
    borderWidth: 1, borderColor: '#efdcc4',
  },
  suggestTitle: { fontSize: 13, color: '#a5713f', marginBottom: 8, fontWeight: '600' },
  sugChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e0b98c',
  },
  sugChipOn: { backgroundColor: '#d98c5f', borderColor: '#d98c5f' },
  sugChipTxt: { color: '#b07235', fontSize: 13, fontWeight: '600' },
  sugChipTxtOn: { color: '#fff', fontWeight: '700' },
  fchip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5ded3',
  },
  fchipOn: { backgroundColor: '#6a8caf', borderColor: '#6a8caf' },
  fchipRec: { borderColor: '#e0b98c', backgroundColor: '#fdf7ef' },
  fchipTxt: { color: '#6a6a6a', fontSize: 13 },
  fchipTxtOn: { color: '#fff', fontWeight: '700' },
  albumChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5ded3',
  },
  albumChipOn: { backgroundColor: '#d98c5f', borderColor: '#d98c5f' },
  albumTxt: { color: '#5a5a5a', fontSize: 15, fontWeight: '600' },
  albumTxtOn: { color: '#fff', fontWeight: '800' },
  albumCount: {
    color: '#b98a5f', fontSize: 12, fontWeight: '700',
    backgroundColor: '#f4ead9', paddingHorizontal: 7, paddingVertical: 1, borderRadius: 9,
    overflow: 'hidden',
  },
  albumCountOn: { color: '#d98c5f', backgroundColor: '#fff' },
  junkHint: {
    color: '#7a9a6a', fontSize: 12, marginTop: 4, marginBottom: 4,
    backgroundColor: '#f1f6ec', borderRadius: 8, padding: 8,
  },
  emptyHint: { color: '#a0a0a0', fontSize: 13, marginTop: 8, fontStyle: 'italic' },
  clearTxt: { color: '#b06a4f', fontSize: 13, marginTop: 10, textDecorationLine: 'underline' },
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
