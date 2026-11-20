// Items live in IndexedDB on the phone only. Photos are stored as JPEG
// ArrayBuffers (more reliable across Safari versions than Blobs).
const DB = 'vinted-companion', STORE = 'items';

let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage aborted (phone may be out of space)'));
  });
}

export const store = {
  all: async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => a.created - b.created),
  put: (item) => tx('readwrite', (s) => s.put({ ...item, updated: Date.now() })),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  delMany: (ids) => tx('readwrite', (s) => { ids.forEach((id) => s.delete(id)); }),
};

// Ask the browser not to evict our data under storage pressure (best effort).
export const persist = () => navigator.storage?.persist?.().catch(() => false);
