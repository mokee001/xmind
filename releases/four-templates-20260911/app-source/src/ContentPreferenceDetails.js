import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import preferenceDetails from './contentPreferenceDetails.cjs';

export const {
  normalizePhotoRange,
  isValidPhotoRange,
  photoRangeLabel,
  normalizeTemporalPreference,
  temporalPreferenceLabel,
} = preferenceDetails;

const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;
const RANGE_OPTIONS = [
  { value: 'all', title: '全部已授权照片', description: '在你已授权的照片中自动挑选。' },
  { value: 'year', title: '最近一年的照片', description: '只回顾拍摄于最近一年的照片。' },
  { value: 'since', title: '从指定日期开始', description: '只回顾这一天及之后拍摄的照片。' },
];
const TIME_OPTIONS = [
  { value: 'balanced', title: '最近与过往均衡安排', description: '新鲜的日常与从前的回忆，交替出现。' },
  { value: 'recent', title: '更多最近的生活', description: '让最近拍下的生活多出现一些。' },
  { value: 'past', title: '多看看从前', description: '多找回一些隔了些日子的回忆。' },
];

function Choice({ option, selected, onPress }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${option.title}，${option.description}`}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}
    >
      <View style={styles.optionCopy}>
        <Text style={styles.optionTitle}>{option.title}</Text>
        <Text style={styles.optionDescription}>{option.description}</Text>
      </View>
      <View accessible={false} style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
    </Pressable>
  );
}

export default function ContentPreferenceDetails({
  section,
  photoRange,
  temporalPreference,
  onChangeRange,
  onChangeTemporal,
  onClose,
}) {
  const [rangeDraft, setRangeDraft] = useState(() => normalizePhotoRange(photoRange));
  const [timeDraft, setTimeDraft] = useState(() => normalizeTemporalPreference(temporalPreference));
  const [dateTouched, setDateTouched] = useState(false);
  const visible = section === 'range' || section === 'time';
  const editingRange = section === 'range';

  useEffect(() => {
    if (!visible) return;
    setRangeDraft(normalizePhotoRange(photoRange));
    setTimeDraft(normalizeTemporalPreference(temporalPreference));
    setDateTouched(false);
  }, [section, photoRange?.mode, photoRange?.since, temporalPreference]);

  const validRange = isValidPhotoRange(rangeDraft);
  const canComplete = !editingRange || validRange;
  const complete = () => {
    if (!canComplete) {
      setDateTouched(true);
      return;
    }
    if (editingRange) onChangeRange?.(normalizePhotoRange(rangeDraft));
    else onChangeTemporal?.(timeDraft);
    onClose?.();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView
          style={styles.keyboardArea}
          behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
        >
          <View style={styles.header}>
            <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
              <Text style={styles.headerButtonText}>取消</Text>
            </Pressable>
            <Text accessibilityRole="header" style={styles.headerTitle}>{editingRange ? '照片范围' : '时间偏好'}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canComplete }}
              disabled={!canComplete}
              onPress={complete}
              style={({ pressed }) => [styles.headerButton, styles.completeButton, !canComplete && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={styles.headerButtonText}>完成</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>{editingRange ? '可以回顾哪些照片？' : '更想看最近，还是从前？'}</Text>
            <Text style={styles.description}>{editingRange
              ? '按拍摄日期记录你允许回顾的范围。'
              : '记录你更想看到最近的生活，还是从前的回忆。'}</Text>
            <Text style={styles.note}>这些设置会随偏好版本保存，自动选片服务尚未接入时间设置。</Text>
            <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel={editingRange ? '照片范围' : '时间偏好'}>
              {(editingRange ? RANGE_OPTIONS : TIME_OPTIONS).map(option => (
                <Choice
                  key={option.value}
                  option={option}
                  selected={editingRange ? rangeDraft.mode === option.value : timeDraft === option.value}
                  onPress={() => {
                    if (editingRange) setRangeDraft(current => ({ ...current, mode: option.value }));
                    else setTimeDraft(option.value);
                  }}
                />
              ))}
            </View>
            {editingRange && rangeDraft.mode === 'since' ? (
              <View style={styles.dateSection}>
                <Text style={styles.dateLabel}>开始日期</Text>
                <TextInput
                  accessibilityLabel="开始日期，格式为四位年份、两位月份、两位日期，以短横线分隔"
                  value={rangeDraft.since}
                  onChangeText={since => {
                    setRangeDraft(current => ({ ...current, since }));
                    setDateTouched(false);
                  }}
                  onBlur={() => setDateTouched(true)}
                  onSubmitEditing={complete}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#8A8A8A"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  returnKeyType="done"
                  maxLength={10}
                  style={[styles.dateInput, dateTouched && !validRange && styles.dateInputInvalid]}
                />
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.dateHint, dateTouched && !validRange && styles.error]}
                >{dateTouched && !validRange
                    ? '请输入真实有效且不晚于今天的日期，例如 2025-01-01。'
                    : '按 YYYY-MM-DD 填写，日期不能晚于今天。'}</Text>
              </View>
            ) : null}
            <Text style={styles.note}>{editingRange
              ? '这里只调整可回顾的范围，不会删除或修改你的原始照片。'
              : '这是时间上的偏好，不会改变你设置的照片范围。'}</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F7F7F7' },
  keyboardArea: { flex: 1 },
  header: { minHeight: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5', backgroundColor: '#FFFFFF' },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  completeButton: { alignItems: 'flex-end' },
  headerButtonText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '600' },
  headerTitle: { flexShrink: 1, fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 17, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 30, paddingBottom: 40 },
  title: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 23, lineHeight: 33, fontWeight: '700' },
  description: { marginTop: 10, fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 14, lineHeight: 22 },
  options: { marginTop: 26, gap: 12 },
  option: { minHeight: 84, paddingHorizontal: 18, paddingVertical: 18, borderRadius: 14, borderWidth: 1, borderColor: '#E5E5E5', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', gap: 16 },
  optionSelected: { borderColor: '#222222', backgroundColor: '#FFFFFF' },
  optionCopy: { flex: 1, minWidth: 0 },
  optionTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, lineHeight: 24, fontWeight: '600' },
  optionDescription: { marginTop: 5, fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 19 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#CACACA', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  radioSelected: { borderColor: '#222222', backgroundColor: '#222222' },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' },
  dateSection: { marginTop: 24 },
  dateLabel: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 14, lineHeight: 22, fontWeight: '600' },
  dateInput: { minHeight: 50, marginTop: 8, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: '#D6D6D6', borderRadius: 12, backgroundColor: '#FFFFFF', fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16 },
  dateInputInvalid: { borderColor: '#C13515' },
  dateHint: { marginTop: 8, fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 19 },
  error: { color: '#C13515' },
  note: { marginTop: 24, fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 20 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.3 },
});
