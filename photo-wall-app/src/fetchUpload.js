import { File } from 'expo-file-system';

// Expo fetch reads file bytes; React Native's URI-only upload parts are for XHR.
export function appendLocalFetchFile(form, field, { uri, name, type }) {
  const file = new File(uri);
  form.append(field, {
    name: name || file.name,
    type: type || file.type || 'application/octet-stream',
    bytes: () => file.bytes(),
  });
}
