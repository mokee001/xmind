// Loaded only by the static Pages export. The local Python API stays unchanged.
(() => {
  const base = new URL('./', document.currentScript.src);
  const legacyKey = `echoo-project-dashboard:v1:${base.pathname}`;
  const storageKey = `echoo-project-dashboard:v2:${base.pathname}`;
  const lockKey = `${storageKey}:write`;
  let initialState;

  async function readJSON(path) {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error('无法读取发布文件，请刷新重试');
    return response.json();
  }

  function checkState(value) {
    if (!value || !Number.isInteger(value.revision) || value.revision < 0 ||
        !value.owners || !['hardware', 'software', 'template'].every(k => typeof value.owners[k] === 'string' && value.owners[k].trim()) ||
        !['tasks', 'ideas', 'updates', 'releases'].every(k => Array.isArray(value[k]))) {
      throw new Error('浏览器中的看板数据格式不正确，请保留数据并联系维护者恢复');
    }
    return window.EchooPlan.validate(value);
  }

  async function readState() {
    let saved;
    try { saved = localStorage.getItem(storageKey); }
    catch { throw new Error('浏览器阻止了本地存储，请允许此站点保存数据后重试'); }
    if (saved !== null) {
      try { return checkState(JSON.parse(saved)); }
      catch { throw new Error('浏览器中的看板数据无法读取，原数据已保留，请联系维护者恢复'); }
    }
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) return window.EchooPlan.upgrade(JSON.parse(legacy), await window.EchooPlan.ready);
    initialState ||= readJSON('seed.json').then(checkState);
    return structuredClone(await initialState);
  }

  async function writeState(options) {
    // Web Locks serializes writes across tabs. Do not silently permit lost updates.
    if (!navigator.locks) throw new Error('请使用支持安全保存的新版 Chrome、Safari、Edge 或 Firefox');
    return navigator.locks.request(lockKey, async () => {
      const next = checkState(JSON.parse(options.body));
      const current = await readState();
      if (next.revision !== current.revision) {
        const error = new Error('另一页面刚更新了看板。当前输入已保留，请核对后再次保存。');
        error.status = 409;
        throw error;
      }
      next.revision += 1;
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { throw new Error('浏览器保存失败，可能是存储空间不足；当前输入已保留，请重试'); }
      return structuredClone(next);
    });
  }

  window.echooStaticStorage = {
    async request(url, options = {}) {
      const route = new URL(url, location.origin);
      if (route.pathname === '/api/state') {
        if (options.method === 'PUT') return writeState(options);
        return readState();
      }
      if (route.pathname === '/api/documents') return readJSON('documents.json');
      if (route.pathname === '/api/document') {
        const id = route.searchParams.get('id');
        const documents = await readJSON('documents.json');
        if (!documents.some(document => document.id === id)) throw new Error('文档不存在');
        return readJSON(`documents/${encodeURIComponent(id)}.json`);
      }
      throw new Error('此操作不适用于当前发布版本');
    }
  };
})();
