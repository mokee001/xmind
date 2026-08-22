import { useEffect, useMemo, useRef, useState } from 'react';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
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
  generateWall,
  publishGeneratedWall,
  publishJulyCalendar,
  readDisplayStatus,
  sendLocalControl,
  syncPhotoAlbum,
  syncJuly2026Photos,
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
  loadDeviceSession,
  loadPhotoSyncPreference,
  saveDeviceSession,
  savePhotoSyncPreference,
} from './src/sessionStore';
import DeviceSetupFlow from './src/DeviceSetupFlow';

const C = {
  canvas: '#F7F7F7', paper: '#FFFFFF', ink: '#222222', muted: '#717171',
  line: '#EBEBEB', green: '#222222', greenSoft: '#F2F2F2', orange: '#222222',
  orangeSoft: '#F2F2F2', red: '#C13515', redSoft: '#FFF4F1', white: '#FFFFFF',
};

const TABS = [
  { id: 'home', label: '投屏', icon: '▣' },
  { id: 'selection', label: '选择', icon: '◉' },
  { id: 'settings', label: '设置', icon: '⚙︎' },
];

const IS_WEB_PREVIEW = Platform.OS === 'web';
const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;
const WEB_PREVIEW_SESSION = {
  device: { device_id: 'web-preview-frame', name: '客厅照片墙' },
  accountToken: 'preview-only',
  apiBase: DEFAULT_API_BASE,
};

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
  { id: 'source-all', title: '所有照片', assetCount: 1842 },
  { id: 'source-family', title: '家庭时光', assetCount: 214 },
  { id: 'source-travel', title: '旅行记录', assetCount: 146 },
  { id: 'source-pets', title: '毛孩子', assetCount: 89 },
];

const PREVIEW_MEMBERS = [
  { id: 'member-owner', name: '王欢', role: '管理员', avatar: '王', detail: '管理设备与家庭成员' },
  { id: 'member-family', name: '家庭成员', role: '成员', avatar: '家', detail: '照片可以参与展示' },
  { id: 'member-guest', name: '共享用户', role: '成员', avatar: '共', detail: '照片可以参与展示' },
];

const EMPTY_RECOGNIZED_CONTENT = { people: [], topics: [], albums: [] };

