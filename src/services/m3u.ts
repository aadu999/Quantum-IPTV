import { Channel, ChannelSource } from '../types';
import { generateChannelId } from '../state/store';
import { circuitBreaker } from '../player/circuit-breaker';
import { showAppAlert } from '../ui/dialog';
import { QuantumOfflineCache } from './cache';

export function inferChannelLanguage(name = '', tvgId = '', group = ''): string | null {
  const text = `${name} ${tvgId} ${group}`.toLowerCase();

  if (
    /malayalam|kerala|\bmal\b|\[mal\]|\|mal\||mal:|mal\s*-|\bml\b|kairali|asianet|manorama|mathrubhumi|mediaone|janam|flowers|amrita|kaumudy|reporter|zeekeralam|surya|kochu|ddmalayalam|darshana|goodness|shalom|harvest|acv|cmalayalam|anandtv/i.test(
      text
    )
  ) {
    return 'Malayalam';
  }
  if (
    /tamil|\btam\b|\[tam\]|\|tam\||tam:|tam\s*-|\bta\b|wintv|win\s*tv|villagetv|village\s*tv|ultimatetv|ultimate\s*tv|sun\s*tv|kalaignar|vijay|zeetamil|polimer|puthiyathalaimurai|news7|jaya|captain|lotus|rajtv|thanthai|ddpodhigai|vettri|makkal|vendhar|isaiaruvi|seithigal|sirippoli|vasanth|chithiram|pepper|mega\s*tv|murasu/i.test(
      text
    )
  ) {
    return 'Tamil';
  }
  if (
    /kannada|\bkan\b|\[kan\]|\|kan\||kan:|kan\s*-|\bkn\b|suvarna|publictv|public\s*tv|udaya|kasthuri|powertv|power\s*tv|rajnews.*kannada|ddchandana|colors.*kannada|zeekannada|bTV|vistara/i.test(
      text
    )
  ) {
    return 'Kannada';
  }
  if (
    /telugu|\btel\b|\[tel\]|\|tel\||tel:|tel\s*-|\bte\b|tv9.*telugu|\bntv\b|\babn\b|\bv6\b|sakshi|\betv\b|tnews|t\s*news|zeetelugu|gemini|mahaa|\b10tv\b|\b99tv\b|\b6tv\b|ddyadagiri|ddsaptagiri|subhavaartha|bhakthi|svbc|hmtv|prime9|studio\s*n/i.test(
      text
    )
  ) {
    return 'Telugu';
  }
  if (
    /hindi|\bhin\b|\[hin\]|\|hin\||hin:|hin\s*-|\bhi\b|aajtak|abpnews|indiatv|republicbharat|zeenews|ndtvindia|news18india|tv9bharatvarsh|ddnational|news24|starplus|sonytv|colors|zeetv/i.test(
      text
    )
  ) {
    return 'Hindi';
  }
  if (
    /english|\beng\b|\[eng\]|\|eng\||eng:|eng\s*-|\ben\b|bbc|cnn|aljazeera|bloomberg|discovery|natgeo|hbo/i.test(
      text
    )
  ) {
    return 'English';
  }

  const langMatch = text.match(
    /\b(malayalam|kannada|hindi|tamil|telugu|english|french|german|spanish|bengali|marathi|punjabi|gujarati|bhojpuri|odia|assamese|urdu|arabic)\b/i
  );
  if (langMatch) {
    return langMatch[1].charAt(0).toUpperCase() + langMatch[1].slice(1).toLowerCase();
  }

  return null;
}

