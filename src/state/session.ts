import { Channel, SessionData } from '../types';

export const QuantumSessionStore = {
  KEY: 'quantum_iptv_session_v2',
  CHANNELS_KEY: 'quantum_iptv_saved_channels_v2',

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
    try {
      if (!channels || !Array.isArray(channels) || channels.length === 0) return;
      const series = channels.filter(c => c.type === 'series' || c.seriesId || (c.url && c.url.includes('/series/')));
      const movies = channels.filter(c => c.type === 'vod' || c.vodId || (c.url && c.url.includes('/movie/')));
      const live = channels.filter(c => c.type !== 'series' && c.type !== 'vod' && !c.seriesId && !c.vodId);

      const ordered = [...series, ...movies, ...live];
      const toSave = ordered.slice(0, 6000).map(c => ({
        id: c.id,
        name: c.name,
        url: c.url,
        logo: c.logo,
        group: c.group,
        language: c.language,
        country: c.country,
        type: c.type,
        seriesId: c.seriesId,
        vodId: c.vodId,
        cover: c.cover,
        plot: c.plot,
        rating: c.rating,
        cast: c.cast,
        director: c.director,
        genre: c.genre,
        releaseDate: c.releaseDate,
        program: c.program,
        sources: c.sources
      }));
      localStorage.setItem(this.CHANNELS_KEY, JSON.stringify(toSave));
    } catch (e) {}
  },

  loadChannels(): Channel[] | null {
    try {
      const raw = localStorage.getItem(this.CHANNELS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  clearSession(): void {
    try {
      localStorage.removeItem(this.KEY);
      localStorage.removeItem(this.CHANNELS_KEY);
    } catch (e) {}
  }
};

(window as any).QuantumSessionStore = QuantumSessionStore;
