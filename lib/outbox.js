/* Local capture queue. IndexedDB in the service worker; memory in tests. */
(function (global) {
  function createMemoryOutbox() {
    const map = new Map();
    return {
      async putMany(rows) {
        let added = 0;
        for (const row of rows) {
          if (!row || !row.raw_hash || map.has(row.raw_hash)) continue;
          map.set(row.raw_hash, row);
          added += 1;
        }
        return added;
      },
      async peek(limit) {
        return [...map.values()].slice(0, limit);
      },
      async remove(hashes) {
        for (const hash of hashes || []) map.delete(hash);
      },
      async size() {
        return map.size;
      },
    };
  }

  function createIdbOutbox() {
    const root = global.indexedDB;
    if (!root) throw new Error("IndexedDB unavailable");
    let opening;
    function open() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const req = root.open("gv-capture", 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("outbox")) {
              db.createObjectStore("outbox", { keyPath: "raw_hash" });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return opening;
    }

    return {
      async putMany(rows) {
        const db = await open();
        return new Promise((resolve, reject) => {
          let added = 0;
          const tx = db.transaction("outbox", "readwrite");
          const store = tx.objectStore("outbox");
          const all = store.getAll();
          all.onsuccess = () => {
            const have = new Set((all.result || []).map((row) => row.raw_hash));
            for (const row of rows || []) {
              if (!row || !row.raw_hash || have.has(row.raw_hash)) continue;
              store.put(row);
              have.add(row.raw_hash);
              added += 1;
            }
          };
          tx.oncomplete = () => resolve(added);
          tx.onerror = () => reject(tx.error);
        });
      },
      async peek(limit) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction("outbox", "readonly");
          const all = tx.objectStore("outbox").getAll();
          all.onsuccess = () => resolve((all.result || []).slice(0, limit));
          tx.onerror = () => reject(tx.error);
        });
      },
      async remove(hashes) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction("outbox", "readwrite");
          const store = tx.objectStore("outbox");
          for (const hash of hashes || []) store.delete(hash);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      async size() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction("outbox", "readonly");
          const count = tx.objectStore("outbox").count();
          count.onsuccess = () => resolve(count.result || 0);
          tx.onerror = () => reject(tx.error);
        });
      },
    };
  }

  global.GVOutbox = { createMemoryOutbox, createIdbOutbox };
})(globalThis);
