import { Component, useEffect, useMemo, useRef, useState } from 'react';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  ActivityIndicator,
  AppState,
  Animated,
  Easing,
  Image,
  LayoutAnimation,
  Linking,
  Modal,
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
  loadPendingDeviceSetup,
  loadPhotoSyncPreference,
  removeDeviceSession,
  saveDeviceSession,
  savePendingDeviceSetup,
  savePhotoSyncPreference,
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
  { id: 'selection', label: '精选', icon: '◉' },
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
  description: '5 张同一只宠物的照片，生成竖版牛仔布拼贴',
  width: 960,
  height: 1280,
  slots: 5,
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

class StartupErrorBoundary extends Component {
  state = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Echooo startup render failed', error, info);
  }

  retry = () => {
    this.setState(state => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render() {
    if (!this.state.error) {
      return <View key={this.state.resetKey} style={{ flex: 1 }}>{this.props.children}</View>;
    }
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F7F7' }}>
        <StatusBar barStyle="dark-content" />
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28 }}>
          <NativeText style={{ color: '#222222', fontSize: 30, lineHeight: 38, fontWeight: '700' }}>
            Echooo 暂时无法启动
          </NativeText>
          <NativeText style={{ color: '#717171', fontSize: 15, lineHeight: 23, marginTop: 12 }}>
            请截取这个页面发给开发人员，我们会根据下方信息定位问题。
          </NativeText>
          <NativeText selectable style={{ color: '#C13515', fontSize: 13, lineHeight: 20, marginTop: 22 }}>
            {String(this.state.error?.message || this.state.error || '未知启动错误')}
          </NativeText>
          <Pressable
            accessibilityRole="button"
            onPress={this.retry}
            style={{ minHeight: 54, marginTop: 28, borderRadius: 18, backgroundColor: '#222222', alignItems: 'center', justifyContent: 'center' }}
          >
            <NativeText style={{ color: '#FFFFFF', fontSize: 17, fontWeight: '700' }}>重新打开</NativeText>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
}

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

const PREVIEW_RECOGNIZED_CONTENT = {
  people: [
    { id: 'person-family-1', label: '家人 A', detail: '128 张照片', icon: 'A' },
    { id: 'person-family-2', label: '家人 B', detail: '96 张照片', icon: 'B' },
    { id: 'person-friends', label: '朋友', detail: '43 张照片', icon: '友' },
  ],
  topics: [
    { id: 'topic-pets', label: '猫咪', detail: '72 张照片', icon: '猫' },
    { id: 'topic-travel', label: '旅行', detail: '116 张照片', icon: '旅' },
    { id: 'topic-food', label: '美食', detail: '38 张照片', icon: '食' },
    { id: 'topic-scenery', label: '风景', detail: '84 张照片', icon: '景' },
  ],
  albums: [
    { id: 'album-family', label: '家庭时光', detail: '214 张照片', icon: '家' },
    { id: 'album-trips', label: '旅行记录', detail: '146 张照片', icon: '行' },
    { id: 'album-pets', label: '毛孩子', detail: '89 张照片', icon: '宠' },
  ],
};

const PREVIEW_SOURCE_ALBUMS = [
  { id: 'all-authorized-photos', title: '所有已授权照片', assetCount: 1842, allPhotos: true, kind: 'library' },
  { id: 'source-family', title: '家庭时光', assetCount: 214, kind: 'personal' },
  { id: 'source-travel', title: '旅行记录', assetCount: 146, kind: 'personal' },
  { id: 'source-pets', title: '毛孩子', assetCount: 89, kind: 'smart' },
];

const EMPTY_RECOGNITION_SNAPSHOT = {
  total: 0,
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

function recognizedItem(album) {
  const label = String(album?.label || '未命名内容');
  return {
    id: `cloud-${album?.id || label}`,
    label,
    detail: `${album?.group || '精选'} · ${Number(album?.count) || 0} 张照片`,
    icon: label.slice(0, 1),
    filters: Array.isArray(album?.filter) ? album.filter : [],
    template: album?.template || 'template_1',
  };
}

function recognizedContentFrom(snapshot, photoSync) {
  const smartAlbums = Array.isArray(snapshot?.albums) ? snapshot.albums : [];
  const people = smartAlbums.filter(album => album.group === '人物').map(recognizedItem);
  const topics = smartAlbums.filter(album => album.group !== '人物').map(recognizedItem);
  const sources = photoSyncSources(photoSync);
  const albums = sources.length ? [{
    id: `source-${sources.map(album => album.id).join('-')}`,
    label: photoSyncLabel(photoSync),
    detail: `${Number(snapshot?.total) || 0} 张云端已识别照片`,
    icon: '册',
    filters: [],
    template: 'template_1',
  }] : [];
  return { people, topics, albums };
}

function photoSyncSources(preference) {
  if (Array.isArray(preference?.albums) && preference.albums.length) return preference.albums;
  return preference?.id ? [preference] : [];
}

function photoSyncLabel(preference) {
  const sources = photoSyncSources(preference);
  if (!sources.length) return '未选择照片来源';
  if (sources.some(album => album?.allPhotos)) return '所有已授权照片';
  if (sources.length === 1) return sources[0].title || '未命名相簿';
  return `${sources.length} 个相簿`;
}

function pickerAlbumKind(album) {
  if (album?.allPhotos) return 'library';
  const type = String(album?.kind || album?.type || '').toLowerCase();
  return type.includes('smart') ? 'smart' : 'personal';
}

function pickerAlbumSort(left, right) {
  const count = Number(right?.assetCount || 0) - Number(left?.assetCount || 0);
  if (count) return count;
  return String(left?.title || '').localeCompare(String(right?.title || ''), 'zh-Hans-CN');
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
    return { state: 'queued', progress: 100, message: '发布已排队，等待墨水屏下载' };
  }
  return { state: 'idle', progress: 0, message: '设备在线，尚无发布任务' };
}

