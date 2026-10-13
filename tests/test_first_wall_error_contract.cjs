const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { runFirstWall } = require('../photo-wall-app/src/firstWall.cjs');

const app = path.resolve(__dirname, '../photo-wall-app');
const dependencies = process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve = name => require.resolve(name, { paths: [dependencies] });
const babel = require(resolve('@babel/core'));
const filename = path.join(app, 'src/deviceApi.js');
const code = babel.transformFileSync(filename, {
  configFile: false, babelrc: false,
  plugins: [resolve('@babel/plugin-transform-modules-commonjs')],
}).code;

function api(fetch) {
  const mocks = {
    'react-native': { Platform: { OS: 'ios' } },
    './unifiedSelection': { UNIFIED_SELECTION: true, SELECTION_CONTRACT: 'unified-recollections-v1' },
    './selectionReadiness.cjs': require('../photo-wall-app/src/selectionReadiness.cjs'),
    './networkRecovery.cjs': require('../photo-wall-app/src/networkRecovery.cjs'),
  };
  const module = { exports: {} };
  vm.compileFunction(code, ['module', 'exports', 'require', 'fetch', 'process', '__DEV__'], { filename })(
    module, module.exports, name => mocks[name] || {}, fetch, { env: {} }, false);
  return module.exports;
}

function fixture(responses) {
  const requests = [], events = [], sleeps = [];
  let saved = {}, live = { device_id: 'synthetic-screen', revision: '' }, bodyReads = 0;
  const options = {
    apiBase: 'https://fixture.invalid/', accountToken: 'synthetic-owner',
    deviceId: 'synthetic-screen', template: 'auto', title: 'Synthetic wall',
    filters: ['person_synthetic'], excludeFilters: ['synthetic-exclusion'],
    selectionSources: ['synthetic-album'], preferenceRevisionId: 'synthetic-preference',
  };
  const client = api(async (url, request) => {
    assert.equal(url, 'https://fixture.invalid/api/generate');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['X-Account-Token'], options.accountToken);
    assert.equal(request.headers['X-Selection-Contract'], 'unified-recollections-v1');
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload, {
      template: options.template, title: options.title, filters: options.filters,
      exclude_filters: options.excludeFilters, device_id: options.deviceId,
      preference_revision_id: options.preferenceRevisionId,
      selection_contract: 'unified-recollections-v1', selection_sources: options.selectionSources,
    });
    const response = responses[requests.length];
    assert.ok(response, 'unexpected extra generation request');
    requests.push(payload);
    events.push(`http:${response.status}`);
    return {
      ok: response.status >= 200 && response.status < 300, status: response.status,
      text: async () => { bodyReads++; return JSON.stringify(response.body); },
    };
  });
  return {
    requests, events, sleeps, saved: () => saved, bodyReads: () => bodyReads,
    deps: {
      load: async () => saved,
      save: async value => { saved = structuredClone(value); events.push(`save:${value.state}`); },
      readDevice: async () => live,
      prepare: async () => { events.push('prepare'); },
      generate: () => client.generateWall(options),
      publish: async wall => {
        assert.deepEqual(wall, responses[responses.length - 1].body);
        events.push('publish');
        live = { device_id: options.deviceId, revision: 'synthetic-revision', displayed_revision: 'synthetic-revision' };
        return { device: live, revision: live.revision };
      },
      stage: value => events.push(`stage:${value}`),
      sleep: async ms => sleeps.push(ms),
      polls: 2,
    },
  };
}

test('actual generate HTTP terminal contract stops first-wall retries despite 尚未 in the detail', async () => {
  const body = {
    detail: '人物识别分组已变化或尚未完成，请重新确认人物偏好；未忽略原有范围',
    code: 'people_selection_changed', retryable: false,
  };
  const f = fixture([{ status: 409, body }]);
  await assert.rejects(runFirstWall(f.deps), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message, body.detail);
    assert.deepEqual(error.data, body);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.bodyReads(), 1);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.saved(), {});
  assert.deepEqual(f.events, ['stage:preparing', 'prepare', 'stage:generating', 'http:409']);
});

test('actual generate HTTP retryable contract recovers and publishes exactly once after valid generation', async () => {
  const pending = { status: 409, body: {
    detail: '人物识别分组正在准备', code: 'people_pending', retryable: true,
  } };
  const wall = { wall_id: 'synthetic-wall', image_url: '/output/synthetic-wall.png' };
  const f = fixture([pending, pending, { status: 200, body: wall }]);
  await runFirstWall(f.deps);
  assert.equal(f.requests.length, 3);
  assert.equal(f.bodyReads(), 3);
  assert.deepEqual(f.sleeps, [5000, 5000]);
  assert.equal(f.events.filter(event => event === 'prepare').length, 1);
  assert.equal(f.events.filter(event => event === 'publish').length, 1);
  assert.ok(f.events.indexOf('http:200') < f.events.indexOf('save:publishing'));
  assert.ok(f.events.indexOf('save:publishing') < f.events.indexOf('publish'));
  assert.deepEqual(f.saved(), {
    state: 'done', wallId: wall.wall_id, beforeRevision: '', revision: 'synthetic-revision',
  });
  assert.equal(f.events.at(-1), 'stage:done');
});
