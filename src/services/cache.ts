import { Channel } from '../types';

export class QuantumOfflineCache {
  static SAVE_KEY = 'quantum_iptv_offline_bundle_v2';

  static saveBundle(channels: Channel[]): void {
    try {
      if (!channels || channels.length === 0) return;
      const payload = {
        timestamp: Date.now(),
        channels: channels.slice(0, 800)
      };
      localStorage.setItem(this.SAVE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  static loadBundle(): { timestamp: number; channels: Channel[] } | null {
    try {
      const raw = localStorage.getItem(this.SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
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
