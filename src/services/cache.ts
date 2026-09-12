import { Channel } from '../types';

const DB_NAME = 'quantum_iptv_db_v2';
const DB_VERSION = 2;
const STORE_CHANNELS = 'channels';
const STORE_PLAYLISTS = 'playlists';
const STORE_KEYVAL = 'keyval';
const LS_SAVE_KEY = 'quantum_iptv_offline_bundle_v2';

export class QuantumOfflineCache {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  // 1. IndexedDB Initialization
  private static getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB not supported'));
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_CHANNELS)) {
          const chStore = db.createObjectStore(STORE_CHANNELS, { keyPath: 'id' });
          chStore.createIndex('language', 'language', { unique: false });
          chStore.createIndex('type', 'type', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
          db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains(STORE_KEYVAL)) {
          db.createObjectStore(STORE_KEYVAL, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  /**
   * Persists the catalogue for offline use.
   *
   * This used to also write a 450-channel bundle to localStorage under
   * LS_SAVE_KEY, which QuantumSessionStore.saveChannels then deleted as legacy
   * bloat on its very next call — the two helpers fought over the same key on
   * every playlist load, costing a multi-megabyte serialise for data that was
   * immediately discarded. The micro-bootstrap in QuantumSessionStore is the
   * single owner of synchronous fast-hydration now; this owns IndexedDB.
   */
  static saveBundle(channels: Channel[]): void {
    if (!channels || channels.length === 0) return;
    this.saveAllChannels(channels).catch(() => {});
  }

  static loadBundle(): { timestamp: number; channels: Channel[] } | null {
    try {
      const raw = localStorage.getItem(LS_SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // 3. Complete Catalog Storage via IndexedDB (Virtually Unlimited Capacity)
  /**
   * Writes the catalogue into IndexedDB, reconciling against what is already
   * stored rather than clearing first.
   *
   * The previous implementation cleared the store and then re-put every row. It
   * ran on every playlist load, and because the clear and the puts were separate
   * awaited steps, a failure or a page close in between left the user with an
   * empty catalogue and no offline fallback at all. Reconciling inside a single
   * transaction means the store is never observably empty, and a run that
   * changes nothing costs no writes.
   */
  static async saveAllChannels(channels: Channel[]): Promise<void> {
    if (!channels || channels.length === 0) return;

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_CHANNELS, 'readwrite');
      const store = tx.objectStore(STORE_CHANNELS);

      const existingKeys = await new Promise<Set<string>>((resolve, reject) => {
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(new Set((req.result || []).map(String)));
        req.onerror = () => reject(req.error);
      });

      const incomingKeys = new Set<string>();
      for (const channel of channels) {
        if (!channel?.id) continue;
        incomingKeys.add(String(channel.id));
        store.put(channel);
      }

      // Drop only rows that genuinely disappeared from the catalogue.
      for (const key of existingKeys) {
        if (!incomingKeys.has(key)) store.delete(key);
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('IndexedDB saveAllChannels error:', e);
    }
  }

  static async loadAllChannels(): Promise<Channel[]> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_CHANNELS, 'readonly');
      const store = tx.objectStore(STORE_CHANNELS);

      return new Promise<Channel[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB loadAllChannels error:', e);
      return [];
    }
  }

  // 4. Playlist Content Caching with TTL
  static async cachePlaylist(url: string, content: string, count: number): Promise<void> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
      const store = tx.objectStore(STORE_PLAYLISTS);

      const record = {
        url,
        content,
        count,
        timestamp: Date.now()
      };
      store.put(record);
    } catch (e) {
      console.warn('cachePlaylist error for', url, e);
    }
  }

  static async getCachedPlaylist(url: string, maxAgeMs = 24 * 3600 * 1000): Promise<{ content: string; count: number } | null> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_PLAYLISTS, 'readonly');
      const store = tx.objectStore(STORE_PLAYLISTS);

      return new Promise((resolve) => {
        const req = store.get(url);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec && rec.content && (Date.now() - rec.timestamp) < maxAgeMs) {
            resolve({ content: rec.content, count: rec.count || 0 });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }
}

export class QuantumWorkerEngine {
  private worker: Worker | null = null;

  constructor() {
    this.initWorker();
  }

  initWorker(): void {
    const workerCode = `
      self.onmessage = function(e) {
        const { type, payload } = e.data;
        if (type === 'FILTER_CHANNELS') {
          const { channels, query } = payload;
          const q = query.toLowerCase();
          const filtered = channels.filter(c => 
            (c.name && c.name.toLowerCase().includes(q)) ||
            (c.group && c.group.toLowerCase().includes(q)) ||
            (c.language && c.language.toLowerCase().includes(q))
          );
          self.postMessage({ type: 'FILTER_COMPLETE', filtered });
        }
      };
    `;
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
    } catch (e) {}
  }

  filterInBackground(channels: Channel[], query: string, callback: (filtered: Channel[]) => void): boolean {
    if (!this.worker) return false;
    this.worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'FILTER_COMPLETE') {
        callback(e.data.filtered);
      }
    };
    this.worker.postMessage({ type: 'FILTER_CHANNELS', payload: { channels, query } });
    return true;
  }
}

export const workerEngine = new QuantumWorkerEngine();
(window as any).QuantumOfflineCache = QuantumOfflineCache;
(window as any).workerEngine = workerEngine;