function ActionButton({ children, onPress, secondary = false, disabled = false, loading = false }) {
  return (
    <MotionPressable
      disabled={disabled}
      onPress={onPress}
      style={styles.buttonMotion}
      contentStyle={[styles.button, secondary && styles.buttonSecondary]}
    >
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator size="small" color={C.white} /> : null}
        <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{children}</Text>
      </View>
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

function AlbumSelectionCard({ album, selected, onPress, featured = false }) {
  return (
    <MotionPressable
      onPress={onPress}
      style={[styles.albumCardMotion, featured && styles.albumCardMotionFeatured]}
      contentStyle={[styles.albumCard, featured && styles.albumCardFeatured, selected && styles.albumCardSelected]}
      accessibilityLabel={`${selected ? '取消选择' : '选择'} ${album.title}`}
      scaleTo={0.985}
    >
      <View style={[styles.albumCover, featured && styles.albumCoverFeatured]}>
        {album.coverUri ? (
          <Image source={{ uri: album.coverUri }} style={styles.albumCoverImage} />
        ) : (
          <View style={styles.albumCoverFallback}>
            <Text style={styles.albumCoverFallbackText}>{album.allPhotos ? '◎' : String(album.title || '相').slice(0, 1)}</Text>
          </View>
        )}
        <View style={[styles.albumSelectionMark, selected && styles.albumSelectionMarkActive]}>
          <Text style={[styles.albumSelectionMarkText, selected && styles.albumSelectionMarkTextActive]}>{selected ? '✓' : ''}</Text>
        </View>
      </View>
      <View style={styles.albumCardBody}>
        <Text numberOfLines={1} style={styles.albumCardTitle}>{album.title}</Text>
        <Text numberOfLines={1} style={styles.albumCardMeta}>{album.allPhotos ? '已允许访问的全部照片' : `${album.assetCount || 0} 张照片`}</Text>
      </View>
    </MotionPressable>
  );
}

function AlbumModal({ visible, albums, selectedSource, onClose, onConfirm }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [showAllSystem, setShowAllSystem] = useState(false);
  const [showAllPersonal, setShowAllPersonal] = useState(false);
  const sourceKey = photoSyncSources(selectedSource).map(album => album.id).join('|');

  useEffect(() => {
    if (!visible) return;
    setSelectedIds(photoSyncSources(selectedSource).map(album => album.id));
    setShowAllSystem(false);
    setShowAllPersonal(false);
  }, [visible, sourceKey]);

  const allPhotos = albums.find(album => album.allPhotos);
  const systemAlbums = albums
    .filter(album => !album.allPhotos && pickerAlbumKind(album) === 'smart')
    .sort(pickerAlbumSort);
  const personalAlbums = albums
    .filter(album => !album.allPhotos && pickerAlbumKind(album) !== 'smart')
    .sort(pickerAlbumSort);
  const featuredAlbums = [allPhotos, ...systemAlbums.slice(0, 3)].filter(Boolean);
  const featuredIds = new Set(featuredAlbums.map(album => album.id));
  const remainingSystemAlbums = systemAlbums.filter(album => !featuredIds.has(album.id));
  const visibleSystemAlbums = showAllSystem ? remainingSystemAlbums : remainingSystemAlbums.slice(0, 6);
  const visiblePersonalAlbums = showAllPersonal ? personalAlbums : personalAlbums.slice(0, 6);
  const selected = albums.filter(album => selectedIds.includes(album.id));

  const toggleAlbum = album => {
    setSelectedIds(current => {
      if (album.allPhotos) return current.includes(album.id) ? [] : [album.id];
      const withoutAllPhotos = current.filter(id => id !== allPhotos?.id);
      return withoutAllPhotos.includes(album.id)
        ? withoutAllPhotos.filter(id => id !== album.id)
        : [...withoutAllPhotos, album.id];
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View><Text style={styles.modalEyebrow}>照片来源</Text><Text style={styles.modalTitle}>选择照片集</Text></View>
            <MotionPressable onPress={onClose} contentStyle={styles.close}><Text style={styles.closeText}>取消</Text></MotionPressable>
          </View>
          <ScrollView style={styles.albumPickerScroll} contentContainerStyle={styles.albumPickerContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.help}>选择要参与照片墙的来源。可多选；“所有已授权照片”会覆盖其他选择。照片只会在你确认同步时上传。</Text>
            <Text style={styles.albumGroupTitle}>照片精选</Text>
            <View style={styles.albumGrid}>
              {featuredAlbums.map((album, index) => (
                <AlbumSelectionCard
                  key={album.id}
                  album={album}
                  featured={index === 0}
                  selected={selectedIds.includes(album.id)}
                  onPress={() => toggleAlbum(album)}
                />
              ))}
            </View>

            {remainingSystemAlbums.length ? (
              <>
                <Text style={styles.albumGroupTitle}>系统分类</Text>
                <View style={styles.albumGrid}>
                  {visibleSystemAlbums.map(album => (
                    <AlbumSelectionCard
                      key={album.id}
                      album={album}
                      selected={selectedIds.includes(album.id)}
                      onPress={() => toggleAlbum(album)}
                    />
                  ))}
                </View>
                {remainingSystemAlbums.length > 6 ? (
                  <MotionPressable
                    onPress={() => setShowAllSystem(current => !current)}
                    contentStyle={styles.albumMoreButton}
                    scaleTo={0.99}
                  >
                    <Text style={styles.albumMoreButtonText}>{showAllSystem ? '收起系统分类' : `查看全部系统分类（${remainingSystemAlbums.length + featuredAlbums.length - 1}）`}</Text>
                  </MotionPressable>
                ) : null}
              </>
            ) : null}

            {personalAlbums.length ? (
              <>
                <Text style={styles.albumGroupTitle}>我的相簿</Text>
                <View style={styles.albumGrid}>
                  {visiblePersonalAlbums.map(album => (
                    <AlbumSelectionCard
                      key={album.id}
                      album={album}
                      selected={selectedIds.includes(album.id)}
                      onPress={() => toggleAlbum(album)}
                    />
                  ))}
                </View>
                {personalAlbums.length > 6 ? (
                  <MotionPressable
                    onPress={() => setShowAllPersonal(current => !current)}
                    contentStyle={styles.albumMoreButton}
                    scaleTo={0.99}
                  >
                    <Text style={styles.albumMoreButtonText}>{showAllPersonal ? '收起相簿' : `查看全部相簿（${personalAlbums.length}）`}</Text>
                  </MotionPressable>
                ) : null}
              </>
            ) : null}
          </ScrollView>
          <View style={styles.albumPickerFooter}>
            <Text style={styles.albumPickerSelection}>{selected.length ? `已选择 ${selected.length} 个照片集` : '请选择至少一个照片集'}</Text>
            <MotionPressable
              disabled={!selected.length}
              onPress={() => onConfirm(selected)}
              contentStyle={styles.albumConfirmButton}
              scaleTo={0.98}
            >
              <Text style={styles.albumConfirmButtonText}>{selected.length ? `同步 ${selected.length} 个照片集` : '同步照片集'}</Text>
            </MotionPressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function NearbyDevicePrompt({ visible, device, onDismiss, onConnect }) {
  if (!device) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.nearbyDeviceBackdrop}>
        <View style={styles.nearbyDevicePrompt}>
          <MotionPressable
            onPress={onDismiss}
            contentStyle={styles.nearbyDeviceClose}
            accessibilityLabel="暂不连接"
            scaleTo={0.9}
          >
            <Text style={styles.nearbyDeviceCloseText}>×</Text>
          </MotionPressable>
          <Text style={styles.nearbyDeviceEyebrow}>发现附近设备</Text>
          <Text style={styles.nearbyDeviceTitle}>{device.deviceName || 'PhotoWall'}</Text>
          <View style={styles.nearbyDeviceArtwork}>
            <View style={styles.nearbyDeviceScreen}>
              <View style={styles.nearbyDeviceMat}>
                <Text style={styles.nearbyDeviceGlyph}>▧</Text>
              </View>
            </View>
          </View>
          <Text style={styles.nearbyDeviceQuestion}>连接这台照片墙吗？</Text>
          <Text style={styles.nearbyDeviceHint}>就在附近 · 信号良好</Text>
          <View style={styles.nearbyDeviceActions}>
            <MotionPressable onPress={onDismiss} style={styles.nearbyDeviceActionMotion} contentStyle={styles.nearbyDeviceSecondary}>
              <Text style={styles.nearbyDeviceSecondaryText}>暂不连接</Text>
            </MotionPressable>
            <MotionPressable onPress={onConnect} style={styles.nearbyDeviceActionMotion} contentStyle={styles.nearbyDevicePrimary}>
              <Text style={styles.nearbyDevicePrimaryText}>连接</Text>
            </MotionPressable>
          </View>
        </View>
      </View>
    </Modal>
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

function PhotoWallApp() {
  const [activeTab, setActiveTab] = useState('home');
  const [session, setSession] = useState(null);
  const [deviceSessions, setDeviceSessions] = useState([]);
  const [deviceSessionsLoaded, setDeviceSessionsLoaded] = useState(IS_WEB_PREVIEW);
  const [reconfigurationSession, setReconfigurationSession] = useState(null);
  const screenMotion = useRef(new Animated.Value(1)).current;
  const accountPreparationRef = useRef(null);
  const [webConnected, setWebConnected] = useState(false);
  const [webPhotoAuthorized, setWebPhotoAuthorized] = useState(false);
  const [permission, setPermission] = useState(null);
  const [albumModal, setAlbumModal] = useState(false);
  const [albums, setAlbums] = useState([]);
  const [photoSync, setPhotoSync] = useState(null);
  const [recognitionSnapshot, setRecognitionSnapshot] = useState(EMPTY_RECOGNITION_SNAPSHOT);
  const [recognitionLoading, setRecognitionLoading] = useState(false);
  const [selectionModel, setSelectionModel] = useState(null);
  const [selectionModelLoading, setSelectionModelLoading] = useState(false);
  const [selectionModelError, setSelectionModelError] = useState('');
  const [generatedWall, setGeneratedWall] = useState(null);
  const [petCollageStage, setPetCollageStage] = useState(null);
  const [addDisplayVisible, setAddDisplayVisible] = useState(false);
  const [deviceModal, setDeviceModal] = useState(false);
  const [nearbyDevicePrompt, setNearbyDevicePrompt] = useState(null);
  const [initialSetupDevice, setInitialSetupDevice] = useState(null);
  const [deviceManagerVisible, setDeviceManagerVisible] = useState(false);
  const [householdMembersVisible, setHouseholdMembersVisible] = useState(false);
  const [accountSession, setAccountSession] = useState(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const [testDeviceBusy, setTestDeviceBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deliveryPending, setDeliveryPending] = useState(false);
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
  const initialDiscoveryStartedRef = useRef(false);
  const initialDiscoveryStopRef = useRef(null);

  const effectiveSession = IS_WEB_PREVIEW && webConnected ? WEB_PREVIEW_SESSION : session;
  const photoAllowed = IS_WEB_PREVIEW ? webPhotoAuthorized : permission?.status === 'granted';
  const connected = IS_WEB_PREVIEW ? webConnected : Boolean(session?.device?.device_id);
  const managedDeviceSessions = IS_WEB_PREVIEW && webConnected ? [WEB_PREVIEW_SESSION] : deviceSessions;
  const canPublish = IS_WEB_PREVIEW || effectiveSession?.device?.can_publish !== false;
  const canManageDevice = IS_WEB_PREVIEW || effectiveSession?.device?.can_manage !== false;
  const deliveryInProgress = !IS_WEB_PREVIEW && (
    deliveryPending || ['queued', 'downloading', 'displaying'].includes(operation.state)
  );
  const actionBusy = publishing || deliveryInProgress;
  const isTestDevice = Boolean(effectiveSession?.device?.test_device);
  const contentMode = !connected ? 'demo' : !photoAllowed ? 'permission' : 'live';
  const liveRecognizedContent = useMemo(
    () => recognizedContentFrom(recognitionSnapshot, photoSync),
    [recognitionSnapshot, photoSync],
  );
  const recognizedContent = contentMode !== 'live' || IS_WEB_PREVIEW
    ? PREVIEW_RECOGNIZED_CONTENT
    : liveRecognizedContent;
  const recognizedItems = [...recognizedContent.people, ...recognizedContent.topics];
  const enabledSelectionCount = recognizedItems.filter(item => displayRules[item.id] !== false).length;
  const recognizedPhotoCount = contentMode === 'live' ? recognitionSnapshot.goodTotal : 0;
  const selectionIsSample = contentMode !== 'live';
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
    if (permission.accessPrivileges === 'limited') return '当前仅可读取系统选定的照片；可在系统设置中改为“完全访问”。';
    return '已允许访问全部照片。';
  }, [permission, webPhotoAuthorized]);
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
    setPhotoSync(null);
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

  const refreshPermission = async () => {
    const result = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    setPermission(result);
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
    let active = true;
    Promise.all([loadDeviceSessions(), loadPendingDeviceSetup()]).then(([stored, pending]) => {
      if (!active) return;
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
    }).catch(caught => {
      if (active) setError(`无法恢复设备状态：${caught.message}`);
    }).finally(() => {
      if (active) setDeviceSessionsLoaded(true);
    });
    loadPhotoSyncPreference().then(setPhotoSync);
    refreshPermission().catch(e => setError(`检查照片权限失败：${e.message}`));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (
      IS_WEB_PREVIEW
      || !deviceSessionsLoaded
      || connected
      || reconfigurationSession
      || deviceModal
      || initialDiscoveryStartedRef.current
    ) return undefined;

    initialDiscoveryStartedRef.current = true;
    let disposed = false;
    let found = false;
    const timeout = setTimeout(() => {
      Promise.resolve(initialDiscoveryStopRef.current?.()).catch(() => {});
      Promise.resolve(stopBleDeviceDiscovery()).catch(() => {});
    }, 15000);

    startBleDeviceDiscovery(device => {
      if (disposed || found || !device?.deviceId) return;
      found = true;
      Promise.resolve(initialDiscoveryStopRef.current?.()).catch(() => {});
      Promise.resolve(stopBleDeviceDiscovery()).catch(() => {});
      setNearbyDevicePrompt(device);
    }, { includeCached: false }).then(stop => {
      if (disposed) {
        Promise.resolve(stop?.()).catch(() => {});
        return;
      }
      initialDiscoveryStopRef.current = stop;
    }).catch(() => {
      // 首次后台发现不干扰首页；用户仍可从右上角手动搜索设备。
    });

    return () => {
      disposed = true;
      clearTimeout(timeout);
      Promise.resolve(initialDiscoveryStopRef.current?.()).catch(() => {});
    };
  }, [deviceSessionsLoaded, connected, reconfigurationSession, deviceModal]);

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
      if (active) setRecognitionSnapshot(result);
    }).catch(caught => {
      if (active) setError(`读取云端识别结果失败：${caught.message}`);
    }).finally(() => {
      if (active) setRecognitionLoading(false);
    });
    return () => { active = false; };
  }, [session?.accountToken, photoAllowed]);

  useEffect(() => {
    if (contentMode !== 'live' || !recognizedItems.length) return;
    setDisplayRules(current => {
      const next = { ...current };
      recognizedItems.forEach(item => {
        if (!(item.id in next)) next[item.id] = true;
      });
      return next;
    });
  }, [contentMode, recognizedItems.map(item => item.id).join('|')]);

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
        if (status) {
          setOperation(current => (
            current.state === 'uploading' || current.state === 'scanning'
              ? current
              : { ...current, ...status }
          ));
          if (status.state === 'done' || status.state === 'failed') setDeliveryPending(false);
        }
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
      const wall = await generatePetCollage({
        apiBase: DEFAULT_API_BASE,
        accountToken: session.accountToken,
        album: photoSync,
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

  const selectWallTemplate = templateId => {
    const selected = templateId === PET_COLLAGE_TEMPLATE.id
      ? PET_COLLAGE_TEMPLATE
      : wallTemplates.find(template => template.id === templateId);
    if (!selected || selected.id === selectedTemplateId) return;
    setSelectedTemplateId(selected.id);
    setGeneratedWall(null);
    setPreviewImageFailed(false);
    setPetCollageStage(null);
    setNotice(`已切换为“${selected.label}”，请重新生成预览。`);
    setError('');
  };

  const openAlbumPicker = async () => {
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    setError('');
    if (IS_WEB_PREVIEW) {
      setAlbums(PREVIEW_SOURCE_ALBUMS);
      setAlbumModal(true);
      return;
    }
    try {
      const available = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
      const nonEmpty = available.filter(album => (album.assetCount || 0) > 0);
      const uniqueAlbums = [...new Map(nonEmpty.map(album => [album.id, album])).values()]
        .map(album => ({
          id: album.id,
          title: album.title || '未命名相簿',
          assetCount: Number(album.assetCount) || 0,
          type: album.type,
          kind: pickerAlbumKind(album),
          nativeAlbum: album,
        }));
      const allPhotos = {
        id: 'all-authorized-photos',
        title: '所有已授权照片',
        allPhotos: true,
        kind: 'library',
      };
      const sorted = [allPhotos, ...uniqueAlbums.sort((left, right) => {
        const kindOrder = { smart: 0, personal: 1 };
        const kindDelta = (kindOrder[left.kind] ?? 2) - (kindOrder[right.kind] ?? 2);
        return kindDelta || pickerAlbumSort(left, right);
      })];
      const smartAlbums = sorted.filter(album => pickerAlbumKind(album) === 'smart');
      const personalAlbums = sorted.filter(album => pickerAlbumKind(album) === 'personal');
      const coverCandidates = [allPhotos, ...smartAlbums.slice(0, 9), ...personalAlbums.slice(0, 7)];
      const covered = await Promise.all(coverCandidates.map(async source => {
        try {
          const request = {
            first: 1,
            mediaType: [MediaLibrary.MediaType.photo],
            sortBy: [[MediaLibrary.SortBy.creationTime, false]],
          };
          if (!source.allPhotos && source.nativeAlbum) request.album = source.nativeAlbum;
          const page = await MediaLibrary.getAssetsAsync(request);
          return { ...source, coverUri: page.assets?.[0]?.uri || '' };
        } catch {
          return source;
        }
      }));
      const coveredById = new Map(covered.map(source => [source.id, source]));
      setAlbums(sorted.map(source => coveredById.get(source.id) || source));
      setAlbumModal(true);
    } catch (caught) {
      setError(`无法读取相簿：${caught.message}`);
    }
  };

  const syncSelectedAlbums = async selectedAlbums => {
    if (!selectedAlbums.length) return;
    setAlbumModal(false);
    const selectedSources = selectedAlbums.map(album => ({
      id: album.id,
      title: album.title,
      allPhotos: Boolean(album.allPhotos),
      type: album.type,
      assetCount: Number(album.assetCount) || 0,
    }));
    const includesAllPhotos = selectedSources.some(album => album.allPhotos);
    const selectedAlbum = {
      version: 2,
      mode: includesAllPhotos ? 'all' : 'albums',
      id: includesAllPhotos ? 'all-authorized-photos' : selectedSources.length === 1 ? selectedSources[0].id : 'multiple-albums',
      title: includesAllPhotos ? '所有已授权照片' : selectedSources.length === 1 ? selectedSources[0].title : `已选择 ${selectedSources.length} 个相簿`,
      allPhotos: includesAllPhotos,
      albums: selectedSources,
    };
    setPhotoSync(selectedAlbum);
    if (IS_WEB_PREVIEW) {
      setNotice(`网页预览已将照片来源切换为“${selectedAlbum.title}”，没有读取或上传照片。`);
      return;
    }
    setPublishing(true); setError(''); setNotice(''); setLastAction('album');
    setOperation({ state: 'scanning', progress: 0, message: `正在读取“${selectedAlbum.title}”中的新照片` });
    try {
      const synced = await syncPhotoAlbum({
        apiBase: DEFAULT_API_BASE,
        accountToken: session?.accountToken,
        album: { ...selectedAlbum, albums: selectedAlbums },
        onProgress: update => setOperation({
          state: update.stage === 'scanning' || update.stage === 'local_analysis' ? 'scanning' : 'uploading',
          progress: update.progress || 0,
          message: update.stage === 'scanning'
            ? `正在检查新增照片 · 已找到 ${update.scanned || 0} 张`
            : update.stage === 'local_analysis'
              ? `照片正在 iPhone 本机分析 · ${update.progress || 0}%${update.selected ? ` · 选出 ${update.selected} 张` : ''}`
            : `正在上传新照片 · ${update.progress || 0}%`,
          }),
      });
      await savePhotoSyncPreference(selectedAlbum);
      setOperation({ state: 'generating', progress: 100, message: '照片已同步，正在读取云端识别结果' });
      try {
        const recognition = await refreshRecognizedContent({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
        });
        setRecognitionSnapshot(recognition);
        setOperation({ state: 'generating', progress: 100, message: '照片已同步，正在生成投屏预览' });
        const wall = await generateWall({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
          template: selectedTemplateId,
        });
        setGeneratedWall(wall);
        setActiveTab('home');
        setOperation({ state: 'idle', progress: 100, message: '照片同步和投屏预览已完成' });
        const recognizedCount = recognition.albums?.length || 0;
        const localSummary = synced.local?.used
          ? `本机检查 ${synced.scanned} 张并选出 ${synced.selected} 张候选；`
          : synced.local?.fallback
            ? `设备端识别已安全回退（${synced.local.reason}）；`
            : '';
        setNotice(synced.unchanged
          ? `这个相簿没有新的照片；已从云端照片生成预览，并读取 ${recognizedCount} 个内容分类。`
          : `${localSummary}已同步 ${synced.synced} 张新照片，并从 ${wall.chosen?.length || 0} 张候选照片生成投屏预览。`);
      } catch (recognitionError) {
        setOperation({ state: 'idle', progress: 100, message: '照片已同步，识别结果可稍后重试读取' });
        setNotice(`照片同步已完成，但云端识别结果暂时无法读取：${recognitionError.message}`);
      }
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`相簿同步失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const startAutomaticDiscovery = async () => {
    if (!connected) {
      connectDevice();
      return;
    }
    const allowed = photoAllowed || await requestPhotoPermission();
    if (!allowed) return;
    await syncSelectedAlbums([{
      id: 'all-authorized-photos',
      title: '完整相册自动发现',
      allPhotos: true,
      kind: 'library',
    }]);
  };

  const generateTemplatePreview = async () => {
    setPublishing(true); setError(''); setNotice(''); setLastAction('template');
    setPetCollageStage(null);
    setOperation({ state: 'generating', progress: 40, message: '云端正在筛选照片并生成模板' });
    try {
      const filterItems = [...(recognizedContent.people || []), ...(recognizedContent.topics || [])]
        .filter(item => Array.isArray(item.filters) && item.filters.length);
      const enabledFilterItems = filterItems.filter(item => displayRules[item.id] !== false);
      const excludeFilters = [...new Set(
        filterItems
          .filter(item => displayRules[item.id] === false)
          .flatMap(item => item.filters),
      )];
      const focusedItem = enabledFilterItems.length === 1 ? enabledFilterItems[0] : null;
      const wall = IS_WEB_PREVIEW
        ? await new Promise(resolve => setTimeout(() => resolve({ previewOnly: true, template: selectedTemplateId, chosen: recognizedItems.slice(0, 6) }), 700))
        : await generateWall({
          apiBase: DEFAULT_API_BASE,
          accountToken: session?.accountToken,
          template: selectedTemplateId,
          filters: focusedItem?.filters || [],
          excludeFilters,
        });
      setGeneratedWall(wall);
      setActiveTab('home');
      setOperation({ state: 'idle', progress: 100, message: '模板预览已生成，等待确认发布' });
      setNotice(`云端已从 ${wall.chosen?.length || 0} 张候选照片中生成“${selectedWallTemplate.label}”预览。`);
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板生成失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const confirmGeneratedWall = async () => {
    if (!generatedWall || (!IS_WEB_PREVIEW && !session) || actionBusy) return;
    if (!canPublish) {
      setError('家庭所有者尚未允许你手动投屏。你仍可以保留并查看当前预览。');
      return;
    }
    const publishingPetCollage = generatedWall.template === 'denim_pet';
    setPublishing(true); setError(''); setNotice(''); setLastAction(publishingPetCollage ? 'pet-publish' : 'template');
    setDeliveryPending(true);
    try {
      if (IS_WEB_PREVIEW) {
        await new Promise(resolve => setTimeout(resolve, 650));
        setOperation({ state: 'queued', progress: 100, message: '精选内容已排队，等待照片墙刷新' });
        setNotice('网页预览已模拟发布；没有上传任何照片。');
        setDeliveryPending(false);
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
      if (publishingPetCollage) setPetCollageStage('published');
      const screen19 = isScreen19Device(nextSession.device);
      setOperation({
        state: 'queued',
        progress: 100,
        message: screen19 ? '模板已发送到 19 寸实时展示屏' : '模板已确认发布，等待墨水屏下载',
      });
      setNotice(screen19 ? '模板已发送到 19 寸屏。' : '模板已下发到照片墙，手机可以离开当前页面。');
    } catch (caught) {
      setDeliveryPending(false);
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板发布失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const retry = () => {
    if (lastAction === 'pet-collage') createPetCollagePreview();
    else if (lastAction === 'pet-publish') confirmGeneratedWall();
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
      const wasAdding = addingDevice;
      setWebConnected(true);
      setReconfigurationSession(null);
      setAddingDevice(false);
      setInitialSetupDevice(null);
      setDeviceModal(false);
      setDeviceManagerVisible(wasAdding || wasReconfiguring);
      setActiveTab(wasAdding || wasReconfiguring ? 'settings' : 'home');
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
    setInitialSetupDevice(null);
    setDeviceModal(false);
    setDeviceManagerVisible(wasAdding || wasReconfiguring);
    setActiveTab(wasAdding || wasReconfiguring ? 'settings' : 'home');
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

  const openBluetoothSetup = () => {
    setDeviceManagerVisible(false);
    setAddDisplayVisible(false);
    setReconfigurationSession(null);
    setInitialSetupDevice(null);
    setDeviceModal(true);
    setActiveTab('home');
  };

  const connectDevice = () => {
    if (connected) {
      setDeviceManagerVisible(true);
      return;
    }
    openBluetoothSetup();
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
    setInitialSetupDevice(null);
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
    setInitialSetupDevice(null);
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
    setInitialSetupDevice(null);
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
    if (!connected) {
      openBluetoothSetup();
    }
    else setDeviceManagerVisible(true);
  };

  const toggleDisplayRule = (id, value) => {
    if (contentMode !== 'live') return;
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>{screenTitle}</Text>
          <Text style={styles.topBarSubtitle}>
            {activeTab === 'home' ? '连接、预览与更新照片墙' : activeTab === 'selection' ? '选择 AI 预筛选集合' : '自动更新、照片来源与设备管理'}
          </Text>
        </View>
        {activeTab === 'home' ? (
          <MotionPressable onPress={manageDevice} contentStyle={styles.connectionStatus} scaleTo={0.94}>
            <View style={[styles.onlineDot, !connected && styles.offlineDot]} />
            <Text style={styles.connectionStatusText}>{connected ? '已连接' : '未连接'}</Text>
          </MotionPressable>
        ) : null}
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
                        <Text style={styles.framePlaceholderText}>{previewImageFailed
                          ? '真实效果图加载失败，请重新生成'
                          : contentMode === 'permission' ? '开启相册后生成真实预览' : '等待生成真实效果图'}</Text>
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
                <Text style={styles.settingLabel}>{contentMode === 'demo' ? '示例展示范围' : '当前展示范围'}</Text>
                <Text style={styles.settingValue}>{enabledSelectionCount} 个精选集参与展示</Text>
                <Text style={styles.settingHint}>{nextUpdateLabel} · 在“精选”页调整预筛选集合。</Text>
              </View>
              <MotionPressable onPress={() => setActiveTab('selection')} contentStyle={styles.summaryEditButton} scaleTo={0.93}>
                <Text style={styles.summaryEditText}>查看</Text>
              </MotionPressable>
            </View>

            {!connected ? (
              <ContextCard
                title="当前展示的是示例"
                description="连接照片墙后，保持相同界面并替换为真实设备和相册内容。"
              />
            ) : !photoAllowed ? (
              <ContextCard
                title="设备已连接，下一步开启相册"
                description="允许完整访问后，照片只在 iPhone 上先做自动筛选；你不需要手动选照片。仅候选成品链路会按当前兼容模式同步。"
                actionLabel="开启本机自动发现"
                onAction={startAutomaticDiscovery}
              />
            ) : (
              <>
                <View style={styles.settingCard}>
                  <TemplatePicker
                    templates={wallTemplates}
                    value={selectedTemplateId}
                    onChange={selectWallTemplate}
                    disabled={actionBusy}
                    loading={templatesLoading}
                  />
                  <Text style={styles.settingHint}>{templatesError
                    ? `暂时无法刷新云端模板，正在使用内置清单：${templatesError}`
                    : '选择模板后生成效果图，确认画面后即可发布。'}</Text>
                </View>
                {!recognizedPhotoCount ? (
                  <ContextCard
                    title="还没有可生成的照片"
                    description="从完整相册自动发现人物、主题和高质量照片，不需要手动选择照片。"
                    actionLabel="开始自动发现"
                    onAction={startAutomaticDiscovery}
                  />
                ) : null}
                {!canPublish ? (
                  <ContextCard
                    title="可查看预览，暂不能手动投屏"
                    description="家庭所有者开启你的投屏权限后，这里的发布按钮会自动可用。"
                  />
                ) : null}
                {generatedWall ? (
                  <ActionButton disabled={actionBusy || !canPublish} loading={actionBusy} onPress={confirmGeneratedWall}>
                    {publishing
                      ? '正在提交发布…'
                      : deliveryInProgress
                        ? operation.state === 'downloading'
                          ? '照片墙正在下载…'
                          : operation.state === 'displaying'
                            ? '照片墙正在刷新…'
                            : '已下发，等待照片墙刷新…'
                        : canPublish ? '发布到照片墙' : '等待所有者开启投屏权限'}
                  </ActionButton>
                ) : (
                  <ActionButton
                    disabled={actionBusy || (selectedTemplateId === PET_COLLAGE_TEMPLATE.id ? IS_WEB_PREVIEW || !photoAllowed : !recognizedPhotoCount)}
                    loading={publishing}
                    onPress={selectedTemplateId === PET_COLLAGE_TEMPLATE.id ? createPetCollagePreview : generateTemplatePreview}
                  >
                    {publishing
                      ? '正在生成…'
                      : recognizedPhotoCount || selectedTemplateId === PET_COLLAGE_TEMPLATE.id
                        ? `生成${selectedWallTemplate.label}效果图`
                        : '同步照片后生成效果图'}
                  </ActionButton>
                )}
              </>
            )}
          </>
        ) : null}

        {activeTab === 'selection' ? (
          <>
            <SectionHeading
              title="AI 精选集"
              description="照片已先经过画质过滤、去重和内容识别；这里只选择要参与展示的集合。"
            />
            {contentMode === 'demo' ? (
              <ContextCard
                title="示例精选集"
                description="连接照片墙并同步来源后，这里会显示从真实照片中预筛选出的集合。"
                actionLabel="连接照片墙"
                onAction={() => setActiveTab('home')}
              />
            ) : contentMode === 'permission' ? (
              <ContextCard
                title="开启照片权限"
                description="完整相册会先在 iPhone 本机分析，不需要你逐张选择。"
                actionLabel="开启本机自动发现"
                onAction={startAutomaticDiscovery}
              />
            ) : (
              <ContextCard
                tone="green"
                title="AI 精选已就绪"
                description={`已从 ${recognitionSnapshot.total} 张来源照片中保留 ${recognitionSnapshot.goodTotal} 张可展示照片。`}
              />
            )}
            {recognizedItems.length ? (
              <>
                <View style={styles.selectionSummary}>
                  <View>
                    <Text style={styles.selectionSummaryValue}>{enabledSelectionCount}</Text>
                    <Text style={styles.selectionSummaryLabel}>个精选集参与展示</Text>
                  </View>
                  <View style={styles.selectionSummaryDivider} />
                  <View style={styles.flex}>
                    <Text style={styles.selectionSummaryText}>{selectionIsSample ? '示例包含' : '已生成'} {recognizedItems.length} 个预筛选集合，可组合参与下一次模板生成。</Text>
                  </View>
                </View>
                <SelectionGroup
                  title="精选集"
                  description="由云端按人物、宠物、主题、氛围和画质自动整理"
                  items={recognizedItems}
                  rules={displayRules}
                  onToggle={toggleDisplayRule}
                  disabled={selectionIsSample}
                  sample={selectionIsSample}
                />
              </>
            ) : (
              <View style={styles.permissionGate}>
                <View style={styles.permissionGateIcon}><Text style={styles.permissionGateIconText}>◌</Text></View>
                <Text style={styles.heroTitle}>{recognitionLoading ? '正在读取识别结果' : '还没有可管理的内容'}</Text>
                <Text style={styles.cardDescription}>{recognitionLoading
                  ? '正在从云端读取预筛选集合。'
                  : '请到“设置”选择照片来源；同步和筛选完成后，精选集会自动出现在这里。'}</Text>
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

            <SectionHeading title="本机照片发现" description="自动分析完整相册，不要求用户手动选择照片。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>照片权限</Text>
              <Text style={styles.settingValue}>{permissionDescription}</Text>
              <Text style={styles.settingHint}>{photoSync ? `当前范围：${photoSync.title}（本机优先，失败时保留兼容回退）` : '尚未建立本机照片索引。原图不会因授权自动上传。'}</Text>
              <ActionButton
                secondary
                onPress={startAutomaticDiscovery}
              >
                {!connected ? '先连接照片墙' : photoAllowed ? '重新扫描完整相册' : '开启本机自动发现'}
              </ActionButton>
              {connected && photoAllowed && !IS_WEB_PREVIEW ? (
                <MotionPressable onPress={() => Linking.openSettings()} contentStyle={styles.settingsLink}>
                  <Text style={styles.settingsLinkText}>管理 iPhone 系统权限</Text>
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
        {!IS_WEB_PREVIEW ? <Text style={styles.footer}>照片仅在你选择相簿并主动同步时上传。</Text> : null}
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
      <NearbyDevicePrompt
        visible={Boolean(nearbyDevicePrompt)}
        device={nearbyDevicePrompt}
        onDismiss={() => setNearbyDevicePrompt(null)}
        onConnect={() => {
          setInitialSetupDevice(nearbyDevicePrompt);
          setNearbyDevicePrompt(null);
          setDeviceModal(true);
          setActiveTab('home');
        }}
      />
      {deviceModal ? (
        <DeviceSetupFlow
          visible={deviceModal}
          session={null}
          existingSession={reconfigurationSession}
          initialDevice={initialSetupDevice}
          autoDiscover={false}
          previewMode={IS_WEB_PREVIEW}
          adapter={IS_WEB_PREVIEW ? null : REAL_DEVICE_SETUP_ADAPTER}
          onClose={closeDeviceSetup}
          onConnected={onConnected}
        />
      ) : null}
      <AlbumModal
        visible={albumModal}
        albums={albums}
        selectedSource={photoSync}
        onClose={() => setAlbumModal(false)}
        onConfirm={syncSelectedAlbums}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <StartupErrorBoundary>
      <PhotoWallApp />
    </StartupErrorBoundary>
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
  buttonContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
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
  moreHeaderMotion: { marginTop: 12 },
  moreHeader: { minHeight: 66, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  moreTitle: { color: C.ink, fontSize: 16, fontWeight: '600' },
  moreHint: { color: C.muted, fontSize: 12, marginTop: 2 },
  moreChevron: { color: C.muted, fontSize: 18, fontWeight: '600' },
  moreBody: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 20, padding: 16, marginTop: 8 },
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
  help: { color: C.muted, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  albumPickerScroll: { maxHeight: 520 },
  albumPickerContent: { paddingBottom: 18 },
  albumGroupTitle: { color: C.ink, fontSize: 15, lineHeight: 20, fontWeight: '700', marginTop: 6, marginBottom: 10 },
  albumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  albumCardMotion: { width: '48.5%' },
  albumCardMotionFeatured: { width: '100%' },
  albumCard: { overflow: 'hidden', minHeight: 166, borderRadius: 18, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line },
  albumCardFeatured: { minHeight: 174 },
  albumCardSelected: { borderColor: C.ink, borderWidth: 2 },
  albumCover: { width: '100%', height: 102, backgroundColor: '#E7E7E7', position: 'relative' },
  albumCoverFeatured: { height: 110 },
  albumCoverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  albumCoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E4E4E4' },
  albumCoverFallbackText: { color: C.ink, fontSize: 28, fontWeight: '700' },
  albumSelectionMark: { position: 'absolute', right: 9, top: 9, width: 23, height: 23, borderRadius: 12, borderWidth: 1.5, borderColor: 'rgba(255,255,255,.92)', backgroundColor: 'rgba(0,0,0,.18)', alignItems: 'center', justifyContent: 'center' },
  albumSelectionMarkActive: { borderColor: C.ink, backgroundColor: C.ink },
  albumSelectionMarkText: { color: C.white, fontSize: 13, lineHeight: 16, fontWeight: '800' },
  albumSelectionMarkTextActive: { color: C.white },
  albumCardBody: { minHeight: 62, paddingHorizontal: 11, paddingVertical: 10, justifyContent: 'center' },
  albumCardTitle: { color: C.ink, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  albumCardMeta: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  albumMoreButton: { minHeight: 42, borderRadius: 14, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  albumMoreButtonText: { color: C.ink, fontSize: 12, fontWeight: '700' },
  albumPickerFooter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, marginHorizontal: -20, paddingHorizontal: 20, paddingTop: 12 },
  albumPickerSelection: { color: C.muted, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  albumConfirmButton: { minHeight: 52, borderRadius: 16, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  albumConfirmButtonText: { color: C.white, fontSize: 15, fontWeight: '700' },
  nearbyDeviceBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.46)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  nearbyDevicePrompt: { width: '100%', maxWidth: 380, borderRadius: 28, backgroundColor: C.paper, paddingHorizontal: 24, paddingTop: 26, paddingBottom: 22, alignItems: 'center' },
  nearbyDeviceClose: { position: 'absolute', right: 13, top: 13, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  nearbyDeviceCloseText: { color: '#C7C7CC', fontSize: 27, lineHeight: 30, fontWeight: '300' },
  nearbyDeviceEyebrow: { color: C.muted, fontSize: 11, letterSpacing: 1.1, fontWeight: '700' },
  nearbyDeviceTitle: { color: C.ink, fontSize: 23, lineHeight: 30, fontWeight: '800', textAlign: 'center', marginTop: 5 },
  nearbyDeviceArtwork: { width: 146, height: 132, alignItems: 'center', justifyContent: 'center', marginTop: 16, marginBottom: 9 },
  nearbyDeviceScreen: { width: 122, height: 91, borderRadius: 8, padding: 8, backgroundColor: C.ink, ...(IS_WEB_PREVIEW ? { boxShadow: '0 12px 24px rgba(0,0,0,.16)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.16, shadowRadius: 18, elevation: 6 }) },
  nearbyDeviceMat: { flex: 1, backgroundColor: '#F2F2F7', alignItems: 'center', justifyContent: 'center' },
  nearbyDeviceGlyph: { color: C.ink, fontSize: 30, lineHeight: 34 },
  nearbyDeviceQuestion: { color: C.ink, fontSize: 18, lineHeight: 25, fontWeight: '700', marginTop: 4 },
  nearbyDeviceHint: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  nearbyDeviceActions: { width: '100%', flexDirection: 'row', gap: 10, marginTop: 22 },
  nearbyDeviceActionMotion: { flex: 1 },
  nearbyDevicePrimary: { minHeight: 48, borderRadius: 15, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  nearbyDevicePrimaryText: { color: C.white, fontSize: 15, fontWeight: '700' },
  nearbyDeviceSecondary: { minHeight: 48, borderRadius: 15, backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  nearbyDeviceSecondaryText: { color: C.ink, fontSize: 15, fontWeight: '700' },
  flex: { flex: 1 },
  bottomNavigation: { position: 'absolute', left: 12, right: 12, bottom: 10, minHeight: 70, borderWidth: 1, borderColor: C.line, borderRadius: 22, backgroundColor: 'rgba(255,255,255,.98)', flexDirection: 'row', padding: 6, ...(IS_WEB_PREVIEW ? { boxShadow: '0 10px 30px rgba(0,0,0,.08)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 24, elevation: 6 }) },
  navMotion: { flex: 1 },
  navItem: { flex: 1, minWidth: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navItemActive: { backgroundColor: C.ink },
  navIcon: { color: '#8E8E93', fontSize: 21, lineHeight: 24 },
  navLabel: { color: '#8E8E93', fontSize: 10, fontWeight: '500' },
  navTextActive: { color: C.white, fontWeight: '700' },
});
