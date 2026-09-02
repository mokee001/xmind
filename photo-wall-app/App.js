import { useEffect, useMemo, useRef, useState } from 'react';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  AppState,
  Animated,
  Easing,
  Image,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text as NativeText,
  TextInput as NativeTextInput,
  View,
} from 'react-native';
import {
  autoClaimDisplay,
  DEFAULT_API_BASE,
  generatePetCollage,
  generateWall,
  listDisplays,
  listWallTemplates,
  publishGeneratedWall,
  readRecognizedContent,
  readDisplayStatus,
  readSelectionModel,
  refreshRecognizedContent,
  removeDisplay,
  reprovisionDisplay,
  sendLocalControl,
  syncPhotoAlbum,
  waitForDisplayRevision,
} from './src/deviceApi';
import {
  cancelProvisioning as cancelBleProvisioning,
  connectProvisioningDevice as connectBleProvisioningDevice,
  provisionWifi as provisionBleWifi,
  scanWifiNetworks as scanBleWifiNetworks,
  startDeviceDiscovery as startBleDeviceDiscovery,
  stopDeviceDiscovery as stopBleDeviceDiscovery,
  subscribeProvisionStatus as subscribeBleProvisionStatus,
} from './src/bleProvisioning';
import {
  clearPendingDeviceSetup,
  clearPhotoSyncPreference,
  loadDeviceSessions,
  loadOrganizingPaused,
  loadPendingDeviceSetup,
  removeDeviceSession,
  saveDeviceSession,
  savePendingDeviceSetup,
  savePhotoSyncPreference,
  saveOrganizingPaused,
  selectDeviceSession,
  updateDeviceSession,
} from './src/sessionStore';
import DeviceSetupFlow from './src/DeviceSetupFlow';
import AddDisplayModal from './src/AddDisplayModal';
import DeviceManagerModal from './src/DeviceManagerModal';
import HouseholdMembersModal from './src/HouseholdMembersModal';
import { adoptDevice, readAccount, registerAccount } from './src/accountApi';
import { loadAccountSession, saveAccountSession } from './src/accountStore';
import {
  advanceTestDisplay,
  createTestDisplay,
  deleteTestDisplay,
  setTestDisplayState,
} from './src/testDeviceApi';

const C = {
  canvas: '#F7F7F7', paper: '#FFFFFF', ink: '#222222', muted: '#717171',
  line: '#EBEBEB', green: '#222222', greenSoft: '#F2F2F2', orange: '#222222',
  orangeSoft: '#F2F2F2', red: '#C13515', redSoft: '#FFF4F1', white: '#FFFFFF',
};

const TABS = [
  { id: 'home', label: '投屏', icon: '▣' },
  { id: 'selection', label: '范围', icon: '◉' },
  { id: 'settings', label: '设置', icon: '⚙︎' },
];

const FALLBACK_WALL_TEMPLATES = [
  { id: 'template_1', label: '日常拼贴', description: '8 张照片的日常手帐拼贴', width: 2000, height: 2668, slots: 8 },
  { id: 'template_2', label: '圣诞手帐', description: '8 张照片的节日主题拼贴', width: 2000, height: 2668, slots: 8 },
  { id: 'eink_portrait_gallery', label: '六色墨水屏·竖版画廊', description: '5 张照片的纯白底竖版画廊', width: 960, height: 1280, slots: 5 },
];

const PET_COLLAGE_TEMPLATE = {
  id: 'denim_pet',
  label: '宠物牛仔拼贴',
  description: '优先同一只宠物，照片不足时自动搭配真实宠物照片',
  width: 960,
  height: 1280,
  slots: 5,
  candidateTarget: 12,
};

const IS_WEB_PREVIEW = Platform.OS === 'web';
const TEST_DEVICE_ENABLED = process.env.EXPO_PUBLIC_ENABLE_TEST_DEVICE === '1';
const TEST_DEVICE_KEY = process.env.EXPO_PUBLIC_TEST_DEVICE_KEY || '';
const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;
const WEB_PREVIEW_SESSION = {
  device: { device_id: 'web-preview-frame', name: '客厅照片墙' },
  accountToken: 'preview-only',
  apiBase: DEFAULT_API_BASE,
};
const AUTHORIZED_PHOTO_SOURCE = {
  id: 'all-allowed-photos',
  title: 'iPhone 已允许的照片',
  allPhotos: true,
};
const MAX_PHOTO_SYNC_PASSES = 1;

function normalizeWallTemplates(result) {
  const templates = Array.isArray(result?.templates) ? result.templates : [];
  const templatesById = new Map(
    templates
      .filter(template => template?.id && template?.qualified !== false)
      .map(template => [String(template.id), template]),
  );
  return FALLBACK_WALL_TEMPLATES.map(fallback => {
    const template = templatesById.get(fallback.id);
    if (!template) return fallback;
    return {
      ...fallback,
      label: String(template.name || template.label || fallback.label),
      description: String(template.description || fallback.description),
      width: Number(template.width) || fallback.width,
      height: Number(template.height) || fallback.height,
      slots: Number(template.slots) || fallback.slots,
    };
  });
}

function resolveApiAssetUrl(value) {
  const path = String(value || '').trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${DEFAULT_API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function resolvePhotoThumbUrl(value) {
  const path = String(value || '').trim();
  if (!path) return '';
  const name = photoBasename(path);
  return name ? `${DEFAULT_API_BASE.replace(/\/$/, '')}/api/thumb/${encodeURIComponent(name)}?s=360` : '';
}

function photoBasename(value) {
  return String(value || '').trim().split(/[\\/]/).pop() || '';
}

const PREVIEW_RECOGNIZED_CONTENT = {
  people: [
    { id: 'person-family-1', label: '家人 A', detail: '人物 · 128 张照片', icon: 'A', group: '人物', count: 128, filters: ['person_1'] },
    { id: 'person-family-2', label: '家人 B', detail: '人物 · 96 张照片', icon: 'B', group: '人物', count: 96, filters: ['person_2'] },
    { id: 'person-friends', label: '朋友', detail: '人物 · 43 张照片', icon: '友', group: '人物', count: 43, filters: ['person_3'] },
  ],
  topics: [
    { id: 'topic-best', label: '每日精选', detail: '精选 · 476 张照片', icon: '精', group: '精选', count: 476, filters: [] },
    { id: 'topic-pets', label: '宠物', detail: '宠物 · 72 张照片', icon: '宠', group: '宠物', count: 72, filters: ['pet'] },
    { id: 'place-shanghai', label: '上海', detail: '地点 · 58 张照片', icon: '沪', group: '地点', count: 58, filters: ['place:上海'] },
    { id: 'topic-travel', label: '旅行', detail: '主题 · 116 张照片', icon: '旅', group: '主题', count: 116, filters: ['travel'] },
    { id: 'topic-food', label: '美食', detail: '主题 · 38 张照片', icon: '食', group: '主题', count: 38, filters: ['food'] },
    { id: 'topic-scenery', label: '风景', detail: '主题 · 84 张照片', icon: '景', group: '主题', count: 84, filters: ['nature'] },
  ],
};

// “范围”页展示的是用户能理解的照片集合，而不是模型的全部底层标签。
// 情绪和色彩仍保留在云端用于排序、搭配模板，但不作为一级范围开关。
const HIDDEN_SCOPE_GROUPS = new Set(['情绪', '色彩']);
const PRIMARY_SCOPE_GROUPS = new Set(['精选', '人物', '宠物', '地点', '相册', '回忆', '事件', '旅行']);

function splitScopeCollections(items) {
  const priority = { 精选: 0, 人物: 1, 宠物: 2, 地点: 3, 相册: 4, 回忆: 5, 事件: 5, 旅行: 5 };
  const primary = items
    .filter(item => !HIDDEN_SCOPE_GROUPS.has(item.group))
    .filter(item => PRIMARY_SCOPE_GROUPS.has(item.group))
    .sort((a, b) => (priority[a.group] ?? 99) - (priority[b.group] ?? 99) || b.count - a.count);
  return { primary, visible: primary };
}

const EMPTY_RECOGNITION_SNAPSHOT = {
  accountToken: '',
  total: 0,
  processedTotal: 0,
  goodTotal: 0,
  peopleAvailable: false,
  people: [],
  albums: [],
};

const EMPTY_OPERATION = { state: 'idle', progress: 0, message: '尚未开始发布' };
const PET_COLLAGE_STEPS = [
  { id: 'analyzing', label: '等待分析' },
  { id: 'cutout', label: '抠图' },
  { id: 'composing', label: '合成' },
  { id: 'preview', label: '预览' },
  { id: 'published', label: '发布' },
];

function recognizedItem(album, localCoverUris = {}) {
  const label = String(album?.label || '未命名内容');
  const coverPaths = [...new Set([
    ...(Array.isArray(album?.covers) ? album.covers : []),
    album?.cover,
  ].filter(Boolean))];
  const coverUrls = coverPaths.map(path => (
    localCoverUris[photoBasename(path)] || resolvePhotoThumbUrl(path)
  )).filter(Boolean);
  return {
    id: `cloud-${album?.id || label}`,
    label,
    detail: `${album?.group || '精选'} · ${Number(album?.count) || 0} 张照片`,
    icon: label.slice(0, 1),
    group: album?.group || '精选',
    count: Number(album?.count) || 0,
    coverUrl: coverUrls[0] || '',
    coverUrls,
    filters: Array.isArray(album?.filter) ? album.filter : [],
    template: album?.template || 'template_1',
  };
}

function recognizedContentFrom(snapshot, localCoverUris = {}) {
  const smartAlbums = Array.isArray(snapshot?.albums) ? snapshot.albums : [];
  const people = smartAlbums.filter(album => album.group === '人物').map(album => recognizedItem(album, localCoverUris));
  const topics = smartAlbums.filter(album => album.group !== '人物').map(album => recognizedItem(album, localCoverUris));
  return { people, topics };
}

function localUrlForDevice(deviceId) {
  const suffix = String(deviceId || '').slice(-4).toLowerCase();
  return suffix ? `http://photowall-${suffix}.local` : null;
}

function normalizeDeviceSession(value) {
  if (!value?.device?.device_id) return null;
  return {
    ...value,
    apiBase: DEFAULT_API_BASE,
    localUrl: value.localUrl || localUrlForDevice(value.device.device_id),
  };
}

const wait = duration => new Promise(resolve => setTimeout(resolve, duration));

function provisioningFailure(status) {
  const code = String(status?.errorCode || status?.status || 'error');
  const fallback = {
    wrong_password: 'Wi-Fi 密码不正确，请重新输入',
    network_not_found: '照片墙找不到这个 Wi-Fi，请确认网络名称后重试',
    timeout: '照片墙连接 Wi-Fi 超时，请靠近路由器后重试',
    cloud_unreachable: '照片墙已联网，但暂时无法连接云端，请稍后重试',
    disconnected: '设备蓝牙连接已断开，请靠近照片墙后重试',
  }[code] || '照片墙连接失败，请重试';
  return new Error(status?.message || fallback);
}

function createProvisionStatusWaiter(timeoutMs = 120000) {
  let settled = false;
  let unsubscribe;
  let timeout;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const promise = new Promise((resolve, reject) => {
    unsubscribe = subscribeBleProvisionStatus(status => {
      if (settled) return;
      if (status.status === 'connected') {
        settled = true;
        cleanup();
        resolve(status);
        return;
      }
      const failed = status.errorCode || [
        'error', 'wrong_password', 'network_not_found', 'timeout', 'cloud_unreachable',
      ].includes(status.status);
      if (failed) {
        settled = true;
        cleanup();
        reject(provisioningFailure(status));
      }
    });
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('等待照片墙联网超时，请检查 Wi-Fi 后重试'));
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      settled = true;
      cleanup();
    },
  };
}

async function claimProvisionedDevice({ device, status }) {
  const deviceId = status?.deviceId || device?.deviceId;
  const setupToken = device?.setupToken;
  if (!deviceId || !setupToken) throw new Error('设备身份信息不完整，请重新连接照片墙');

  let lastError;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const claimed = await autoClaimDisplay({
        apiBase: DEFAULT_API_BASE,
        deviceId,
        setupToken,
        name: device?.deviceName || '客厅照片墙',
      });
      return {
        device: claimed.device,
        accountToken: claimed.account_token,
        apiBase: DEFAULT_API_BASE,
        localUrl: status?.localUrl || localUrlForDevice(deviceId),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 14) await wait(1000);
    }
  }
  throw new Error(`设备已联网，但自动绑定失败：${lastError?.message || '请稍后重试'}`);
}

