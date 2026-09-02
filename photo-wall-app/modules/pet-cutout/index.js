import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const PetCutout = Platform.OS === 'ios' ? requireOptionalNativeModule('PetCutout') : null;

export function isPetCutoutAvailable() {
  return Boolean(PetCutout);
}

export async function cutoutPet(sourceUri) {
  if (!PetCutout) {
    throw new Error('宠物抠图目前仅支持 iPhone');
  }
  return PetCutout.cutoutAsync(sourceUri);
}

export async function removePetCutout(outputUri) {
  if (PetCutout && outputUri) {
    await PetCutout.removeAsync(outputUri);
  }
}