export function sanitizeChannel(ch: Channel): Channel {
  if (!ch) return ch;
  const url = (ch.url || '').toLowerCase();
  const grp = (ch.group || '').toLowerCase();
  const type = (ch.type || '').toLowerCase();

  // Priority check for TV Series
  if (type === 'series' || ch.seriesId || url.includes('/series/') || grp.includes('series')) {
    ch.type = 'series';
    return ch;
  }

  // VOD Movies or static movie video extensions
  const isLiveStreamUrl =
    url.endsWith('.m3u8') ||
    url.endsWith('.ts') ||
    url.includes('/live/') ||
    url.includes('iptv-org.github.io') ||
    url.includes('akamaized.net') ||
    url.includes('cloudfront.net') ||
    url.includes('stream') ||
    url.includes('master');
  const isVodUrl =
    type === 'vod' ||
    ch.vodId ||
    url.includes('/movie/') ||
    (/\.(mp4|mkv|avi|mov)(\?.*)?$/i.test(url) && !isLiveStreamUrl);

  if (isVodUrl) {
    ch.type = 'vod';
  } else {
    ch.type = 'live';
  }

  if (ch.type === 'live' && (grp === 'movies' || grp === 'movie' || grp.includes('movie'))) {
    ch.group = 'Live Movies';
  }
  return ch;
}

export class QuantumQuarantineManager {
  public quarantinedRecords: any[] = [];
  public ingestionJobs: any[] = [];

  logJob(job: any): void {
    this.ingestionJobs.unshift(job);
    if (this.ingestionJobs.length > 20) this.ingestionJobs.pop();
    this.updateUIBadge();
  }

  quarantine(record: any, reason: string, sourceUrl: string): any {
    const entry = {
      id: 'q_' + Math.random().toString(36).substring(2, 9),
      record,
      reason,
      sourceUrl,
      timestamp: new Date().toLocaleTimeString()
    };
    this.quarantinedRecords.unshift(entry);
    if (this.quarantinedRecords.length > 200) this.quarantinedRecords.pop();
    this.updateUIBadge();
    return entry;
  }

  updateUIBadge(): void {
    const badge = document.getElementById('badge-quarantine-count');
    if (badge) {
      badge.textContent = String(this.quarantinedRecords.length);
      if (this.quarantinedRecords.length > 0) badge.classList.remove('hidden');
    }
  }
}
export const quarantineManager = new QuantumQuarantineManager();
(window as any).quarantineManager = quarantineManager;

