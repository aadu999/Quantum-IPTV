import { Channel } from '../types';
import { state } from '../state/store';
import { QuantumSessionStore } from '../state/session';
import { fetchWithProxyFallback } from './proxy';
import { inferChannelLanguage, parseM3U, sourceFusionEngine } from './m3u';

export function parseXtreamInput(hostInput?: string, userInput?: string, passInput?: string): {
  host: string;
  username: string;
  password: string;
} {
  let host = (hostInput || '').trim();
  let user = (userInput || '').trim();
  let pass = (passInput || '').trim();

  if (host.includes(' ')) {
    const parts = host.split(/\s+/);
    if (parts.length >= 3) {
      host = parts[0];
      if (!user) user = parts[1];
      if (!pass) pass = parts[2];
    }
  }

  if (host && !host.startsWith('http://') && !host.startsWith('https://')) {
    host = 'http://' + host;
  }

  if (
    host.includes('get.php') ||
    host.includes('player_api.php') ||
    host.includes('username=') ||
    host.includes('user=')
  ) {
    try {
      const u = new URL(host);
      const params = new URLSearchParams(u.search);
      if (params.get('username')) user = params.get('username')!;
      if (!user && params.get('user')) user = params.get('user')!;
      if (params.get('password')) pass = params.get('password')!;
      if (!pass && params.get('pass')) pass = params.get('pass')!;
      host = u.origin;
    } catch {
      const userMatch = host.match(/(?:username|user)=([^&]+)/i);
      const passMatch = host.match(/(?:password|pass)=([^&]+)/i);
      if (userMatch) user = userMatch[1];
      if (passMatch) pass = passMatch[1];
      host = host.split('/get.php')[0].split('/player_api.php')[0];
    }
  }
  return {
    host: (host || '').replace(/\/+$/, ''),
    username: user,
    password: pass
  };
}

export function getXtreamCredentials(channel: Channel | null = null): {
  host: string;
  username: string;
  password: string;
} {
  let host =
    state.lastXtreamHost ||
    ((document.getElementById('rem-xtream-host') as HTMLInputElement)?.value ||
      (document.getElementById('input-xtream-host') as HTMLInputElement)?.value ||
      '').trim();
  let user =
    state.lastXtreamUser ||
    ((document.getElementById('rem-xtream-user') as HTMLInputElement)?.value ||
      (document.getElementById('input-xtream-user') as HTMLInputElement)?.value ||
      '').trim();
  let pass =
    state.lastXtreamPass ||
    ((document.getElementById('rem-xtream-pass') as HTMLInputElement)?.value ||
      (document.getElementById('input-xtream-pass') as HTMLInputElement)?.value ||
      '').trim();

  if (!host || !user || !pass) {
    const session = QuantumSessionStore.loadSession();
    if (session) {
      host = host || session.xtreamHost || '';
      user = user || session.xtreamUser || '';
      pass = pass || session.xtreamPass || '';
    }
  }

  if ((!host || !user || !pass) && channel && channel.url) {
    try {
      const match = channel.url.match(/^(https?:\/\/[^\/]+)\/(?:series|movie|live)\/([^\/]+)\/([^\/]+)/i);
      if (match) {
        host = host || match[1];
        user = user || match[2];
        pass = pass || match[3];
      }
    } catch {}
  }

  const parsed = parseXtreamInput(host, user, pass);
  if (parsed.host) state.lastXtreamHost = parsed.host;
  if (parsed.username) state.lastXtreamUser = parsed.username;
  if (parsed.password) state.lastXtreamPass = parsed.password;
  return parsed;
}

