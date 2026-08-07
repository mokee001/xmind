import { useEffect, useMemo, useState } from 'react';
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
  { id: 'preview', label: '预览', icon: '▣' },
  { id: 'settings', label: '设置', icon: '☷' },
];

const IS_WEB_PREVIEW = Platform.OS === 'web';
const WEB_PREVIEW_SESSION = {
  device: { device_id: 'web-preview-frame', name: '客厅照片墙' },
  accountToken: 'preview-only',
  apiBase: DEFAULT_API_BASE,
};

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

function WebPreviewBar({ connected, hasPhoto, onToggleConnection, onClearPhoto }) {
  if (!IS_WEB_PREVIEW) return null;
  return (
    <View style={styles.webPreviewBar}>
      <View style={styles.flex}>
        <Text style={styles.webPreviewTitle}>网页 UI 预览</Text>
        <Text style={styles.webPreviewHint}>不会连接设备、读取系统权限或上传照片</Text>
      </View>
      <View style={styles.webPreviewActions}>
        <TouchableOpacity onPress={onToggleConnection} style={styles.webPreviewButton}>
          <Text style={styles.webPreviewButtonText}>{connected ? '查看未连接' : '查看已连接'}</Text>
        </TouchableOpacity>
        {hasPhoto ? (
          <TouchableOpacity onPress={onClearPhoto} style={styles.webPreviewButton}>
            <Text style={styles.webPreviewButtonText}>清除照片</Text>
          </TouchableOpacity>
        ) : null}
      </View>
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
  const [webConnected, setWebConnected] = useState(true);
  const [permission, setPermission] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deviceModal, setDeviceModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [operation, setOperation] = useState({ state: 'idle', progress: 0, message: '尚未开始发布' });
  const [lastAction, setLastAction] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const effectiveSession = IS_WEB_PREVIEW && webConnected ? WEB_PREVIEW_SESSION : session;
  const photoAllowed = IS_WEB_PREVIEW || permission?.status === 'granted';
  const connected = IS_WEB_PREVIEW ? webConnected : Boolean(session?.device?.device_id);
  const permissionDescription = useMemo(() => {
    if (IS_WEB_PREVIEW) return '网页预览使用浏览器文件选择器，不读取 iPhone 权限。';
    if (!permission) return '正在检查 iPhone 相册权限…';
    if (permission.status !== 'granted') return '需要允许访问，才能选择照片。';
    if (permission.accessPrivileges === 'limited') return '已允许访问你选择的照片。';
    return '已允许访问照片。';
  }, [permission]);

  const refreshPermission = async () => {
    const result = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    setPermission(result);
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
      if (result.status !== 'granted') setError('没有获得照片权限。请点“允许访问照片”，然后在系统设置中开启。');
      return result.status === 'granted';
    } catch (e) {
      setError(`无法申请照片权限：${e.message}`);
      return false;
    }
  };

  useEffect(() => {
    if (IS_WEB_PREVIEW) return;
    loadDeviceSession().then(saved => {
      if (saved?.device?.device_id) setSession({ ...saved, apiBase: DEFAULT_API_BASE });
    });
    (async () => {
      const current = await refreshPermission();
      if (current.status === 'undetermined') await requestPhotoPermission();
    })().catch(e => setError(`检查照片权限失败：${e.message}`));
  }, []);

  useEffect(() => {
    if (IS_WEB_PREVIEW) return undefined;
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
    const allowed = IS_WEB_PREVIEW || photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    setError(''); setNotice('');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
    if (!result.canceled) {
      setSelectedPhoto(result.assets[0]);
    }
    if (!IS_WEB_PREVIEW) await refreshPermission();
  };

  const simulateWebPublish = async kind => {
    setLastAction(kind);
    setPublishing(true); setError(''); setNotice('');
    const steps = kind === 'calendar'
      ? [
        { state: 'scanning', progress: 20, message: '预览：正在查找七月照片' },
        { state: 'generating', progress: 70, message: '预览：正在生成日历' },
        { state: 'queued', progress: 100, message: '预览：发布任务已排队' },
      ]
      : [
        { state: 'uploading', progress: 45, message: '预览：正在上传照片' },
        { state: 'queued', progress: 100, message: '预览：发布任务已排队' },
      ];
    for (const step of steps) {
      setOperation(step);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    setNotice('这是网页交互预览，没有数据被上传。');
    setPublishing(false);
  };

  const publish = async () => {
    if (!selectedPhoto || (!IS_WEB_PREVIEW && !session)) return;
    if (IS_WEB_PREVIEW) return simulateWebPublish('photo');
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
    if ((!IS_WEB_PREVIEW && !session) || publishing) return;
    if (IS_WEB_PREVIEW) return simulateWebPublish('calendar');
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

  const connectDevice = () => {
    if (IS_WEB_PREVIEW) setWebConnected(true);
    else setDeviceModal(true);
  };

  const manageDevice = () => {
    if (IS_WEB_PREVIEW) setWebConnected(value => !value);
    else setDeviceModal(true);
  };

  const operationCard = (
    <View style={styles.statusCard}>
      <View style={styles.statusHeader}>
        <View style={styles.flex}>
          <Text style={styles.statusLabel}>最近发布</Text>
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
          <TouchableOpacity activeOpacity={0.8} onPress={manageDevice} style={styles.connectionStatus}>
            <View style={[styles.onlineDot, !connected && styles.offlineDot]} />
            <Text style={styles.connectionStatusText}>{connected ? '已连接' : '未连接'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <WebPreviewBar
        connected={connected}
        hasPhoto={Boolean(selectedPhoto)}
        onToggleConnection={manageDevice}
        onClearPhoto={() => setSelectedPhoto(null)}
      />

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
                    <ActionButton onPress={connectDevice}>开始连接</ActionButton>
                  </View>
                </View>
              </>
            ) : (
              <>
                <SectionHeading
                  eyebrow={effectiveSession.device.name || '家庭墨水屏'}
                  title="发布照片"
                  description="选择照片后，可以先查看相框效果，再发布到照片墙。"
                />
                <View style={styles.publishCard}>
                  {selectedPhoto ? (
                    <View style={styles.selectedPhotoRow}>
                      <Image source={{ uri: selectedPhoto.uri }} style={styles.selectedThumbnail} />
                      <View style={styles.flex}>
                        <Text style={styles.cardTitle}>照片已选择</Text>
                        <Text style={styles.cardDescription}>可以查看相框效果或直接发布。</Text>
                        <TouchableOpacity onPress={() => setActiveTab('preview')}>
                          <Text style={styles.previewLink}>查看效果预览 →</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : <Text style={styles.cardDescription}>还没有选择照片。</Text>}
                  <ActionButton secondary={Boolean(selectedPhoto)} onPress={choosePhoto}>{selectedPhoto ? '更换照片' : '选择照片'}</ActionButton>
                  {selectedPhoto ? (
                    <ActionButton disabled={publishing} onPress={publish}>
                      {publishing && lastAction === 'photo' ? '正在发布…' : '发布到照片墙'}
                    </ActionButton>
                  ) : null}
                </View>
                <TouchableOpacity activeOpacity={0.8} onPress={() => setMoreOpen(value => !value)} style={styles.moreHeader}>
                  <View>
                    <Text style={styles.moreTitle}>更多发布方式</Text>
                    <Text style={styles.moreHint}>日历等低频功能</Text>
                  </View>
                  <Text style={styles.moreChevron}>{moreOpen ? '⌃' : '⌄'}</Text>
                </TouchableOpacity>
                {moreOpen ? (
                  <View style={styles.moreBody}>
                    <Text style={styles.cardTitle}>2026 年 7 月家庭日历</Text>
                    <Text style={styles.cardDescription}>同步已授权的 2026 年 7 月照片，由云端生成并发布。</Text>
                    <ActionButton disabled={!photoAllowed || publishing} onPress={publishCalendar}>
                      {publishing && lastAction === 'calendar' ? '正在同步并发布…' : '发布七月日历'}
                    </ActionButton>
                  </View>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {activeTab === 'preview' ? (
          <>
            <SectionHeading
              eyebrow="空间效果"
              title="相框预览"
              description="模拟照片墙挂在家中墙面上的效果。实际墨水屏颜色会略有差异。"
            />
            <View style={styles.roomPreview}>
              <View style={styles.hangingLine} />
              <View style={styles.frameShadow}>
                <View style={styles.frameOuter}>
                  <View style={styles.frameMat}>
                    {selectedPhoto ? (
                      <Image source={{ uri: selectedPhoto.uri }} style={styles.framePhoto} />
                    ) : (
                      <View style={styles.framePlaceholder}>
                        <Text style={styles.framePlaceholderIcon}>＋</Text>
                        <Text style={styles.framePlaceholderText}>选择照片查看效果</Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
              <View style={styles.shelf} />
              <View style={styles.vase} />
              <View style={styles.plantStem} />
              <View style={[styles.plantLeaf, styles.plantLeafLeft]} />
              <View style={[styles.plantLeaf, styles.plantLeafRight]} />
            </View>
            <ActionButton secondary={Boolean(selectedPhoto)} onPress={choosePhoto}>{selectedPhoto ? '更换照片' : '选择照片'}</ActionButton>
            {selectedPhoto ? <ActionButton onPress={() => setActiveTab('home')}>返回首页发布</ActionButton> : null}
          </>
        ) : null}

        {activeTab === 'settings' ? (
          <>
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>设备</Text>
              <Text style={styles.settingValue}>{connected ? effectiveSession.device.name || '客厅照片墙' : '尚未绑定'}</Text>
              <Text style={styles.settingHint}>{connected ? effectiveSession.device.device_id : '连接 PhotoWall-XXXX 完成首次配对。'}</Text>
              <ActionButton secondary onPress={connected ? manageDevice : connectDevice}>
                {IS_WEB_PREVIEW ? (connected ? '预览未连接状态' : '预览已连接状态') : (connected ? '查看设备' : '连接设备')}
              </ActionButton>
            </View>
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>照片权限</Text>
              <Text style={styles.settingValue}>{permissionDescription}</Text>
              {!IS_WEB_PREVIEW ? (
                <ActionButton secondary onPress={photoAllowed ? () => Linking.openSettings() : requestPhotoPermission}>
                  {photoAllowed ? '打开系统设置' : '申请照片权限'}
                </ActionButton>
              ) : null}
            </View>
            <SectionHeading title="发布记录" description="查看最近一次上传和屏幕刷新状态。" />
            {operationCard}
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>人物隐私</Text>
              <Text style={styles.settingValue}>尚未启用</Text>
              <Text style={styles.settingHint}>云端人物接口完成后，可在这里设置允许展示、每次审核或不展示。</Text>
            </View>
          </>
        ) : null}

        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>✓ {notice}</Text></View> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        <Text style={styles.footer}>{IS_WEB_PREVIEW ? '网页预览不会上传照片或调用真实设备接口。' : '照片仅在你主动选择并发送时上传。'}</Text>
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
  webPreviewBar: { width: '100%', maxWidth: 760, alignSelf: 'center', marginTop: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, backgroundColor: C.greenSoft, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  webPreviewTitle: { color: C.green, fontSize: 12, fontWeight: '900' },
  webPreviewHint: { color: C.green, fontSize: 10, marginTop: 2 },
  webPreviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  webPreviewButton: { borderRadius: 10, borderWidth: 1, borderColor: C.green, paddingHorizontal: 10, paddingVertical: 7 },
  webPreviewButtonText: { color: C.green, fontSize: 10, fontWeight: '800' },
  connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, paddingHorizontal: 11, paddingVertical: 8 },
  connectionStatusText: { color: C.ink, fontSize: 11, fontWeight: '800' },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.green },
  offlineDot: { backgroundColor: C.red },
  brand: { color: C.orange, fontSize: 13, fontWeight: '900', letterSpacing: 2, marginTop: 8 },
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
  heroCard: { backgroundColor: C.paper, borderRadius: 22, borderWidth: 1, borderColor: C.line, padding: 18, marginBottom: 14, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 20 },
  heroArt: { width: 230, maxWidth: '100%', aspectRatio: 4 / 3, borderRadius: 12, overflow: 'hidden', backgroundColor: '#E7C665', position: 'relative' },
  heroSun: { position: 'absolute', width: 48, height: 48, borderRadius: 24, right: 28, top: 24, backgroundColor: C.orange },
  heroMountainBack: { position: 'absolute', width: 185, height: 140, left: -55, bottom: -78, backgroundColor: '#6E8B7C', transform: [{ rotate: '35deg' }] },
  heroMountainFront: { position: 'absolute', width: 205, height: 165, right: -70, bottom: -92, backgroundColor: '#34554C', transform: [{ rotate: '42deg' }] },
  heroArtText: { position: 'absolute', left: 14, bottom: 13, color: C.ink, backgroundColor: C.paper, paddingHorizontal: 8, paddingVertical: 5, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  heroCopy: { flex: 1, minWidth: 210 },
  heroTitle: { color: C.ink, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 25, fontWeight: '700', marginTop: 12 },
  publishCard: { backgroundColor: C.paper, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 17, marginBottom: 16 },
  selectedPhotoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 2 },
  selectedThumbnail: { width: 84, height: 64, borderRadius: 9, resizeMode: 'cover', backgroundColor: C.canvas },
  previewLink: { color: C.orange, fontSize: 11, fontWeight: '800', marginTop: 7 },
  roomPreview: { height: 430, borderRadius: 22, overflow: 'hidden', backgroundColor: '#D8CFBD', borderWidth: 1, borderColor: '#C7BBA6', alignItems: 'center', paddingTop: 54, position: 'relative' },
  hangingLine: { position: 'absolute', top: 22, width: 1, height: 43, backgroundColor: '#8E806B' },
  frameShadow: { width: '78%', maxWidth: 310, padding: 7, backgroundColor: 'rgba(65,48,35,.18)', borderRadius: 3, shadowColor: '#3D3026', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.3, shadowRadius: 16, elevation: 9 },
  frameOuter: { padding: 12, backgroundColor: '#4A3528', borderWidth: 2, borderColor: '#2E211A' },
  frameMat: { padding: 14, backgroundColor: '#F1E8D6' },
  framePhoto: { width: '100%', aspectRatio: 4 / 3, resizeMode: 'cover', backgroundColor: '#E8DFCA' },
  framePlaceholder: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#E7DEC9', alignItems: 'center', justifyContent: 'center' },
  framePlaceholderIcon: { color: C.orange, fontSize: 32 },
  framePlaceholderText: { color: C.muted, fontSize: 11, marginTop: 7 },
  shelf: { position: 'absolute', left: 24, right: 24, bottom: 62, height: 12, borderRadius: 4, backgroundColor: '#71513B' },
  vase: { position: 'absolute', right: 52, bottom: 74, width: 42, height: 58, borderBottomLeftRadius: 17, borderBottomRightRadius: 17, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: '#8C5B43' },
  plantStem: { position: 'absolute', right: 72, bottom: 130, width: 2, height: 42, backgroundColor: '#486253', transform: [{ rotate: '-8deg' }] },
  plantLeaf: { position: 'absolute', width: 28, height: 13, borderRadius: 14, backgroundColor: '#61796A' },
  plantLeafLeft: { right: 71, bottom: 151, transform: [{ rotate: '28deg' }] },
  plantLeafRight: { right: 48, bottom: 163, transform: [{ rotate: '-25deg' }] },
  moreHeader: { minHeight: 64, backgroundColor: C.paper, borderRadius: 16, borderWidth: 1, borderColor: C.line, paddingHorizontal: 17, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  moreTitle: { color: C.ink, fontSize: 14, fontWeight: '800' },
  moreHint: { color: C.muted, fontSize: 10, marginTop: 3 },
  moreChevron: { color: C.orange, fontSize: 20, fontWeight: '900' },
  moreBody: { backgroundColor: C.paper, borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 17, marginTop: 8 },
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