export class QuantumEntityDeduplicator {
  normalizeTitle(title = ''): string {
    return title
      .toLowerCase()
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .replace(/\b(hd|fhd|uhd|4k|sd|720p|1080p|live|stream|uk|in|us|ca|au|fr|de)\b/gi, '')
      .replace(/[^a-z0-9]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  calculateMatchConfidence(ch1: Channel, ch2: Channel): { confidence: number; reason: string } {
    if (ch1.url === ch2.url) return { confidence: 100, reason: 'EXACT_URL_MATCH' };
    if (ch1.tvgId && ch2.tvgId && ch1.tvgId === ch2.tvgId) return { confidence: 95, reason: 'EXACT_EPG_ID_MATCH' };

    const norm1 = this.normalizeTitle(ch1.name);
    const norm2 = this.normalizeTitle(ch2.name);
    if (norm1 && norm1 === norm2) return { confidence: 90, reason: 'NORMALIZED_TITLE_MATCH' };

    if (norm1 && norm2 && (norm1.includes(norm2) || norm2.includes(norm1))) {
      return { confidence: 75, reason: 'SUBSTRING_TITLE_MATCH' };
    }

    return { confidence: 0, reason: 'NO_MATCH' };
  }
}
export const deduplicator = new QuantumEntityDeduplicator();
(window as any).deduplicator = deduplicator;

export class QuantumSourceTracker {
  public snapshots = new Map<string, any>();

  recordSnapshot(sourceUrl: string, channels: Channel[]): any {
    const previous = this.snapshots.get(sourceUrl);
    const currentMap = new Map(channels.map(c => [c.url, c]));

    const diff = {
      timestamp: new Date().toLocaleTimeString(),
      sourceUrl,
      total: channels.length,
      added: 0,
      removed: 0,
      unchanged: 0
    };

    if (previous) {
      const prevMap = new Map(previous.channels.map((c: any) => [c.url, c]));
      channels.forEach(c => {
        if (prevMap.has(c.url)) diff.unchanged++;
        else diff.added++;
      });
      previous.channels.forEach((c: any) => {
        if (!currentMap.has(c.url)) diff.removed++;
      });
    } else {
      diff.added = channels.length;
    }

    this.snapshots.set(sourceUrl, { channels: [...channels], lastDiff: diff });
    return diff;
  }
}
export const sourceTracker = new QuantumSourceTracker();
(window as any).sourceTracker = sourceTracker;

export class QuantumSourceFusionEngine {
  public fusedMap = new Map<string, Channel>();

  fuseChannel(channelObj: Channel, sourceName = 'Default Playlist'): Channel {
    sanitizeChannel(channelObj);
    const normTitle = deduplicator.normalizeTitle(channelObj.name);
    const typePrefix = channelObj.type || 'live';
    const key = `${typePrefix}:${channelObj.tvgId ? channelObj.tvgId.toLowerCase() : normTitle || channelObj.url}`;

    const streamSource: ChannelSource = {
      url: channelObj.url,
      sourceName: sourceName
    };

    if (this.fusedMap.has(key)) {
      const existing = this.fusedMap.get(key)!;
      if (!existing.sources) existing.sources = [{ url: existing.url, sourceName: 'Primary' }];
      const hasUrl = existing.sources.some(s => s.url === channelObj.url);
      if (!hasUrl) {
        existing.sources.push(streamSource);
      }
      if (channelObj.logo && (!existing.logo || existing.logo.includes('via.placeholder'))) existing.logo = channelObj.logo;
      if (channelObj.language && !existing.language) existing.language = channelObj.language;
      if (channelObj.group && (!existing.group || existing.group === 'Live')) existing.group = channelObj.group;
      return existing;
    } else {
      const merged: Channel = {
        ...channelObj,
        sources: [streamSource],
        activeSourceIndex: 0
      };
      this.fusedMap.set(key, merged);
      return merged;
    }
  }

  getBestSource(channel: Channel): ChannelSource {
    if (!channel || !channel.sources || channel.sources.length === 0) {
      return { url: channel.url, sourceName: 'Primary' };
    }
    for (let i = 0; i < channel.sources.length; i++) {
      const src = channel.sources[i];
      if (circuitBreaker.isAvailable(src.url)) {
        channel.activeSourceIndex = i;
        return src;
      }
    }
    channel.activeSourceIndex = 0;
    return channel.sources[0];
  }
}
export const sourceFusionEngine = new QuantumSourceFusionEngine();
(window as any).sourceFusionEngine = sourceFusionEngine;

export function parseM3U(m3uText: string, defaultLanguage: string | null = null, sourceUrl = ''): Channel[] {
  if (!m3uText) return [];
  const cleanText = m3uText.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/);
  const results: Channel[] = [];
  let currentInfo: Partial<Channel> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Giant line protection
    if (line.length > 10000) {
      quarantineManager.quarantine(`Line ${i + 1} exceeds 10k chars`, 'GIANT_LINE_REJECTED', sourceUrl);
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      currentInfo = {};

      const logoMatch = line.match(/tvg-logo="([^"]+)"/i) || line.match(/tvg-logo=([^\s,]+)/i);
      if (logoMatch) currentInfo.logo = logoMatch[1];

      const countryMatch = line.match(/tvg-country="([^"]+)"/i) || line.match(/tvg-country=([^\s,]+)/i);
      if (countryMatch) currentInfo.country = countryMatch[1].toUpperCase();

      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i) || line.match(/tvg-id=([^\s,]+)/i);
      if (tvgIdMatch) currentInfo.tvgId = tvgIdMatch[1];

      const langMatch =
        line.match(/tvg-language="([^"]+)"/i) ||
        line.match(/language="([^"]+)"/i) ||
        line.match(/tvg-language=([^\s,]+)/i);
      if (langMatch) currentInfo.language = langMatch[1].trim();

      const groupMatch = line.match(/group-title="([^"]+)"/i) || line.match(/group-title=([^\s,]+)/i);
      if (groupMatch) currentInfo.group = groupMatch[1];

      const commaIdx = line.lastIndexOf(',');
      if (commaIdx !== -1) {
        currentInfo.name = line.substring(commaIdx + 1).trim();
      } else {
        currentInfo.name = 'Live Stream ' + (results.length + 1);
      }

      if (!currentInfo.language) {
        currentInfo.language =
          defaultLanguage || inferChannelLanguage(currentInfo.name, currentInfo.tvgId, currentInfo.group) || undefined;
      }
    } else if (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('/api/proxy') || (line.includes('://') && !line.startsWith('#'))) {
      let resolvedUrl = line;
      if (resolvedUrl.startsWith('/api/proxy?url=')) {
        try {
          resolvedUrl = decodeURIComponent(resolvedUrl.substring(15));
        } catch (e) {}
      }

      if (currentInfo) {
        currentInfo.url = resolvedUrl;
        currentInfo.id = generateChannelId(currentInfo.name || 'Stream', currentInfo.url);
        currentInfo.program = currentInfo.group ? `${currentInfo.group}` : 'Broadcast Program';

        const ch = sanitizeChannel(currentInfo as Channel);
        results.push(ch);
        currentInfo = null;
      } else {
        const standaloneName = `Stream ${results.length + 1}`;
        const standaloneCh = sanitizeChannel({
          id: generateChannelId(standaloneName, resolvedUrl),
          name: standaloneName,
          url: resolvedUrl,
          type: 'live',
          language: defaultLanguage || inferChannelLanguage(standaloneName) || undefined,
          group: 'Imported',
          program: 'Stream'
        });
        results.push(standaloneCh);
      }
    } else if (!line.startsWith('#')) {
      quarantineManager.quarantine(line.substring(0, 100), 'MALFORMED_LINE', sourceUrl);
    }
  }
  return results;
}

