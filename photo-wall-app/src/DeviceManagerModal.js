import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;

function deviceName(session) {
  return session?.device?.name || '照片墙';
}

function deviceId(session) {
  return session?.device?.device_id || '';
}

function deviceFamilyLabel(session) {
  const family = String(session?.device?.device_family || '').toLowerCase();
  const id = deviceId(session).toLowerCase();
  if (family === 'walnutpi_19in' || id.startsWith('walnutpi-')) return '19 寸实时展示屏';
  if (family === 'esp32_e6' || id.startsWith('pwe6-')) return 'ESP32 墨水屏';
  return '照片墙设备';
}

function deviceIsOnline(session) {
  const state = String(session?.device?.state || '').toLowerCase();
  if (session?.device?.error || state === 'error' || state === 'failed') return false;
  const lastSeen = Number(session?.device?.last_seen) || 0;
  if (lastSeen) return Date.now() / 1000 - lastSeen <= 90;
  return ['online', 'queued', 'downloading', 'displaying', 'displayed'].includes(state);
}

function isScreen19(session) {
  return deviceFamilyLabel(session) === '19 寸实时展示屏';
}

export default function DeviceManagerModal({
  visible,
  sessions,
  activeDeviceId,
  onClose,
  onDismiss,
  onSelect,
  onReconfigure,
  onAdd,
  onRemove,
  activeConnectionLabel,
  connectionError,
  onCheckConnection,
  connectionCheck,
  onForget,
}) {
  const [removalTarget, setRemovalTarget] = useState(null);
  const [busyDeviceId, setBusyDeviceId] = useState('');
  const [error, setError] = useState('');
  const [confirmingLocalRemoval, setConfirmingLocalRemoval] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!visible && !busyRef.current) {
      setRemovalTarget(null);
      setConfirmingLocalRemoval(false);
      setError('');
    }
  }, [visible]);

  const runDeviceAction = async (session, action) => {
    const id = deviceId(session);
    if (!id || busyRef.current) return;
    busyRef.current = true;
    setBusyDeviceId(id);
    setError('');
    try {
      await action(session);
    } catch (caught) {
      setError(caught.message || '设备操作失败，请稍后重试');
    } finally {
      busyRef.current = false;
      setBusyDeviceId('');
    }
  };

  const confirmRemoval = async () => {
    if (!removalTarget) return;
    await runDeviceAction(removalTarget, async session => {
      await onRemove(session);
      setRemovalTarget(null);
    });
  };
  const confirmLocalRemoval = async () => {
    if (!removalTarget || !confirmingLocalRemoval) return;
    await runDeviceAction(removalTarget, async session => {
      await onForget(session);
      setRemovalTarget(null);
      setConfirmingLocalRemoval(false);
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} onDismiss={onDismiss}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
            <Text style={styles.headerButtonText}>关闭</Text>
          </Pressable>
          <Text style={styles.headerTitle}>设备管理</Text>
          <View style={styles.headerButtonPlaceholder} />
        </View>

        {removalTarget ? (
          <View style={styles.confirmation}>
            <View style={styles.warningMark}><Text style={styles.warningMarkText}>!</Text></View>
            <Text style={styles.confirmationTitle}>{confirmingLocalRemoval ? '仅从此手机移除？' : '删除这台照片墙？'}</Text>
            <Text style={styles.confirmationName}>{deviceName(removalTarget)}</Text>
            <Text style={styles.confirmationId}>{deviceId(removalTarget)}</Text>
            <Text style={styles.confirmationDescription}>{confirmingLocalRemoval
              ? '这不会解除云端绑定，也不会清除屏幕的 Wi-Fi。恢复连接所需的信息会安全保留在此手机，之后可以重新添加同一设备。不会在后台自动重试删除。'
              : isScreen19(removalTarget)
              ? '删除后，这台屏幕只会从 App 的设备列表移除，不会改变屏幕原有的连接设置。'
              : '服务确认移除后，管理员权限会被撤销；屏幕恢复联网后会清除连接设置。再次连接请从“添加设备”开始。'}</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(busyDeviceId)}
              onPress={confirmingLocalRemoval ? confirmLocalRemoval : confirmRemoval}
              style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}
            >
              <Text style={styles.dangerButtonText}>{busyDeviceId ? '正在处理…' : confirmingLocalRemoval ? '确认仅从此手机移除' : '确认删除'}</Text>
            </Pressable>
            {error && !confirmingLocalRemoval && onForget ? <Pressable accessibilityRole="button" disabled={Boolean(busyDeviceId)}
              onPress={() => {setConfirmingLocalRemoval(true);setError('');}} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>仅从此手机移除并重新连接</Text>
            </Pressable> : null}
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(busyDeviceId)}
              onPress={() => { if (confirmingLocalRemoval) setConfirmingLocalRemoval(false); else setRemovalTarget(null); setError(''); }}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}
            >
              <Text style={styles.secondaryButtonText}>取消</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.summary}>
              <Text style={styles.summaryValue}>{sessions.length}</Text>
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryTitle}>台已添加设备</Text>
                <Text style={styles.summaryDescription}>你可以自由切换设备；重新配网和删除仅限家庭所有者。</Text>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
              {sessions.map(session => {
                const id = deviceId(session);
                const current = id === activeDeviceId;
                const label = current && activeConnectionLabel ? activeConnectionLabel
                  : deviceIsOnline(session) ? '最近在线' : '状态待确认';
                const online = label === '已连接' || label === '最近在线';
                const canManage = session.device?.can_manage !== false;
                return (
                  <View key={id} style={styles.deviceRow}>
                    <View style={[styles.statusDot, online && styles.statusDotOnline]} />
                    <View style={styles.deviceCopy}>
                      <View style={styles.deviceTitleRow}>
                        <Text style={styles.deviceName}>{deviceName(session)}</Text>
                        {current ? <Text style={styles.currentBadge}>当前设备</Text> : null}
                        {!canManage ? <Text style={styles.memberBadge}>家庭成员</Text> : null}
                      </View>
                      <Text style={styles.deviceId}>{deviceFamilyLabel(session)} · {id}</Text>
                      <Text style={styles.deviceStatus}>{label}</Text>
                    </View>
                    <View style={styles.rowActions}>
                      {canManage && !isScreen19(session) ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={Boolean(busyDeviceId)}
                          onPress={() => runDeviceAction(session, onReconfigure)}
                          style={({ pressed }) => [styles.selectButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}
                        >
                          <Text style={styles.selectButtonText}>{busyDeviceId === id ? '准备中…' : '重新配网'}</Text>
                        </Pressable>
                      ) : null}
                      {!current ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={Boolean(busyDeviceId)}
                          onPress={() => runDeviceAction(session, onSelect)}
                          style={({ pressed }) => [styles.selectButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}
                        >
                          <Text style={styles.selectButtonText}>{busyDeviceId === id ? '切换中…' : '设为当前'}</Text>
                        </Pressable>
                      ) : null}
                      {canManage ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={Boolean(busyDeviceId)}
                          onPress={() => { setRemovalTarget(session); setError(''); }}
                          style={({ pressed }) => [styles.removeButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}
                        >
                          <Text style={styles.removeButtonText}>删除</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })}
              {!sessions.length ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>还没有设备</Text>
                  <Text style={styles.emptyDescription}>添加成功后，每台照片墙都会记录在这里。</Text>
                </View>
              ) : null}
            </ScrollView>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {connectionError || connectionCheck ? <View style={styles.connectionError} accessibilityLiveRegion="polite">
              <Text style={styles.error}>{connectionCheck?.message || connectionError}</Text>
              <Pressable accessibilityRole="button" disabled={connectionCheck?.state === 'checking'} onPress={onCheckConnection} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{connectionCheck?.state === 'checking' ? '正在检查…' : '检查连接 / 重试'}</Text></Pressable>
            </View> : null}
            <View style={styles.footer}>
              <Pressable accessibilityRole="button" disabled={Boolean(busyDeviceId)} onPress={onAdd} style={({ pressed }) => [styles.addButton, pressed && styles.pressed, busyDeviceId && styles.disabled]}>
                <Text style={styles.addButtonText}>添加设备</Text>
              </Pressable>
            </View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  connectionError: { paddingHorizontal: 20, paddingBottom: 12 },
  page: { flex: 1, backgroundColor: '#F7F7F7' },
  header: { height: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5', backgroundColor: '#FFFFFF' },
  headerButton: { width: 64, minHeight: 40, justifyContent: 'center' },
  headerButtonText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '600' },
  headerButtonPlaceholder: { width: 64 },
  headerTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 17, fontWeight: '700' },
  summary: { marginHorizontal: 20, paddingVertical: 24, flexDirection: 'row', alignItems: 'center', gap: 14 },
  summaryValue: { width: 48, fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 40, lineHeight: 46, fontWeight: '700', textAlign: 'center' },
  summaryCopy: { flex: 1 },
  summaryTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, fontWeight: '700' },
  summaryDescription: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 18, marginTop: 3 },
  list: { paddingHorizontal: 20, paddingBottom: 24 },
  deviceRow: { minHeight: 112, paddingVertical: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DDDDDD' },
  statusDot: { width: 9, height: 9, borderRadius: 5, marginTop: 6, backgroundColor: '#B6B6B6' },
  statusDotOnline: { backgroundColor: '#287D4A' },
  deviceCopy: { flex: 1, minWidth: 0 },
  deviceTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  deviceName: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, lineHeight: 22, fontWeight: '700' },
  currentBadge: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 10, lineHeight: 18, fontWeight: '700', paddingHorizontal: 7, borderRadius: 5, overflow: 'hidden', backgroundColor: '#222222' },
  memberBadge: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 9, lineHeight: 18, fontWeight: '700', paddingHorizontal: 7, borderRadius: 5, overflow: 'hidden', backgroundColor: '#EFEFEF' },
  deviceId: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 10, lineHeight: 16, marginTop: 4 },
  deviceStatus: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 11, lineHeight: 16, marginTop: 2 },
  rowActions: { alignItems: 'flex-end', gap: 8 },
  selectButton: { minWidth: 76, minHeight: 34, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D5D5D5', borderRadius: 6, backgroundColor: '#FFFFFF' },
  selectButtonText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 11, fontWeight: '700' },
  removeButton: { minWidth: 52, minHeight: 34, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  removeButtonText: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 11, fontWeight: '700' },
  emptyState: { minHeight: 240, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DDDDDD' },
  emptyTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 17, fontWeight: '700' },
  emptyDescription: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 13, lineHeight: 19, marginTop: 6, textAlign: 'center' },
  footer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E5E5', backgroundColor: '#FFFFFF' },
  addButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#1C1C1E' },
  addButtonText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  confirmation: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  warningMark: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF4F1' },
  warningMarkText: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 30, fontWeight: '700' },
  confirmationTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 24, lineHeight: 31, fontWeight: '700', marginTop: 24, textAlign: 'center' },
  confirmationName: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, fontWeight: '700', marginTop: 18 },
  confirmationId: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 11, marginTop: 4 },
  confirmationDescription: { maxWidth: 360, fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 14, lineHeight: 21, marginTop: 18, textAlign: 'center' },
  dangerButton: { width: '100%', maxWidth: 400, minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#C13515', marginTop: 28 },
  dangerButtonText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryButton: { width: '100%', maxWidth: 400, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#D5D5D5', backgroundColor: '#FFFFFF', marginTop: 10 },
  secondaryButtonText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '700' },
  error: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 12, lineHeight: 18, marginHorizontal: 20, marginBottom: 8, textAlign: 'center' },
  pressed: { opacity: 0.66 },
  disabled: { opacity: 0.45 },
});
