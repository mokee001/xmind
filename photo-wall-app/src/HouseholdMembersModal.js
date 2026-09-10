import { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  acceptHouseholdInvite,
  adoptDevice,
  createHouseholdInvite,
  listHouseholds,
  readHouseholdMembers,
  registerAccount,
  removeHouseholdMember,
  updateAccount,
  updateHouseholdMember,
} from './accountApi';
import { saveAccountSession } from './accountStore';

const SYSTEM_FONT = Platform.OS === 'ios' || Platform.OS === 'web' ? 'PingFang SC' : undefined;
const PREVIEW_ACCOUNT_SESSION = {
  accessToken: 'preview-only',
  account: { user_id: 'preview-owner', name: '我', avatar: '我' },
};
const PREVIEW_HOUSEHOLD = {
  household_id: 'preview-home',
  name: '我的家庭',
  role: 'owner',
  members_count: 2,
  devices: [{ device_id: 'web-preview-frame', name: '客厅照片墙' }],
};
const PREVIEW_MEMBERS = [
  { user_id: 'preview-owner', name: '我', avatar: '我', role: 'owner', can_publish: true, is_self: true },
  { user_id: 'preview-member', name: '家人', avatar: '家', role: 'member', can_publish: false, is_self: false },
];

function deviceHousehold(households, deviceId) {
  if (!deviceId) return households[0] || null;
  return households.find(household => (
    household.devices || []
  ).some(device => device.device_id === deviceId)) || null;
}

function memberRole(member) {
  return member.role === 'owner' ? '所有者' : '家庭成员';
}