(window as any).parseM3U = parseM3U;
(window as any).sanitizeChannel = sanitizeChannel;

export async function loadM3uPlaylist(
  rawInput: string,
  isBackground = false,
  defaultLanguage: string | null = null
): Promise<void> {
  if (!rawInput) return;
  const lines = String(rawInput)
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  const engine = (window as any).engine;
  if (!isBackground && !(window as any).state?.isRemoteClient && engine) {
    engine.showSpinner(true, `Processing ${lines.length} IPTV source lines...`);
  }
  let importedTotal = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isBackground && !(window as any).state?.isRemoteClient && engine) {
      engine.showSpinner(true, `Processing Line ${i + 1}/${lines.length}...`);
    }

    try {
      const parts = line.split(/\s+/);
      const xtreamConnector = (window as any).xtreamConnector;
      if (parts.length >= 3 && parts[0].startsWith('http') && xtreamConnector) {
        const count = await xtreamConnector.fetchXtreamPlaylist(parts[0], parts[1], parts[2]);
        if (count > 0) importedTotal++;
      } else if (line.startsWith('http://') || line.startsWith('https://')) {
        await loadM3uSinglePlaylist(line, true, defaultLanguage);
        importedTotal++;
      }
    } catch (e: any) {
      console.warn(`Error processing line [${line}]:`, e.message);
    }
  }

  if (!isBackground && !(window as any).state?.isRemoteClient) {
    if (engine) engine.showSpinner(false);
    (window as any).closeModals?.();
    const channelsCount = (window as any).state?.channels?.length || 0;
    showAppAlert(
      `Batch Import Completed!\nProcessed ${importedTotal}/${lines.length} sources successfully.\nTotal Active Channels: ${channelsCount.toLocaleString()}`,
      { title: 'Playlist Import Completed', type: 'success' }
    );
  }
}

