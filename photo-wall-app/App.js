import React, { useEffect, useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
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
  DEFAULT_PROVISION_URL,
  provisionDisplay,
  publishDisplayPhoto,
  readProvisionStatus,
} from './src/deviceApi';
import { loadDeviceSession, saveDeviceSession } from './src/sessionStore';

const C = {
  canvas: '#F5F1E8', paper: '#FFFCF6', ink: '#242822', muted: '#70776D',
  line: '#DED8CC', green: '#47695D', greenSoft: '#E2ECE6', orange: '#BC6348',
  orangeSoft: '#F4E1D8', red: '#A84D45', redSoft: '#F4DFDC', white: '#FFFFFF',
};

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

function DeviceModal({ visible, session, onClose, onConnected }) {
  const [provisionUrl, setProvisionUrl] = useState(DEFAULT_PROVISION_URL);
  const [ssid, setSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

  const claim = async (code = pairingCode) => {
    const result = await claimDisplay({ apiBase: DEFAULT_API_BASE, pairingCode: code, name: '客厅照片墙' });
    await onConnected({ device: result.device, accountToken: result.account_token, apiBase: DEFAULT_API_BASE });
    setMessage('绑定成功。以后屏幕会自己连接云端。');
    return result;
  };

  const inspect = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await readProvisionStatus(provisionUrl);
      setPairingCode(result.pairing_code || '');
      setMessage(`已找到屏幕 ${result.device_id}，配对码 ${result.pairing_code}`);
    } catch (e) {
      setError(`没有找到屏幕：${e.message}`);
    } finally { setBusy(false); }
  };

  const configure = async () => {
    setBusy(true); setError(''); setMessage('正在连接屏幕…');
    try {
      const accepted = await provisionDisplay({ provisionUrl, ssid, password: wifiPassword, apiBase: DEFAULT_API_BASE });
      const code = accepted.pairing_code || pairingCode;
      setPairingCode(code);
      let lastError;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await wait(3000);
        try { await claim(code); lastError = null; break; } catch (e) { lastError = e; }
      }
      if (lastError) throw lastError;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const bindOnline = async () => {
    setBusy(true); setError('');
    try { await claim(); } catch (e) { setError(e.message); } finally { setBusy(false); }
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
                <Text style={styles.help}>第一次连接：先在 iPhone 的 Wi-Fi 设置中连接屏幕发出的 PhotoWall-XXXX 热点，然后回到这里。</Text>
                <Field label="屏幕配置地址" value={provisionUrl} onChangeText={setProvisionUrl} />
                <ActionButton secondary onPress={inspect} disabled={busy}>{busy ? '正在查找…' : '查找屏幕'}</ActionButton>
                {message ? <Text style={styles.successText}>{message}</Text> : null}
                <Field label="家里 Wi-Fi 名称" value={ssid} onChangeText={setSsid} />
                <Field label="家里 Wi-Fi 密码" value={wifiPassword} onChangeText={setWifiPassword} secureTextEntry />
                <Text style={styles.cloudEndpoint}>线上服务：api.mokeedesign.cn</Text>
                <ActionButton onPress={configure} disabled={busy || !ssid.trim()}>{busy ? '正在连接…' : '发送配置并绑定'}</ActionButton>
                <View style={styles.divider} />
                <Text style={styles.sectionLabel}>屏幕已经联网？输入六位配对码</Text>
                <TextInput
                  value={pairingCode}
                  onChangeText={value => setPairingCode(value.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  placeholder="例如 072826"
                  style={styles.input}
                />
                <ActionButton secondary onPress={bindOnline} disabled={busy || pairingCode.length !== 6}>绑定屏幕</ActionButton>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, ...props }) {
  return <><Text style={styles.fieldLabel}>{label}</Text><TextInput autoCapitalize="none" style={styles.input} {...props} /></>;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [permission, setPermission] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [deviceModal, setDeviceModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
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
    loadDeviceSession().then(saved => {
      if (saved?.device?.device_id) setSession({ ...saved, apiBase: DEFAULT_API_BASE });
    });
    (async () => {
      const current = await refreshPermission();
      if (current.status === 'undetermined') await requestPhotoPermission();
    })().catch(e => setError(`检查照片权限失败：${e.message}`));
  }, []);

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
    if (!result.canceled) setSelectedPhoto(result.assets[0]);
    await refreshPermission();
  };

  const publish = async () => {
    if (!selectedPhoto || !session) return;
    setPublishing(true); setError(''); setNotice('');
    try {
      await publishDisplayPhoto({
        apiBase: DEFAULT_API_BASE,
        deviceId: session.device.device_id,
        accountToken: session.accountToken,
        asset: selectedPhoto,
      });
      setNotice('照片已发送。墨水屏会自动下载并刷新。');
    } catch (e) { setError(`发送失败：${e.message}`); } finally { setPublishing(false); }
  };

  const onConnected = async next => {
    setSession(next);
    await saveDeviceSession(next);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <Text style={styles.brand}>照片墙</Text>
        <Text style={styles.title}>三步把照片放到屏幕</Text>
        <Text style={styles.subtitle}>不需要 Expo，也不用理解复杂设置。按顺序完成下面三步即可。</Text>

        <StepCard
          number="1"
          title="允许访问照片"
          description={permissionDescription}
          ok={photoAllowed}
          action={photoAllowed ? () => Linking.openSettings() : requestPhotoPermission}
          actionLabel={photoAllowed ? '管理照片权限' : '允许访问照片'}
        />

        <StepCard
          number="2"
          title="连接墨水屏"
          description={connected ? `${session.device.name || '照片墙'} · ${session.device.state || '已绑定'}` : '只需首次配置一次，之后屏幕会自己联网。'}
          ok={connected}
          action={() => setDeviceModal(true)}
          actionLabel={connected ? '查看设备' : '开始连接'}
        />

        <StepCard
          number="3"
          title="选择照片并上屏"
          description={selectedPhoto ? '照片已选好，可以发送到墨水屏。' : '从 iPhone 相册选择一张照片。'}
          ok={Boolean(selectedPhoto)}
          action={choosePhoto}
          actionLabel={selectedPhoto ? '重新选择照片' : '选择照片'}
        >
          {selectedPhoto ? <Image source={{ uri: selectedPhoto.uri }} style={styles.preview} /> : null}
          {selectedPhoto ? (
            <ActionButton disabled={!connected || publishing} onPress={publish}>
              {publishing ? '正在发送…' : connected ? '发送到墨水屏' : '请先连接墨水屏'}
            </ActionButton>
          ) : null}
        </StepCard>

        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>✓ {notice}</Text></View> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        <Text style={styles.footer}>照片仅在你主动选择并发送时上传。</Text>
      </ScrollView>

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
  page: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 22, paddingBottom: 60 },
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
  button: { minHeight: 48, borderRadius: 13, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', marginTop: 15, paddingHorizontal: 16 },
  buttonSecondary: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line },
  buttonText: { color: C.white, fontSize: 13, fontWeight: '800' },
  buttonTextSecondary: { color: C.ink },
  disabled: { opacity: 0.35 },
  preview: { width: '100%', height: 260, borderRadius: 14, resizeMode: 'cover', marginTop: 16 },
  notice: { backgroundColor: C.greenSoft, borderRadius: 14, padding: 14, marginTop: 2 },
  noticeText: { color: C.green, fontSize: 12, fontWeight: '700', lineHeight: 19 },
  error: { backgroundColor: C.redSoft, borderRadius: 14, padding: 14, marginTop: 2 },
  errorText: { color: C.red, fontSize: 12, lineHeight: 19, marginTop: 10 },
  footer: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 22 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,22,19,.55)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '92%', backgroundColor: C.paper, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 36 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalEyebrow: { color: C.orange, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  modalTitle: { color: C.ink, fontSize: 26, fontWeight: '800', marginTop: 4 },
  close: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: C.muted, fontSize: 24 },
  help: { color: C.muted, fontSize: 13, lineHeight: 21, marginBottom: 8 },
  fieldLabel: { color: C.muted, fontSize: 11, fontWeight: '800', marginTop: 13, marginBottom: 7 },
  input: { height: 47, borderRadius: 12, borderWidth: 1, borderColor: C.line, color: C.ink, paddingHorizontal: 13, backgroundColor: C.white },
  cloudEndpoint: { color: C.green, backgroundColor: C.greenSoft, borderRadius: 10, padding: 11, fontSize: 11, fontWeight: '800', marginTop: 14 },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 22 },
  sectionLabel: { color: C.ink, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  successText: { color: C.green, fontSize: 12, lineHeight: 18, marginTop: 10 },
  connectedBox: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.greenSoft, padding: 15, borderRadius: 15, marginBottom: 14 },
  connectedIcon: { color: C.green, fontSize: 24, fontWeight: '900' },
  flex: { flex: 1 },
});
