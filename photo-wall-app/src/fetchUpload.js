import { File } from 'expo-file-system';

const PHOTO_MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
  gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff',
};
const typeForName = name => PHOTO_MIME_TYPES[String(name || '').match(/\.([^.]+)$/)?.[1].toLowerCase()];

// Expo fetch reads file bytes; React Native's URI-only upload parts are for XHR.
export function appendLocalFetchFile(form, field, { uri, name, type }) {
  const file = new File(uri);
  const detectedType = type || file.type;
  form.append(field, {
    name: name || file.name,
    type: detectedType && detectedType !== 'application/octet-stream' ? detectedType
      : typeForName(file.name) || typeForName(name) || 'application/octet-stream',
    bytes: () => file.bytes(),
  });
}