export async function loadM3uSinglePlaylist(
  url: string,
  isBackground = false,
  defaultLanguage: string | null = null
): Promise<number> {
  const engine = (window as any).engine;
  const state = (window as any).state;
  if (!isBackground && !state?.isRemoteClient && engine) {
    engine.showSpinner(true, 'Fetching M3U Playlist...');
  }
  const startTime = Date.now();

  try {
    let content = '';
    // Check local offline cache first for instant load
    const cached = await QuantumOfflineCache.getCachedPlaylist(url);
    if (cached && cached.content) {
      content = cached.content;
    } else {
      try {
        const { fetchWithProxyFallback } = await import('./proxy');
        content = await fetchWithProxyFallback(url);
        if (content && (content.includes('#EXTINF') || content.includes('#EXTM3U'))) {
          QuantumOfflineCache.cachePlaylist(url, content, 0).catch(() => {});
        }
      } catch (e: any) {
        console.warn('Proxy fetch failed in loadM3uSinglePlaylist for:', url, e.message);
      }
    }

    if (!content || (!content.includes('#EXTINF') && !content.includes('#EXTM3U'))) {
      if (url.includes('username=') && url.includes('password=') && (window as any).xtreamConnector) {
        const count = await (window as any).xtreamConnector.fetchXtreamPlaylist(url);
        if (count > 0) return count;
      }
      quarantineManager.quarantine(url, 'INVALID_PLAYLIST_HEADER', url);
      throw new Error('Invalid M3U playlist format');
    }

    if (!defaultLanguage) {
      if (url.includes('/languages/mal.m3u')) defaultLanguage = 'Malayalam';
      else if (url.includes('/languages/tel.m3u')) defaultLanguage = 'Telugu';
      else if (url.includes('/languages/tam.m3u')) defaultLanguage = 'Tamil';
      else if (url.includes('/languages/kan.m3u')) defaultLanguage = 'Kannada';
      else if (url.includes('/languages/hin.m3u')) defaultLanguage = 'Hindi';
    }

    const parsedChannels = parseM3U(content, defaultLanguage, url);
    if (parsedChannels.length > 0) {
      const snapshotDiff = sourceTracker.recordSnapshot(url, parsedChannels);

      let acceptedCount = 0;
      let duplicateCount = 0;

      parsedChannels.forEach(c => {
        const fused = sourceFusionEngine.fuseChannel(c, url);
        if (!state.channels.includes(fused)) {
          acceptedCount++;
          state.channels.push(fused);
        } else {
          duplicateCount++;
        }
      });

      quarantineManager.logJob({
        sourceUrl: url,
        timestamp: new Date().toLocaleTimeString(),
        durationMs: Date.now() - startTime,
        recordsRead: parsedChannels.length,
        recordsAccepted: acceptedCount,
        duplicates: duplicateCount,
        snapshotDiff
      });

      (window as any).updateLanguageDropdown?.();
      (window as any).filterChannels?.();
      try {
        const { QuantumOfflineCache } = await import('./cache');
        QuantumOfflineCache.saveBundle(state.channels);
      } catch (e) {}
      try {
        const { QuantumSessionStore } = await import('../state/session');
        QuantumSessionStore.saveChannels(state.channels);
      } catch (e) {}
      try {
        const { broadcastTVCatalog } = await import('./remote');
        broadcastTVCatalog();
      } catch (e) {}

      const countBadge = document.getElementById('badge-channels-count');
      if (countBadge) countBadge.textContent = `${state.channels.length.toLocaleString()} Channels Active`;

      if (!isBackground && !state.isRemoteClient) {
        (window as any).playChannel?.(0, { directPlay: true });
        (window as any).closeModals?.();
      }

      if (state.isRemoteClient) {
        (window as any).renderRemoteChannelsList?.();
        (window as any).renderRemoteFavsList?.();
      }

      return acceptedCount;
    }
    return 0;
  } catch (err) {
    if (!isBackground && !state?.isRemoteClient && engine) engine.showSpinner(false);
    throw err;
  }
}

(window as any).loadM3uPlaylist = loadM3uPlaylist;
(window as any).loadM3uSinglePlaylist = loadM3uSinglePlaylist;

