import { registerRootComponent } from 'expo';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const RELEASE_LABEL = '1.3.3 (20)';

function StartupShell() {
  const [LoadedApp, setLoadedApp] = useState(null);
  const [startupError, setStartupError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const previousHandler = global.ErrorUtils?.getGlobalHandler?.();
    const reportStartupError = error => {
      const message = String(error?.stack || error?.message || error || '未知启动错误');
      console.error('Echooo startup failed', message);
      if (active) setStartupError(message);
    };

    global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
      reportStartupError(error);
      if (!isFatal) previousHandler?.(error, false);
    });

    // 先让原生启动壳完成首帧，再加载体积较大的业务模块。
    const timer = setTimeout(() => {
      try {
        const AppModule = require('./App');
        const NextApp = AppModule?.default || AppModule;
        if (typeof NextApp !== 'function') throw new Error('App 模块没有导出可运行组件');
        if (active) setLoadedApp(() => NextApp);
      } catch (error) {
        reportStartupError(error);
      }
    }, 120);

    return () => {
      active = false;
      clearTimeout(timer);
      if (previousHandler) global.ErrorUtils?.setGlobalHandler?.(previousHandler);
    };
  }, [attempt]);

  if (LoadedApp) return <LoadedApp />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.content}>
        <View style={styles.logo}><Text style={styles.logoText}>ECHO</Text></View>
        {startupError ? (
          <>
            <Text style={styles.title}>Echooo 启动失败</Text>
            <Text style={styles.hint}>请截取本页发给开发人员。错误信息已完整保留。</Text>
            <View style={styles.errorBox}>
              <Text selectable style={styles.errorText}>{startupError}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setStartupError('');
                setLoadedApp(null);
                setAttempt(value => value + 1);
              }}
              style={styles.button}
            >
              <Text style={styles.buttonText}>重新加载</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator color="#222222" size="small" style={styles.spinner} />
            <Text style={styles.loading}>正在启动 Echooo…</Text>
          </>
        )}
        <Text style={styles.version}>{RELEASE_LABEL}</Text>
      </View>
    </SafeAreaView>
  );
}

registerRootComponent(StartupShell);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F7F7' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  logo: { minWidth: 126, height: 56, paddingHorizontal: 16, borderRadius: 16, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#F7F7F7', fontSize: 32, lineHeight: 38, fontWeight: '900', letterSpacing: -1.4 },
  spinner: { marginTop: 34 },
  loading: { color: '#555555', fontSize: 16, lineHeight: 22, marginTop: 14 },
  title: { color: '#222222', fontSize: 28, lineHeight: 36, fontWeight: '800', marginTop: 30, textAlign: 'center' },
  hint: { color: '#717171', fontSize: 14, lineHeight: 21, marginTop: 10, textAlign: 'center' },
  errorBox: { width: '100%', maxHeight: 220, marginTop: 20, padding: 14, borderRadius: 14, backgroundColor: '#FFF0ED' },
  errorText: { color: '#C13515', fontSize: 12, lineHeight: 18 },
  button: { width: '100%', minHeight: 54, marginTop: 20, borderRadius: 18, backgroundColor: '#222222', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  version: { position: 'absolute', bottom: 20, color: '#999999', fontSize: 12 },
});