function localUrlForDevice(deviceId) {
  const suffix = String(deviceId || '').slice(-4).toLowerCase();
  return suffix ? `http://photowall-${suffix}.local` : null;
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
  provisionWifi: async ({ ssid, password, device }) => {
    const waiter = createProvisionStatusWaiter();
    try {
      await provisionBleWifi({ ssid, password, apiBase: DEFAULT_API_BASE });
      const status = await waiter.promise;
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

function MemberRow({ member, enabled, onToggle, sample = false, disabled = false }) {
  return (
    <View style={styles.memberRow}>
      <View style={styles.memberAvatar}><Text style={styles.memberAvatarText}>{member.avatar}</Text></View>
      <View style={styles.flex}>
        <View style={styles.inlineTitleRow}>
          <Text style={styles.selectionTitle}>{member.name}</Text>
          <Text style={styles.memberRole}>{member.role}</Text>
          {sample ? <Text style={styles.samplePill}>示例</Text> : null}
        </View>
        <Text style={styles.selectionDetail}>{member.detail}</Text>
      </View>
      <MonochromeSwitch
        value={enabled}
        disabled={disabled}
        onValueChange={onToggle}
      />
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

function AlbumModal({ visible, albums, onClose, onSelect }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View><Text style={styles.modalEyebrow}>照片同步</Text><Text style={styles.modalTitle}>选择相簿</Text></View>
            <MotionPressable onPress={onClose} contentStyle={styles.close}><Text style={styles.closeText}>取消</Text></MotionPressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.help}>仅同步你在这里选定的相簿；之后只上传云端还未处理的新照片。</Text>
            {albums.map(album => (
              <MotionPressable key={album.id} onPress={() => onSelect(album)} style={styles.albumRowMotion} contentStyle={styles.albumRow}>
                <View style={styles.flex}>
                  <Text style={styles.cardTitle}>{album.title}</Text>
                  <Text style={styles.cardDescription}>{album.assetCount || 0} 张照片</Text>
                </View>
                <Text style={styles.moreChevron}>›</Text>
              </MotionPressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [session, setSession] = useState(null);
  const screenMotion = useRef(new Animated.Value(1)).current;
  const [webConnected, setWebConnected] = useState(false);
  const [webPhotoAuthorized, setWebPhotoAuthorized] = useState(false);
  const [permission, setPermission] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [albumModal, setAlbumModal] = useState(false);
  const [albums, setAlbums] = useState([]);
  const [photoSync, setPhotoSync] = useState(null);
  const [generatedWall, setGeneratedWall] = useState(null);
  const [deviceModal, setDeviceModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [operation, setOperation] = useState({ state: 'idle', progress: 0, message: '尚未开始发布' });
  const [lastAction, setLastAction] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [updateFrequency, setUpdateFrequency] = useState('每天');
  const [updateTime, setUpdateTime] = useState('20:00');
  const [displayPlan, setDisplayPlan] = useState('每日精选');
  const [memberRules, setMemberRules] = useState(() => Object.fromEntries(
    PREVIEW_MEMBERS.map(member => [member.id, true]),
  ));
  const [displayRules, setDisplayRules] = useState(() => Object.fromEntries(
    Object.values(PREVIEW_RECOGNIZED_CONTENT).flat().map(item => [item.id, true]),
  ));

  const effectiveSession = IS_WEB_PREVIEW && webConnected ? WEB_PREVIEW_SESSION : session;
  const photoAllowed = IS_WEB_PREVIEW ? webPhotoAuthorized : permission?.status === 'granted';
  const connected = IS_WEB_PREVIEW ? webConnected : Boolean(session?.device?.device_id);
  const contentMode = !connected ? 'demo' : !photoAllowed ? 'permission' : 'live';
  const recognizedContent = contentMode !== 'live' || IS_WEB_PREVIEW
    ? PREVIEW_RECOGNIZED_CONTENT
    : EMPTY_RECOGNIZED_CONTENT;
  const recognizedItems = Object.values(recognizedContent).flat();
  const enabledSelectionCount = recognizedItems.filter(item => displayRules[item.id] !== false).length;
  const selectionIsSample = contentMode !== 'live';
  const nextUpdateLabel = updateFrequency === '关闭' ? '自动更新已关闭' : `${updateFrequency} ${updateTime} 自动更新`;
  const householdMembers = connected && !IS_WEB_PREVIEW
    ? [{ id: 'member-owner', name: '当前用户', role: '管理员', avatar: '我', detail: '管理设备与家庭成员' }]
    : PREVIEW_MEMBERS;
  const permissionDescription = useMemo(() => {
    if (IS_WEB_PREVIEW) return webPhotoAuthorized ? '已模拟允许访问照片。' : '尚未模拟开启照片权限。';
    if (!permission) return '正在检查 iPhone 相册权限…';
    if (permission.status !== 'granted') return '需要允许访问，才能选择照片。';
    if (permission.accessPrivileges === 'limited') return '已允许访问你选择的照片。';
    return '已允许访问照片。';
  }, [permission, webPhotoAuthorized]);

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
    if (IS_WEB_PREVIEW) return;
    loadDeviceSession().then(saved => {
      if (saved?.device?.device_id) {
        setSession({
          ...saved,
          apiBase: DEFAULT_API_BASE,
          localUrl: saved.localUrl || localUrlForDevice(saved.device.device_id),
        });
      }
    });
    loadPhotoSyncPreference().then(setPhotoSync);
    refreshPermission().catch(e => setError(`检查照片权限失败：${e.message}`));
  }, []);

  useEffect(() => {
    if (IS_WEB_PREVIEW || !connected || permission?.status !== 'undetermined') return;
    requestPhotoPermission().catch(() => {});
  }, [connected, permission?.status]);

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

  const simulateWebPublish = async kind => {
    setLastAction(kind);
    setPublishing(true); setError(''); setNotice('');
    const steps = [
      { state: 'scanning', progress: 20, message: '预览：正在查找七月照片' },
      { state: 'generating', progress: 70, message: '预览：正在生成日历' },
      { state: 'queued', progress: 100, message: '预览：发布任务已排队' },
    ];
    for (const step of steps) {
      setOperation(step);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    setNotice('这是网页交互预览，没有数据被上传。');
    setPublishing(false);
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
        accountToken: session?.accountToken,
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
      const available = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const nonEmpty = available.filter(album => (album.assetCount || 0) > 0);
      if (!nonEmpty.length) throw new Error('没有找到包含照片的相簿');
      setAlbums(nonEmpty);
      setAlbumModal(true);
    } catch (caught) {
      setError(`无法读取相簿：${caught.message}`);
    }
  };

  const syncSelectedAlbum = async album => {
    setAlbumModal(false);
    setPhotoSync({ id: album.id, title: album.title });
    if (IS_WEB_PREVIEW) {
      setNotice(`网页预览已将照片来源切换为“${album.title}”，没有读取或上传照片。`);
      return;
    }
    setPublishing(true); setError(''); setNotice(''); setLastAction('album');
    setOperation({ state: 'scanning', progress: 0, message: `正在读取“${album.title}”中的新照片` });
    try {
      const synced = await syncPhotoAlbum({
        apiBase: DEFAULT_API_BASE,
        accountToken: session?.accountToken,
        album,
        onProgress: update => setOperation({
          state: update.stage === 'scanning' ? 'scanning' : 'uploading',
          progress: update.progress || 0,
          message: update.stage === 'scanning'
            ? `正在检查新增照片 · 已找到 ${update.scanned || 0} 张`
            : `正在上传新照片 · ${update.progress || 0}%`,
        }),
      });
      await savePhotoSyncPreference({ id: album.id, title: album.title });
      setOperation({ state: 'idle', progress: 100, message: synced.unchanged ? '没有需要同步的新照片' : '同步完成，可以生成模板预览' });
      setNotice(synced.unchanged ? '这个相簿没有新的照片需要上传。' : `已同步 ${synced.synced} 张新照片，云端已完成打标和去重。`);
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`相簿同步失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const generateTemplatePreview = async () => {
    setPublishing(true); setError(''); setNotice(''); setLastAction('template');
    setOperation({ state: 'generating', progress: 40, message: '云端正在筛选照片并生成模板' });
    try {
      const wall = IS_WEB_PREVIEW
        ? await new Promise(resolve => setTimeout(() => resolve({ previewOnly: true, chosen: recognizedItems.slice(0, 6) }), 700))
        : await generateWall({ apiBase: DEFAULT_API_BASE, accountToken: session?.accountToken });
      setGeneratedWall(wall);
      setActiveTab('home');
      setOperation({ state: 'idle', progress: 100, message: '模板预览已生成，等待确认发布' });
      setNotice(`云端已从 ${wall.chosen?.length || 0} 张候选照片中生成模板预览。`);
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板生成失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const confirmGeneratedWall = async () => {
    if (!generatedWall || (!IS_WEB_PREVIEW && !session)) return;
    setPublishing(true); setError(''); setNotice(''); setLastAction('template');
    try {
      if (IS_WEB_PREVIEW) {
        await new Promise(resolve => setTimeout(resolve, 650));
        setOperation({ state: 'queued', progress: 100, message: '精选内容已排队，等待照片墙刷新' });
        setNotice('网页预览已模拟发布；没有上传任何照片。');
        return;
      }
      const result = await publishGeneratedWall({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
      });
      const nextSession = { ...session, device: result.device || session.device, apiBase: DEFAULT_API_BASE };
      setSession(nextSession);
      await saveDeviceSession(nextSession);
      setOperation({ state: 'queued', progress: 100, message: '模板已确认发布，等待墨水屏下载' });
      setNotice('模板已下发到照片墙，手机可以离开当前页面。');
    } catch (caught) {
      setOperation({ state: 'failed', progress: 0, message: caught.message });
      setError(`模板发布失败：${caught.message}`);
    } finally { setPublishing(false); }
  };

  const retry = () => {
    if (lastAction === 'calendar') publishCalendar();
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
    if (IS_WEB_PREVIEW) {
      setWebConnected(true);
      setDeviceModal(false);
      setActiveTab('home');
      return;
    }
    const normalized = {
      ...next,
      apiBase: DEFAULT_API_BASE,
      localUrl: next.localUrl || localUrlForDevice(next.device?.device_id),
    };
    setSession(normalized);
    await saveDeviceSession(normalized);
    setDeviceModal(false);
    setActiveTab('home');
  };

  const connectDevice = () => {
    setDeviceModal(false);
    setActiveTab('home');
  };

  const manageDevice = () => {
    if (IS_WEB_PREVIEW && connected) {
      setWebConnected(false);
      setWebPhotoAuthorized(false);
      setGeneratedWall(null);
    }
    else if (!connected) {
      setDeviceModal(false);
      setActiveTab('home');
    }
    else setDeviceModal(true);
  };

  const toggleDisplayRule = (id, value) => {
    if (contentMode !== 'live') return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDisplayRules(current => ({ ...current, [id]: value }));
  };

  const toggleMemberRule = (id, value) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMemberRules(current => ({ ...current, [id]: value }));
  };

  const toggleMore = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMoreOpen(value => !value);
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
            {activeTab === 'home' ? '连接、预览与更新照片墙' : activeTab === 'selection' ? '决定哪些内容可以展示' : '自动更新、照片来源与家庭成员'}
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
              <View style={styles.frameShadow}>
                <View style={styles.frameOuter}>
                  <View style={styles.frameMat}>
                    {generatedWall?.image_url ? (
                      <Image source={{ uri: `${DEFAULT_API_BASE}${generatedWall.image_url}` }} style={styles.framePhoto} />
                    ) : contentMode === 'demo' || generatedWall?.previewOnly ? (
                      <View style={styles.curatedArtwork}>
                        {contentMode === 'demo' ? <Text style={styles.artSampleBadge}>示例</Text> : null}
                        <Text style={styles.curatedEyebrow}>PHOTO WALL</Text>
                        <Text style={styles.curatedTitle}>今日精选</Text>
                        <View style={styles.curatedGrid}>
                          <View style={[styles.curatedTile, styles.curatedTileBlue]}><Text style={styles.curatedTileText}>家人</Text></View>
                          <View style={[styles.curatedTile, styles.curatedTileGreen]}><Text style={styles.curatedTileText}>旅行</Text></View>
                          <View style={[styles.curatedTile, styles.curatedTileOrange]}><Text style={styles.curatedTileText}>生活</Text></View>
                        </View>
                      </View>
                    ) : (
                      <View style={styles.framePlaceholder}>
                        <Text style={styles.framePlaceholderIcon}>{contentMode === 'permission' ? '◎' : '◌'}</Text>
                        <Text style={styles.framePlaceholderText}>{contentMode === 'permission' ? '开启相册后生成真实预览' : '等待生成精选预览'}</Text>
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
            <View style={styles.displaySummaryCard}>
              <View style={styles.flex}>
                <Text style={styles.settingLabel}>{contentMode === 'demo' ? '示例展示范围' : '当前展示范围'}</Text>
                <Text style={styles.settingValue}>{enabledSelectionCount} 项内容参与精选</Text>
                <Text style={styles.settingHint}>{nextUpdateLabel} · 在“选择”页调整人物、内容分类和相簿。</Text>
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
                description="iPhone 会显示系统授权窗口。允许后才能识别人物、内容分类和相簿。"
                actionLabel="允许访问照片"
                onAction={requestPhotoPermission}
              />
            ) : (
              <>
                {generatedWall ? (
                  <ActionButton disabled={publishing} onPress={confirmGeneratedWall}>
                    {publishing ? '正在发布…' : '发布到照片墙'}
                  </ActionButton>
                ) : (
                  <ActionButton disabled={publishing || !enabledSelectionCount} onPress={generateTemplatePreview}>
                    {publishing ? '正在生成…' : '生成精选预览'}
                  </ActionButton>
                )}
                <MotionPressable onPress={toggleMore} style={styles.moreHeaderMotion} contentStyle={styles.moreHeader}>
                  <View>
                    <Text style={styles.moreTitle}>更多发布方式</Text>
                    <Text style={styles.moreHint}>家庭日历等特殊版式</Text>
                  </View>
                  <Text style={styles.moreChevron}>{moreOpen ? '⌃' : '⌄'}</Text>
                </MotionPressable>
                {moreOpen ? (
                  <View style={styles.moreBody}>
                    <Text style={styles.cardTitle}>2026 年 7 月家庭日历</Text>
                    <Text style={styles.cardDescription}>使用当前允许展示的照片，由云端生成并发布。</Text>
                    <ActionButton disabled={!photoAllowed || publishing} onPress={publishCalendar}>
                      {publishing && lastAction === 'calendar' ? '正在同步并发布…' : '发布七月日历'}
                    </ActionButton>
                  </View>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {activeTab === 'selection' ? (
          <>
            <SectionHeading
              title="选择展示内容"
              description="这里只控制照片墙展示范围，不会删除或修改手机里的照片。"
            />
            {contentMode === 'demo' ? (
              <ContextCard
                title="示例内容"
                description="连接照片墙并开启相册后，这些位置会显示你真实识别出的人物、内容分类和相簿。"
                actionLabel="连接照片墙"
                onAction={() => setActiveTab('home')}
              />
            ) : contentMode === 'permission' ? (
              <ContextCard
                title="开启照片权限"
                description="下面先展示示例结构。授权后会在原位置替换为你的真实内容。"
                actionLabel="允许访问照片"
                onAction={requestPhotoPermission}
              />
            ) : (
              <ContextCard
                tone="green"
                title="正在使用真实相册内容"
                description="修改开关只影响照片墙展示，不会改动手机里的照片。"
              />
            )}
            {recognizedItems.length ? (
              <>
                <View style={styles.selectionSummary}>
                  <View>
                    <Text style={styles.selectionSummaryValue}>{enabledSelectionCount}</Text>
                    <Text style={styles.selectionSummaryLabel}>项参与展示</Text>
                  </View>
                  <View style={styles.selectionSummaryDivider} />
                  <View style={styles.flex}>
                    <Text style={styles.selectionSummaryText}>{selectionIsSample ? '示例包含' : '已识别'} {recognizedContent.people.length} 组人物、{recognizedContent.topics.length} 个内容分类和 {recognizedContent.albums.length} 个相簿。</Text>
                  </View>
                </View>
                <SelectionGroup
                  title="人物"
                  description="选择照片墙里可以出现的人"
                  items={recognizedContent.people}
                  rules={displayRules}
                  onToggle={toggleDisplayRule}
                  disabled={selectionIsSample}
                  sample={selectionIsSample}
                />
                <SelectionGroup
                  title="内容分类"
                  description="选择希望持续展示的内容类型"
                  items={recognizedContent.topics}
                  rules={displayRules}
                  onToggle={toggleDisplayRule}
                  disabled={selectionIsSample}
                  sample={selectionIsSample}
                />
                <SelectionGroup
                  title="相簿"
                  description="控制整个相簿是否参与精选"
                  items={recognizedContent.albums}
                  rules={displayRules}
                  onToggle={toggleDisplayRule}
                  disabled={selectionIsSample}
                  sample={selectionIsSample}
                />
              </>
            ) : (
              <View style={styles.permissionGate}>
                <View style={styles.permissionGateIcon}><Text style={styles.permissionGateIconText}>◌</Text></View>
                <Text style={styles.heroTitle}>正在等待识别结果</Text>
                <Text style={styles.cardDescription}>相册识别接口接入后，人物、主题和相簿会自动出现在这里。</Text>
              </View>
            )}
          </>
        ) : null}

        {activeTab === 'settings' ? (
          <>
            <SectionHeading title="家庭成员" description="管理连接到这个照片墙的用户，以及他们的照片是否参与展示。" />
            {!connected ? (
              <ContextCard title="成员示例" description="连接设备后可以邀请家庭成员，并设置每个人的共享权限。" />
            ) : null}
            <View style={styles.settingCardFlush}>
              {householdMembers.map((member, index) => (
                <View key={member.id} style={index > 0 && styles.selectionRowBorder}>
                  <MemberRow
                    member={member}
                    enabled={memberRules[member.id] !== false}
                    onToggle={value => toggleMemberRule(member.id, value)}
                    sample={!connected || IS_WEB_PREVIEW}
                    disabled={!connected}
                  />
                </View>
              ))}
            </View>
            <ActionButton
              secondary
              disabled={!connected}
              onPress={() => setNotice('成员邀请界面已预留，接入家庭成员接口后可发送邀请。')}
            >
              邀请家庭成员
            </ActionButton>

            <SectionHeading title="自动更新" description="App 不打开时，也按这里的规则由云端生成并投屏。" />
            <View style={styles.settingCard}>
              <ChoiceRow label="更新频次" options={['每天', '每周', '关闭']} value={updateFrequency} onChange={setUpdateFrequency} disabled={!connected} />
              <ChoiceRow label="更新时间" options={['08:00', '12:00', '20:00']} value={updateTime} onChange={setUpdateTime} disabled={!connected || updateFrequency === '关闭'} />
              <ChoiceRow label="展示方案" options={['每日精选', '人物优先', '旅行回忆']} value={displayPlan} onChange={setDisplayPlan} disabled={!connected} />
              <Text style={styles.settingHint}>{connected ? `${nextUpdateLabel} · ${displayPlan}` : '连接设备后可以保存自动更新计划。'}</Text>
            </View>

            <SectionHeading title="照片来源" description="选择允许照片墙读取和同步的 iPhone 相簿。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingLabel}>照片权限</Text>
              <Text style={styles.settingValue}>{permissionDescription}</Text>
              <Text style={styles.settingHint}>{photoSync ? `当前来源：${photoSync.title}（仅上传新增照片）` : '尚未选择参与精选的相簿。'}</Text>
              <ActionButton
                secondary
                onPress={!connected ? connectDevice : photoAllowed ? openAlbumPicker : requestPhotoPermission}
              >
                {!connected ? '先连接照片墙' : photoAllowed ? '选择照片来源' : '允许访问照片'}
              </ActionButton>
              {connected && photoAllowed && !IS_WEB_PREVIEW ? (
                <MotionPressable onPress={() => Linking.openSettings()} contentStyle={styles.settingsLink}>
                  <Text style={styles.settingsLinkText}>管理 iPhone 系统权限</Text>
                </MotionPressable>
              ) : null}
            </View>

            <SectionHeading title="设备" description="查看照片墙状态或重新进入连接流程。" />
            <View style={styles.settingCard}>
              <Text style={styles.settingValue}>{connected ? effectiveSession.device.name || '客厅照片墙' : '尚未绑定'}</Text>
              <Text style={styles.settingHint}>{connected ? effectiveSession.device.device_id : '通过蓝牙发现并完成首次配对。'}</Text>
              <ActionButton secondary onPress={connected ? manageDevice : connectDevice}>
                {IS_WEB_PREVIEW ? (connected ? '切换为未连接' : '进入连接流程') : (connected ? '查看设备' : '连接设备')}
              </ActionButton>
              {connected && !IS_WEB_PREVIEW ? (
                <ActionButton secondary disabled={publishing} onPress={testLocalControl}>
                  {publishing ? '正在测试连接…' : '测试局域网连接'}
                </ActionButton>
              ) : null}
            </View>
            <SectionHeading title="发布记录" description="查看最近一次上传和屏幕刷新状态。" />
            {operationCard}
          </>
        ) : null}

        {!connected ? (
          <View style={activeTab === 'home' ? undefined : styles.setupFlowHidden}>
            <DeviceSetupFlow
              embedded
              visible
              session={null}
              previewMode={IS_WEB_PREVIEW}
              adapter={IS_WEB_PREVIEW ? null : REAL_DEVICE_SETUP_ADAPTER}
              onClose={() => {}}
              onConnected={onConnected}
            />
          </View>
        ) : null}

        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>✓ {notice}</Text></View> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        {!IS_WEB_PREVIEW ? <Text style={styles.footer}>照片仅在你选择相簿并主动同步时上传。</Text> : null}
        </Animated.View>
      </ScrollView>

      <BottomNavigation activeTab={activeTab} onChange={setActiveTab} />
      {connected ? (
        <DeviceSetupFlow
          visible={deviceModal}
          session={effectiveSession}
          previewMode={IS_WEB_PREVIEW}
          adapter={IS_WEB_PREVIEW ? null : REAL_DEVICE_SETUP_ADAPTER}
          onClose={() => setDeviceModal(false)}
          onConnected={onConnected}
        />
      ) : null}
      <AlbumModal
        visible={albumModal}
        albums={albums}
        onClose={() => setAlbumModal(false)}
        onSelect={syncSelectedAlbum}
      />
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
  setupFlowHidden: { display: 'none' },
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
  frameOuter: { padding: 11, backgroundColor: '#1C1C1E' },
  frameMat: { padding: 14, backgroundColor: '#FFFFFF' },
  framePhoto: { width: '100%', aspectRatio: 4 / 3, resizeMode: 'cover', backgroundColor: '#F2F2F7' },
  framePlaceholder: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#F2F2F7', alignItems: 'center', justifyContent: 'center' },
  framePlaceholderIcon: { color: C.ink, fontSize: 32 },
  framePlaceholderText: { color: C.muted, fontSize: 12, marginTop: 7 },
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
  settingCardFlush: { overflow: 'hidden', backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 20, marginBottom: 2 },
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
  memberRow: { minHeight: 76, paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12 },
  memberAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1C1C1E', alignItems: 'center', justifyContent: 'center' },
  memberAvatarText: { color: C.white, fontSize: 14, fontWeight: '700' },
  memberRole: { color: C.white, fontSize: 9, lineHeight: 16, fontWeight: '700', paddingHorizontal: 7, borderRadius: 8, backgroundColor: C.ink, overflow: 'hidden' },
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
