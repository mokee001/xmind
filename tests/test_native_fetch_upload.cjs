const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const app = path.resolve(__dirname, '../photo-wall-app');
const dependencies = process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve = name => require.resolve(name, { paths: [dependencies] });
const babel = require(resolve('@babel/core'));
function load(filename, mocks = {}) {
  const module = { exports: {} };
  const code = babel.transformFileSync(filename, {
    configFile: false, babelrc: false,
    plugins: [
      resolve(filename.endsWith('.ts') ? '@babel/plugin-transform-typescript' : '@babel/plugin-transform-flow-strip-types'),
      resolve('@babel/plugin-transform-modules-commonjs'),
    ],
  }).code;
  vm.compileFunction(code, ['module', 'exports', 'require'], { filename })(
    module, module.exports, name => name in mocks ? mocks[name] : require(name),
  );
  return module.exports;
}

const expo = path.dirname(resolve('expo/package.json'));
const rn = path.dirname(resolve('react-native/package.json'));
const RNFormData = load(path.join(rn, 'Libraries/Network/FormData.js')).default;
const { installFormDataPatch } = load(path.join(expo, 'src/winter/FormData.ts'));
const FormData = installFormDataPatch(RNFormData);
const { convertFormDataAsync } = load(path.join(expo, 'src/winter/fetch/convertFormData.ts'), {
  '../../utils/blobUtils': { blobToArrayBufferAsync: blob => blob.arrayBuffer() },
});

// Only native file I/O is substituted; use the installed SDK's real serializer.
class LocalFile {
  constructor(uri) { this.path = new URL(uri); this.name = path.basename(this.path.pathname); }
  bytes() { return fs.promises.readFile(this.path); }
}
const { appendLocalFetchFile } = load(path.join(app, 'src/fetchUpload.js'), {
  'expo-file-system': { File: LocalFile },
});

test('locked Expo serializer reproduces the reported URI-only upload failure', async () => {
  const form = new FormData();
  form.append('files', { uri: 'file:///test.jpg', name: 'test.jpg', type: 'image/jpeg' });
  await assert.rejects(convertFormDataAsync(form), /Unsupported FormDataPart implementation/);
});

test('native file bytes, original filename and selection metadata survive multipart encoding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photowall-upload-'));
  try {
    const local = path.join(dir, 'cached-image.jpg');
    const bytes = Buffer.from([255, 216, 0, 34, 13, 10, 128, 255, 217]);
    fs.writeFileSync(local, bytes);
    const form = new FormData();
    appendLocalFetchFile(form, 'files', {
      uri: require('node:url').pathToFileURL(local).href,
      name: 'original-photo.jpg', type: 'image/jpeg',
    });
    const metadata = JSON.stringify([{ local_engine: 'apple-vision-local-v1', vision: { faces: [] } }]);
    form.append('metadata', metadata);
    form.append('sources', JSON.stringify(['all']));
    const { body, boundary } = await convertFormDataAsync(form);
    const decoded = await new Response(body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }).formData();
    assert.equal(decoded.get('files').name, 'original-photo.jpg');
    assert.equal(decoded.get('files').type, 'image/jpeg');
    assert.deepEqual(Buffer.from(await decoded.get('files').arrayBuffer()), bytes);
    assert.equal(decoded.get('metadata'), metadata);
    assert.equal(decoded.get('sources'), '["all"]');
    assert.deepEqual(fs.readFileSync(local), bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing original fails serialization instead of silently uploading an empty photo', async () => {
  const form = new FormData();
  appendLocalFetchFile(form, 'file', {
    uri: 'file:///photowall-upload-test-missing/image.png', name: 'image.png', type: 'image/png',
  });
  await assert.rejects(convertFormDataAsync(form), { code: 'ENOENT' });
});
