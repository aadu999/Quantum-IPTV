import { Channel, SessionData } from '../types';
import { QuantumOfflineCache } from '../services/cache';

export const QuantumSessionStore = {
  KEY: 'quantum_iptv_session_v2',
  BOOTSTRAP_KEY: 'quantum_iptv_bootstrap_v2',
  LEGACY_CHANNELS_KEY: 'quantum_iptv_saved_channels_v2',

  saveSession(data: Partial<SessionData> = {}): void {
    try {
      const current = this.loadSession() || {};
      const updated = { ...current, ...data, lastUpdated: Date.now() };
      localStorage.setItem(this.KEY, JSON.stringify(updated));
    } catch (e) {}
  },

  loadSession(): (SessionData & { lastUpdated?: number }) | null {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  saveChannels(channels: Channel[]): void {
    if (!channels || !Array.isArray(channels) || channels.length === 0) return;

    // 1. Asynchronously persist full catalog (unlimited capacity) into IndexedDB
    QuantumOfflineCache.saveAllChannels(channels).catch(err => {
      console.warn('[QuantumSessionStore] Failed to save to IndexedDB:', err);
    });

    // 2. Extract ultra-lightweight micro-bootstrap (top 50 priority channels) for instant cold start (< 20KB)
    try {
      const malayalam = channels.filter(c =>
        (c.language && c.language.toLowerCase() === 'malayalam') ||
        (c.name && c.name.toLowerCase().includes('malayalam')) ||
        (c.group && c.group.toLowerCase().includes('malayalam')) ||
        (c.name && c.name.toLowerCase().includes('asianet'))
      );
      const others = channels.filter(c => !malayalam.includes(c));
      const bootstrap = [...malayalam, ...others].slice(0, 50).map(c => ({
        id: c.id,
        name: c.name,
        url: c.url,
        logo: c.logo,
        group: c.group,
        language: c.language,
        country: c.country,
        type: c.type,
        program: c.program,
        sources: c.sources
      }));

      localStorage.setItem(this.BOOTSTRAP_KEY, JSON.stringify(bootstrap));

      // Purge legacy bloated multi-megabyte 6,000 channel string to eliminate main-thread freeze
      localStorage.removeItem(this.LEGACY_CHANNELS_KEY);
      localStorage.removeItem('quantum_iptv_offline_bundle_v2');
    } catch (e) {
      console.warn('[QuantumSessionStore] Bootstrap save warning:', e);
    }
  },

  loadChannels(): Channel[] | null {
    // 1. Fast path: Read ultra-lightweight micro-bootstrap (< 50 items, < 2ms parse time)
    try {
      const bootstrapRaw = localStorage.getItem(this.BOOTSTRAP_KEY);
      if (bootstrapRaw) {
        return JSON.parse(bootstrapRaw);
      }
    } catch (e) {}

    // 2. Migration path: Check legacy key if present, migrate to IndexedDB, then purge legacy key
    try {
      const legacyRaw = localStorage.getItem(this.LEGACY_CHANNELS_KEY);
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Asynchronously migrate to IndexedDB
          QuantumOfflineCache.saveAllChannels(parsed).catch(() => {});
          // Save lightweight bootstrap
          this.saveChannels(parsed);
          return parsed.slice(0, 50);
        }
      }
    } catch (e) {}

    return null;
  },

  clearSession(): void {
    try {
      localStorage.removeItem(this.KEY);
      localStorage.removeItem(this.BOOTSTRAP_KEY);
      localStorage.removeItem(this.LEGACY_CHANNELS_KEY);
      localStorage.removeItem('quantum_iptv_offline_bundle_v2');
    } catch (e) {}
  }
};

if (typeof window !== 'undefined') {
  (window as any).QuantumSessionStore = QuantumSessionStore;
}
