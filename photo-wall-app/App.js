import React, { useEffect, useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  AppState,
  Image,
  Linking,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  claimDisplay,
  DEFAULT_API_BASE,
  publishDisplayPhoto,
  publishJulyCalendar,
  readDisplayStatus,
  syncJuly2026Photos,
} from './src/deviceApi';
import { loadDeviceSession, saveDeviceSession } from './src/sessionStore';

const C = {
  canvas: '#F5F1E8', paper: '#FFFCF6', ink: '#242822', muted: '#70776D',
  line: '#DED8CC', green: '#47695D', greenSoft: '#E2ECE6', orange: '#BC6348',
  orangeSoft: '#F4E1D8', red: '#A84D45', redSoft: '#F4DFDC', white: '#FFFFFF',
};

const TABS = [
  { id: 'home', label: '首页', icon: '⌂' },
  { id: 'albums', label: '相册', icon: '▧' },
  { id: 'settings', label: '设置', icon: '☷' },
];

function deliveryStatus(device) {
  if (!device) return null;
  const state = String(device.state || '').toLowerCase();
  if (device.error || state === 'error' || state === 'failed') {
    return { state: 'failed', progress: Number(device.progress) || 0, message: device.error || '屏幕刷新失败' };
  }
  if (device.revision && device.displayed_revision === device.revision) {
    return { state: 'done', progress: 100, message: '墨水屏已完成刷新' };
  }
  if (state === 'downloading') {
    return { state, progress: Number(device.progress) || 0, message: '墨水屏正在下载画面' };
  }
  if (state === 'displaying' || state === 'refreshing') {
    return { state: 'displaying', progress: Number(device.progress) || 0, message: '墨水屏正在刷新画面' };
  }
  if (device.revision) {
    return { state: 'queued', progress: 100, message: '发布已排队，等待墨水屏下载' };
  }
  return { state: 'idle', progress: 0, message: '设备在线，尚无发布任务' };
}

function ActionButton({ children, onPress, secondary = false, disabled = false }) {
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{children}</Text>
    </TouchableOpacity>
  );
}

function StatusBadge({ ok, children }) {
  return (
    <View style={[styles.badge, { backgroundColor: ok ? C.greenSoft : C.redSoft }]}>
      <Text style={[styles.badgeText, { color: ok ? C.green : C.red }]}>{children}</Text>
    </View>
  );
}

