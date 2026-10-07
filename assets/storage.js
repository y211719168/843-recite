/**
 * IndexedDB 封装。
 *
 * 关键设计：词条内容（cards.json，只读）与学习进度（progress，可写）分离，
 * 只用 card.id 关联。这样修订词条库不会破坏学习记录。
 */

const DB_NAME = 'recite843';
const DB_VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        const s = db.createObjectStore('logs', { keyPath: 'seq', autoIncrement: true });
        s.createIndex('cardId', 'cardId');
        s.createIndex('day', 'day');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ---------- progress ---------- */

export const getAllProgress = () =>
  open().then(db => wrap(db.transaction('progress').objectStore('progress').getAll()))
    .then(list => Object.fromEntries(list.map(x => [x.id, x])));

export const putProgress = st =>
  tx('progress', 'readwrite', s => s.put(st));

export const bulkPutProgress = list =>
  tx('progress', 'readwrite', s => { list.forEach(x => s.put(x)); return list.length; });

export const clearProgress = () =>
  tx('progress', 'readwrite', s => s.clear());

/* ---------- logs ---------- */

export const addLog = log =>
  tx('logs', 'readwrite', s => s.add(log));

export const getLogs = () =>
  open().then(db => wrap(db.transaction('logs').objectStore('logs').getAll()));

export const clearLogs = () =>
  tx('logs', 'readwrite', s => s.clear());

/* ---------- meta ---------- */

export const getMeta = key =>
  open().then(db => wrap(db.transaction('meta').objectStore('meta').get(key)))
    .then(r => (r ? r.value : undefined));

export const setMeta = (key, value) =>
  tx('meta', 'readwrite', s => s.put({ key, value }));

export const allMeta = () =>
  open().then(db => wrap(db.transaction('meta').objectStore('meta').getAll()))
    .then(list => Object.fromEntries(list.map(x => [x.key, x.value])));

/* ---------- 全量导出 / 导入 ---------- */

export async function exportAll() {
  const [progress, logs, meta] = await Promise.all([getAllProgress(), getLogs(), allMeta()]);
  return {
    app: 'recite843',
    exportedAt: new Date().toISOString(),
    progress,
    logs,
    meta,
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'recite843') throw new Error('备份文件格式不正确');
  const progress = Object.values(data.progress || {});
  await clearProgress();
  await clearLogs();
  if (progress.length) await bulkPutProgress(progress);
  for (const log of data.logs || []) {
    const { seq, ...rest } = log;
    await addLog(rest);
  }
  for (const [k, v] of Object.entries(data.meta || {})) await setMeta(k, v);
  return progress.length;
}

/** 申请持久化存储，降低被系统清理的概率 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function estimateUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
