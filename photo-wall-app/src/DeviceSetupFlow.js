import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const COLORS = {
  canvas: '#F7F7F7',
  paper: '#FFFFFF',
  ink: '#222222',
  muted: '#717171',
  line: '#EBEBEB',
  blue: '#222222',
  blueSoft: '#F2F2F2',
  green: '#222222',
  greenSoft: '#F2F2F2',
  red: '#C13515',
  redSoft: '#FFF4F1',
};

const PREVIEW_DEVICES = [
  { deviceId: 'pwe6-preview-a6f2', deviceName: 'PhotoWall-A6F2', signalStrength: -42 },
];

const PREVIEW_NETWORKS = [
  { ssid: '家里的 Wi-Fi', signalStrength: -38, secure: true },
  { ssid: 'Mokee Studio', signalStrength: -55, secure: true },
  { ssid: 'ChinaNet-5G', signalStrength: -68, secure: true },
];

const wait = duration => new Promise(resolve => setTimeout(resolve, duration));

function signalBars(value = -80) {
  if (value >= -48) return 3;
  if (value >= -65) return 2;
  return 1;
}

function Signal({ strength }) {
  const bars = signalBars(strength);
  return (
    <View style={styles.signal}>
      {[1, 2, 3].map(index => (
        <View key={index} style={[styles.signalBar, { height: 4 + index * 3 }, index <= bars && styles.signalBarActive]} />
      ))}
    </View>
  );
}

function PrimaryButton({ children, onPress, secondary = false, disabled = false }) {
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
    <Animated.View style={[styles.primaryButtonMotion, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => !disabled && animateTo(0.97)}
        onPressOut={() => animateTo(1)}
        style={[styles.primaryButton, secondary && styles.secondaryButton, disabled && styles.buttonDisabled]}
      >
        <Text style={[styles.primaryButtonText, secondary && styles.secondaryButtonText]}>{children}</Text>
      </Pressable>
    </Animated.View>
  );
}

