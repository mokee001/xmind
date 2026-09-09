import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const NativeCuration = Platform.OS === 'ios'
  ? requireOptionalNativeModule('LocalPhotoCuration')
  : null;

export function isLocalPhotoCurationAvailable() {
  return Boolean(NativeCuration);
}

export async function curateLocalPhotos(assetIds, options = {}) {
  if (!NativeCuration) throw new Error('当前安装包不包含设备端照片识别模块');
  return NativeCuration.curateAsync(assetIds, {
    minimumScore: options.minimumScore ?? 0.52,
    maximumCandidates: options.maximumCandidates ?? 160,
    textLineLimit: options.textLineLimit ?? 5,
  });
}