function SectionHeading({ eyebrow, title, description }) {
  return (
    <View style={styles.sectionHeading}>
      {eyebrow ? <Text style={styles.sectionEyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.sectionTitle}>{title}</Text>
      {description ? <Text style={styles.sectionDescription}>{description}</Text> : null}
    </View>
  );
}

function BottomNavigation({ activeTab, onChange }) {
  return (
    <View style={styles.bottomNavigation}>
      {TABS.map(tab => {
        const active = tab.id === activeTab;
        return (
          <TouchableOpacity
            key={tab.id}
            activeOpacity={0.8}
            onPress={() => onChange(tab.id)}
            style={[styles.navItem, active && styles.navItemActive]}
          >
            <Text style={[styles.navIcon, active && styles.navTextActive]}>{tab.icon}</Text>
            <Text style={[styles.navLabel, active && styles.navTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function StepCard({ number, title, description, ok, action, actionLabel, children }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.stepNumber, ok && styles.stepNumberDone]}>
          <Text style={[styles.stepNumberText, ok && styles.stepNumberTextDone]}>{ok ? '✓' : number}</Text>
        </View>
        <View style={styles.cardCopy}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardDescription}>{description}</Text>
        </View>
        <StatusBadge ok={ok}>{ok ? '已完成' : '未完成'}</StatusBadge>
      </View>
      {children}
      {actionLabel ? <ActionButton onPress={action}>{actionLabel}</ActionButton> : null}
    </View>
  );
}

function PairingStep({ number, title, children }) {
  return (
    <View style={styles.pairingStep}>
      <View style={styles.pairingNumber}><Text style={styles.pairingNumberText}>{number}</Text></View>
      <View style={styles.flex}>
        <Text style={styles.pairingTitle}>{title}</Text>
        <Text style={styles.pairingDescription}>{children}</Text>
      </View>
    </View>
  );
}

function DeviceModal({ visible, session, onClose, onConnected }) {
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const bindOnline = async () => {
    setBusy(true); setError('');
    try {
      const result = await claimDisplay({
        apiBase: DEFAULT_API_BASE,
        pairingCode,
        name: '客厅照片墙',
      });
      const nextSession = {
        device: result.device,
        accountToken: result.account_token,
        apiBase: DEFAULT_API_BASE,
      };
      await onConnected(nextSession);
      setPairingCode('');
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View><Text style={styles.modalEyebrow}>墨水屏</Text><Text style={styles.modalTitle}>{session ? '设备已连接' : '连接设备'}</Text></View>
            <TouchableOpacity onPress={onClose} style={styles.close}><Text style={styles.closeText}>×</Text></TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {session ? (
              <>
                <View style={styles.connectedBox}>
                  <Text style={styles.connectedIcon}>✓</Text>
                  <View style={styles.flex}>
                    <Text style={styles.cardTitle}>{session.device.name || '客厅照片墙'}</Text>
                    <Text style={styles.cardDescription}>{session.device.device_id}</Text>
                  </View>
                </View>
                <Text style={styles.help}>屏幕已经绑定。选择照片后即可发布，不需要让手机一直连接屏幕。</Text>
                <ActionButton onPress={onClose}>完成</ActionButton>
              </>
            ) : (
              <>
                <PairingStep number="1" title="连接屏幕 Wi-Fi">
                  打开 iPhone“设置”→“Wi-Fi”，连接名称为 PhotoWall-XXXX 的网络。
                </PairingStep>
                <PairingStep number="2" title="在自动打开的网页完成配网">
                  在系统自动打开的 PhotoWall 页面中填写家庭 Wi-Fi。完成后等待约 30 秒，屏幕热点会消失，这是正常的。
                </PairingStep>
                <PairingStep number="3" title="回到 App 绑定屏幕">
                  屏幕已经联网后，输入 PhotoWall 网页显示的六位配对码。
                </PairingStep>
                <TextInput
                  value={pairingCode}
                  onChangeText={value => setPairingCode(value.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="例如 072826"
                  style={styles.input}
                />
                <ActionButton onPress={bindOnline} disabled={busy || pairingCode.length !== 6}>
                  {busy ? '正在绑定…' : '绑定屏幕'}
                </ActionButton>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [session, setSession] = useState(null);
  const [permission, setPermission] = useState(null);
  const [photoCount, setPhotoCount] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [deviceModal, setDeviceModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [operation, setOperation] = useState({ state: 'idle', progress: 0, message: '尚未开始发布' });
  const [lastAction, setLastAction] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const photoAllowed = permission?.status === 'granted';
  const connected = Boolean(session?.device?.device_id);
  const permissionDescription = useMemo(() => {
    if (!permission) return '正在检查 iPhone 相册权限…';
    if (permission.status !== 'granted') return '需要允许访问，才能选择照片。';
    if (permission.accessPrivileges === 'limited') return '已允许访问你选择的照片。';
    return '已允许访问照片。';
  }, [permission]);

  const refreshPhotoCount = async status => {
    if (status !== 'granted') {
      setPhotoCount(null);
      return;
    }
    const result = await MediaLibrary.getAssetsAsync({
      first: 1,
      mediaType: [MediaLibrary.MediaType.photo],
    });
    setPhotoCount(result.totalCount);
  };

  const refreshPermission = async () => {
    const result = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    setPermission(result);
    await refreshPhotoCount(result.status);
    return result;
  };

  const requestPhotoPermission = async () => {
    setError('');
    try {
      const current = await refreshPermission();
      if (current.status === 'granted') return true;
      if (current.canAskAgain === false) {
        await Linking.openSettings();
        return false;
      }
      const result = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      setPermission(result);
      await refreshPhotoCount(result.status);
      if (result.status !== 'granted') setError('没有获得照片权限。请点“允许访问照片”，然后在系统设置中开启。');
      return result.status === 'granted';
    } catch (e) {
      setError(`无法申请照片权限：${e.message}`);
      return false;
    }
  };

  useEffect(() => {
    loadDeviceSession().then(saved => {
      if (saved?.device?.device_id) setSession({ ...saved, apiBase: DEFAULT_API_BASE });
    });
    (async () => {
      const current = await refreshPermission();
      if (current.status === 'undetermined') await requestPhotoPermission();
    })().catch(e => setError(`检查照片权限失败：${e.message}`));
  }, []);

  useEffect(() => {
    if (!session?.device?.device_id || !session.accountToken) return undefined;
    let active = true;
    const refreshDevice = async () => {
      try {
        const device = await readDisplayStatus({
          apiBase: DEFAULT_API_BASE,
          deviceId: session.device.device_id,
          accountToken: session.accountToken,
        });
        if (!active) return;
        const nextSession = { ...session, apiBase: DEFAULT_API_BASE, device };
        setSession(nextSession);
        saveDeviceSession(nextSession).catch(() => {});
        const status = deliveryStatus(device);
        if (status) setOperation(current => (
          current.state === 'uploading' || current.state === 'scanning'
            ? current
            : { ...current, ...status }
        ));
      } catch (caught) {
        if (active) setOperation(current => current.state === 'idle'
          ? { ...current, message: `暂时无法读取设备状态：${caught.message}` }
          : current);
      }
    };
    refreshDevice();
    const timer = setInterval(refreshDevice, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [session?.device?.device_id, session?.accountToken]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refreshPermission().catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  const choosePhoto = async () => {
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    setError(''); setNotice('');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
    if (!result.canceled) {
      setSelectedPhoto(result.assets[0]);
      setActiveTab('home');
    }
    await refreshPermission();
  };

  const publish = async () => {
    if (!selectedPhoto || !session) return;
    setLastAction('photo');
    setPublishing(true); setError(''); setNotice('');
    setOperation({ state: 'uploading', progress: 0, message: '正在上传照片' });
    try {
      const result = await publishDisplayPhoto({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
        asset: selectedPhoto,
        onProgress: fraction => setOperation({
          state: 'uploading',
          progress: Math.round(fraction * 100),
          message: `正在上传照片 · ${Math.round(fraction * 100)}%`,
        }),
      });
      const nextSession = { ...session, device: result.device || session.device, apiBase: DEFAULT_API_BASE };
      setSession(nextSession);
      await saveDeviceSession(nextSession);
      setOperation({ state: 'queued', progress: 100, message: '发布已排队，等待墨水屏下载' });
      setNotice('照片已交给线上服务，手机可以离开当前页面。');
    } catch (e) {
      setOperation({ state: 'failed', progress: 0, message: e.message });
      setError(`发送失败：${e.message}`);
    } finally { setPublishing(false); }
  };

  const publishCalendar = async () => {
    if (!session || publishing) return;
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    setLastAction('calendar');
    setPublishing(true); setError(''); setNotice('');
    setOperation({ state: 'scanning', progress: 0, message: '正在查找 2026 年 7 月照片' });
    try {
      const synced = await syncJuly2026Photos({
        apiBase: DEFAULT_API_BASE,
        onProgress: update => {
          const scanning = update.stage === 'scanning';
          setOperation({
            state: scanning ? 'scanning' : 'uploading',
            progress: update.progress || 0,
            message: scanning
              ? `正在读取已授权照片 · 已找到 ${update.scanned || 0} 张`
              : `正在上传 2026 年 7 月照片 · ${update.progress || 0}%`,
          });
        },
      });
      setOperation({ state: 'generating', progress: 100, message: '照片上传完成，云端正在生成日历' });
      const result = await publishJulyCalendar({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
      });
      const nextSession = { ...session, device: result.device || session.device, apiBase: DEFAULT_API_BASE };
      setSession(nextSession);
      await saveDeviceSession(nextSession);
      setOperation({ state: 'queued', progress: 100, message: '七月日历已排队，等待墨水屏下载' });
      setNotice(`已同步 ${synced.synced} 张照片；日历使用 ${result.calendar?.selected_day_count || 0} 天的代表照片。`);
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`七月日历发布失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const retry = () => {
    if (lastAction === 'calendar') publishCalendar();
    else if (lastAction === 'photo') publish();
  };

  const onConnected = async next => {
    setSession(next);
    await saveDeviceSession(next);
    setActiveTab('home');
  };

  const operationCard = (
    <View style={styles.statusCard}>
      <View style={styles.statusHeader}>
        <View style={styles.flex}>
          <Text style={styles.statusLabel}>真实发布状态</Text>
          <Text style={styles.statusTitle}>{operation.message}</Text>
        </View>
        <StatusBadge ok={operation.state === 'done'}>
          {{
            idle: '待发布', scanning: '读取中', uploading: '上传中', generating: '生成中',
            queued: '已排队', downloading: '下载中', displaying: '刷新中', done: '已完成', failed: '失败',
          }[operation.state] || operation.state}
        </StatusBadge>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, operation.progress || 0))}%` }]} />
      </View>
      {operation.state === 'failed' && lastAction ? <ActionButton secondary onPress={retry}>重试上一次操作</ActionButton> : null}
    </View>
  );

  const screenTitle = TABS.find(tab => tab.id === activeTab)?.label || '首页';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.brand}>照片墙</Text>
          <Text style={styles.topBarTitle}>{screenTitle}</Text>
        </View>
        {activeTab === 'home' ? (
          <TouchableOpacity activeOpacity={0.8} onPress={() => setDeviceModal(true)} style={styles.connectionStatus}>
            <View style={[styles.onlineDot, !connected && styles.offlineDot]} />
            <Text style={styles.connectionStatusText}>{connected ? '已连接' : '未连接'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        {activeTab === 'home' ? (
          <>
            {!connected ? (
              <>
                <SectionHeading
                  eyebrow="家庭墨水屏"
                  title="先连接你的照片墙"
                  description="首次配对完成后，首页会直接显示照片预览和发布功能。"
                />
                <View style={styles.heroCard}>
                  <View style={styles.heroArt}>
                    <View style={styles.heroSun} />
                    <View style={styles.heroMountainBack} />
                    <View style={styles.heroMountainFront} />
                    <Text style={styles.heroArtText}>PHOTO WALL</Text>
                  </View>
                  <View style={styles.heroCopy}>
                    <Text style={styles.heroTitle}>连接你的墨水屏</Text>
                    <Text style={styles.cardDescription}>连接 PhotoWall-XXXX 并输入六位配对码。完成后日常使用不需要 Mac。</Text>
                    <ActionButton onPress={() => setDeviceModal(true)}>开始连接</ActionButton>
                  </View>
                </View>
              </>
            ) : (
              <>
                <SectionHeading
                  eyebrow={session.device.name || '家庭墨水屏'}
                  title="创作预览"
                  description="选择真实相册照片，确认画面后直接发布到已连接的墨水屏。"
                />
                <View style={styles.previewPanel}>
                  <View style={styles.previewHeader}>
                    <Text style={styles.previewLabel}>SPECTRA 6 画面预览</Text>
                    <StatusBadge ok={Boolean(selectedPhoto)}>{selectedPhoto ? '已选照片' : '等待选择'}</StatusBadge>
                  </View>
                  {selectedPhoto ? (
                    <Image source={{ uri: selectedPhoto.uri }} style={styles.einkPreview} />
                  ) : (
                    <View style={styles.emptyPreview}>
                      <Text style={styles.emptyPreviewIcon}>＋</Text>
                      <Text style={styles.emptyPreviewText}>从真实相册选择一张照片</Text>
                    </View>
                  )}
                  <ActionButton secondary onPress={choosePhoto}>{selectedPhoto ? '更换照片' : '选择照片'}</ActionButton>
                  <ActionButton disabled={!selectedPhoto || publishing} onPress={publish}>
                    {publishing && lastAction === 'photo' ? '正在发送…' : '确认并发布'}
                  </ActionButton>
                </View>
                <SectionHeading title="自动日历" />
                <StepCard
                  number="7"
                  title="2026 年 7 月家庭日历"
                  description="读取已授权范围内拍摄于 2026 年 7 月的照片，上传后由云端生成并发布。"
                  ok={operation.state === 'done' && lastAction === 'calendar'}
                >
                  <ActionButton disabled={!photoAllowed || publishing} onPress={publishCalendar}>
                    {publishing && lastAction === 'calendar' ? '正在同步并发布…' : '一键同步并发布七月日历'}
                  </ActionButton>
                </StepCard>
              </>
            )}
          </>
        ) : null}

        {activeTab === 'albums' ? (
          <>
            <SectionHeading
              eyebrow="照片来源"
              title="系统相册"
              description="只读取 iPhone 实际授权范围，照片数量和授权状态不会使用演示数据。"
            />
            <StepCard
              number="1"
              title="照片访问权限"
              description={permissionDescription}
              ok={photoAllowed}
              action={photoAllowed ? () => Linking.openSettings() : requestPhotoPermission}
              actionLabel={photoAllowed ? '管理系统照片权限' : '允许访问照片'}
            >
              {photoAllowed ? (
                <View style={styles.realDataBox}>
                  <Text style={styles.realDataValue}>{photoCount ?? '—'}</Text>
                  <Text style={styles.realDataLabel}>当前授权范围内的照片</Text>
                </View>
              ) : null}
            </StepCard>
            <StepCard
              number="2"
              title="选择准备展示的照片"
              description={selectedPhoto ? '照片已选好，返回首页即可预览和发布。' : '使用系统照片选择器，不会自动上传整个相册。'}
              ok={Boolean(selectedPhoto)}
              action={choosePhoto}
              actionLabel={selectedPhoto ? '重新选择照片' : '从相册选择'}
            >
              {selectedPhoto ? <Image source={{ uri: selectedPhoto.uri }} style={styles.preview} /> : null}
            </StepCard>
          </>
        ) : null}

        {activeTab === 'settings' ? (
          <>
            <SectionHeading eyebrow="设备与账号" title="设置" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>云端服务</Text>
              <Text style={styles.settingValue}>api.mokeedesign.cn</Text>
              <Text style={styles.settingHint}>固定线上地址，不能由用户修改。</Text>
            </View>
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>墨水屏</Text>
              <Text style={styles.settingValue}>{connected ? session.device.name || '客厅照片墙' : '尚未绑定'}</Text>
              <Text style={styles.settingHint}>{connected ? session.device.device_id : '连接 PhotoWall-XXXX 完成首次配对。'}</Text>
              <ActionButton secondary onPress={() => setDeviceModal(true)}>{connected ? '查看设备' : '连接设备'}</ActionButton>
            </View>
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>照片权限</Text>
              <Text style={styles.settingValue}>{permissionDescription}</Text>
              <ActionButton secondary onPress={photoAllowed ? () => Linking.openSettings() : requestPhotoPermission}>
                {photoAllowed ? '打开系统设置' : '申请照片权限'}
              </ActionButton>
            </View>
            <SectionHeading eyebrow="发布任务" title="任务与状态" description="上传、生成和屏幕刷新状态统一放在这里。" />
            {operationCard}
            <SectionHeading eyebrow="隐私与展示" title="人物管理" description="人物策略将支持允许展示、每次审核和不展示三种选择。" />
            <View style={styles.infoCard}>
              <Text style={styles.infoIcon}>◎</Text>
              <Text style={styles.infoTitle}>等待云端人物接口</Text>
              <Text style={styles.infoText}>当前线上接口还不能返回真实人物列表和策略。为避免展示虚构人物，本页不使用演示数据。</Text>
            </View>
            <View style={styles.policyRow}>
              {['允许展示', '每次审核', '不展示'].map((label, index) => (
                <View key={label} style={[styles.policyPill, index === 1 && styles.policyPillAmber, index === 2 && styles.policyPillRed]}>
                  <Text style={styles.policyPillText}>{label}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>✓ {notice}</Text></View> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        <Text style={styles.footer}>照片仅在你主动选择并发送时上传。</Text>
      </ScrollView>

      <BottomNavigation activeTab={activeTab} onChange={setActiveTab} />
      <DeviceModal
        visible={deviceModal}
        session={session}
        onClose={() => setDeviceModal(false)}
        onConnected={onConnected}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 22, paddingBottom: 120 },
  topBar: { minHeight: 68, paddingHorizontal: 22, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.canvas },
  topBarTitle: { color: C.ink, fontSize: 20, fontWeight: '800', marginTop: 2 },
  connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, paddingHorizontal: 11, paddingVertical: 8 },
  connectionStatusText: { color: C.ink, fontSize: 11, fontWeight: '800' },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.green },
  offlineDot: { backgroundColor: C.red },
  brand: { color: C.orange, fontSize: 13, fontWeight: '900', letterSpacing: 2, marginTop: 8 },
  title: { color: C.ink, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 34, lineHeight: 43, fontWeight: '700', marginTop: 9 },
  subtitle: { color: C.muted, fontSize: 15, lineHeight: 24, marginTop: 8, marginBottom: 24 },
  card: { backgroundColor: C.paper, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 17, marginBottom: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  stepNumber: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center' },
  stepNumberDone: { backgroundColor: C.greenSoft },
  stepNumberText: { color: C.orange, fontWeight: '900', fontSize: 15 },
  stepNumberTextDone: { color: C.green },
  cardCopy: { flex: 1 },
  cardTitle: { color: C.ink, fontSize: 16, fontWeight: '800' },
  cardDescription: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 4 },
  badge: { borderRadius: 14, paddingHorizontal: 8, paddingVertical: 5 },
  badgeText: { fontSize: 9, fontWeight: '900' },
  sectionHeading: { marginTop: 8, marginBottom: 17 },
  sectionEyebrow: { color: C.orange, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, marginBottom: 5 },
  sectionTitle: { color: C.ink, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 27, lineHeight: 35, fontWeight: '700' },
  sectionDescription: { color: C.muted, fontSize: 13, lineHeight: 21, marginTop: 7 },
  button: { minHeight: 48, borderRadius: 13, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', marginTop: 15, paddingHorizontal: 16 },
  buttonSecondary: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line },
  buttonText: { color: C.white, fontSize: 13, fontWeight: '800' },
  buttonTextSecondary: { color: C.ink },
  disabled: { opacity: 0.35 },
  preview: { width: '100%', height: 260, borderRadius: 14, resizeMode: 'cover', marginTop: 16 },
  heroCard: { backgroundColor: C.paper, borderRadius: 22, borderWidth: 1, borderColor: C.line, padding: 18, marginBottom: 14, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 20 },
  heroArt: { width: 230, maxWidth: '100%', aspectRatio: 4 / 3, borderRadius: 12, overflow: 'hidden', backgroundColor: '#E7C665', position: 'relative' },
  heroSun: { position: 'absolute', width: 48, height: 48, borderRadius: 24, right: 28, top: 24, backgroundColor: C.orange },
  heroMountainBack: { position: 'absolute', width: 185, height: 140, left: -55, bottom: -78, backgroundColor: '#6E8B7C', transform: [{ rotate: '35deg' }] },
  heroMountainFront: { position: 'absolute', width: 205, height: 165, right: -70, bottom: -92, backgroundColor: '#34554C', transform: [{ rotate: '42deg' }] },
  heroArtText: { position: 'absolute', left: 14, bottom: 13, color: C.ink, backgroundColor: C.paper, paddingHorizontal: 8, paddingVertical: 5, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  heroCopy: { flex: 1, minWidth: 210 },
  heroTitle: { color: C.ink, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 25, fontWeight: '700', marginTop: 12 },
  realDataBox: { backgroundColor: C.greenSoft, borderRadius: 13, padding: 15, marginTop: 15 },
  realDataValue: { color: C.green, fontSize: 26, fontWeight: '900' },
  realDataLabel: { color: C.green, fontSize: 11, marginTop: 3 },
  previewPanel: { backgroundColor: '#292B27', borderRadius: 20, padding: 17, marginBottom: 23 },
  previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 13 },
  previewLabel: { color: '#D8D3CA', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  einkPreview: { width: '100%', aspectRatio: 4 / 3, resizeMode: 'contain', backgroundColor: '#EFE8D6' },
  emptyPreview: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#EFE8D6', alignItems: 'center', justifyContent: 'center', padding: 20 },
  emptyPreviewIcon: { color: C.orange, fontSize: 35 },
  emptyPreviewText: { color: C.muted, fontSize: 12, marginTop: 8 },
  infoCard: { backgroundColor: C.paper, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 22, alignItems: 'center' },
  infoIcon: { color: C.orange, fontSize: 36 },
  infoTitle: { color: C.ink, fontSize: 17, fontWeight: '800', marginTop: 8 },
  infoText: { color: C.muted, fontSize: 12, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  policyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 },
  policyPill: { flex: 1, minWidth: 90, alignItems: 'center', borderRadius: 14, paddingVertical: 11, backgroundColor: C.greenSoft },
  policyPillAmber: { backgroundColor: '#F4E8D1' },
  policyPillRed: { backgroundColor: C.redSoft },
  policyPillText: { color: C.ink, fontSize: 10, fontWeight: '800' },
  settingCard: { backgroundColor: C.paper, borderRadius: 17, borderWidth: 1, borderColor: C.line, padding: 17, marginBottom: 12 },
  settingLabel: { color: C.orange, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  settingValue: { color: C.ink, fontSize: 15, fontWeight: '800', marginTop: 7 },
  settingHint: { color: C.muted, fontSize: 11, lineHeight: 18, marginTop: 5 },
  notice: { backgroundColor: C.greenSoft, borderRadius: 14, padding: 14, marginTop: 2 },
  noticeText: { color: C.green, fontSize: 12, fontWeight: '700', lineHeight: 19 },
  error: { backgroundColor: C.redSoft, borderRadius: 14, padding: 14, marginTop: 2 },
  errorText: { color: C.red, fontSize: 12, lineHeight: 19, marginTop: 10 },
  footer: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 22 },
  statusCard: { backgroundColor: C.paper, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 17, marginBottom: 14 },
  statusHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  statusLabel: { color: C.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  statusTitle: { color: C.ink, fontSize: 14, fontWeight: '800', marginTop: 5, maxWidth: 250 },
  progressTrack: { height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: C.line, marginTop: 15 },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: C.green },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,22,19,.55)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '92%', backgroundColor: C.paper, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 36 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalEyebrow: { color: C.orange, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  modalTitle: { color: C.ink, fontSize: 26, fontWeight: '800', marginTop: 4 },
  close: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: C.muted, fontSize: 24 },
  help: { color: C.muted, fontSize: 13, lineHeight: 21, marginBottom: 8 },
  input: { height: 47, borderRadius: 12, borderWidth: 1, borderColor: C.line, color: C.ink, paddingHorizontal: 13, backgroundColor: C.white },
  pairingStep: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line },
  pairingNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center' },
  pairingNumberText: { color: C.orange, fontSize: 12, fontWeight: '900' },
  pairingTitle: { color: C.ink, fontSize: 14, fontWeight: '800' },
  pairingDescription: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 4 },
  connectedBox: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.greenSoft, padding: 15, borderRadius: 15, marginBottom: 14 },
  connectedIcon: { color: C.green, fontSize: 24, fontWeight: '900' },
  flex: { flex: 1 },
  bottomNavigation: { position: 'absolute', left: 10, right: 10, bottom: 7, minHeight: 68, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, flexDirection: 'row', padding: 5, shadowColor: '#594F42', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 18, elevation: 5 },
  navItem: { flex: 1, minWidth: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navItemActive: { backgroundColor: C.orangeSoft },
  navIcon: { color: C.muted, fontSize: 18 },
  navLabel: { color: C.muted, fontSize: 9, fontWeight: '700' },
  navTextActive: { color: C.orange, fontWeight: '900' },
});