function ProgressHeader({ stage }) {
  const activeIndex = stage === 'device' ? 0 : stage === 'wifi' || stage === 'password' ? 1 : 2;
  return (
    <View style={styles.progressHeader}>
      {['发现设备', '连接网络', '完成'].map((label, index) => (
        <View key={label} style={styles.progressItem}>
          <View style={[styles.progressDot, index <= activeIndex && styles.progressDotActive]} />
          <Text style={[styles.progressLabel, index <= activeIndex && styles.progressLabelActive]}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export default function DeviceSetupFlow({
  visible,
  session,
  onClose,
  onConnected,
  previewMode = false,
  adapter = null,
  embedded = false,
}) {
  const [stage, setStage] = useState('device');
  const [devices, setDevices] = useState([]);
  const [networks, setNetworks] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const stageMotion = useRef(new Animated.Value(1)).current;
  const pulseMotion = useRef(new Animated.Value(0)).current;
  const discoveryStopRef = useRef(null);
  const discoveryTimeoutRef = useRef(null);
  const flowGenerationRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const wifiScanRequestRef = useRef(0);
  const deviceConnectionRef = useRef(false);

  const transition = nextStage => {
    stageMotion.setValue(0);
    setStage(nextStage);
    Animated.timing(stageMotion, {
      toValue: 1,
      duration: 340,
      easing: Easing.bezier(0.2, 0.82, 0.2, 1),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };

  useEffect(() => {
    if (stage !== 'connecting') {
      pulseMotion.setValue(0);
      return undefined;
    }
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(pulseMotion, {
        toValue: 1,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(pulseMotion, {
        toValue: 0,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]));
    pulse.start();
    return () => pulse.stop();
  }, [stage]);

  useEffect(() => {
    if (!visible || previewMode || !adapter?.subscribeProvisionStatus) return undefined;
    return adapter.subscribeProvisionStatus(status => {
      if (status?.message) setStatusText(status.message);
      if (status?.status === 'awaiting_confirmation') setProgress(current => Math.max(current, 10));
      if (status?.status === 'idle') setProgress(current => Math.max(current, 22));
      if (status?.status === 'connecting') setProgress(current => Math.max(current, 58));
      if (status?.status === 'connected') setProgress(100);
    });
  }, [visible, previewMode, adapter]);

  useEffect(() => () => {
    flowGenerationRef.current += 1;
    wifiScanRequestRef.current = 0;
    deviceConnectionRef.current = false;
    if (discoveryTimeoutRef.current) clearTimeout(discoveryTimeoutRef.current);
    discoveryStopRef.current?.();
  }, []);

  const discoverDevices = async () => {
    if (discoveryTimeoutRef.current) clearTimeout(discoveryTimeoutRef.current);
    await discoveryStopRef.current?.();
    discoveryStopRef.current = null;
    setBusy(true);
    setError('');
    setDevices([]);
    let scanContinues = false;
    try {
      if (previewMode) {
        await wait(650);
        setDevices(PREVIEW_DEVICES);
        return;
      }
      if (!adapter?.startDeviceDiscovery) {
        throw new Error('蓝牙连接能力正在接入，请等待固件接口完成后使用真机测试。');
      }
      const stop = await adapter.startDeviceDiscovery(device => {
        if (!device?.deviceId) return;
        setDevices(current => {
          const next = current.filter(item => item.deviceId !== device.deviceId);
          return [...next, device].sort((left, right) => right.signalStrength - left.signalStrength);
        });
        setBusy(false);
      });
      discoveryStopRef.current = typeof stop === 'function' ? stop : adapter.stopDeviceDiscovery;
      discoveryTimeoutRef.current = setTimeout(() => setBusy(false), 12000);
      scanContinues = true;
    } catch (caught) {
      setError(caught.message || '没有发现附近的照片墙');
    } finally {
      if (!scanContinues) setBusy(false);
    }
  };

  useEffect(() => {
    if (!visible || session) return;
    setStage('device');
    setDevices([]);
    setNetworks([]);
    setSelectedDevice(null);
    setSelectedNetwork(null);
    setPassword('');
    setShowPassword(false);
    setProgress(0);
    setStatusText('');
    setError('');
    setResult(null);
    discoverDevices();
  }, [visible, session]);

  const scanConnectedNetworks = async () => {
    if (wifiScanRequestRef.current) return;
    const generation = flowGenerationRef.current;
    const requestId = ++requestSequenceRef.current;
    wifiScanRequestRef.current = requestId;
    setBusy(true);
    setError('');
    setStatusText('已连接，正在读取附近网络…');
    try {
      const found = await adapter.scanWifiNetworks();
      if (flowGenerationRef.current !== generation) return;
      setNetworks(Array.isArray(found) ? found : []);
    } catch (caught) {
      if (flowGenerationRef.current !== generation) return;
      setError(caught.message || '无法读取附近的 Wi-Fi');
    } finally {
      if (wifiScanRequestRef.current === requestId) {
        wifiScanRequestRef.current = 0;
        if (flowGenerationRef.current === generation) setBusy(false);
      }
    }
  };

  const chooseDevice = async device => {
    if (deviceConnectionRef.current) return;
    deviceConnectionRef.current = true;
    if (discoveryTimeoutRef.current) clearTimeout(discoveryTimeoutRef.current);
    await discoveryStopRef.current?.();
    discoveryStopRef.current = null;
    setSelectedDevice(device);
    setBusy(true);
    setError('');
    setStatusText('正在连接照片墙…');
    transition('wifi');
    try {
      if (previewMode) {
        await wait(650);
        setNetworks(PREVIEW_NETWORKS);
        return;
      }
      const connected = await adapter.connectProvisioningDevice(device.deviceId);
      setSelectedDevice(current => ({ ...current, ...connected }));
      await scanConnectedNetworks();
    } catch (caught) {
      setError(caught.message || '无法读取附近的 Wi-Fi');
    } finally {
      deviceConnectionRef.current = false;
      setBusy(false);
    }
  };

  const restartDeviceConnection = async () => {
    flowGenerationRef.current += 1;
    wifiScanRequestRef.current = 0;
    deviceConnectionRef.current = false;
    setBusy(true);
    setError('');
    try { await adapter?.cancelProvisioning?.(); } catch {}
    setNetworks([]);
    setSelectedDevice(null);
    setSelectedNetwork(null);
    setPassword('');
    setStatusText('');
    transition('device');
    await discoverDevices();
  };

  const chooseNetwork = network => {
    setSelectedNetwork(network);
    setPassword('');
    setError('');
    transition('password');
  };

  const finishPreviewConnection = async () => {
    const messages = [
      [18, '正在安全发送网络信息'],
      [48, `照片墙正在加入“${selectedNetwork.ssid}”`],
      [76, '设备已联网，正在自动绑定'],
      [100, '连接完成'],
    ];
    for (const [nextProgress, message] of messages) {
      setProgress(nextProgress);
      setStatusText(message);
      await wait(520);
    }
    if (password === '00000000') {
      throw new Error('Wi-Fi 密码不正确，请重新输入');
    }
    const previewResult = {
      device: { device_id: selectedDevice.deviceId, name: '客厅照片墙' },
      accountToken: 'preview-only',
      previewOnly: true,
    };
    setResult(previewResult);
    transition('success');
  };

  const connectWifi = async () => {
    if (!selectedNetwork || (selectedNetwork.secure && !password)) return;
    setBusy(true);
    setError('');
    setProgress(6);
    setStatusText('正在准备连接');
    transition('connecting');
    try {
      if (previewMode) {
        await finishPreviewConnection();
        return;
      }
      if (!adapter?.provisionWifi) throw new Error('蓝牙配网接口尚未接入');
      const provisioned = await adapter.provisionWifi({
        ssid: selectedNetwork.ssid,
        password,
        device: selectedDevice,
      });
      setProgress(100);
      setStatusText('连接完成');
      setResult(provisioned);
      transition('success');
    } catch (caught) {
      setError(caught.message || '连接失败，请重试');
      transition('error');
    } finally {
      setBusy(false);
    }
  };

  const retryPassword = () => {
    setPassword('');
    setProgress(0);
    setStatusText('');
    setError('');
    transition('password');
  };

  const finish = async () => {
    if (result) await onConnected(result);
    onClose();
  };

  const close = () => {
    if (discoveryTimeoutRef.current) clearTimeout(discoveryTimeoutRef.current);
    discoveryStopRef.current?.();
    discoveryStopRef.current = null;
    if (!previewMode && !session && stage !== 'success') {
      adapter?.cancelProvisioning?.().catch(() => {});
    }
    onClose();
  };

  const renderBody = () => {
    if (session) {
      return (
        <View style={styles.centeredState}>
          <View style={[styles.stateIcon, styles.successIcon]}><Text style={styles.successMark}>✓</Text></View>
          <Text style={styles.stateTitle}>照片墙已连接</Text>
          <Text style={styles.stateDescription}>{session.device?.name || '客厅照片墙'}</Text>
          <View style={styles.deviceIdentifier}><Text style={styles.deviceIdentifierText}>{session.device?.device_id}</Text></View>
          <PrimaryButton onPress={onClose}>完成</PrimaryButton>
        </View>
      );
    }

    if (stage === 'device') {
      return (
        <>
          <Text style={styles.title}>选择照片墙</Text>
          <Text style={styles.description}>保持照片墙通电并靠近手机，无需进入系统 Wi-Fi 设置。</Text>
          <View style={styles.discoveryArt}>
            <View style={styles.discoveryRingLarge} />
            <View style={styles.discoveryRingSmall} />
            <View style={styles.deviceGlyph}><Text style={styles.deviceGlyphText}>▧</Text></View>
          </View>
          {busy ? <Text style={styles.scanningText}>正在寻找附近设备…</Text> : null}
          {devices.map(device => (
            <Pressable key={device.deviceId} onPress={() => chooseDevice(device)} style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}>
              <View style={styles.listIcon}><Text style={styles.listIconText}>▧</Text></View>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{device.deviceName || 'PhotoWall'}</Text>
                <Text style={styles.rowSubtitle}>就在附近 · 点击连接</Text>
              </View>
              <Signal strength={device.signalStrength} />
            </Pressable>
          ))}
          {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
          {!busy && !devices.length ? <PrimaryButton secondary onPress={discoverDevices}>重新查找</PrimaryButton> : null}
        </>
      );
    }

    if (stage === 'wifi') {
      return (
        <>
          <Text style={styles.title}>选择家庭 Wi-Fi</Text>
          <Text style={styles.description}>以下网络由照片墙扫描得到。请选择设备今后长期使用的网络。</Text>
          <View style={styles.selectedDevicePill}>
            <View style={styles.connectedDot} />
            <Text style={styles.selectedDeviceText}>已连接 {selectedDevice?.deviceName}</Text>
          </View>
          {busy ? <Text style={styles.scanningText}>{statusText || '正在读取附近网络…'}</Text> : null}
          <View style={styles.listGroup}>
            {networks.map(network => (
              <Pressable key={network.ssid} onPress={() => chooseNetwork(network)} style={({ pressed }) => [styles.wifiRow, pressed && styles.rowPressed]}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{network.ssid}</Text>
                  <Text style={styles.rowSubtitle}>{network.secure ? '需要密码' : '开放网络'}</Text>
                </View>
                <Signal strength={network.signalStrength} />
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
          {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
          {!busy && error ? (
            <>
              <PrimaryButton onPress={scanConnectedNetworks}>重新连接 Wi-Fi</PrimaryButton>
              <PrimaryButton secondary onPress={restartDeviceConnection}>重新连接设备</PrimaryButton>
            </>
          ) : null}
        </>
      );
    }

    if (stage === 'password') {
      return (
        <>
          <Pressable onPress={() => transition('wifi')}><Text style={styles.backLink}>‹ 重新选择网络</Text></Pressable>
          <Text style={styles.title}>输入 Wi-Fi 密码</Text>
          <Text style={styles.description}>密码只会通过蓝牙发送给照片墙，App 不会保存。</Text>
          <View style={styles.networkCard}>
            <Text style={styles.networkLabel}>网络</Text>
            <View style={styles.networkNameRow}>
              <Text style={styles.networkName}>{selectedNetwork?.ssid}</Text>
              <Signal strength={selectedNetwork?.signalStrength} />
            </View>
          </View>
          <View style={styles.passwordField}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="输入密码"
              placeholderTextColor="#8E8E93"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.passwordInput}
              onSubmitEditing={connectWifi}
            />
            <Pressable onPress={() => setShowPassword(value => !value)} style={styles.showPasswordButton}>
              <Text style={styles.showPasswordText}>{showPassword ? '隐藏' : '显示'}</Text>
            </Pressable>
          </View>
          <PrimaryButton disabled={selectedNetwork?.secure && !password} onPress={connectWifi}>连接照片墙</PrimaryButton>
          {previewMode ? <Text style={styles.previewHint}>网页预览：输入 00000000 可以查看密码错误状态。</Text> : null}
        </>
      );
    }

    if (stage === 'connecting') {
      return (
        <View style={styles.centeredState}>
          <Animated.View style={[styles.connectingOrb, {
            transform: [{ scale: pulseMotion.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1.04] }) }],
          }]}>
            <View style={styles.connectingOrbCore}><Text style={styles.connectingGlyph}>▧</Text></View>
          </Animated.View>
          <Text style={styles.stateTitle}>正在连接</Text>
          <Text style={styles.stateDescription}>{statusText}</Text>
          <View style={styles.connectionProgress}><View style={[styles.connectionProgressFill, { width: `${progress}%` }]} /></View>
          <Text style={styles.progressValue}>{progress}%</Text>
          <Text style={styles.keepOpenText}>请保持照片墙通电，并让 App 停留在此页面。</Text>
        </View>
      );
    }

    if (stage === 'success') {
      return (
        <View style={styles.centeredState}>
          <View style={[styles.stateIcon, styles.successIcon]}><Text style={styles.successMark}>✓</Text></View>
          <Text style={styles.stateTitle}>照片墙已准备好</Text>
          <Text style={styles.stateDescription}>已连接 {selectedNetwork?.ssid}，设备也已自动绑定到你的 App。</Text>
          <View style={styles.successSummary}>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>设备</Text><Text style={styles.summaryValue}>{selectedDevice?.deviceName}</Text></View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>网络</Text><Text style={styles.summaryValue}>{selectedNetwork?.ssid}</Text></View>
          </View>
          <PrimaryButton onPress={finish}>开始使用</PrimaryButton>
        </View>
      );
    }

    return (
      <View style={styles.centeredState}>
        <View style={[styles.stateIcon, styles.failureIcon]}><Text style={styles.failureMark}>!</Text></View>
        <Text style={styles.stateTitle}>没有连接成功</Text>
        <Text style={styles.stateDescription}>{error || '请检查 Wi-Fi 密码后重试。'}</Text>
        <PrimaryButton onPress={retryPassword}>重新输入密码</PrimaryButton>
        <PrimaryButton secondary onPress={() => transition('wifi')}>选择其他网络</PrimaryButton>
      </View>
    );
  };

  const header = (
    <View style={styles.sheetHeader}>
      {!session && stage !== 'success' ? <ProgressHeader stage={stage} /> : <View style={styles.flex} />}
      {!embedded ? <Pressable onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable> : null}
    </View>
  );
  const body = (
    <Animated.View style={{
      opacity: stageMotion,
      transform: [
        { translateY: stageMotion.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
        { scale: stageMotion.interpolate({ inputRange: [0, 1], outputRange: [0.992, 1] }) },
      ],
    }}>
      {renderBody()}
    </Animated.View>
  );

  if (embedded) {
    return (
      <View style={styles.inlineSheet}>
        {header}
        <View style={styles.content}>{body}</View>
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          {header}
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {body}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.28)' },
  sheet: { width: '100%', maxHeight: '94%', minHeight: 560, alignSelf: 'center', backgroundColor: COLORS.canvas, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' },
  inlineSheet: { width: '100%', minHeight: 560, borderRadius: 24, borderWidth: 1, borderColor: COLORS.line, overflow: 'hidden', backgroundColor: COLORS.paper },
  sheetHeader: { minHeight: 68, paddingHorizontal: 20, paddingTop: 14, flexDirection: 'row', alignItems: 'center' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 20, paddingBottom: 40 },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  closeText: { color: COLORS.muted, fontSize: 25, lineHeight: 27, fontWeight: '400' },
  flex: { flex: 1 },
  progressHeader: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 16 },
  progressItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  progressDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#D0D0D0' },
  progressDotActive: { backgroundColor: COLORS.blue },
  progressLabel: { color: '#8E8E93', fontFamily: 'PingFang SC', fontSize: 10, fontWeight: '500' },
  progressLabelActive: { color: COLORS.ink, fontWeight: '600' },
  title: { color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 27, lineHeight: 34, fontWeight: '700', letterSpacing: -0.55 },
  description: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 14, lineHeight: 21, marginTop: 7, marginBottom: 18 },
  discoveryArt: { height: 180, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  discoveryRingLarge: { position: 'absolute', width: 174, height: 174, borderRadius: 87, borderWidth: 1, borderColor: 'rgba(34,34,34,.08)' },
  discoveryRingSmall: { position: 'absolute', width: 126, height: 126, borderRadius: 63, borderWidth: 1, borderColor: 'rgba(34,34,34,.16)' },
  deviceGlyph: {
    width: 78, height: 92, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.ink,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 14px 28px rgba(0,0,0,.16)' }
      : { shadowColor: '#000', shadowOffset: { width: 0, height: 14 }, shadowOpacity: .16, shadowRadius: 24, elevation: 8 }),
  },
  deviceGlyphText: { color: '#F2F2F7', fontSize: 34 },
  scanningText: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 13, textAlign: 'center', marginBottom: 14 },
  listGroup: { overflow: 'hidden', borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper },
  listRow: { minHeight: 72, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, flexDirection: 'row', alignItems: 'center', gap: 12, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  wifiRow: { minHeight: 66, paddingHorizontal: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.line, flexDirection: 'row', alignItems: 'center', gap: 12, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  rowPressed: { opacity: .72, transform: [{ scale: .98 }] },
  listIcon: { width: 42, height: 48, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.ink },
  listIconText: { color: '#F2F2F7', fontSize: 20 },
  rowTitle: { color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 16, lineHeight: 21, fontWeight: '600' },
  rowSubtitle: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 11, marginTop: 3 },
  signal: { width: 24, height: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  signalBar: { width: 3, borderRadius: 2, backgroundColor: '#D1D1D6' },
  signalBarActive: { backgroundColor: COLORS.blue },
  chevron: { color: '#C7C7CC', fontSize: 24, lineHeight: 26 },
  selectedDevicePill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 15, backgroundColor: COLORS.greenSoft, marginBottom: 14 },
  connectedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.green },
  selectedDeviceText: { color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 11, fontWeight: '600' },
  backLink: { color: COLORS.blue, fontFamily: 'PingFang SC', fontSize: 14, fontWeight: '600', marginBottom: 14, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  networkCard: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, marginBottom: 12 },
  networkLabel: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 11 },
  networkNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5 },
  networkName: { color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 17, fontWeight: '600' },
  passwordField: { minHeight: 56, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, flexDirection: 'row', alignItems: 'center', paddingLeft: 15 },
  passwordInput: { flex: 1, height: 56, color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 16, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  showPasswordButton: { height: 56, minWidth: 62, alignItems: 'center', justifyContent: 'center', ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  showPasswordText: { color: COLORS.blue, fontFamily: 'PingFang SC', fontSize: 13, fontWeight: '600' },
  primaryButtonMotion: { width: '100%', marginTop: 14 },
  primaryButton: { width: '100%', minHeight: 54, borderRadius: 16, backgroundColor: COLORS.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  secondaryButton: { backgroundColor: COLORS.ink },
  primaryButtonText: { color: '#FFFFFF', fontFamily: 'PingFang SC', fontSize: 16, fontWeight: '600' },
  secondaryButtonText: { color: '#FFFFFF' },
  buttonDisabled: { opacity: .34 },
  previewHint: { color: '#8E8E93', fontFamily: 'PingFang SC', fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 10 },
  centeredState: { minHeight: 440, alignItems: 'center', justifyContent: 'center' },
  connectingOrb: { width: 150, height: 150, borderRadius: 75, borderWidth: 1, borderColor: 'rgba(34,34,34,.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  connectingOrbCore: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft },
  connectingGlyph: { color: COLORS.blue, fontSize: 40 },
  stateIcon: { width: 82, height: 82, borderRadius: 41, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  successIcon: { backgroundColor: COLORS.ink },
  failureIcon: { backgroundColor: COLORS.redSoft },
  successMark: { color: '#FFFFFF', fontSize: 38, fontWeight: '700' },
  failureMark: { color: COLORS.red, fontSize: 38, fontWeight: '700' },
  stateTitle: { color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 26, lineHeight: 32, fontWeight: '700', textAlign: 'center' },
  stateDescription: { maxWidth: 340, color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8 },
  connectionProgress: { width: '100%', height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: '#D1D1D6', marginTop: 28 },
  connectionProgressFill: { height: '100%', borderRadius: 3, backgroundColor: COLORS.blue },
  progressValue: { color: COLORS.blue, fontFamily: 'PingFang SC', fontSize: 12, fontWeight: '600', marginTop: 9 },
  keepOpenText: { color: '#8E8E93', fontFamily: 'PingFang SC', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 26 },
  successSummary: { width: '100%', borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, paddingHorizontal: 15, marginTop: 24 },
  summaryRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  summaryDivider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.line },
  summaryLabel: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 13 },
  summaryValue: { flexShrink: 1, color: COLORS.ink, fontFamily: 'PingFang SC', fontSize: 13, fontWeight: '600', textAlign: 'right' },
  deviceIdentifier: { marginTop: 16, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper },
  deviceIdentifierText: { color: COLORS.muted, fontFamily: 'PingFang SC', fontSize: 11 },
  errorBox: { borderRadius: 12, padding: 12, backgroundColor: COLORS.redSoft, marginTop: 12 },
  errorText: { color: COLORS.red, fontFamily: 'PingFang SC', fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