const REAL_DEVICE_SETUP_ADAPTER = {
  startDeviceDiscovery: startBleDeviceDiscovery,
  stopDeviceDiscovery: stopBleDeviceDiscovery,
  connectProvisioningDevice: connectBleProvisioningDevice,
  scanWifiNetworks: scanBleWifiNetworks,
  subscribeProvisionStatus: subscribeBleProvisionStatus,
  cancelProvisioning: cancelBleProvisioning,
  provisionWifi: async ({ ssid, password, device, existingSession }) => {
    const waiter = createProvisionStatusWaiter();
    try {
      if (existingSession?.device?.device_id) {
        await reprovisionDisplay({
          apiBase: DEFAULT_API_BASE,
          deviceId: existingSession.device.device_id,
          accountToken: existingSession.accountToken,
          setupToken: device?.setupToken,
        });
      }
      await provisionBleWifi({ ssid, password, apiBase: DEFAULT_API_BASE });
      const status = await waiter.promise;
      if (existingSession?.device?.device_id) {
        const deviceId = status?.deviceId || device?.deviceId;
        if (deviceId !== existingSession.device.device_id) {
          throw new Error('连接到的不是原照片墙，请返回后选择正确设备');
        }
        return {
          ...existingSession,
          apiBase: DEFAULT_API_BASE,
          localUrl: status?.localUrl || localUrlForDevice(deviceId),
          device: { ...existingSession.device, state: 'online', error: '' },
        };
      }
      return claimProvisionedDevice({ device, status });
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  },
};

function Text({ style, ...props }) {
  return <NativeText {...props} style={[styles.systemFont, style]} />;
}

function TextInput({ style, ...props }) {
  return <NativeTextInput {...props} style={[styles.systemFont, style]} />;
}

function MotionPressable({
  children,
  onPress,
  disabled = false,
  style,
  contentStyle,
  scaleTo = 0.97,
  accessibilityLabel,
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = value => {
    Animated.spring(scale, {
      toValue: value,
      damping: 18,
      stiffness: 320,
      mass: 0.62,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => !disabled && animateTo(scaleTo)}
        onPressOut={() => animateTo(1)}
        style={[styles.motionPressable, contentStyle, disabled && styles.disabled]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

function deviceFamily(device) {
  const explicit = String(device?.device_family || '').toLowerCase();
  if (explicit) return explicit;
  const deviceId = String(device?.device_id || '').toLowerCase();
  return deviceId.startsWith('walnutpi-') ? 'walnutpi_19in' : 'esp32_e6';
}

function isScreen19Device(device) {
  return deviceFamily(device) === 'walnutpi_19in';
}

function isEinkDevice(device) {
  return deviceFamily(device) === 'esp32_e6';
}

function deliveryStatus(device) {
  if (!device) return null;
  const state = String(device.state || '').toLowerCase();
  if (device.error || state === 'error' || state === 'failed') {
    return { state: 'failed', progress: Number(device.progress) || 0, message: device.error || '屏幕刷新失败' };
  }
  if (isScreen19Device(device)) {
    if (state === 'displayed' || (device.revision && device.displayed_revision === device.revision)) {
      return { state: 'done', progress: 100, message: '19 寸屏已显示最新画面' };
    }
    if (device.revision) {
      return { state: 'queued', progress: 100, message: '画面已发送，等待 19 寸屏在线接收' };
    }
    return { state: 'idle', progress: 0, message: '19 寸屏在线，尚无展示任务' };
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
    return { state: 'queued', progress: Number(device.progress) || 0, message: '发布已排队，等待墨水屏下载' };
  }
  return { state: 'idle', progress: 0, message: '设备在线，尚无发布任务' };
}

function ActionButton({ children, onPress, secondary = false, disabled = false }) {
  return (
    <MotionPressable
      disabled={disabled}
      onPress={onPress}
      style={styles.buttonMotion}
      contentStyle={[styles.button, secondary && styles.buttonSecondary]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{children}</Text>
    </MotionPressable>
  );
}

function StatusBadge({ ok, children }) {
  const failed = children === '失败';
  const backgroundColor = failed ? C.redSoft : ok ? C.ink : C.orangeSoft;
  const color = failed ? C.red : ok ? C.white : C.ink;
  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}

function MonochromeSwitch({ value, disabled = false, onValueChange }) {
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(position, {
      toValue: value ? 1 : 0,
      damping: 18,
      stiffness: 320,
      mass: 0.62,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [value]);

  if (!IS_WEB_PREVIEW) {
    return (
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: '#D1D1D6', true: C.ink }}
        thumbColor={C.white}
      />
    );
  }

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.switchTrack, value && styles.switchTrackActive, disabled && styles.switchDisabled]}
    >
      <Animated.View style={[styles.switchThumb, {
        transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
      }]} />
    </Pressable>
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

function SelectionGroup({ title, description, items, rules, onToggle, disabled = false, sample = false }) {
  return (
    <View style={styles.selectionGroup}>
      <View style={styles.selectionGroupHeader}>
        <View style={styles.flex}>
          <View style={styles.inlineTitleRow}>
            <Text style={styles.selectionGroupTitle}>{title}</Text>
            {sample ? <Text style={styles.samplePill}>示例</Text> : null}
          </View>
          <Text style={styles.selectionGroupDescription}>{description}</Text>
        </View>
      </View>
      {items.map((item, index) => {
        const enabled = rules[item.id] !== false;
        return (
          <View key={item.id} style={[styles.selectionRow, index > 0 && styles.selectionRowBorder, disabled && styles.selectionRowDisabled]}>
            <View style={styles.selectionAvatar}><Text style={styles.selectionAvatarText}>{item.icon}</Text></View>
            <View style={styles.flex}>
              <Text style={styles.selectionTitle}>{item.label}</Text>
              <Text style={styles.selectionDetail}>{item.detail} · {enabled ? '参与展示' : '不展示'}</Text>
            </View>
            <MonochromeSwitch
              value={enabled}
              disabled={disabled}
              onValueChange={value => onToggle(item.id, value)}
            />
          </View>
        );
      })}
    </View>
  );
}

function ScopeOverview({ sourceCount, processedCount, qualityCount, totalCollections, enabledCollections, sample = false }) {
  const syncRate = sourceCount > 0
    ? Math.max(0, Math.min(100, Math.round((processedCount / sourceCount) * 100)))
    : 0;
  return (
    <View style={styles.scopeOverview}>
      <View style={styles.scopeOverviewHeader}>
        <View style={styles.flex}>
          <Text style={styles.scopeOverviewEyebrow}>当前内容路径</Text>
          <Text style={styles.scopeOverviewTitle}>从手机照片到照片墙</Text>
        </View>
        {sample ? <Text style={styles.scopeOverviewBadge}>示例</Text> : null}
      </View>
      <View style={styles.scopeFlow}>
        <View style={styles.scopeStep}>
          <Text style={styles.scopeStepValue}>{sourceCount || '—'}</Text>
          <Text style={styles.scopeStepLabel}>系统允许</Text>
        </View>
        <Text style={styles.scopeArrow}>›</Text>
        <View style={styles.scopeStep}>
          <Text style={styles.scopeStepValue}>{processedCount || '—'}</Text>
          <Text style={styles.scopeStepLabel}>云端已整理</Text>
        </View>
        <Text style={styles.scopeArrow}>›</Text>
        <View style={styles.scopeStep}>
          <Text style={styles.scopeStepValue}>{qualityCount || '—'}</Text>
          <Text style={styles.scopeStepLabel}>可展示</Text>
        </View>
        <Text style={styles.scopeArrow}>›</Text>
        <View style={styles.scopeStep}>
          <Text style={styles.scopeStepValue}>{enabledCollections}/{totalCollections}</Text>
          <Text style={styles.scopeStepLabel}>集合开启</Text>
        </View>
      </View>
      <View style={styles.scopeQualityTrack}>
        <View style={[styles.scopeQualityFill, { width: `${syncRate}%` }]} />
      </View>
      <Text style={styles.scopeOverviewHint}>{sourceCount
        ? processedCount < sourceCount
          ? `iPhone 已允许 ${sourceCount} 张，云端目前整理了 ${processedCount} 张，其中 ${qualityCount} 张可展示。其余主要是重复连拍、无相机信息、截图文档、严重模糊或极端曝光；继续同步后数量会增加。`
          : `已整理全部允许照片，其中 ${qualityCount} 张可展示；其余主要因重复连拍、无相机信息、截图文档、严重模糊或极端曝光被排除。`
        : '先连接设备并允许照片访问，真实数量和照片集合会自动替换这里的状态。'}</Text>
    </View>
  );
}

function ThemeCoverCarousel({ item, paused = false }) {
  const urls = (Array.isArray(item?.coverUrls) && item.coverUrls.length
    ? item.coverUrls
    : [item?.coverUrl]).filter(Boolean).slice(0, 10);
  const sourceKey = urls.join('|');
  const [index, setIndex] = useState(0);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    setIndex(0);
    opacity.setValue(1);
  }, [sourceKey]);

  useEffect(() => {
    if (paused || urls.length <= 1) return undefined;
    const timer = setInterval(() => {
      Animated.timing(opacity, {
        toValue: 0.08,
        duration: 160,
        useNativeDriver: Platform.OS !== 'web',
      }).start(({ finished }) => {
        if (!finished) return;
        setIndex(current => (current + 1) % urls.length);
        Animated.timing(opacity, {
          toValue: 1,
          duration: 260,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      });
    }, 2600);
    return () => {
      clearInterval(timer);
      opacity.stopAnimation();
    };
  }, [sourceKey, paused]);

  if (!urls.length) {
    return <View style={styles.themeCoverFallback}><Text style={styles.themeCoverGlyph}>{item?.icon}</Text></View>;
  }
  return (
    <>
      <Animated.View style={[styles.themeCoverAnimated, { opacity }]}>
        <Image source={{ uri: urls[index % urls.length] }} style={styles.themeCoverImage} />
      </Animated.View>
      {urls.length > 1 ? (
        <View style={styles.themeCarouselCount}>
          <Text style={styles.themeCarouselCountText}>{(index % urls.length) + 1}/{urls.length}</Text>
        </View>
      ) : null}
    </>
  );
}

function ThemeScopeGrid({
  items,
  rules,
  onToggle,
  disabled = false,
  sample = false,
  title = '推荐集合',
  description = '展示与你最相关的人物、宠物、地点和高价值相册',
}) {
  return (
    <View style={styles.themeScopeSection}>
      <View style={styles.themeScopeHeader}>
        <View style={styles.flex}>
          <Text style={styles.selectionGroupTitle}>{title}</Text>
          <Text style={styles.selectionGroupDescription}>{description}</Text>
        </View>
        {sample ? <Text style={styles.samplePill}>示例</Text> : null}
      </View>
      <View style={styles.themeGrid}>
        {items.map(item => {
          const controllable = Array.isArray(item.filters) && item.filters.length > 0;
          const enabled = !controllable || rules[item.id] !== false;
          return (
            <View
              key={item.id}
              style={[styles.themeCardMotion, styles.themeCard, !enabled && styles.themeCardOff, disabled && styles.selectionRowDisabled]}
            >
              <View style={styles.themeCover}>
                <ThemeCoverCarousel item={item} />
                <View style={styles.themeGroupBadge}><Text style={styles.themeGroupText}>{item.group || '集合'}</Text></View>
              </View>
              <View style={styles.themeCardBody}>
                <Text numberOfLines={1} style={styles.themeCardTitle}>{item.label}</Text>
                <Text style={styles.themeCardCount}>{item.count || 0} 张可用照片</Text>
              </View>
              <View style={styles.themeRuleRow}>
                <Text style={styles.themeRuleLabel}>{controllable ? (enabled ? '允许参与自动上墙' : '已从范围排除') : '默认精选范围'}</Text>
                {controllable ? (
                  <MonochromeSwitch
                    value={enabled}
                    disabled={disabled}
                    onValueChange={value => onToggle(item.id, value)}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ContextCard({ tone = 'blue', title, description, actionLabel, onAction }) {
  return (
    <View style={[styles.contextCard, tone === 'green' && styles.contextCardGreen]}>
      <View style={styles.flex}>
        <Text style={[styles.contextTitle, tone === 'green' && styles.contextTitleGreen]}>{title}</Text>
        <Text style={styles.contextDescription}>{description}</Text>
      </View>
      {actionLabel ? (
        <MotionPressable onPress={onAction} style={styles.contextActionMotion} contentStyle={styles.contextAction}>
          <Text style={styles.contextActionText}>{actionLabel}</Text>
        </MotionPressable>
      ) : null}
    </View>
  );
}

function ChoiceRow({ label, options, value, onChange, disabled = false }) {
  return (
    <View style={styles.choiceBlock}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.choiceRow}>
        {options.map(option => {
          const active = option === value;
          return (
            <MotionPressable
              key={option}
              disabled={disabled}
              onPress={() => onChange(option)}
              style={styles.choiceChipMotion}
              contentStyle={[styles.choiceChip, active && styles.choiceChipActive, disabled && styles.choiceChipDisabled]}
              scaleTo={0.95}
            >
              <Text style={[styles.choiceChipText, active && styles.choiceChipTextActive]}>{option}</Text>
            </MotionPressable>
          );
        })}
      </View>
    </View>
  );
}

function TemplatePicker({ templates, value, onChange, disabled = false, loading = false }) {
  const allTemplates = [...templates, PET_COLLAGE_TEMPLATE];
  return (
    <View style={styles.templatePickerBlock}>
      <View style={styles.templatePickerHeader}>
        <Text style={styles.settingLabel}>模板</Text>
        <Text style={styles.templatePickerCount}>{loading ? '正在读取…' : `${allTemplates.length} 个 · 左右滑动`}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.templatePickerRow}
      >
        {allTemplates.map(template => {
          const active = template.id === value;
          const format = template.height > template.width ? '竖版' : '横版';
          return (
            <MotionPressable
              key={template.id}
              disabled={disabled}
              onPress={() => onChange(template.id)}
              style={styles.templateCardMotion}
              contentStyle={[
                styles.templateCard,
                active && styles.templateCardActive,
                disabled && styles.choiceChipDisabled,
              ]}
              scaleTo={0.96}
            >
              <Text style={[styles.templateCardName, active && styles.templateCardNameActive]}>{template.label}</Text>
              <Text style={[styles.templateCardMeta, active && styles.templateCardMetaActive]}>
                {format}{template.slots ? ` · ${template.slots} 张` : ''}
              </Text>
              {template.description ? (
                <Text numberOfLines={2} style={[styles.templateCardDescription, active && styles.templateCardDescriptionActive]}>
                  {template.description}
                </Text>
              ) : null}
            </MotionPressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function BottomNavigation({ activeTab, onChange }) {
  return (
    <View style={styles.bottomNavigation}>
      {TABS.map(tab => {
        const active = tab.id === activeTab;
        return (
          <MotionPressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={styles.navMotion}
            contentStyle={[styles.navItem, active && styles.navItemActive]}
            scaleTo={0.92}
          >
            <Text style={[styles.navIcon, active && styles.navTextActive]}>{tab.icon}</Text>
            <Text style={[styles.navLabel, active && styles.navTextActive]}>{tab.label}</Text>
          </MotionPressable>
        );
      })}
    </View>
  );
}

function WebPreviewBar({ connected, onToggleConnection }) {
  if (!IS_WEB_PREVIEW) return null;
  return (
    <View style={styles.webPreviewBar}>
      <View style={styles.flex}>
        <Text style={styles.webPreviewTitle}>网页预览 · 不会上传数据</Text>
      </View>
      <View style={styles.webPreviewActions}>
        <MotionPressable onPress={onToggleConnection} contentStyle={styles.webPreviewButton}>
          <Text style={styles.webPreviewButtonText}>{connected ? '切换为未连接' : '打开配网流程'}</Text>
        </MotionPressable>
      </View>
    </View>
  );
}

function PetCollageFlow({ stage }) {
  const activeIndex = PET_COLLAGE_STEPS.findIndex(step => step.id === stage);
  return (
    <View style={styles.petFlow}>
      <View style={styles.petFlowLine} />
      {PET_COLLAGE_STEPS.map((step, index) => {
        const reached = activeIndex >= index;
        return (
          <View key={step.id} style={styles.petFlowStep}>
            <View style={[styles.petFlowDot, reached && styles.petFlowDotReached]}>
              <Text style={[styles.petFlowNumber, reached && styles.petFlowNumberReached]}>{index + 1}</Text>
            </View>
            <Text style={[styles.petFlowLabel, reached && styles.petFlowLabelReached]}>{step.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [session, setSession] = useState(null);
  const [deviceSessions, setDeviceSessions] = useState([]);
  const [reconfigurationSession, setReconfigurationSession] = useState(null);
  const screenMotion = useRef(new Animated.Value(1)).current;
  const accountPreparationRef = useRef(null);
  const photoSyncInFlightRef = useRef(false);
  const organizingPausedRef = useRef(false);
  const templateActionInFlightRef = useRef(false);
  const publishInFlightRef = useRef(false);
  const [webConnected, setWebConnected] = useState(false);
  const [webPhotoAuthorized, setWebPhotoAuthorized] = useState(false);
  const [permission, setPermission] = useState(null);
  const [accessiblePhotoCount, setAccessiblePhotoCount] = useState(0);
  const [photoSync, setPhotoSync] = useState(AUTHORIZED_PHOTO_SOURCE);
  const [recognitionSnapshot, setRecognitionSnapshot] = useState(EMPTY_RECOGNITION_SNAPSHOT);
  const [localCoverUris, setLocalCoverUris] = useState({});
  const [organizingPaused, setOrganizingPaused] = useState(false);
  const [recognitionLoading, setRecognitionLoading] = useState(false);
  const [selectionModel, setSelectionModel] = useState(null);
  const [selectionModelLoading, setSelectionModelLoading] = useState(false);
  const [selectionModelError, setSelectionModelError] = useState('');
  const [generatedWall, setGeneratedWall] = useState(null);
  const [petCollageStage, setPetCollageStage] = useState(null);
  const [addDisplayVisible, setAddDisplayVisible] = useState(false);
  const [deviceModal, setDeviceModal] = useState(false);
  const [deviceManagerVisible, setDeviceManagerVisible] = useState(false);
  const [householdMembersVisible, setHouseholdMembersVisible] = useState(false);
  const [accountSession, setAccountSession] = useState(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const [testDeviceBusy, setTestDeviceBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [operation, setOperation] = useState(EMPTY_OPERATION);
  const [lastAction, setLastAction] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [wallTemplates, setWallTemplates] = useState(FALLBACK_WALL_TEMPLATES);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState(FALLBACK_WALL_TEMPLATES[0].id);
  const [previewImageFailed, setPreviewImageFailed] = useState(false);
  const [updateFrequency, setUpdateFrequency] = useState('每天');
  const [updateTime, setUpdateTime] = useState('20:00');
  const [displayPlan, setDisplayPlan] = useState('每日精选');
  const [displayRules, setDisplayRules] = useState(() => Object.fromEntries(
    Object.values(PREVIEW_RECOGNIZED_CONTENT).flat().map(item => [item.id, true]),
  ));

  const effectiveSession = IS_WEB_PREVIEW && webConnected ? WEB_PREVIEW_SESSION : session;
  const photoAllowed = IS_WEB_PREVIEW ? webPhotoAuthorized : permission?.status === 'granted';
  const connected = IS_WEB_PREVIEW ? webConnected : Boolean(session?.device?.device_id);
  const managedDeviceSessions = IS_WEB_PREVIEW && webConnected ? [WEB_PREVIEW_SESSION] : deviceSessions;
  const canPublish = IS_WEB_PREVIEW || effectiveSession?.device?.can_publish !== false;
  const canManageDevice = IS_WEB_PREVIEW || effectiveSession?.device?.can_manage !== false;
  const isTestDevice = Boolean(effectiveSession?.device?.test_device);
  const deviceDeliveryPending = !IS_WEB_PREVIEW
    && isEinkDevice(effectiveSession?.device)
    && Boolean(effectiveSession?.device?.revision)
    && effectiveSession.device.displayed_revision !== effectiveSession.device.revision
    && !effectiveSession.device.error
    && !['error', 'failed'].includes(String(effectiveSession.device.state || '').toLowerCase());
  const publishDeliveryActive = publishing || (deviceDeliveryPending && operation.state !== 'failed');
  const contentMode = !connected ? 'demo' : !photoAllowed ? 'permission' : 'live';
  const liveRecognitionSnapshot = recognitionSnapshot.accountToken === session?.accountToken
    ? recognitionSnapshot
    : EMPTY_RECOGNITION_SNAPSHOT;
  const liveRecognizedContent = useMemo(
    () => recognizedContentFrom(liveRecognitionSnapshot, localCoverUris),
    [liveRecognitionSnapshot, localCoverUris],
  );
  const recognizedContent = IS_WEB_PREVIEW
    ? PREVIEW_RECOGNIZED_CONTENT
    : liveRecognizedContent;
  const recognizedItems = [...recognizedContent.people, ...recognizedContent.topics];
  const {
    primary: primaryScopeItems,
    visible: visibleScopeItems,
  } = splitScopeCollections(recognizedItems);
  // “精选”代表整个优质照片池，没有排除标签；人物、宠物及其他语义集合
  // 才会生成可执行的范围规则。情绪/色彩不会进入这里。
  const manageableScopeItems = visibleScopeItems.filter(item => Array.isArray(item.filters) && item.filters.length);
  const enabledCollectionCount = visibleScopeItems.filter(item => (
    !Array.isArray(item.filters) || !item.filters.length || displayRules[item.id] !== false
  )).length;
  const scopeSourceCount = IS_WEB_PREVIEW ? 514 : accessiblePhotoCount;
  const scopeProcessedCount = IS_WEB_PREVIEW
    ? 492
    : Number(liveRecognitionSnapshot.processedTotal) || Number(liveRecognitionSnapshot.total) || 0;
  const scopeQualityCount = IS_WEB_PREVIEW ? 476 : Number(liveRecognitionSnapshot.goodTotal) || 0;
  const scopeSyncIncomplete = contentMode === 'live' && scopeSourceCount > scopeProcessedCount;
  const requestedCoverNames = useMemo(() => [...new Set(
    (liveRecognitionSnapshot.albums || [])
      .filter(album => PRIMARY_SCOPE_GROUPS.has(album?.group))
      .flatMap(album => [
        ...(Array.isArray(album?.covers) ? album.covers : []),
        album?.cover,
      ]).map(photoBasename).filter(Boolean),
  )], [liveRecognitionSnapshot.albums]);
  const requestedCoverNamesKey = requestedCoverNames.join('|');
  const recognizedPhotoCount = contentMode === 'live' ? liveRecognitionSnapshot.goodTotal : 0;
  const selectionIsSample = IS_WEB_PREVIEW;
  const selectedWallTemplate = selectedTemplateId === PET_COLLAGE_TEMPLATE.id
    ? PET_COLLAGE_TEMPLATE
    : wallTemplates.find(template => template.id === selectedTemplateId) || wallTemplates[0] || FALLBACK_WALL_TEMPLATES[0];
  const renderedWallTemplate = wallTemplates.find(template => template.id === generatedWall?.template) || selectedWallTemplate;
  const generatedImageUrl = resolveApiAssetUrl(generatedWall?.image_url);
  const isPortraitPreview = generatedWall?.template === 'denim_pet'
    || (renderedWallTemplate.height > renderedWallTemplate.width);
  const nextUpdateLabel = updateFrequency === '关闭' ? '自动更新已关闭' : `${updateFrequency} ${updateTime} 自动更新`;
  const permissionDescription = useMemo(() => {
    if (IS_WEB_PREVIEW) return webPhotoAuthorized ? '已模拟允许访问照片。' : '尚未模拟开启照片权限。';
    if (!permission) return '正在检查 iPhone 相册权限…';
    if (permission.status !== 'granted') return '需要允许访问，才能选择照片。';
    if (permission.accessPrivileges === 'limited') return `已允许访问你选择的 ${accessiblePhotoCount || 0} 张照片。`;
    return accessiblePhotoCount ? `已允许访问全部照片（${accessiblePhotoCount} 张）。` : '已允许访问全部照片。';
  }, [permission, webPhotoAuthorized, accessiblePhotoCount]);
  const selectionModelDescription = !connected
    ? '连接设备后自动读取。'
    : selectionModelLoading
      ? '正在读取云端精选模型…'
      : selectionModel
        ? Number(selectionModel.trained_samples) > 0
          ? `已加载 · ${Number(selectionModel.trained_samples)} 条偏好样本`
          : '已加载 · 等待根据你的选择学习偏好'
        : `暂未加载${selectionModelError ? `：${selectionModelError}` : ''}`;

  const clearDeviceRuntimeState = () => {
    setSession(null);
    setReconfigurationSession(null);
    setAddingDevice(false);
    setPhotoSync(AUTHORIZED_PHOTO_SOURCE);
    setRecognitionSnapshot(EMPTY_RECOGNITION_SNAPSHOT);
    setRecognitionLoading(false);
    setSelectionModel(null);
    setSelectionModelLoading(false);
    setSelectionModelError('');
    setGeneratedWall(null);
    setPreviewImageFailed(false);
    setPetCollageStage(null);
    setOperation(EMPTY_OPERATION);
    setAddDisplayVisible(false);
    setDeviceModal(false);
    setDeviceManagerVisible(false);
    setActiveTab('home');
  };

  const persistAccountSession = async nextAccountSession => {
    await saveAccountSession(nextAccountSession);
    setAccountSession(nextAccountSession);
    return nextAccountSession;
  };

  const prepareAccountSession = async () => {
    if (!accountPreparationRef.current) {
      accountPreparationRef.current = (async () => {
        const stored = accountSession || await loadAccountSession();
        if (stored?.accessToken) {
          setAccountSession(stored);
          try {
            const current = await readAccount({ accessToken: stored.accessToken });
            return persistAccountSession({ ...stored, account: current.account });
          } catch (caught) {
            if (caught.status !== 401) throw caught;
          }
        }
        return persistAccountSession(await registerAccount({ name: stored?.account?.name || '我' }));
      })();
    }
    try {
      return await accountPreparationRef.current;
    } finally {
      accountPreparationRef.current = null;
    }
  };

  const upgradeDeviceToFamily = async (value, nextAccountSession) => {
    const normalized = normalizeDeviceSession(value);
    if (!normalized?.accountToken || !nextAccountSession?.accessToken) return normalized;
    if (
      normalized.accountToken === nextAccountSession.accessToken
      && (normalized.householdId || normalized.device?.household_id)
    ) return normalized;
    const adopted = await adoptDevice({
      accessToken: nextAccountSession.accessToken,
      deviceId: normalized.device.device_id,
      deviceAccountToken: normalized.accountToken,
      householdName: `${normalized.device.name || '照片墙'}家庭`,
    });
    const householdDevice = adopted.household?.devices?.find(device => (
      device.device_id === normalized.device.device_id
    ));
    return normalizeDeviceSession({
      ...normalized,
      accountToken: nextAccountSession.accessToken,
      householdId: adopted.household?.household_id,
      device: {
        ...normalized.device,
        ...(householdDevice || {}),
        can_manage: adopted.household?.role === 'owner',
        can_publish: adopted.household?.role === 'owner' || Boolean(adopted.household?.can_publish),
      },
    });
  };

  const syncAccountDevices = async nextAccountSession => {
    if (!nextAccountSession?.accessToken) return null;
    const [result, local] = await Promise.all([
      listDisplays({ apiBase: DEFAULT_API_BASE, accountToken: nextAccountSession.accessToken }),
      loadDeviceSessions(),
    ]);
    let stored = local;
    for (const device of result.devices || []) {
      const existing = stored.sessions.find(item => item.device?.device_id === device.device_id);
      const nextSession = normalizeDeviceSession({
        ...existing,
        accountToken: nextAccountSession.accessToken,
        householdId: device.household_id || existing?.householdId,
        device: { ...(existing?.device || {}), ...device },
      });
      stored = await updateDeviceSession(nextSession);
    }
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    const activeSession = sessions.find(item => item.device.device_id === stored.activeDeviceId) || sessions[0] || null;
    setDeviceSessions(sessions);
    if (activeSession) setSession(activeSession);
    return activeSession;
  };

  const handleFamilyDeviceUpgrade = async next => {
    const normalized = normalizeDeviceSession(next);
    const stored = await updateDeviceSession(normalized);
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    setDeviceSessions(sessions);
    if (normalized.device.device_id === session?.device?.device_id) setSession(normalized);
  };

  const handleHouseholdJoined = async (_household, nextAccountSession) => {
    await syncAccountDevices(nextAccountSession);
  };

  const handleHouseholdLeft = async household => {
    const leavingDeviceIds = new Set((household?.devices || []).map(device => device.device_id));
    for (const deviceId of leavingDeviceIds) await removeDeviceSession(deviceId);
    const stored = await loadDeviceSessions();
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    const activeSession = sessions.find(item => item.device.device_id === stored.activeDeviceId) || sessions[0] || null;
    setDeviceSessions(sessions);
    if (activeSession) setSession(activeSession);
    else clearDeviceRuntimeState();
  };

  useEffect(() => {
    screenMotion.setValue(0);
    Animated.timing(screenMotion, {
      toValue: 1,
      duration: 340,
      easing: Easing.bezier(0.2, 0.82, 0.2, 1),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [activeTab, connected]);

  const refreshAccessiblePhotoCount = async permissionResult => {
    if (IS_WEB_PREVIEW) return 0;
    if (permissionResult?.status !== 'granted') {
      setAccessiblePhotoCount(0);
      return 0;
    }
    const page = await MediaLibrary.getAssetsAsync({
      first: 1,
      mediaType: [MediaLibrary.MediaType.photo],
    });
    const count = Number(page.totalCount) || page.assets.length || 0;
    setAccessiblePhotoCount(count);
    return count;
  };

  const refreshPermission = async () => {
    const result = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    setPermission(result);
    await refreshAccessiblePhotoCount(result);
    return result;
  };

  const requestPhotoPermission = async () => {
    setError('');
    if (IS_WEB_PREVIEW) {
      setWebPhotoAuthorized(true);
      setPermission({ status: 'granted', accessPrivileges: 'all', canAskAgain: true });
      setNotice('网页预览已切换为“已授权”状态，没有读取电脑照片。');
      return true;
    }
    try {
      const current = await refreshPermission();
      if (current.status === 'granted') {
        setPhotoSync(AUTHORIZED_PHOTO_SOURCE);
        savePhotoSyncPreference(AUTHORIZED_PHOTO_SOURCE).catch(() => {});
        return true;
      }
      if (current.canAskAgain === false) {
        await Linking.openSettings();
        return false;
      }
      const result = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      setPermission(result);
      await refreshAccessiblePhotoCount(result);
      if (result.status !== 'granted') setError('没有获得照片权限。请点“允许访问照片”，然后在系统设置中开启。');
      if (result.status === 'granted') {
        setPhotoSync(AUTHORIZED_PHOTO_SOURCE);
        savePhotoSyncPreference(AUTHORIZED_PHOTO_SOURCE).catch(() => {});
      }
      return result.status === 'granted';
    } catch (e) {
      setError(`无法申请照片权限：${e.message}`);
      return false;
    }
  };

  useEffect(() => {
    let active = true;
    setTemplatesLoading(true);
    setTemplatesError('');
    listWallTemplates({ apiBase: DEFAULT_API_BASE }).then(result => {
      if (!active) return;
      const templates = normalizeWallTemplates(result);
      if (!templates.length) throw new Error('云端没有返回可用模板');
      setWallTemplates(templates);
      setSelectedTemplateId(current => (
        current === PET_COLLAGE_TEMPLATE.id || templates.some(template => template.id === current) ? current : templates[0].id
      ));
    }).catch(caught => {
      if (active) setTemplatesError(caught.message || '暂时无法读取云端模板');
    }).finally(() => {
      if (active) setTemplatesLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setPreviewImageFailed(false);
  }, [generatedImageUrl]);

  useEffect(() => {
    if (IS_WEB_PREVIEW) return;
    Promise.all([loadDeviceSessions(), loadPendingDeviceSetup(), loadOrganizingPaused()]).then(([stored, pending, paused]) => {
      organizingPausedRef.current = paused;
      setOrganizingPaused(paused);
      const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
      setDeviceSessions(sessions);
      const saved = sessions.find(item => item.device.device_id === stored.activeDeviceId) || sessions[0];
      if (pending?.kind === 'reconfigure' && pending.session?.device?.device_id) {
        setReconfigurationSession(normalizeDeviceSession(pending.session));
        if (saved) setSession(saved);
        setDeviceModal(true);
        setActiveTab('settings');
        return;
      }
      if (saved) setSession(saved);
    });
    refreshPermission().catch(e => setError(`检查照片权限失败：${e.message}`));
  }, []);

  useEffect(() => {
    if (IS_WEB_PREVIEW) return undefined;
    let active = true;
    const initializeAccount = async () => {
      const nextAccountSession = await prepareAccountSession();
      if (!active) return;
      setAccountSession(nextAccountSession);
      try {
        const local = await loadDeviceSessions();
        for (const current of local.sessions) {
          try {
            const upgraded = await upgradeDeviceToFamily(current, nextAccountSession);
            if (upgraded?.accountToken === nextAccountSession.accessToken) {
              await updateDeviceSession(upgraded);
            }
          } catch {
            // 可能是其他家庭的旧绑定；由邀请码流程处理，不删除本地记录。
          }
        }
        if (!active) return;
        await syncAccountDevices(nextAccountSession);
      } catch {
        // 家庭接口尚未部署或网络暂时不可用时，保留原有设备会话和连接流程。
      }
    };
    initializeAccount().catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (IS_WEB_PREVIEW || !connected || permission?.status !== 'undetermined') return;
    requestPhotoPermission().catch(() => {});
  }, [connected, permission?.status]);

  useEffect(() => {
    if (IS_WEB_PREVIEW || !session?.accountToken) {
      setSelectionModel(null);
      setSelectionModelLoading(false);
      setSelectionModelError('');
      return undefined;
    }
    let active = true;
    setSelectionModel(null);
    setSelectionModelLoading(true);
    setSelectionModelError('');
    readSelectionModel({
      apiBase: DEFAULT_API_BASE,
      accountToken: session.accountToken,
    }).then(model => {
      if (active) setSelectionModel(model);
    }).catch(caught => {
      if (active) setSelectionModelError(caught.message || '读取失败');
    }).finally(() => {
      if (active) setSelectionModelLoading(false);
    });
    return () => { active = false; };
  }, [session?.accountToken]);

  useEffect(() => {
    if (IS_WEB_PREVIEW || !session?.accountToken || !photoAllowed) return undefined;
    let active = true;
    setRecognitionSnapshot(EMPTY_RECOGNITION_SNAPSHOT);
    setRecognitionLoading(true);
    readRecognizedContent({
      apiBase: DEFAULT_API_BASE,
      accountToken: session.accountToken,
    }).then(result => {
      if (active) setRecognitionSnapshot({ ...result, accountToken: session.accountToken });
    }).catch(caught => {
      if (active) setError(`读取云端识别结果失败：${caught.message}`);
    }).finally(() => {
      if (active) setRecognitionLoading(false);
    });
    return () => { active = false; };
  }, [session?.accountToken, photoAllowed]);

  useEffect(() => {
    if (IS_WEB_PREVIEW || !photoAllowed || !requestedCoverNames.length) {
      setLocalCoverUris({});
      return undefined;
    }
    let active = true;
    const resolveLocalCovers = async () => {
      const pending = new Set(requestedCoverNames);
      const resolved = {};
      let after;
      do {
        const page = await MediaLibrary.getAssetsAsync({
          first: 200,
          after,
          mediaType: [MediaLibrary.MediaType.photo],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        for (const asset of page.assets) {
          if (pending.has(asset.filename)) {
            resolved[asset.filename] = asset.uri;
            pending.delete(asset.filename);
          }
        }
        after = page.endCursor;
        if (!page.hasNextPage || !pending.size) break;
      } while (after);
      if (active) setLocalCoverUris(resolved);
    };
    resolveLocalCovers().catch(() => {
      if (active) setLocalCoverUris({});
    });
    return () => { active = false; };
  }, [photoAllowed, requestedCoverNamesKey]);

  useEffect(() => {
    if (contentMode !== 'live' || !manageableScopeItems.length) return;
    setDisplayRules(current => {
      const next = { ...current };
      manageableScopeItems.forEach(item => {
        if (!(item.id in next)) next[item.id] = true;
      });
      return next;
    });
  }, [contentMode, manageableScopeItems.map(item => item.id).join('|')]);

  useEffect(() => {
    if (IS_WEB_PREVIEW || addingDevice || reconfigurationSession) return undefined;
    if (!session?.device?.device_id || !session.accountToken) return undefined;
    let active = true;
    let invalidStatusCount = 0;
    const refreshDevice = async () => {
      try {
        const device = await readDisplayStatus({
          apiBase: DEFAULT_API_BASE,
          deviceId: session.device.device_id,
          accountToken: session.accountToken,
        });
        if (!active) return;
        invalidStatusCount = 0;
        const nextSession = { ...session, apiBase: DEFAULT_API_BASE, device };
        const stored = await updateDeviceSession(nextSession);
        if (!active) return;
        setSession(nextSession);
        setDeviceSessions(stored.sessions.map(normalizeDeviceSession).filter(Boolean));
        const status = deliveryStatus(device);
        if (status) setOperation(current => (
          current.state === 'uploading' || current.state === 'scanning'
            ? current
            : { ...current, ...status }
        ));
      } catch (caught) {
        if (!active) return;
        const invalidSession = caught.status === 401 || caught.code === 'DEVICE_NOT_FOUND';
        if (invalidSession) {
          invalidStatusCount += 1;
          if (invalidStatusCount >= 2) {
            const invalidDeviceId = session.device.device_id;
            const fallback = await removeDeviceSession(invalidDeviceId);
            setDeviceSessions(current => current.filter(item => item.device.device_id !== invalidDeviceId));
            if (fallback) {
              const normalized = normalizeDeviceSession(fallback);
              setSession(normalized);
              setNotice(`原设备绑定已失效，已切换到“${normalized.device.name || '另一台照片墙'}”。`);
            } else {
              await Promise.allSettled([clearPendingDeviceSetup(), clearPhotoSyncPreference()]);
              clearDeviceRuntimeState();
              setNotice('这台照片墙的绑定已经失效，请重新连接设备。');
            }
          }
          return;
        }
        invalidStatusCount = 0;
        setOperation(current => current.state === 'idle'
          ? { ...current, message: `暂时无法读取设备状态：${caught.message}` }
          : current);
      }
    };
    refreshDevice();
    const timer = setInterval(refreshDevice, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [session?.device?.device_id, session?.accountToken, addingDevice, reconfigurationSession?.device?.device_id]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refreshPermission().catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  const createPetCollagePreview = async () => {
    if (!session || publishing) return;
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    setPublishing(true); setError(''); setNotice(''); setLastAction('pet-collage');
    setGeneratedWall(null);
    setPetCollageStage('analyzing');
    setOperation({ state: 'scanning', progress: 0, message: '正在读取 iPhone 已授权的照片' });
    try {
      let recognition = await readRecognizedContent({
        apiBase: DEFAULT_API_BASE,
        accountToken: session.accountToken,
      });
      let petCandidateCount = Number(
        recognition.albums?.find(album => album.group === '宠物')?.count,
      ) || 0;
      for (let pass = 0;
        petCandidateCount < PET_COLLAGE_TEMPLATE.candidateTarget && pass < MAX_PHOTO_SYNC_PASSES;
        pass += 1) {
        setOperation({
          state: 'scanning',
          progress: 0,
          message: `已找到 ${petCandidateCount} 张宠物候选，正在继续查找同一只宠物`,
        });
        const synced = await syncPhotoAlbum({
          apiBase: DEFAULT_API_BASE,
          accountToken: session.accountToken,
          album: AUTHORIZED_PHOTO_SOURCE,
          shouldPause: () => organizingPausedRef.current,
          onProgress: update => setOperation({
            state: update.stage === 'scanning' ? 'scanning' : 'uploading',
            progress: Number(update.progress) || 0,
            message: update.stage === 'scanning'
              ? `正在查找更多宠物照片 · 第 ${pass + 1} 批`
              : `正在上传宠物候选照片 · ${Number(update.progress) || 0}%`,
          }),
        });
        if (synced.paused) {
          setOperation({ state: 'idle', progress: 0, message: '智能整理已暂停' });
          setNotice('已暂停宠物照片整理；当前已上传的照片会保留。');
          return;
        }
        recognition = await readRecognizedContent({
          apiBase: DEFAULT_API_BASE,
          accountToken: session.accountToken,
        });
        setRecognitionSnapshot({ ...recognition, accountToken: session.accountToken });
        petCandidateCount = Number(
          recognition.albums?.find(album => album.group === '宠物')?.count,
        ) || 0;
        if (synced.unchanged) break;
      }
      if (petCandidateCount < PET_COLLAGE_TEMPLATE.slots) {
        throw new Error(
          `当前已识别 ${petCandidateCount} 张宠物照片；该模板至少需要 ${PET_COLLAGE_TEMPLATE.slots} 张同一只宠物的照片`,
        );
      }
      const wall = await generatePetCollage({
        apiBase: DEFAULT_API_BASE,
        accountToken: session.accountToken,
        album: AUTHORIZED_PHOTO_SOURCE,
        onProgress: update => {
          const stage = {
            scanning: 'analyzing',
            analyzing: 'analyzing',
            awaiting_cutouts: 'cutout',
            cutout: 'cutout',
            composing: 'composing',
            ready: 'preview',
          }[update.stage];
          if (stage) setPetCollageStage(stage);
          setOperation({
            state: update.stage === 'scanning' ? 'scanning' : update.stage === 'cutout' || update.stage === 'awaiting_cutouts' ? 'uploading' : 'generating',
            progress: Number(update.progress) || 0,
            message: update.message || '正在制作宠物牛仔拼贴',
          });
        },
      });
      setGeneratedWall(wall);
      setPetCollageStage('preview');
      setActiveTab('home');
      setOperation({ state: 'idle', progress: 100, message: '宠物拼贴已生成，等待确认发布' });
      setNotice('宠物牛仔拼贴预览已生成，请确认画面后发布。');
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`宠物拼贴生成失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const selectWallTemplate = async templateId => {
    const selected = templateId === PET_COLLAGE_TEMPLATE.id
      ? PET_COLLAGE_TEMPLATE
      : wallTemplates.find(template => template.id === templateId);
    if (!selected || publishing || templateActionInFlightRef.current) return;
    templateActionInFlightRef.current = true;
    try {
      setSelectedTemplateId(selected.id);
      setGeneratedWall(null);
      setPreviewImageFailed(false);
      setPetCollageStage(null);
      setError('');
      if (selected.id === PET_COLLAGE_TEMPLATE.id) {
        setNotice(`已切换为“${selected.label}”，正在从已允许照片中生成真实效果图…`);
        await createPetCollagePreview();
        return;
      }
      if (!photoAllowed) {
        setNotice(`已切换为“${selected.label}”。开启照片权限并同步后会生成真实效果图。`);
        return;
      }
      setNotice(`已切换为“${selected.label}”，正在检查已允许照片并生成真实效果图…`);
      await syncAuthorizedPhotosForTemplate(selected.id);
    } finally {
      templateActionInFlightRef.current = false;
    }
  };

  const syncAuthorizedPhotos = async () => {
    if (organizingPausedRef.current) {
      setNotice('智能整理已暂停。请先在“范围”页恢复整理。');
      return;
    }
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    await syncAuthorizedPhotosForTemplate(selectedTemplateId, { fullSync: true, generatePreview: false });
  };

  const manageAuthorizedPhotos = async () => {
    if (permission?.accessPrivileges !== 'limited') {
      await Linking.openSettings();
      return;
    }
    setError('');
    try {
      await MediaLibrary.presentPermissionsPickerAsync([MediaLibrary.MediaType.photo]);
      await refreshPermission();
      if (organizingPausedRef.current) {
        setNotice('照片访问范围已更新；智能整理仍处于暂停状态。');
        return;
      }
      await syncAuthorizedPhotosForTemplate(selectedTemplateId, { fullSync: true, generatePreview: false });
    } catch (caught) {
      setError(`无法更新照片访问范围：${caught.message}`);
    }
  };

  const syncAuthorizedPhotosForTemplate = async (
    templateOverride = selectedTemplateId,
    { fullSync = false, generatePreview = true } = {},
  ) => {
    if (photoSyncInFlightRef.current) return;
    photoSyncInFlightRef.current = true;
    const source = AUTHORIZED_PHOTO_SOURCE;
    setPhotoSync(source);
    if (IS_WEB_PREVIEW) {
      setNotice('网页预览不会读取或上传 iPhone 照片。');
      photoSyncInFlightRef.current = false;
      return;
    }
    setPublishing(true); setError(''); setNotice(''); setLastAction('album');
    setOperation({ state: 'scanning', progress: 0, message: `正在读取“${source.title}”中的新照片` });
    try {
      const template = templateOverride === PET_COLLAGE_TEMPLATE.id
        ? PET_COLLAGE_TEMPLATE
        : wallTemplates.find(item => item.id === templateOverride);
      const requiredPhotoCount = Math.max(1, Number(template?.slots) || 1);
      let recognition = await readRecognizedContent({
        apiBase: DEFAULT_API_BASE,
        accountToken: session?.accountToken,
      });
      setRecognitionSnapshot({ ...recognition, accountToken: session?.accountToken || '' });
      let totalScanned = 0;
      let totalSynced = 0;
      let lastSync = null;
      for (let pass = 0; pass < MAX_PHOTO_SYNC_PASSES; pass += 1) {
        if (!fullSync && Number(recognition.goodTotal) >= requiredPhotoCount) break;
        lastSync = await syncPhotoAlbum({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
          album: source,
          shouldPause: () => organizingPausedRef.current,
          onProgress: update => setOperation({
            state: update.stage === 'scanning' ? 'scanning' : 'uploading',
            progress: update.progress || 0,
            message: update.stage === 'scanning'
              ? `正在检查已允许照片 · 第 ${pass + 1} 批 · 已扫描 ${update.scanned || 0} 张`
              : `正在上传第 ${pass + 1} 批新照片 · ${update.progress || 0}%`,
          }),
        });
        if (Number(lastSync.available) > 0) setAccessiblePhotoCount(Number(lastSync.available));
        totalScanned += Number(lastSync.scanned) || 0;
        totalSynced += Number(lastSync.synced) || 0;
        await savePhotoSyncPreference(source);
        setOperation({ state: 'generating', progress: 100, message: '照片已同步，正在检查可展示照片数量' });
        recognition = await readRecognizedContent({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
        });
        setRecognitionSnapshot({ ...recognition, accountToken: session?.accountToken || '' });
        if (lastSync.paused) break;
        if (lastSync.unchanged) break;
        if (!fullSync && Number(recognition.goodTotal) >= requiredPhotoCount) break;
        if (fullSync && !lastSync.hasMore) break;
        setOperation({
          state: 'scanning',
          progress: 0,
          message: fullSync
            ? `云端已整理 ${recognition.processedTotal || recognition.total || 0} 张，继续同步更多已允许照片`
            : `已保留 ${recognition.goodTotal || 0}/${requiredPhotoCount} 张，继续读取更多已允许照片`,
        });
      }
      await savePhotoSyncPreference(source);
      if (lastSync?.paused) {
        setOperation({ state: 'idle', progress: 0, message: '智能整理已暂停' });
        setNotice(`整理已暂停，本次已新增同步 ${totalSynced} 张照片；恢复后可继续。`);
        return;
      }
      if (generatePreview && Number(recognition.goodTotal) < requiredPhotoCount) {
        throw new Error(`已扫描 ${totalScanned} 张允许访问的照片，但去重和质量筛选后只有 ${recognition.goodTotal || 0} 张可展示；“${template?.label || '当前模板'}”需要 ${requiredPhotoCount} 张原相机照片`);
      }
      if (!generatePreview) {
        const refreshed = await refreshRecognizedContent({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
        });
        setRecognitionSnapshot({ ...refreshed, accountToken: session?.accountToken || '' });
        setOperation({ state: 'idle', progress: 100, message: '照片范围同步完成' });
        setNotice(lastSync?.hasMore && !lastSync?.unchanged
          ? `本次新增同步 ${totalSynced} 张照片，iPhone 中仍有照片尚未整理，可再次点击“继续同步”。`
          : totalSynced
            ? `已新增同步 ${totalSynced} 张照片，云端现有 ${refreshed.goodTotal || 0} 张可展示照片。`
            : `已检查 iPhone 允许的照片，云端现有 ${refreshed.goodTotal || 0} 张可展示照片。`);
        return;
      }
      setOperation({ state: 'generating', progress: 100, message: '照片已同步，正在生成投屏预览' });
      const wall = await generateWall({
        apiBase: DEFAULT_API_BASE,
        accountToken: session?.accountToken,
        template: templateOverride,
      });
      setGeneratedWall(wall);
      setActiveTab('home');
      setOperation({ state: 'idle', progress: 100, message: '照片同步和投屏预览已完成' });
      const recognizedCount = recognition.albums?.length || 0;
      setNotice(lastSync?.unchanged && !totalSynced
        ? `已检查 ${totalScanned} 张允许访问的照片；云端已有照片，并读取 ${recognizedCount} 个照片集合。`
        : `已同步 ${totalSynced} 张新照片，并从 ${wall.chosen?.length || 0} 张候选照片生成真实效果图。`);
      refreshRecognizedContent({
        apiBase: DEFAULT_API_BASE,
        accountToken: session?.accountToken,
      }).then(result => {
        setRecognitionSnapshot({ ...result, accountToken: session?.accountToken || '' });
      }).catch(() => {});
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`照片同步失败：${caught.message}`);
    } finally {
      photoSyncInFlightRef.current = false;
      setPublishing(false);
    }
  };

  const generateTemplatePreview = async (templateId = selectedTemplateId) => {
    if (!IS_WEB_PREVIEW && !Number(liveRecognitionSnapshot.total)) {
      await syncAuthorizedPhotosForTemplate(templateId);
      return;
    }
    setPublishing(true); setError(''); setNotice(''); setLastAction('template');
    setPetCollageStage(null);
    setOperation({ state: 'generating', progress: 40, message: '云端正在筛选照片并生成模板' });
    try {
      const filterItems = manageableScopeItems;
      const enabledFilterItems = filterItems.filter(item => displayRules[item.id] !== false);
      const excludeFilters = [...new Set(
        filterItems
          .filter(item => displayRules[item.id] === false)
          .flatMap(item => item.filters),
      )];
      const focusedItem = enabledFilterItems.length === 1 ? enabledFilterItems[0] : null;
      const wall = IS_WEB_PREVIEW
        ? await new Promise(resolve => setTimeout(() => resolve({ previewOnly: true, template: templateId, chosen: visibleScopeItems.slice(0, 6) }), 700))
        : await generateWall({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
          template: templateId,
          filters: focusedItem?.filters || [],
          excludeFilters,
        });
      setGeneratedWall(wall);
      setActiveTab('home');
      setOperation({ state: 'idle', progress: 100, message: '模板预览已生成，等待确认发布' });
      const template = wallTemplates.find(item => item.id === templateId) || selectedWallTemplate;
      setNotice(`云端已从 ${wall.chosen?.length || 0} 张候选照片中生成“${template.label}”真实效果图。`);
    } catch (caught) {
      if (caught.status === 400 && String(caught.message).includes('相册为空')) {
        setRecognitionSnapshot(EMPTY_RECOGNITION_SNAPSHOT);
        setPublishing(false);
        await syncAuthorizedPhotosForTemplate(templateId);
        return;
      }
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板生成失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const confirmGeneratedWall = async () => {
    if (!generatedWall || (!IS_WEB_PREVIEW && !session) || publishDeliveryActive || publishInFlightRef.current) return;
    if (!canPublish) {
      setError('家庭所有者尚未允许你手动投屏。你仍可以保留并查看当前预览。');
      return;
    }
    publishInFlightRef.current = true;
    const publishingPetCollage = generatedWall.template === 'denim_pet';
    setPublishing(true); setError(''); setNotice(''); setLastAction(publishingPetCollage ? 'pet-publish' : 'template-publish');
    setOperation({ state: 'queued', progress: 0, message: '正在提交发布任务' });
    try {
      if (IS_WEB_PREVIEW) {
        await new Promise(resolve => setTimeout(resolve, 650));
        setOperation({ state: 'done', progress: 100, message: '网页预览已模拟发布完成' });
        setNotice('网页预览已模拟发布；没有上传任何照片。');
        return;
      }
      const result = await publishGeneratedWall({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
        wallId: generatedWall.wall_id,
      });
      const nextSession = {
        ...session,
        device: { ...session.device, ...(result.device || {}) },
        apiBase: DEFAULT_API_BASE,
      };
      setSession(nextSession);
      const stored = await updateDeviceSession(nextSession);
      setDeviceSessions(stored.sessions.map(normalizeDeviceSession).filter(Boolean));
      const screen19 = isScreen19Device(nextSession.device);
      if (screen19) {
        if (publishingPetCollage) setPetCollageStage('published');
        setOperation({ state: 'done', progress: 100, message: '模板已发送到 19 寸实时展示屏' });
        setNotice('模板已发送到 19 寸屏。');
        return;
      }

      setOperation(deliveryStatus(nextSession.device) || {
        state: 'queued',
        progress: 0,
        message: '模板已确认发布，等待墨水屏下载',
      });
      setNotice('发布已开始，请等待照片墙完成刷新。');
      const displayedDevice = await waitForDisplayRevision({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
        revision: result.revision,
        onProgress: (device, connection) => {
          if (device) {
            setSession(current => current?.device?.device_id === device.device_id
              ? { ...current, device: { ...current.device, ...device } }
              : current);
          }
          const status = deliveryStatus(device);
          if (connection?.reconnecting) {
            setOperation(current => ({ ...current, message: '照片墙仍在刷新，正在重新连接状态服务' }));
          } else if (status) {
            setOperation(status);
          }
        },
      });
      const completedSession = {
        ...nextSession,
        device: { ...nextSession.device, ...displayedDevice },
      };
      setSession(completedSession);
      const completedStored = await updateDeviceSession(completedSession);
      setDeviceSessions(completedStored.sessions.map(normalizeDeviceSession).filter(Boolean));
      if (publishingPetCollage) setPetCollageStage('published');
      setOperation({ state: 'done', progress: 100, message: '照片墙已完成刷新' });
      setNotice('照片墙已显示这张画面。');
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板发布失败：${caught.message}`);
    } finally {
      publishInFlightRef.current = false;
      setPublishing(false);
    }
  };

  const retry = () => {
    if (lastAction === 'pet-collage') createPetCollagePreview();
    else if (lastAction === 'pet-publish') confirmGeneratedWall();
    else if (lastAction === 'template-publish') confirmGeneratedWall();
    else if (lastAction === 'template') generateTemplatePreview();
  };

  const testLocalControl = async () => {
    const provisionUrl = effectiveSession?.localUrl || localUrlForDevice(effectiveSession?.device?.device_id);
    if (!provisionUrl) {
      setError('没有找到照片墙的局域网地址，请确认手机和照片墙连接同一个 Wi-Fi。');
      return;
    }
    setPublishing(true);
    setError('');
    setNotice('');
    setOperation({ state: 'displaying', progress: 5, message: '正在通过局域网联系照片墙' });
    try {
      await sendLocalControl({ provisionUrl });
      setOperation({ state: 'done', progress: 100, message: '局域网控制测试完成' });
      setNotice('照片墙已收到测试刷新指令。');
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`局域网控制失败：${caught.message}`);
    } finally {
      setPublishing(false);
    }
  };

  const onConnected = async next => {
    const wasReconfiguring = Boolean(reconfigurationSession?.device?.device_id);
    if (IS_WEB_PREVIEW) {
      setWebConnected(true);
      setReconfigurationSession(null);
      setAddingDevice(false);
      setDeviceModal(false);
      setDeviceManagerVisible(false);
      setActiveTab(wasReconfiguring ? 'settings' : 'home');
      return;
    }
    const wasAdding = addingDevice;
    let normalized = normalizeDeviceSession(next);
    if (normalized.accountToken) {
      try {
        const nextAccountSession = await prepareAccountSession();
        normalized = await upgradeDeviceToFamily(normalized, nextAccountSession);
      } catch {
        // 家庭服务不可用不应阻断首次配网；稍后可从“家庭与成员”再次升级。
      }
    }
    const stored = wasReconfiguring
      ? await updateDeviceSession(normalized)
      : await saveDeviceSession(normalized);
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    const activeSession = sessions.find(item => item.device.device_id === stored.activeDeviceId) || normalized;
    setSession(activeSession);
    setDeviceSessions(sessions);
    await clearPendingDeviceSetup();
    setReconfigurationSession(null);
    setAddingDevice(false);
    setDeviceModal(false);
    setDeviceManagerVisible(false);
    setActiveTab(wasReconfiguring ? 'settings' : 'home');
    if (wasAdding) setNotice(`已添加“${normalized.device.name || '照片墙'}”，共 ${sessions.length} 台设备。`);
    if (wasReconfiguring) setNotice(`“${normalized.device.name || '照片墙'}”已连接新网络，设备列表保持 ${sessions.length} 台。`);
  };

  const storeTestDeviceSnapshot = async device => {
    const nextSession = normalizeDeviceSession({
      ...session,
      device: { ...(session?.device || {}), ...device },
    });
    if (!nextSession) throw new Error('模拟照片墙会话不存在，请重新连接');
    const stored = await updateDeviceSession(nextSession);
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    const activeSession = sessions.find(item => item.device.device_id === stored.activeDeviceId) || nextSession;
    setSession(activeSession);
    setDeviceSessions(sessions);
    setOperation(deliveryStatus(activeSession.device) || EMPTY_OPERATION);
    return activeSession;
  };

  const connectTestDevice = async () => {
    if (!TEST_DEVICE_KEY) {
      setError('模拟设备密钥未配置，请按测试文档设置 EXPO_PUBLIC_TEST_DEVICE_KEY。');
      return;
    }
    setTestDeviceBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await createTestDisplay({
        apiBase: DEFAULT_API_BASE,
        testKey: TEST_DEVICE_KEY,
        name: 'iOS 模拟照片墙',
      });
      await onConnected({
        device: result.device,
        accountToken: result.account_token,
        apiBase: DEFAULT_API_BASE,
        localUrl: null,
      });
      setOperation(deliveryStatus(result.device) || EMPTY_OPERATION);
      setNotice('模拟照片墙已连接。现在可以验证家庭成员、相册权限和发布状态。');
      setActiveTab('settings');
    } catch (caught) {
      setError(`无法连接模拟照片墙：${caught.message}`);
    } finally {
      setTestDeviceBusy(false);
    }
  };

  const advanceCurrentTestDevice = async () => {
    if (!session?.device?.test_device) return;
    setTestDeviceBusy(true);
    setError('');
    try {
      const result = await advanceTestDisplay({
        apiBase: DEFAULT_API_BASE,
        testKey: TEST_DEVICE_KEY,
        deviceId: session.device.device_id,
      });
      const nextSession = await storeTestDeviceSnapshot(result.device);
      setNotice(`模拟状态已更新：${deliveryStatus(nextSession.device)?.message || result.device.state}`);
    } catch (caught) {
      setError(`无法推进模拟状态：${caught.message}`);
    } finally {
      setTestDeviceBusy(false);
    }
  };

  const failCurrentTestDevice = async () => {
    if (!session?.device?.test_device) return;
    setTestDeviceBusy(true);
    setError('');
    try {
      const result = await setTestDisplayState({
        apiBase: DEFAULT_API_BASE,
        testKey: TEST_DEVICE_KEY,
        deviceId: session.device.device_id,
        state: 'failed',
        progress: 36,
        error: '模拟网络中断：用于验证失败提示和重试入口',
      });
      await storeTestDeviceSnapshot(result.device);
      setNotice('已模拟一次刷新失败；点击“重试并推进”可以恢复。');
    } catch (caught) {
      setError(`无法模拟失败状态：${caught.message}`);
    } finally {
      setTestDeviceBusy(false);
    }
  };

  const resetCurrentTestDevice = async () => {
    if (!session?.device?.test_device) return;
    setTestDeviceBusy(true);
    setError('');
    try {
      const result = await setTestDisplayState({
        apiBase: DEFAULT_API_BASE,
        testKey: TEST_DEVICE_KEY,
        deviceId: session.device.device_id,
        state: 'online',
        progress: 0,
      });
      await storeTestDeviceSnapshot(result.device);
      setNotice('模拟照片墙已恢复为在线空闲状态。');
    } catch (caught) {
      setError(`无法重置模拟照片墙：${caught.message}`);
    } finally {
      setTestDeviceBusy(false);
    }
  };

  const removeCurrentTestDevice = async () => {
    if (!session?.device?.test_device) return;
    const deviceId = session.device.device_id;
    setTestDeviceBusy(true);
    setError('');
    try {
      await deleteTestDisplay({
        apiBase: DEFAULT_API_BASE,
        testKey: TEST_DEVICE_KEY,
        deviceId,
      });
      await removeDeviceSession(deviceId);
      const stored = await loadDeviceSessions();
      const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
      const activeSession = sessions.find(item => item.device.device_id === stored.activeDeviceId) || null;
      setDeviceSessions(sessions);
      if (activeSession) {
        setSession(activeSession);
        setOperation(deliveryStatus(activeSession.device) || EMPTY_OPERATION);
      } else {
        clearDeviceRuntimeState();
      }
      setNotice('模拟照片墙及其本机会话已清除。');
      setActiveTab('settings');
    } catch (caught) {
      setError(`无法删除模拟照片墙：${caught.message}`);
    } finally {
      setTestDeviceBusy(false);
    }
  };

  const connectDevice = () => {
    if (IS_WEB_PREVIEW) {
      setAddingDevice(true);
      setDeviceModal(true);
      return;
    }
    setDeviceManagerVisible(false);
    setAddDisplayVisible(true);
  };

  const removeManagedDevice = async targetSession => {
    let cleanupWarning = '';
    const removedDeviceId = targetSession?.device?.device_id;
    const sourceSessions = IS_WEB_PREVIEW ? managedDeviceSessions : deviceSessions;
    const remaining = sourceSessions.filter(item => item.device.device_id !== removedDeviceId);
    const removingCurrent = removedDeviceId === effectiveSession?.device?.device_id;
    let fallback = null;
    if (IS_WEB_PREVIEW) {
      setWebConnected(false);
      setWebPhotoAuthorized(false);
    } else if (removedDeviceId && targetSession.accountToken) {
      if (!isScreen19Device(targetSession.device)) {
        try {
          await removeDisplay({
            apiBase: DEFAULT_API_BASE,
            deviceId: removedDeviceId,
            accountToken: targetSession.accountToken,
          });
        } catch (caught) {
          // A second client may already have removed the display. The local App
          // should still discard that unusable binding and allow a clean setup.
          if (caught.status !== 401 && caught.status !== 404) throw caught;
        }
      }
      const cleanup = await Promise.allSettled([
        removeDeviceSession(removedDeviceId).then(next => { fallback = next; }),
        clearPendingDeviceSetup(),
        ...(!remaining.length ? [clearPhotoSyncPreference()] : []),
      ]);
      if (cleanup.some(result => result.status === 'rejected')) {
        cleanupWarning = '设备已删除；本机安全存储清理未完全完成，如重启后仍显示旧设备，请再次删除。';
      }
    }
    setDeviceSessions(remaining);
    if (removingCurrent && remaining.length) {
      const next = normalizeDeviceSession(fallback || remaining[0]);
      setSession(next);
      setGeneratedWall(null);
      setRecognitionSnapshot(EMPTY_RECOGNITION_SNAPSHOT);
      setSelectionModel(null);
      setOperation(deliveryStatus(next.device) || EMPTY_OPERATION);
      setNotice(cleanupWarning || `设备已删除，已切换到“${next.device.name || '另一台照片墙'}”。`);
    } else if (removingCurrent) {
      clearDeviceRuntimeState();
      setNotice(cleanupWarning || (isScreen19Device(targetSession.device)
        ? '19 寸屏已从 App 设备列表移除，屏幕原连接设置保持不变。'
        : '设备已删除。屏幕会清除原网络并重新进入连接模式。'));
    } else {
      setNotice(cleanupWarning || `已删除“${targetSession.device.name || '照片墙'}”。`);
    }
  };

  const addDevice = () => {
    setDeviceManagerVisible(false);
    setAddDisplayVisible(true);
  };

  const addEsp32Device = () => {
    setAddDisplayVisible(false);
    setAddingDevice(true);
    setDeviceModal(true);
  };

  const addScreen19Device = async () => {
    let nextAccountSession = accountSession;
    try {
      nextAccountSession = await prepareAccountSession();
    } catch {}
    const tokens = [...new Set([
      nextAccountSession?.accessToken,
      session?.accountToken,
      ...deviceSessions.map(item => item.accountToken),
    ].filter(Boolean))];
    const discovered = [];
    for (const accountToken of tokens) {
      try {
        const result = await listDisplays({ apiBase: DEFAULT_API_BASE, accountToken });
        for (const device of result.devices || []) {
          if (isScreen19Device(device) && !discovered.some(item => item.device.device_id === device.device_id)) {
            discovered.push({ device, accountToken });
          }
        }
      } catch {}
    }
    if (!discovered.length) {
      throw new Error('没有找到已连接的 19 寸屏。请先按原来的屏幕连接流程完成连接，再回来同步。');
    }
    let stored = await loadDeviceSessions();
    for (const found of discovered) {
      const existing = stored.sessions.find(item => item.device?.device_id === found.device.device_id);
      stored = await updateDeviceSession(normalizeDeviceSession({
        ...existing,
        accountToken: found.accountToken,
        device: { ...(existing?.device || {}), ...found.device },
      }));
    }
    const target = discovered.find(found => !deviceSessions.some(item => item.device.device_id === found.device.device_id)) || discovered[0];
    const selected = await selectDeviceSession(target.device.device_id);
    const sessions = stored.sessions.map(normalizeDeviceSession).filter(Boolean);
    const activeSession = normalizeDeviceSession(selected);
    setSession(activeSession);
    setDeviceSessions(sessions);
    setOperation(deliveryStatus(activeSession.device) || EMPTY_OPERATION);
    setAddDisplayVisible(false);
    setDeviceManagerVisible(true);
    setActiveTab('settings');
    setNotice(`已同步“${activeSession.device.name || '19 寸实时展示屏'}”，共 ${sessions.length} 台设备。`);
  };

  const closeDeviceSetup = async () => {
    const wasReconfiguring = Boolean(reconfigurationSession?.device?.device_id);
    setDeviceModal(false);
    setAddingDevice(false);
    if (!wasReconfiguring) return;
    setReconfigurationSession(null);
    setDeviceManagerVisible(true);
    try {
      await clearPendingDeviceSetup();
    } catch (caught) {
      setError(`无法清理重新配网状态：${caught.message}`);
    }
  };

  const reconfigureManagedDevice = async targetSession => {
    if (!targetSession?.device?.device_id || !targetSession.accountToken) {
      throw new Error('这台设备缺少管理员权限，请删除后重新添加');
    }
    if (isScreen19Device(targetSession.device)) {
      throw new Error('19 寸屏无需重新配网');
    }
    if (!IS_WEB_PREVIEW) {
      await reprovisionDisplay({
        apiBase: DEFAULT_API_BASE,
        deviceId: targetSession.device.device_id,
        accountToken: targetSession.accountToken,
      });
      await savePendingDeviceSetup({ kind: 'reconfigure', session: targetSession });
    }
    setReconfigurationSession(targetSession);
    setAddingDevice(false);
    setDeviceManagerVisible(false);
    setDeviceModal(true);
    setNotice('已通知照片墙进入配网模式，请保持通电并选择新的 Wi-Fi。');
  };

  const switchDevice = async next => {
    if (!next?.device?.device_id || next.device.device_id === session?.device?.device_id) return;
    const normalized = normalizeDeviceSession(await selectDeviceSession(next.device.device_id));
    setSession(normalized);
    setGeneratedWall(null);
    setRecognitionSnapshot(EMPTY_RECOGNITION_SNAPSHOT);
    setSelectionModel(null);
    setOperation(deliveryStatus(normalized.device) || EMPTY_OPERATION);
    setNotice(`已切换到“${normalized.device.name || '照片墙'}”。`);
  };

  const manageDevice = () => {
    if (!connected) connectDevice();
    else setDeviceManagerVisible(true);
  };

  const toggleOrganizingPaused = () => {
    if (contentMode !== 'live') return;
    const next = !organizingPausedRef.current;
    organizingPausedRef.current = next;
    setOrganizingPaused(next);
    saveOrganizingPaused(next).catch(() => {});
    setError('');
    setNotice(next
      ? publishing
        ? '已请求暂停；当前正在上传的单张照片完成后停止。'
        : '智能整理已暂停，不会继续读取或上传新照片。'
      : '智能整理已恢复；需要时点击“继续同步剩余照片”。');
  };

  const toggleDisplayRule = (id, value) => {
    if (contentMode !== 'live') return;
    if (!value && enabledCollectionCount <= 1 && displayRules[id] !== false) {
      setError('至少保留一个可上墙集合，避免自动更新时没有可展示内容。');
      return;
    }
    setError('');
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDisplayRules(current => ({ ...current, [id]: value }));
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

  const screenTitle = TABS.find(tab => tab.id === activeTab)?.label || '投屏';
  const connectionLabel = deviceModal ? '连接中' : connected ? '已连接' : '未连接';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>{screenTitle}</Text>
          <Text style={styles.topBarSubtitle}>
            {activeTab === 'home' ? '预览与更新照片墙' : activeTab === 'selection' ? '管理照片可以出现的范围' : '自动更新、照片访问与设备管理'}
          </Text>
        </View>
        <MotionPressable onPress={manageDevice} contentStyle={styles.connectionStatus} scaleTo={0.94}>
          <View style={[styles.onlineDot, !connected && styles.offlineDot]} />
          <Text style={styles.connectionStatusText}>{connectionLabel}</Text>
        </MotionPressable>
      </View>

      <WebPreviewBar
        connected={connected}
        onToggleConnection={manageDevice}
      />

      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <Animated.View style={{
          opacity: screenMotion,
          transform: [
            { translateY: screenMotion.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
            { scale: screenMotion.interpolate({ inputRange: [0, 1], outputRange: [0.992, 1] }) },
          ],
        }}>
        {activeTab === 'home' ? (
          <>
            <SectionHeading
              eyebrow={connected ? effectiveSession.device.name || '客厅照片墙' : '示例预览'}
              title="投屏预览"
              description={connected ? '查看照片墙下一次会显示的内容。' : '先体验完整效果，连接后会替换为你的真实照片。'}
            />
            <View style={styles.roomPreview}>
              <View style={styles.hangingLine} />
              <View style={[styles.frameShadow, isPortraitPreview && styles.frameShadowPortrait]}>
                <View style={styles.frameOuter}>
                  <View style={styles.frameMat}>
                    {generatedImageUrl && !previewImageFailed ? (
                      <Image
                        source={{ uri: generatedImageUrl }}
                        style={isPortraitPreview ? styles.framePhotoPortrait : styles.framePhoto}
                        onError={() => setPreviewImageFailed(true)}
                      />
                    ) : contentMode === 'demo' ? (
                      <View style={styles.curatedArtwork}>
                        <Text style={styles.artSampleBadge}>示例</Text>
                        <Text style={styles.curatedEyebrow}>PHOTO WALL</Text>
                        <Text style={styles.curatedTitle}>今日精选</Text>
                        <View style={styles.curatedGrid}>
                          <View style={[styles.curatedTile, styles.curatedTileBlue]}><Text style={styles.curatedTileText}>家人</Text></View>
                          <View style={[styles.curatedTile, styles.curatedTileGreen]}><Text style={styles.curatedTileText}>旅行</Text></View>
                          <View style={[styles.curatedTile, styles.curatedTileOrange]}><Text style={styles.curatedTileText}>生活</Text></View>
                        </View>
                      </View>
                    ) : generatedWall?.previewOnly ? (
                      <View style={styles.framePlaceholder}>
                        <Text style={styles.framePlaceholderIcon}>◌</Text>
                        <Text style={styles.framePlaceholderText}>网页只验证界面，真机生成后显示真实效果图</Text>
                      </View>
                    ) : (
                      <View style={styles.framePlaceholder}>
                        <Text style={styles.framePlaceholderIcon}>{contentMode === 'permission' ? '◎' : '◌'}</Text>
                        <Text style={styles.framePlaceholderText}>{publishing
                          ? operation.message || '正在生成真实效果图'
                          : operation.state === 'failed'
                            ? `生成失败\n${operation.message || '请稍后重试'}`
                          : previewImageFailed
                          ? '真实效果图加载失败，请重新生成'
                          : contentMode === 'permission'
                            ? '开启相册后生成真实预览'
                            : `已选择“${selectedWallTemplate.label}”\n等待生成真实效果图`}</Text>
                      </View>
                    )}
                    {generatedImageUrl && !previewImageFailed ? (
                      <View style={styles.realPreviewBadge}>
                        <Text style={styles.realPreviewBadgeText}>云端真实效果图</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
              <View style={styles.shelf} />
              <View style={styles.vase} />
              <View style={styles.plantStem} />
              <View style={[styles.plantLeaf, styles.plantLeafLeft]} />
              <View style={[styles.plantLeaf, styles.plantLeafRight]} />
            </View>
            <View style={styles.displaySummaryCard}>
              <View style={styles.flex}>
                <Text style={styles.settingLabel}>{contentMode === 'demo' ? '等待真实照片' : '当前展示范围'}</Text>
                <Text style={styles.settingValue}>{enabledCollectionCount} 个照片集合参与展示</Text>
                <Text style={styles.settingHint}>{nextUpdateLabel} · 在“范围”页调整人物、宠物和相册集合。</Text>
              </View>
              <MotionPressable onPress={() => setActiveTab('selection')} contentStyle={styles.summaryEditButton} scaleTo={0.93}>
                <Text style={styles.summaryEditText}>查看</Text>
              </MotionPressable>
            </View>

            {!connected ? (
              <ContextCard
                title="当前展示的是示例"
                description="连接照片墙后，保持相同界面并替换为真实设备和相册内容。"
                actionLabel="连接照片墙"
                onAction={connectDevice}
              />
            ) : !photoAllowed ? (
              <ContextCard
                title="设备已连接，下一步开启相册"
                description="iPhone 会显示系统授权窗口。PhotoWall 只同步系统允许访问的照片，并从中整理真实照片集合。"
                actionLabel="允许访问照片"
                onAction={requestPhotoPermission}
              />
            ) : (
              <>
                <View style={styles.settingCard}>
                  <TemplatePicker
                    templates={wallTemplates}
                    value={selectedTemplateId}
                    onChange={selectWallTemplate}
                    disabled={publishing}
                    loading={templatesLoading}
                  />
                  <Text style={styles.settingHint}>{templatesError
                    ? `暂时无法刷新云端模板，正在使用内置清单：${templatesError}`
                    : '点击模板会立即生成并替换上方真实效果图；确认画面后再发布。'}</Text>
                </View>
                {!recognizedPhotoCount ? (
                  <ContextCard
                    title="还没有同步照片"
                    description="同步 iPhone 已允许访问的照片后，模板会立即生成真实效果图。"
                    actionLabel="同步已允许照片"
                    onAction={syncAuthorizedPhotos}
                  />
                ) : null}
                {!canPublish ? (
                  <ContextCard
                    title="可查看预览，暂不能手动投屏"
                    description="家庭所有者开启你的投屏权限后，这里的发布按钮会自动可用。"
                  />
                ) : null}
                {generatedWall ? (
                  <>
                    <ActionButton disabled={publishDeliveryActive || !canPublish} onPress={confirmGeneratedWall}>
                      {!canPublish
                        ? '等待所有者开启投屏权限'
                        : publishDeliveryActive
                          ? operation.state === 'displaying'
                            ? '照片墙正在刷新…'
                            : operation.state === 'downloading'
                              ? '正在发送到照片墙…'
                              : '等待照片墙接收…'
                          : '发布到照片墙'}
                    </ActionButton>
                    {(['pet-publish', 'template-publish'].includes(lastAction)
                      && ['queued', 'downloading', 'displaying', 'done', 'failed'].includes(operation.state))
                      ? operationCard
                      : null}
                  </>
                ) : (
                  <ActionButton
                    disabled={publishing || !photoAllowed || (selectedTemplateId === PET_COLLAGE_TEMPLATE.id && IS_WEB_PREVIEW)}
                    onPress={selectedTemplateId === PET_COLLAGE_TEMPLATE.id ? createPetCollagePreview : () => generateTemplatePreview()}
                  >
                    {publishing
                      ? '正在生成…'
                      : recognizedPhotoCount || selectedTemplateId === PET_COLLAGE_TEMPLATE.id
                        ? `生成${selectedWallTemplate.label}效果图`
                        : '同步照片并生成效果图'}
                  </ActionButton>
                )}
              </>
            )}
          </>
        ) : null}

        {activeTab === 'selection' ? (
          <>
            <SectionHeading
              title="展示范围"
              description="决定哪些人物、宠物、地点和相册集合可以出现在照片墙；不会删除或修改 iPhone 中的照片。"
            />
            {contentMode === 'demo' ? (
              <ContextCard
                title={IS_WEB_PREVIEW ? '交互示例' : '连接后查看真实范围'}
                description={IS_WEB_PREVIEW
                  ? '这里演示范围管理的结构；iPhone 真机会替换为真实照片数量与集合。'
                  : '连接照片墙并允许照片访问后，这里会自动出现真实识别结果。'}
                actionLabel="连接照片墙"
                onAction={connectDevice}
              />
            ) : contentMode === 'permission' ? (
              <ContextCard
                title="开启照片权限"
                description="你在 iOS 中允许的照片构成上传范围；之后可以在本页控制哪些照片集合能够上墙。"
                actionLabel="允许访问照片"
                onAction={requestPhotoPermission}
              />
            ) : (
              <ContextCard
                tone="green"
                title={scopeSyncIncomplete
                  ? '还有照片尚未整理'
                  : liveRecognitionSnapshot.total ? '真实展示范围已就绪' : '等待照片同步'}
                description={scopeSyncIncomplete
                  ? `iPhone 已允许 ${scopeSourceCount} 张，云端目前整理了 ${scopeProcessedCount} 张。分批同步可避免长时间卡住。`
                  : liveRecognitionSnapshot.total
                    ? '范围调整会在下一次生成预览或自动更新时生效。'
                    : '照片权限已开启，但当前账户还没有同步照片。'}
                actionLabel={scopeSyncIncomplete ? '继续同步剩余照片' : !liveRecognitionSnapshot.total ? '开始同步' : undefined}
                onAction={scopeSyncIncomplete || !liveRecognitionSnapshot.total ? syncAuthorizedPhotos : undefined}
              />
            )}
            <ScopeOverview
              sourceCount={scopeSourceCount}
              processedCount={scopeProcessedCount}
              qualityCount={scopeQualityCount}
              totalCollections={visibleScopeItems.length}
              enabledCollections={enabledCollectionCount}
              sample={selectionIsSample}
            />
            <View style={[styles.organizingControl, organizingPaused && styles.organizingControlPaused]}>
              <View style={styles.flex}>
                <Text style={styles.organizingControlLabel}>智能整理</Text>
                <Text style={styles.organizingControlTitle}>{organizingPaused ? '已暂停' : '正在使用'}</Text>
                <Text style={styles.organizingControlDescription}>{contentMode !== 'live'
                  ? '连接设备并开启照片权限后可以暂停或恢复整理。'
                  : organizingPaused
                    ? '不会继续读取或上传新照片，已经整理好的内容仍可预览和上墙。'
                    : publishing
                      ? '正在处理照片；暂停会在当前单张上传完成后生效。'
                      : '只有点击同步时才整理新照片，不影响已经生成的集合。'}</Text>
              </View>
              <MotionPressable
                disabled={contentMode !== 'live'}
                onPress={toggleOrganizingPaused}
                contentStyle={[styles.organizingControlButton, contentMode !== 'live' && styles.choiceChipDisabled]}
                scaleTo={0.94}
              >
                <Text style={styles.organizingControlButtonText}>{organizingPaused ? '继续整理' : '暂停整理'}</Text>
              </MotionPressable>
            </View>
            <View style={styles.scopeLogicNote}>
              <Text style={styles.scopeLogicTitle}>智能整理方式</Text>
              <Text style={styles.scopeLogicText}>Echooo 会将已允许照片整理成精选、人物、宠物、地点和高价值相册。宽泛内容、色彩与氛围只用于后台排序和画面搭配，不再作为范围选项。</Text>
            </View>
            {visibleScopeItems.length ? (
              <>
                {primaryScopeItems.length ? (
                  <ThemeScopeGrid
                    items={primaryScopeItems}
                    rules={displayRules}
                    onToggle={toggleDisplayRule}
                    disabled={selectionIsSample}
                    sample={selectionIsSample}
                  />
                ) : null}
                <Text style={styles.scopeFootnote}>卡片轮播的是集合中的真实照片；开关只控制集合是否参与自动上墙，不会在这里生成或发布画面。</Text>
              </>
            ) : (
              <View style={styles.permissionGate}>
                <View style={styles.permissionGateIcon}><Text style={styles.permissionGateIconText}>◌</Text></View>
                <Text style={styles.heroTitle}>{recognitionLoading ? '正在整理照片' : '还没有可管理的照片集合'}</Text>
                <Text style={styles.cardDescription}>{recognitionLoading
                  ? '正在整理精选、人物、宠物、地点和相册集合。'
                  : connected && photoAllowed
                    ? '同步真实照片后，符合数量门槛的集合会自动出现。'
                    : '连接设备并允许照片访问后，真实集合会自动出现。'}</Text>
                {connected && photoAllowed && !recognitionLoading ? (
                  <ActionButton secondary onPress={syncAuthorizedPhotos}>同步已允许照片</ActionButton>
                ) : null}
              </View>
            )}
          </>
        ) : null}

        {activeTab === 'settings' ? (
          <>
            <SectionHeading title="自动更新" description="App 不打开时，也按这里的规则由云端生成并投屏。" />
            <View style={styles.settingCard}>
              <ChoiceRow label="更新频次" options={['每天', '每周', '关闭']} value={updateFrequency} onChange={setUpdateFrequency} disabled={!connected} />
              <ChoiceRow label="更新时间" options={['08:00', '12:00', '20:00']} value={updateTime} onChange={setUpdateTime} disabled={!connected || updateFrequency === '关闭'} />
              <ChoiceRow label="展示方案" options={['每日精选', '人物优先', '旅行回忆']} value={displayPlan} onChange={setDisplayPlan} disabled={!connected} />
              <Text style={styles.settingHint}>{connected ? `${nextUpdateLabel} · ${displayPlan}` : '连接设备后可以保存自动更新计划。'}</Text>
            </View>

            <SectionHeading title="iPhone 照片访问" description="唯一照片来源由 iOS 系统权限决定；PhotoWall 不再额外选择第二个相簿。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>照片权限</Text>
              <Text style={styles.settingValue}>{permissionDescription}</Text>
              <Text style={styles.settingHint}>Echooo 会同步全部“已允许照片”，且只上传云端尚未处理的新增照片。“范围”页中的人物与集合均从这些真实照片中整理。</Text>
              <ActionButton
                secondary
                onPress={!connected ? connectDevice : photoAllowed ? syncAuthorizedPhotos : requestPhotoPermission}
              >
                {!connected
                  ? '先连接照片墙'
                  : photoAllowed
                    ? scopeSyncIncomplete ? '继续同步剩余照片' : '检查新增照片'
                    : '允许访问照片'}
              </ActionButton>
              {connected && photoAllowed && !IS_WEB_PREVIEW ? (
                <MotionPressable onPress={manageAuthorizedPhotos} contentStyle={styles.settingsLink}>
                  <Text style={styles.settingsLinkText}>{permission?.accessPrivileges === 'limited'
                    ? '调整 iPhone 允许访问的照片'
                    : '管理 iPhone 系统权限'}</Text>
                </MotionPressable>
              ) : null}
            </View>

            <SectionHeading title="家庭与成员" description="同一台照片墙可以由多位家庭成员使用，每个人独立管理自己的相册。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>我的账户</Text>
              <Text style={styles.settingValue}>{accountSession?.account?.name || (IS_WEB_PREVIEW ? '网页预览账户' : '正在建立本机账户…')}</Text>
              <Text style={styles.settingHint}>{connected
                ? `${canManageDevice ? '家庭所有者' : '家庭成员'} · 邀请家人后无需再次蓝牙配网`
                : '可以输入家庭邀请码直接加入已有照片墙。'}</Text>
              <ActionButton secondary onPress={() => setHouseholdMembersVisible(true)}>
                管理家庭成员
              </ActionButton>
            </View>

            <SectionHeading title="设备管理" description="可以在设备间切换；只有家庭所有者能重新配网或删除设备。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>已添加设备</Text>
              <Text style={styles.settingValue}>{connected ? `${managedDeviceSessions.length} 台照片墙` : '尚未绑定'}</Text>
              <Text style={styles.settingHint}>{connected ? `当前：${effectiveSession.device.name || '照片墙'} · ${effectiveSession.device.device_id}` : '通过蓝牙发现并完成首次配对。'}</Text>
              <Text style={styles.settingHint}>{connected ? `${canManageDevice ? '所有者权限已验证' : '当前为家庭成员'} · 云端精选模型：${selectionModelDescription}` : null}</Text>
              <ActionButton secondary onPress={connected ? manageDevice : connectDevice}>
                {IS_WEB_PREVIEW ? (connected ? '管理设备' : '进入连接流程') : (connected ? '管理设备' : '连接设备')}
              </ActionButton>
              {connected && !IS_WEB_PREVIEW && !isTestDevice && isEinkDevice(effectiveSession.device) ? (
                <ActionButton secondary disabled={publishing} onPress={testLocalControl}>
                  {publishing ? '正在测试连接…' : '测试局域网连接'}
                </ActionButton>
              ) : null}
            </View>
            {TEST_DEVICE_ENABLED && !IS_WEB_PREVIEW ? (
              <>
                <SectionHeading title="软件测试照片墙" description="主板不可用时，复用正式账户和状态模型完成 iOS 模拟器冒烟测试。" />
                <View style={styles.settingCard}>
                  <Text style={styles.settingLabel}>仅限本地测试环境</Text>
                  <Text style={styles.settingValue}>{isTestDevice ? '模拟照片墙已连接' : '可以新建一台模拟照片墙'}</Text>
                  <Text style={styles.settingHint}>{isTestDevice
                    ? `当前状态：${deliveryStatus(effectiveSession.device)?.message || effectiveSession.device.state}`
                    : '测试入口默认不参与正式构建，也不能控制真实硬件。'}</Text>
                  {!isTestDevice ? (
                    <ActionButton disabled={testDeviceBusy} onPress={connectTestDevice}>
                      {testDeviceBusy ? '正在创建…' : '连接模拟照片墙'}
                    </ActionButton>
                  ) : (
                    <>
                      <ActionButton disabled={testDeviceBusy} onPress={advanceCurrentTestDevice}>
                        {testDeviceBusy ? '正在更新…' : effectiveSession.device.state === 'failed' ? '重试并推进' : '推进到下一状态'}
                      </ActionButton>
                      <ActionButton secondary disabled={testDeviceBusy} onPress={failCurrentTestDevice}>
                        模拟刷新失败
                      </ActionButton>
                      <ActionButton secondary disabled={testDeviceBusy} onPress={resetCurrentTestDevice}>
                        恢复在线空闲
                      </ActionButton>
                      <MotionPressable disabled={testDeviceBusy} onPress={removeCurrentTestDevice} contentStyle={styles.settingsLink}>
                        <Text style={styles.settingsLinkText}>清除模拟照片墙</Text>
                      </MotionPressable>
                    </>
                  )}
                </View>
              </>
            ) : null}
            <SectionHeading title="发布记录" description="查看最近一次上传和屏幕刷新状态。" />
            {operationCard}
          </>
        ) : null}

        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>✓ {notice}</Text></View> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        {!IS_WEB_PREVIEW ? <Text style={styles.footer}>仅同步 iOS 系统已允许访问的照片；“范围”页只控制哪些照片集合可以上墙。</Text> : null}
        </Animated.View>
      </ScrollView>

      <BottomNavigation activeTab={activeTab} onChange={setActiveTab} />
      <DeviceManagerModal
        visible={deviceManagerVisible}
        sessions={managedDeviceSessions}
        activeDeviceId={effectiveSession?.device?.device_id || null}
        onClose={() => setDeviceManagerVisible(false)}
        onSelect={switchDevice}
        onReconfigure={reconfigureManagedDevice}
        onAdd={addDevice}
        onRemove={removeManagedDevice}
      />
      <AddDisplayModal
        visible={addDisplayVisible}
        onClose={() => {
          setAddDisplayVisible(false);
          if (deviceSessions.length) setDeviceManagerVisible(true);
        }}
        onAddEsp32={addEsp32Device}
        onAddScreen19={addScreen19Device}
      />
      <HouseholdMembersModal
        visible={householdMembersVisible}
        accountSession={accountSession}
        deviceSession={IS_WEB_PREVIEW ? null : session}
        onClose={() => setHouseholdMembersVisible(false)}
        onAccountSessionChange={setAccountSession}
        onDeviceSessionChange={handleFamilyDeviceUpgrade}
        onHouseholdJoined={handleHouseholdJoined}
        onHouseholdLeft={handleHouseholdLeft}
        previewMode={IS_WEB_PREVIEW}
      />
      {deviceModal && (addingDevice || reconfigurationSession) ? (
        <DeviceSetupFlow
          visible={deviceModal}
          session={null}
          existingSession={reconfigurationSession}
          previewMode={IS_WEB_PREVIEW}
          adapter={IS_WEB_PREVIEW ? null : REAL_DEVICE_SETUP_ADAPTER}
          onClose={closeDeviceSetup}
          onConnected={onConnected}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  systemFont: { fontFamily: SYSTEM_FONT },
  motionPressable: IS_WEB_PREVIEW ? { outlineStyle: 'none' } : {},
  switchTrack: { width: 48, height: 28, borderRadius: 14, padding: 2, backgroundColor: '#D6D6D6', justifyContent: 'center', ...(IS_WEB_PREVIEW ? { outlineStyle: 'none' } : {}) },
  switchTrackActive: { backgroundColor: C.ink },
  switchThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.white, ...(IS_WEB_PREVIEW ? { boxShadow: '0 1px 4px rgba(0,0,0,.18)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.18, shadowRadius: 4, elevation: 2 }) },
  switchDisabled: { opacity: 0.42 },
  safe: { flex: 1, backgroundColor: C.canvas },
  page: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 4, paddingBottom: 112 },
  topBar: { minHeight: 88, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', backgroundColor: C.canvas },
  topBarTitle: { color: C.ink, fontSize: 32, lineHeight: 38, fontWeight: '800', letterSpacing: -0.8 },
  topBarSubtitle: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  webPreviewBar: { width: 'auto', maxWidth: 644, alignSelf: 'center', marginHorizontal: 18, marginBottom: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  webPreviewTitle: { color: C.ink, fontSize: 12, fontWeight: '700' },
  webPreviewHint: { color: C.muted, fontSize: 11, marginTop: 2 },
  webPreviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  webPreviewButton: { minHeight: 36, borderRadius: 12, backgroundColor: C.ink, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  webPreviewButtonText: { color: C.white, fontSize: 11, fontWeight: '700' },
  connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 18, borderWidth: 1, borderColor: C.ink, backgroundColor: C.ink, paddingHorizontal: 12, paddingVertical: 9 },
  connectionStatusText: { color: C.white, fontSize: 12, fontWeight: '700' },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.white },
  offlineDot: { backgroundColor: '#B0B0B0' },
  cardTitle: { color: C.ink, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  cardDescription: { color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  badge: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  inlineTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  samplePill: { color: C.muted, fontSize: 9, lineHeight: 16, fontWeight: '700', paddingHorizontal: 7, borderRadius: 8, backgroundColor: '#E5E5EA', overflow: 'hidden' },
  contextCard: { minHeight: 84, marginBottom: 14, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, paddingHorizontal: 16, paddingVertical: 15, flexDirection: 'row', alignItems: 'center', gap: 12 },
  contextCardGreen: { backgroundColor: C.paper },
  contextTitle: { color: C.ink, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  contextTitleGreen: { color: C.ink },
  contextDescription: { color: C.muted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  contextActionMotion: { minWidth: 98 },
  contextAction: { minHeight: 40, borderRadius: 14, paddingHorizontal: 14, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  contextActionText: { color: C.white, fontSize: 11, fontWeight: '700' },
  sectionHeading: { marginTop: 14, marginBottom: 12 },
  sectionEyebrow: { color: C.muted, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  sectionTitle: { color: C.ink, fontSize: 21, lineHeight: 27, fontWeight: '700', letterSpacing: -0.35 },
  sectionDescription: { color: C.muted, fontSize: 14, lineHeight: 20, marginTop: 5 },
  buttonMotion: { marginTop: 14 },
  button: { width: '100%', minHeight: 52, borderRadius: 16, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  buttonSecondary: { backgroundColor: C.ink },
  buttonText: { color: C.white, fontSize: 15, fontWeight: '700' },
  buttonTextSecondary: { color: C.white },
  disabled: { opacity: 0.35 },
  heroTitle: { color: C.ink, fontSize: 21, fontWeight: '700' },
  roomPreview: { height: 420, borderRadius: 24, borderWidth: 1, borderColor: C.line, overflow: 'hidden', backgroundColor: '#F0F0ED', alignItems: 'center', paddingTop: 54, position: 'relative' },
  hangingLine: { position: 'absolute', top: 22, width: 1, height: 43, backgroundColor: '#9A9A9A' },
  frameShadow: {
    width: '78%', maxWidth: 310, padding: 5, backgroundColor: 'rgba(0,0,0,.10)', borderRadius: 5,
    ...(IS_WEB_PREVIEW
      ? { boxShadow: '0 16px 30px rgba(0,0,0,.16)' }
      : { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.16, shadowRadius: 24, elevation: 8 }),
  },
  frameShadowPortrait: { width: '62%', maxWidth: 230 },
  frameOuter: { padding: 11, backgroundColor: '#1C1C1E' },
  frameMat: { padding: 14, backgroundColor: '#FFFFFF', position: 'relative' },
  framePhoto: { width: '100%', aspectRatio: 4 / 3, resizeMode: 'cover', backgroundColor: '#F2F2F7' },
  framePhotoPortrait: { width: '100%', aspectRatio: 3 / 4, resizeMode: 'contain', backgroundColor: '#F2F2F7' },
  framePlaceholder: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#F2F2F7', alignItems: 'center', justifyContent: 'center' },
  framePlaceholderIcon: { color: C.ink, fontSize: 32 },
  framePlaceholderText: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 7, paddingHorizontal: 10, textAlign: 'center' },
  realPreviewBadge: { position: 'absolute', right: 20, bottom: 20, borderRadius: 10, backgroundColor: 'rgba(28,28,30,.82)', paddingHorizontal: 8, paddingVertical: 5 },
  realPreviewBadgeText: { color: C.white, fontSize: 8, lineHeight: 11, fontWeight: '700' },
  curatedArtwork: { width: '100%', aspectRatio: 4 / 3, padding: 16, backgroundColor: '#F5F1E8', justifyContent: 'center' },
  artSampleBadge: { position: 'absolute', right: 10, top: 10, color: '#84786A', fontSize: 8, lineHeight: 17, fontWeight: '800', paddingHorizontal: 8, borderRadius: 9, backgroundColor: 'rgba(255,255,255,.78)', overflow: 'hidden' },
  curatedEyebrow: { color: '#84786A', fontSize: 8, fontWeight: '800', letterSpacing: 1.6 },
  curatedTitle: { color: '#201D19', fontSize: 24, lineHeight: 29, fontWeight: '800', marginTop: 3, marginBottom: 12 },
  curatedGrid: { flexDirection: 'row', gap: 6 },
  curatedTile: { flex: 1, height: 66, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  curatedTileBlue: { backgroundColor: '#3B3B3B' },
  curatedTileGreen: { backgroundColor: '#686868' },
  curatedTileOrange: { backgroundColor: '#999999' },
  curatedTileText: { color: C.white, fontSize: 10, fontWeight: '700' },
  shelf: { position: 'absolute', left: 24, right: 24, bottom: 62, height: 8, borderRadius: 4, backgroundColor: '#5A5A5A' },
  vase: { position: 'absolute', right: 52, bottom: 70, width: 42, height: 58, borderBottomLeftRadius: 17, borderBottomRightRadius: 17, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: '#C8C8C8' },
  plantStem: { position: 'absolute', right: 72, bottom: 126, width: 2, height: 42, backgroundColor: '#5A5A5A', transform: [{ rotate: '-8deg' }] },
  plantLeaf: { position: 'absolute', width: 28, height: 13, borderRadius: 14, backgroundColor: '#777777' },
  plantLeafLeft: { right: 71, bottom: 151, transform: [{ rotate: '28deg' }] },
  plantLeafRight: { right: 48, bottom: 163, transform: [{ rotate: '-25deg' }] },
  displaySummaryCard: { minHeight: 96, marginTop: 12, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, flexDirection: 'row', alignItems: 'center', gap: 14 },
  summaryEditButton: { minWidth: 58, height: 38, borderRadius: 13, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  summaryEditText: { color: C.white, fontSize: 12, fontWeight: '700' },
  moreDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginVertical: 20 },
  petFlow: { position: 'relative', flexDirection: 'row', marginTop: 16, marginHorizontal: 2 },
  petFlowLine: { position: 'absolute', left: '10%', right: '10%', top: 12, height: 1, backgroundColor: C.line },
  petFlowStep: { flex: 1, alignItems: 'center' },
  petFlowDot: { width: 25, height: 25, borderRadius: 13, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' },
  petFlowDotReached: { borderColor: C.ink, backgroundColor: C.ink },
  petFlowNumber: { color: C.muted, fontSize: 10, fontWeight: '700' },
  petFlowNumberReached: { color: C.white },
  petFlowLabel: { color: C.muted, fontSize: 10, lineHeight: 14, marginTop: 6, textAlign: 'center' },
  petFlowLabelReached: { color: C.ink, fontWeight: '700' },
  permissionGate: { minHeight: 310, borderRadius: 22, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center', padding: 24 },
  permissionGateIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  permissionGateIconText: { color: C.orange, fontSize: 31, fontWeight: '600' },
  selectionSummary: { minHeight: 92, borderRadius: 16, backgroundColor: '#1C1C1E', paddingHorizontal: 18, paddingVertical: 15, flexDirection: 'row', alignItems: 'center', gap: 17, marginBottom: 14 },
  selectionSummaryValue: { color: C.white, fontSize: 28, lineHeight: 31, fontWeight: '800' },
  selectionSummaryLabel: { color: '#AEAEB2', fontSize: 10, marginTop: 2 },
  selectionSummaryDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: 'rgba(255,255,255,.20)' },
  selectionSummaryText: { color: '#F2F2F7', fontSize: 12, lineHeight: 18 },
  selectionGroup: { overflow: 'hidden', borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, marginBottom: 14 },
  selectionGroupHeader: { paddingHorizontal: 16, paddingTop: 15, paddingBottom: 11, backgroundColor: '#FAFAFA' },
  selectionGroupTitle: { color: C.ink, fontSize: 17, lineHeight: 22, fontWeight: '700' },
  selectionGroupDescription: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  selectionRow: { minHeight: 70, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  selectionRowDisabled: { opacity: 0.58 },
  selectionRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(60,60,67,.18)' },
  selectionAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center' },
  selectionAvatarText: { color: C.ink, fontSize: 14, fontWeight: '700' },
  selectionTitle: { color: C.ink, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  selectionDetail: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  scopeOverview: { borderRadius: 24, backgroundColor: '#1C1C1E', padding: 18, marginBottom: 12 },
  scopeOverviewHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  scopeOverviewEyebrow: { color: '#AEAEB2', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  scopeOverviewTitle: { color: C.white, fontSize: 19, lineHeight: 25, fontWeight: '700', marginTop: 3 },
  scopeOverviewBadge: { color: C.ink, backgroundColor: C.white, borderRadius: 10, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 5, fontSize: 9, fontWeight: '700' },
  scopeFlow: { flexDirection: 'row', alignItems: 'center', marginTop: 20 },
  scopeStep: { flex: 1, minHeight: 66, borderRadius: 16, backgroundColor: 'rgba(255,255,255,.09)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  scopeStepValue: { color: C.white, fontSize: 20, lineHeight: 24, fontWeight: '800' },
  scopeStepLabel: { color: '#C7C7CC', fontSize: 9, lineHeight: 13, marginTop: 3, textAlign: 'center' },
  scopeArrow: { color: '#8E8E93', fontSize: 22, fontWeight: '300', paddingHorizontal: 5 },
  scopeQualityTrack: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,.14)', overflow: 'hidden', marginTop: 17 },
  scopeQualityFill: { height: '100%', borderRadius: 3, backgroundColor: C.white },
  scopeOverviewHint: { color: '#C7C7CC', fontSize: 10, lineHeight: 16, marginTop: 10 },
  organizingControl: { minHeight: 112, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, padding: 15, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 14 },
  organizingControlPaused: { backgroundColor: '#F2F2F2' },
  organizingControlLabel: { color: C.muted, fontSize: 10, fontWeight: '600' },
  organizingControlTitle: { color: C.ink, fontSize: 17, lineHeight: 22, fontWeight: '700', marginTop: 3 },
  organizingControlDescription: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 3 },
  organizingControlButton: { minWidth: 88, minHeight: 42, borderRadius: 14, backgroundColor: C.ink, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  organizingControlButtonText: { color: C.white, fontSize: 11, fontWeight: '700' },
  scopeLogicNote: { borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, padding: 15, marginBottom: 12 },
  scopeLogicTitle: { color: C.ink, fontSize: 13, fontWeight: '700' },
  scopeLogicText: { color: C.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  themeScopeSection: { borderRadius: 22, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, padding: 14, marginBottom: 12 },
  themeScopeHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 },
  themeCardMotion: { width: '48.3%' },
  themeCard: { overflow: 'hidden', borderRadius: 17, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper },
  themeCardOff: { opacity: 0.68 },
  themeCover: { width: '100%', aspectRatio: 1.2, backgroundColor: '#EFEFF4' },
  themeCoverAnimated: { width: '100%', height: '100%' },
  themeCoverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  themeCoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EFEFF4' },
  themeCoverGlyph: { color: C.ink, fontSize: 28, fontWeight: '700' },
  themeGroupBadge: { position: 'absolute', left: 8, top: 8, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 4, backgroundColor: 'rgba(28,28,30,.78)' },
  themeGroupText: { color: C.white, fontSize: 8, fontWeight: '700' },
  themeCarouselCount: { position: 'absolute', left: 8, bottom: 8, minWidth: 30, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 4, backgroundColor: 'rgba(28,28,30,.72)', alignItems: 'center' },
  themeCarouselCountText: { color: C.white, fontSize: 8, fontWeight: '700' },
  themeCheck: { position: 'absolute', right: 8, top: 8, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.88)' },
  themeCheckOn: { backgroundColor: C.ink },
  themeCheckText: { color: C.muted, fontSize: 12, fontWeight: '800' },
  themeCheckTextOn: { color: C.white },
  themeCardBody: { paddingHorizontal: 11, paddingVertical: 10 },
  themeCardTitle: { color: C.ink, fontSize: 14, fontWeight: '700' },
  themeCardCount: { color: C.muted, fontSize: 9, lineHeight: 13, marginTop: 3 },
  themeRuleRow: { minHeight: 45, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  themeRuleLabel: { color: C.muted, fontSize: 9, fontWeight: '600' },
  scopeFootnote: { color: C.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginHorizontal: 16, marginBottom: 8 },
  settingCard: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 20, padding: 16, marginBottom: 12 },
  settingLabel: { color: C.muted, fontSize: 12, fontWeight: '500' },
  settingValue: { color: C.ink, fontSize: 17, lineHeight: 22, fontWeight: '600', marginTop: 5 },
  settingHint: { color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  choiceBlock: { marginBottom: 17 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9 },
  choiceChipMotion: { minWidth: 70 },
  choiceChip: { minHeight: 36, borderRadius: 13, paddingHorizontal: 13, backgroundColor: C.orangeSoft, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  choiceChipActive: { backgroundColor: C.ink, borderColor: C.ink },
  choiceChipDisabled: { opacity: 0.45 },
  choiceChipText: { color: C.ink, fontSize: 11, fontWeight: '600' },
  choiceChipTextActive: { color: C.white },
  templatePickerBlock: { marginBottom: 10 },
  templatePickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  templatePickerCount: { color: C.muted, fontSize: 10, fontWeight: '600' },
  templatePickerRow: { gap: 9, paddingTop: 10, paddingRight: 2 },
  templateCardMotion: { width: 148 },
  templateCard: { minHeight: 104, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: '#F7F7F7', padding: 13, justifyContent: 'space-between' },
  templateCardActive: { borderColor: C.ink, backgroundColor: C.ink },
  templateCardName: { color: C.ink, fontSize: 14, lineHeight: 19, fontWeight: '700' },
  templateCardNameActive: { color: C.white },
  templateCardMeta: { color: C.muted, fontSize: 10, lineHeight: 15, fontWeight: '600', marginTop: 5 },
  templateCardMetaActive: { color: 'rgba(255,255,255,.72)' },
  templateCardDescription: { color: C.muted, fontSize: 9, lineHeight: 13, marginTop: 7 },
  templateCardDescriptionActive: { color: 'rgba(255,255,255,.72)' },
  settingsLink: { minHeight: 38, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  settingsLinkText: { color: C.ink, fontSize: 12, fontWeight: '700' },
  notice: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 16, padding: 14, marginTop: 2 },
  noticeText: { color: C.ink, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  error: { backgroundColor: C.redSoft, borderRadius: 12, padding: 14, marginTop: 2 },
  errorText: { color: C.red, fontSize: 13, lineHeight: 19, marginTop: 10 },
  footer: { color: '#8E8E93', fontSize: 11, textAlign: 'center', marginTop: 22 },
  statusCard: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 20, padding: 16, marginBottom: 14 },
  statusHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  statusLabel: { color: C.muted, fontSize: 12, fontWeight: '500' },
  statusTitle: { color: C.ink, fontSize: 15, fontWeight: '600', marginTop: 4, maxWidth: 270 },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: '#E5E5EA', marginTop: 16 },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: C.ink },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.34)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '92%', backgroundColor: C.canvas, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 36 },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 },
  modalEyebrow: { color: C.muted, fontSize: 12, fontWeight: '500' },
  modalTitle: { color: C.ink, fontSize: 28, lineHeight: 34, fontWeight: '700', marginTop: 2, letterSpacing: -0.4 },
  close: { minWidth: 48, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  closeText: { color: C.ink, fontSize: 16, fontWeight: '700' },
  help: { color: C.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  albumRowMotion: { marginBottom: 8 },
  albumRow: { minHeight: 70, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  bottomNavigation: { position: 'absolute', left: 12, right: 12, bottom: 10, minHeight: 70, borderWidth: 1, borderColor: C.line, borderRadius: 22, backgroundColor: 'rgba(255,255,255,.98)', flexDirection: 'row', padding: 6, ...(IS_WEB_PREVIEW ? { boxShadow: '0 10px 30px rgba(0,0,0,.08)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 24, elevation: 6 }) },
  navMotion: { flex: 1 },
  navItem: { flex: 1, minWidth: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navItemActive: { backgroundColor: C.ink },
  navIcon: { color: '#8E8E93', fontSize: 21, lineHeight: 24 },
  navLabel: { color: '#8E8E93', fontSize: 10, fontWeight: '500' },
  navTextActive: { color: C.white, fontWeight: '700' },
});
