// Kleine IndexedDB-Schicht. Alle Datensätze haben ein Feld `id`.
const DB_NAME = 'weinkeller';
const DB_VERSION = 2;
export const STORES = ['wines', 'racks', 'tastings', 'shopping', 'settings'];
// Interne Stores für die Cloud-Synchronisation (nicht im Export enthalten)
const SYSTEM_STORES = ['outbox', 'meta'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...STORES, ...SYSTEM_STORES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  all: store => tx(store, 'readonly', s => s.getAll()),
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  put: (store, value) => tx(store, 'readwrite', s => { s.put(value); return value; }),
  delete: (store, id) => tx(store, 'readwrite', s => { s.delete(id); }),
  clear: store => tx(store, 'readwrite', s => { s.clear(); }),
};

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

export async function exportAll() {
  const out = { app: 'weinkeller', version: 1, exportedAt: new Date().toISOString() };
  for (const name of STORES) {
    out[name] = await db.all(name);
  }
  // API-Key nicht mit exportieren
  out.settings = out.settings.filter(s => s.id !== 'apiKey');
  return out;
}

export async function importAll(data) {
  if (!data || data.app !== 'weinkeller') throw new Error('Keine gültige Weinkeller-Sicherung.');
  // Datensätze ohne Zeitstempel bekommen einen, damit die Synchronisation sie als neu erkennt
  const now = new Date().toISOString();
  for (const name of STORES) for (const item of data[name] || []) item.updatedAt ||= now;
  for (const name of STORES) {
    if (!Array.isArray(data[name])) continue;
    if (name !== 'settings') await db.clear(name);
    for (const item of data[name]) await db.put(name, item);
  }
}