export default function HouseholdMembersModal({
  visible,
  accountSession,
  deviceSession,
  onClose,
  onAccountSessionChange,
  onDeviceSessionChange,
  onHouseholdJoined,
  onHouseholdLeft,
  previewMode = false,
}) {
  const [localAccountSession, setLocalAccountSession] = useState(accountSession);
  const [household, setHousehold] = useState(null);
  const [members, setMembers] = useState([]);
  const [name, setName] = useState(accountSession?.account?.name || '我');
  const [invite, setInvite] = useState(null);
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const persistAccount = async session => {
    if (!previewMode) await saveAccountSession(session);
    setLocalAccountSession(session);
    setName(session.account?.name || '我');
    onAccountSessionChange?.(session);
    return session;
  };

  const ensureAccount = async () => {
    if (previewMode) return localAccountSession || PREVIEW_ACCOUNT_SESSION;
    if (localAccountSession?.accessToken) return localAccountSession;
    if (accountSession?.accessToken) return persistAccount(accountSession);
    return persistAccount(await registerAccount({ name: '我' }));
  };

  const refreshMembers = async (session, nextHousehold) => {
    if (!nextHousehold?.household_id) {
      setMembers([]);
      return;
    }
    const result = await readHouseholdMembers({
      accessToken: session.accessToken,
      householdId: nextHousehold.household_id,
    });
    setHousehold(result.household);
    setMembers(result.members || []);
  };

  useEffect(() => {
    if (!visible) return undefined;
    if (previewMode) {
      setLocalAccountSession(PREVIEW_ACCOUNT_SESSION);
      setName(PREVIEW_ACCOUNT_SESSION.account.name);
      setHousehold(PREVIEW_HOUSEHOLD);
      setMembers(PREVIEW_MEMBERS);
      setInvite(null);
      setError('');
      setNotice('网页预览仅演示交互，不会创建账户或修改线上数据。');
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    setNotice('');
    setInvite(null);
    const load = async () => {
      const session = await ensureAccount();
      const listed = await listHouseholds({ accessToken: session.accessToken });
      if (!active) return;
      const deviceId = deviceSession?.device?.device_id;
      let nextHousehold = deviceHousehold(listed.households || [], deviceId);
      if (!nextHousehold && deviceId && deviceSession?.accountToken) {
        const adopted = await adoptDevice({
          accessToken: session.accessToken,
          deviceId,
          deviceAccountToken: deviceSession.accountToken,
          householdName: `${deviceSession.device?.name || '照片墙'}家庭`,
        });
        nextHousehold = adopted.household;
        await onDeviceSessionChange?.({
          ...deviceSession,
          accountToken: session.accessToken,
          householdId: nextHousehold.household_id,
        });
      }
      if (!active) return;
      setHousehold(nextHousehold);
      await refreshMembers(session, nextHousehold);
    };
    load().catch(caught => {
      if (active) setError(caught.message || '家庭成员信息加载失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [visible, deviceSession?.device?.device_id, previewMode]);

  const saveName = async () => {
    if (!name.trim() || busy) return;
    setBusy('name'); setError(''); setNotice('');
    try {
      if (previewMode) {
        const next = {
          ...PREVIEW_ACCOUNT_SESSION,
          account: { ...PREVIEW_ACCOUNT_SESSION.account, name: name.trim(), avatar: name.trim().slice(0, 1) },
        };
        await persistAccount(next);
        setMembers(current => current.map(member => member.is_self ? { ...member, name: name.trim(), avatar: name.trim().slice(0, 1) } : member));
        setNotice('网页预览已模拟更新账户名称。');
        return;
      }
      const session = await ensureAccount();
      const result = await updateAccount({ accessToken: session.accessToken, name: name.trim() });
      await persistAccount({ ...session, account: result.account });
      if (household) await refreshMembers(session, household);
      setNotice('账户名称已更新。');
    } catch (caught) {
      setError(caught.message || '账户名称更新失败');
    } finally { setBusy(''); }
  };

  const createInvite = async () => {
    if (!household?.household_id || busy) return;
    setBusy('invite'); setError(''); setNotice('');
    try {
      if (previewMode) {
        setInvite({ code: 'ECHO2026' });
        setNotice('这是网页预览邀请码，不会写入线上服务。');
        return;
      }
      const session = await ensureAccount();
      const result = await createHouseholdInvite({
        accessToken: session.accessToken,
        householdId: household.household_id,
      });
      setInvite(result.invite);
      setNotice('邀请码 24 小时内有效，使用一次后自动失效。');
    } catch (caught) {
      setError(caught.message || '邀请码生成失败');
    } finally { setBusy(''); }
  };

  const acceptInvite = async () => {
    const code = inviteCode.trim();
    if (!code || busy) return;
    setBusy('accept'); setError(''); setNotice('');
    try {
      if (previewMode) {
        setInviteCode('');
        setNotice('网页预览已模拟加入家庭，真实 App 会自动同步共享设备。');
        return;
      }
      const session = await ensureAccount();
      const result = await acceptHouseholdInvite({
        accessToken: session.accessToken,
        code,
      });
      setInviteCode('');
      setHousehold(result.household);
      await refreshMembers(session, result.household);
      await onHouseholdJoined?.(result.household, session);
      setNotice(`已加入“${result.household.name}”，设备会自动出现在设备列表。`);
    } catch (caught) {
      setError(caught.message || '加入家庭失败');
    } finally { setBusy(''); }
  };

  const togglePublish = async member => {
    if (!household?.household_id || busy) return;
    setBusy(member.user_id); setError(''); setNotice('');
    try {
      if (previewMode) {
        setMembers(current => current.map(item => item.user_id === member.user_id ? { ...item, can_publish: !item.can_publish } : item));
        return;
      }
      const session = await ensureAccount();
      await updateHouseholdMember({
        accessToken: session.accessToken,
        householdId: household.household_id,
        userId: member.user_id,
        canPublish: !member.can_publish,
      });
      await refreshMembers(session, household);
    } catch (caught) {
      setError(caught.message || '成员权限更新失败');
    } finally { setBusy(''); }
  };

  const removeMember = async member => {
    if (!household?.household_id || busy) return;
    setBusy(member.user_id); setError(''); setNotice('');
    try {
      if (previewMode) {
        setMembers(current => current.filter(item => item.user_id !== member.user_id));
        setNotice(member.is_self ? '网页预览已模拟退出家庭。' : `网页预览已模拟移除“${member.name}”。`);
        return;
      }
      const session = await ensureAccount();
      await removeHouseholdMember({
        accessToken: session.accessToken,
        householdId: household.household_id,
        userId: member.user_id,
      });
      if (member.is_self) {
        const previousHousehold = household;
        setHousehold(null);
        setMembers([]);
        await onHouseholdLeft?.(previousHousehold, session);
        setNotice(`已退出“${previousHousehold.name}”。`);
      } else {
        await refreshMembers(session, household);
        setNotice(`已移除“${member.name}”，其账户不能再访问这些设备。`);
      }
    } catch (caught) {
      setError(caught.message || '移除成员失败');
    } finally { setBusy(''); }
  };

  const owner = household?.role === 'owner';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
            <Text style={styles.headerButtonText}>关闭</Text>
          </Pressable>
          <Text style={styles.headerTitle}>家庭与成员</Text>
          <View style={styles.headerButton} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.sectionTitle}>我的账户</Text>
          <View style={styles.card}>
            <View style={styles.accountRow}>
              <View style={styles.avatar}><Text style={styles.avatarText}>{localAccountSession?.account?.avatar || '我'}</Text></View>
              <View style={styles.flex}>
                <Text style={styles.label}>显示名称</Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  maxLength={40}
                  placeholder="你的名称"
                  style={styles.nameInput}
                />
              </View>
              <Pressable onPress={saveName} disabled={Boolean(busy)} style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}>
                <Text style={styles.smallButtonText}>{busy === 'name' ? '保存中' : '保存'}</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>每位家庭成员拥有独立账户和相册权限。</Text>
          </View>

          <Text style={styles.sectionTitle}>当前家庭</Text>
          <View style={styles.card}>
            {loading ? <Text style={styles.emptyTitle}>正在读取家庭信息…</Text> : household ? (
              <>
                <Text style={styles.householdName}>{household.name}</Text>
                <Text style={styles.hint}>{household.members_count || members.length} 位成员 · {household.devices?.length || 0} 台设备 · {household.role === 'owner' ? '你是所有者' : '你是家庭成员'}</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>还没有加入家庭</Text>
                <Text style={styles.hint}>首次连接照片墙会自动创建家庭，也可以在下方输入邀请码加入。</Text>
              </>
            )}
          </View>

          {household ? (
            <>
              <View style={styles.sectionTitleRow}><Text style={styles.sectionTitle}>成员</Text><Text style={styles.sectionCount}>{members.length} 人</Text></View>
              <View style={styles.card}>
                {members.map((member, index) => (
                  <View key={member.user_id} style={[styles.memberRow, index > 0 && styles.divider]}>
                    <View style={styles.memberAvatar}><Text style={styles.memberAvatarText}>{member.avatar || member.name?.slice(0, 1)}</Text></View>
                    <View style={styles.flex}>
                      <View style={styles.memberTitleRow}><Text style={styles.memberName}>{member.name}</Text>{member.is_self ? <Text style={styles.selfBadge}>我</Text> : null}</View>
                      <Text style={styles.memberRole}>{memberRole(member)}{member.role === 'member' ? (member.can_publish ? ' · 可手动投屏' : ' · 仅贡献照片') : ''}</Text>
                      {(owner && member.role !== 'owner') || (!owner && member.is_self && member.role !== 'owner') ? (
                        <Pressable onPress={() => removeMember(member)} disabled={Boolean(busy)}>
                          <Text style={styles.removeText}>{busy === member.user_id ? '处理中…' : member.is_self ? '退出家庭' : '移除成员'}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {owner && member.role !== 'owner' ? (
                      <Switch
                        value={Boolean(member.can_publish)}
                        onValueChange={() => togglePublish(member)}
                        disabled={Boolean(busy)}
                        trackColor={{ false: '#D6D6D6', true: '#222222' }}
                        thumbColor="#FFFFFF"
                      />
                    ) : null}
                  </View>
                ))}
              </View>
              {owner ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>邀请家庭成员</Text>
                  <Text style={styles.hint}>家人不需要重新进行蓝牙配网，只需在自己的 App 中输入邀请码。</Text>
                  <Pressable onPress={createInvite} disabled={Boolean(busy)} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
                    <Text style={styles.primaryButtonText}>{busy === 'invite' ? '正在生成…' : '生成一次性邀请码'}</Text>
                  </Pressable>
                  {invite ? <View style={styles.inviteBox}><Text style={styles.inviteLabel}>家庭邀请码</Text><Text selectable style={styles.inviteCode}>{invite.code}</Text><Text style={styles.inviteHint}>24 小时内有效 · 使用一次后失效</Text></View> : null}
                </View>
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>加入其他家庭</Text>
          <View style={styles.card}>
            <Text style={styles.hint}>输入家庭所有者发给你的 8 位邀请码。</Text>
            <TextInput
              value={inviteCode}
              onChangeText={value => setInviteCode(value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
              placeholder="例如 8KJ4M2QP"
              style={styles.codeInput}
            />
            <Pressable onPress={acceptInvite} disabled={!inviteCode.trim() || Boolean(busy)} style={({ pressed }) => [styles.primaryButton, (!inviteCode.trim() || busy) && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.primaryButtonText}>{busy === 'accept' ? '正在加入…' : '加入家庭'}</Text>
            </Pressable>
          </View>

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
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
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 56 },
  sectionTitleRow: { marginTop: 26, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 20, lineHeight: 26, fontWeight: '700', marginTop: 26, marginBottom: 10 },
  sectionCount: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12 },
  card: { borderRadius: 20, borderWidth: 1, borderColor: '#EBEBEB', backgroundColor: '#FFFFFF', padding: 16, marginBottom: 12 },
  cardTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, fontWeight: '700' },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#222222' },
  avatarText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  flex: { flex: 1, minWidth: 0 },
  label: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 10, fontWeight: '600' },
  nameInput: { minHeight: 34, fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 16, fontWeight: '700', paddingVertical: 4 },
  smallButton: { minHeight: 36, minWidth: 56, paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#222222', alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  hint: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 12, lineHeight: 18, marginTop: 8 },
  householdName: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 20, fontWeight: '700' },
  emptyTitle: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '700' },
  memberRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E5E5' },
  memberAvatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F0F0' },
  memberAvatarText: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '700' },
  memberTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  memberName: { fontFamily: SYSTEM_FONT, color: '#222222', fontSize: 15, fontWeight: '700' },
  selfBadge: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 9, lineHeight: 16, paddingHorizontal: 6, borderRadius: 8, overflow: 'hidden', backgroundColor: '#222222' },
  memberRole: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 11, lineHeight: 17, marginTop: 2 },
  removeText: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 10, fontWeight: '600', marginTop: 5 },
  primaryButton: { minHeight: 50, marginTop: 14, borderRadius: 16, backgroundColor: '#222222', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryButtonText: { fontFamily: SYSTEM_FONT, color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  inviteBox: { marginTop: 12, paddingVertical: 18, borderRadius: 16, backgroundColor: '#F3F3F3', alignItems: 'center' },
  inviteLabel: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 10, fontWeight: '600' },
  inviteCode: { fontFamily: 'Menlo', color: '#222222', fontSize: 28, lineHeight: 38, fontWeight: '700', letterSpacing: 3, marginTop: 5 },
  inviteHint: { fontFamily: SYSTEM_FONT, color: '#717171', fontSize: 10, marginTop: 4 },
  codeInput: { minHeight: 54, marginTop: 12, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: '#D8D8D8', backgroundColor: '#FFFFFF', fontFamily: 'Menlo', color: '#222222', fontSize: 18, fontWeight: '700', letterSpacing: 2, textAlign: 'center' },
  notice: { fontFamily: SYSTEM_FONT, color: '#245B35', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  error: { fontFamily: SYSTEM_FONT, color: '#C13515', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  pressed: { opacity: 0.66 },
  disabled: { opacity: 0.42 },
});
