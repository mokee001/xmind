import { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;

export default function AddDisplayModal({ visible, onClose, onAddEsp32, onAddScreen19 }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setBusy(false);
    setError('');
  }, [visible]);

  const addScreen19 = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onAddScreen19();
    } catch (caught) {
      setError(caught.message || '没有找到已连接的 19 寸屏');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>取消</Text>
          </Pressable>
          <Text style={styles.headerTitle}>添加设备</Text>
          <View style={styles.headerButton} />
        </View>

        <View style={styles.content}>
          <Text style={styles.title}>选择屏幕类型</Text>
          <Text style={styles.description}>两种屏幕会出现在同一个设备列表中。</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onAddEsp32} style={({ pressed }) => [styles.option, pressed && styles.pressed, busy && styles.disabled]}>
            <View style={styles.optionMark}><Text style={styles.optionMarkText}>E6</Text></View>
            <View style={styles.flex}>
              <Text style={styles.optionTitle}>ESP32 墨水屏</Text>
              <Text style={styles.optionDescription}>继续使用原来的蓝牙发现和 Wi-Fi 配网</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={addScreen19} style={({ pressed }) => [styles.option, pressed && styles.pressed, busy && styles.disabled]}>
            <View style={styles.optionMark}><Text style={styles.optionMarkText}>19</Text></View>
            <View style={styles.flex}>
              <Text style={styles.optionTitle}>19 寸实时展示屏</Text>
              <Text style={styles.optionDescription}>{busy ? '正在同步已连接设备…' : '沿用原连接方式，同步已经连接的屏幕'}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F7F7F7' },
  header: { height: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5', backgroundColor: '#FFFFFF' },
  headerButton: { width: 64, minHeight: 40, justifyContent: 'center' },
  headerButtonText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '600' },
  headerTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 17, fontWeight: '700' },
  content: { padding: 22 },
  title: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 25, lineHeight: 32, fontWeight: '700' },
  description: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 14, lineHeight: 21, marginTop: 5, marginBottom: 22 },
  option: { minHeight: 88, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 12, borderRadius: 8, borderWidth: 1, borderColor: '#E0E0E0', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', gap: 13 },
  optionMark: { width: 42, height: 42, borderRadius: 8, backgroundColor: '#222222', alignItems: 'center', justifyContent: 'center' },
  optionMarkText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  optionTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, fontWeight: '700' },
  optionDescription: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 17, marginTop: 3 },
  chevron: { color: '#8E8E93', fontSize: 24 },
  error: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 13, lineHeight: 19, marginTop: 12 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.72 },
  flex: { flex: 1 },
});