export function attachXtreamAutoParse(hostId: string, userId: string, passId: string): void {
  const hostEl = document.getElementById(hostId) as HTMLInputElement | null;
  const userEl = document.getElementById(userId) as HTMLInputElement | null;
  const passEl = document.getElementById(passId) as HTMLInputElement | null;
  if (!hostEl) return;

  const triggerParse = () => {
    const raw = hostEl.value.trim();
    if (
      raw.includes('get.php') ||
      raw.includes('player_api.php') ||
      raw.includes('username=') ||
      raw.includes('user=')
    ) {
      const parsed = parseXtreamInput(raw, userEl ? userEl.value : '', passEl ? passEl.value : '');
      if (parsed.host) hostEl.value = parsed.host;
      if (userEl && parsed.username) userEl.value = parsed.username;
      if (passEl && parsed.password) passEl.value = parsed.password;
    }
  };

  hostEl.addEventListener('input', triggerParse);
  hostEl.addEventListener('paste', () => setTimeout(triggerParse, 50));
  hostEl.addEventListener('blur', triggerParse);
}

export class QuantumXtreamConnector {
  async fetchXtreamPlaylist(hostInput?: string, userInput?: string, passInput?: string): Promise<number> {
    const { host, username, password } = parseXtreamInput(hostInput, userInput, passInput);

    if (!host) {
      throw new Error('Please specify a valid Xtream Host URL.');
    }

    let addedCount = 0;

    // STRATEGY A: Query JSON Player API (player_api.php) if credentials are available
    if (username && password) {
      try {
        const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const authText = await fetchWithProxyFallback(apiUrl);
        let data: any = null;
        try {
          data = JSON.parse(authText);
        } catch {}

        if (data && data.user_info && data.user_info.auth !== 0) {
          state.lastXtreamHost = host;
          state.lastXtreamUser = username;
          state.lastXtreamPass = password;

          // 1. TV Series
          try {
            const seriesUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series`;
            const seriesText = await fetchWithProxyFallback(seriesUrl);
            const seriesStreams = JSON.parse(seriesText);
            if (Array.isArray(seriesStreams)) {
              seriesStreams.forEach(item => {
                const seriesStreamUrl = `${host}/series/${username}/${password}/${item.series_id}.mkv`;
                const ch: Channel = {
                  id: 'xt_series_' + item.series_id,
                  name: item.name,
                  url: seriesStreamUrl,
                  logo: item.cover || item.stream_icon,
                  cover: item.cover || item.stream_icon,
                  plot: item.plot,
                  rating: item.rating,
                  cast: item.cast,
                  director: item.director,
                  genre: item.genre || item.category_name || 'TV Series',
                  releaseDate: item.releaseDate,
                  seriesId: item.series_id,
                  group: 'TV Series',
                  language: inferChannelLanguage(item.name) || undefined,
                  type: 'series'
                };
                const fused = sourceFusionEngine.fuseChannel(ch, 'Xtream Series');
                if (!state.channels.includes(fused)) {
                  state.channels.push(fused);
                  addedCount++;
                }
              });
            }
          } catch (e: any) {
            console.warn('Xtream Series JSON fetch warning:', e.message);
          }

          // 2. VOD Movies
          try {
            const vodUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_streams`;
            const vodText = await fetchWithProxyFallback(vodUrl);
            const vodStreams = JSON.parse(vodText);
            if (Array.isArray(vodStreams)) {
              vodStreams.slice(0, 300).forEach(item => {
                const vodStreamUrl = `${host}/movie/${username}/${password}/${item.stream_id}.${item.container_extension || 'mp4'}`;
                const ch: Channel = {
                  id: 'xt_vod_' + item.stream_id,
                  name: item.name,
                  url: vodStreamUrl,
                  logo: item.stream_icon,
                  vodId: item.stream_id,
                  group: 'VOD Movies',
                  language: inferChannelLanguage(item.name) || undefined,
                  type: 'vod',
                  rating: item.rating
                };
                const fused = sourceFusionEngine.fuseChannel(ch, 'Xtream VOD');
                if (!state.channels.includes(fused)) {
                  state.channels.push(fused);
                  addedCount++;
                }
              });
            }
          } catch (e: any) {
            console.warn('Xtream VOD JSON fetch warning:', e.message);
          }

          // 3. Live Streams with dual HLS + TS failover sources
          try {
            const liveUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`;
            const liveText = await fetchWithProxyFallback(liveUrl);
            const liveStreams = JSON.parse(liveText);
            if (Array.isArray(liveStreams)) {
              liveStreams.forEach(item => {
                const m3u8Url = `${host}/live/${username}/${password}/${item.stream_id}.m3u8`;
                const tsUrl = `${host}/live/${username}/${password}/${item.stream_id}.ts`;
                const ch: Channel = {
                  id: 'xt_live_' + item.stream_id,
                  name: item.name,
                  url: m3u8Url,
                  logo: item.stream_icon,
                  group: item.category_name || 'Xtream Live',
                  language: inferChannelLanguage(item.name) || undefined,
                  type: 'live',
                  tvgId: item.epg_channel_id,
                  sources: [
                    { url: m3u8Url, sourceName: 'Xtream HLS' },
                    { url: tsUrl, sourceName: 'Xtream MPEG-TS' }
                  ]
                };
                const fused = sourceFusionEngine.fuseChannel(ch, 'Xtream API');
                if (!state.channels.includes(fused)) {
                  state.channels.push(fused);
                  addedCount++;
                }
              });
            }
          } catch (e: any) {
            console.warn('Xtream Live Streams JSON fetch warning:', e.message);
          }
        }
      } catch (e: any) {
        console.warn('Xtream Strategy A failed:', e.message);
      }
    }

    // STRATEGY B: Xtream M3U Plus Feed Fallback (get.php) if Strategy A yielded 0 channels
    if (addedCount === 0 && username && password) {
      console.log('Initiating Xtream Strategy B (M3U Plus Feed)...');
      const m3uPlusUrl = `${host}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus`;
      try {
        const m3uText = await fetchWithProxyFallback(m3uPlusUrl);
        if (m3uText && (m3uText.includes('#EXTINF') || m3uText.includes('#EXTM3U'))) {
          const parsed = parseM3U(m3uText, null, m3uPlusUrl);
          parsed.forEach(c => {
            const fused = sourceFusionEngine.fuseChannel(c, 'Xtream M3U Feed');
            if (!state.channels.includes(fused)) {
              state.channels.push(fused);
              addedCount++;
            }
          });
        }
      } catch (e: any) {
        console.error('Xtream Strategy B (M3U Feed) failed:', e.message);
      }
    }

    if (addedCount === 0) {
      throw new Error(`Could not load channels from Xtream server (${host}). Please check credentials, port, or server status.`);
    }

    (window as any).updateLanguageDropdown?.();
    (window as any).filterChannels?.();
    return addedCount;
  }

  async fetchSeriesInfo(seriesId: string, channel: Channel | null = null): Promise<any> {
    if (!seriesId) return null;
    const creds = getXtreamCredentials(channel);
    if (!creds || !creds.host || !creds.username || !creds.password) return null;
    const { host, username, password } = creds;
    const infoUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
    try {
      const text = await fetchWithProxyFallback(infoUrl);
      return JSON.parse(text);
    } catch (e: any) {
      console.warn(`Failed to fetch series info for ID ${seriesId}:`, e.message);
      return null;
    }
  }

  async fetchVodInfo(vodId: string, channel: Channel | null = null): Promise<any> {
    if (!vodId) return null;
    const creds = getXtreamCredentials(channel);
    if (!creds || !creds.host || !creds.username || !creds.password) return null;
    const { host, username, password } = creds;
    const infoUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_info&vod_id=${encodeURIComponent(vodId)}`;
    try {
      const text = await fetchWithProxyFallback(infoUrl);
      return JSON.parse(text);
    } catch (e: any) {
      console.warn(`Failed to fetch VOD info for ID ${vodId}:`, e.message);
      return null;
    }
  }
}

export const xtreamConnector = new QuantumXtreamConnector();
(window as any).xtreamConnector = xtreamConnector;
(window as any).parseXtreamInput = parseXtreamInput;
(window as any).getXtreamCredentials = getXtreamCredentials;
(window as any).attachXtreamAutoParse = attachXtreamAutoParse;
