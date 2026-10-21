/* Grail Velocity — service-worker speed helpers. Classic script (importScripts). */
(function (global) {
  /**
   * Read-through cache over chrome.storage.local for hot keys (tapeSnapshots,
   * tapeScratch, catalog, tapeApi, tapeSecret). Every keystroke used to
   * deserialize the whole tape from storage; now reads hit memory until
   * chrome.storage.onChanged reports a change (from any extension page).
   *
   * Values are returned by reference — callers must not mutate them in place
   * (tape.js already builds new arrays/objects on every write).
   */
  function createStorageCache(area, onChanged) {
    const mem = new Map();
    if (onChanged && typeof onChanged.addListener === "function") {
      onChanged.addListener((changes, areaName) => {
        if (areaName && areaName !== "local") return;
        for (const [key, change] of Object.entries(changes || {})) {
          // Removal is cached as "known absent" so we do not re-read storage.
          mem.set(key, change && "newValue" in change ? change.newValue : undefined);
        }
      });
    }
    async function get(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      const missing = list.filter((k) => !mem.has(k));
      if (missing.length) {
        const fresh = (await area.get(missing)) || {};
        for (const k of missing) mem.set(k, fresh[k]);
      }
      const out = {};
      for (const k of list) {
        const v = mem.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    async function set(obj) {
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
      await area.set(obj);
    }
    function clear() {
      mem.clear();
    }
    return { get, set, clear };
  }

  /**
   * fetch() with a hard deadline so a slow / cold Tape API can never stall
   * typeahead or capture. Rejects with AbortError / TimeoutError on expiry.
   */
  function fetchWithTimeout(fetchImpl, url, init, ms) {
    const opts = { ...(init || {}) };
    if (ms > 0 && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      opts.signal = AbortSignal.timeout(ms);
    }
    return fetchImpl(url, opts);
  }

  /**
   * Tiny TTL + LRU memo for remote suggest hits (q -> hits).
   */
  function createTtlCache(opts) {
    const ttl = (opts && opts.ttlMs) || 20000;
    const max = (opts && opts.max) || 200;
    const now = (opts && opts.now) || (() => Date.now());
    const map = new Map();
    return {
      get(key) {
        const hit = map.get(key);
        if (!hit) return undefined;
        if (now() - hit.at > ttl) {
          map.delete(key);
          return undefined;
        }
        map.delete(key);
        map.set(key, hit);
        return hit.value;
      },
      set(key, value) {
        map.delete(key);
        map.set(key, { at: now(), value });
        while (map.size > max) map.delete(map.keys().next().value);
      },
      clear() {
        map.clear();
      },
      get size() {
        return map.size;
      },
    };
  }

  /**
   * Local-first background sync for POST /tape.
   *
   * enqueue() returns immediately, so capture -> overlay update no longer waits
   * on the network. Items are persisted to storage (survive service-worker
   * suspension) and flushed serially in FIFO order. A failed send keeps the item
   * and retries with backoff; the next enqueue or worker start also flushes.
   *
   * deps: { storage: {get,set}, send(payload) -> {ok}, key, max, setTimer, onSent }
   */
  function createOutbox(deps) {
    const key = deps.key || "tapeOutbox";
    const max = deps.max || 200;
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    let queue = null;
    let flushing = null;
    let retryMs = 0;
    let retryTimer = null;

    async function loadQueue() {
      if (queue) return queue;
      const data = (await deps.storage.get([key])) || {};
      queue = Array.isArray(data[key]) ? data[key] : [];
      return queue;
    }

    async function persist() {
      await deps.storage.set({ [key]: queue.slice() });
    }

    async function enqueue(payload) {
      await loadQueue();
      queue.push({ payload, at: Date.now() });
      if (queue.length > max) queue.splice(0, queue.length - max);
      persist().catch(() => {});
      flush();
      return { ok: true, queued: true, pending: queue.length };
    }

    function scheduleRetry() {
      if (retryTimer) return;
      retryMs = Math.min(60000, retryMs ? retryMs * 2 : 2000);
      retryTimer = setTimer(() => {
        retryTimer = null;
        flush();
      }, retryMs);
    }

    function flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        await loadQueue();
        let sent = 0;
        while (queue.length) {
          const item = queue[0];
          let res;
          try {
            res = await deps.send(item.payload);
          } catch (err) {
            res = { ok: false, error: String((err && err.message) || err) };
          }
          // 4xx (except 408/429) will never succeed — drop instead of wedging the queue.
          const status = res && res.status;
          const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
          if (!(res && res.ok) && !permanent) {
            scheduleRetry();
            break;
          }
          queue.shift();
          sent += 1;
          retryMs = 0;
          await persist().catch(() => {});
        }
        if (sent && deps.onSent) deps.onSent(sent);
        return { sent, pending: queue.length };
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    }

    async function pending() {
      await loadQueue();
      return queue.length;
    }

    return { enqueue, flush, pending };
  }

  global.GVSync = { createStorageCache, fetchWithTimeout, createTtlCache, createOutbox };
})(typeof globalThis !== "undefined" ? globalThis : self);
