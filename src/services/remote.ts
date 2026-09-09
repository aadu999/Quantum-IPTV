import { Channel } from '../types';
import { state, FALLBACK_LOGO } from '../state/store';
import { QuantumSessionStore } from '../state/session';
import { parseXtreamInput, getXtreamCredentials, xtreamConnector } from './xtream';
import { formatTimestamp } from '../ui/controls';

declare const mqtt: any;
declare const QRCode: any;

let mqttClient: any = null;
const broadcastChan =
  typeof window !== 'undefined' && window.BroadcastChannel
    ? new BroadcastChannel(`quantum_iptv_${state.roomId}`)
    : null;

export function initRemoteSync(): void {
  if (broadcastChan) {
    broadcastChan.onmessage = (event: MessageEvent) => {
      if (!event.data) return;
      if (state.isRemoteClient) {
        if (event.data.action === 'SYNC_STATE') updateRemoteStateView(event.data.payload);
        if (event.data.action === 'SYNC_CATALOG') handleIncomingCatalogSync(event.data.payload);
      } else {
        handleIncomingRemoteCommand(event.data);
      }
    };
  }

  try {
    if (typeof mqtt !== 'undefined') {
      const clientId = (state.isRemoteClient ? 'remote_' : 'tv_') + Math.random().toString(16).substring(2, 10);
      mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
        clientId,
        clean: true,
        connectTimeout: 6000,
        reconnectPeriod: 2500
      });

      mqttClient.on('connect', () => {
        const cmdTopic = `quantum_tv/${state.roomId}/cmd`;
        const stateTopic = `quantum_tv/${state.roomId}/state`;
        const catalogTopic = `quantum_tv/${state.roomId}/catalog`;

        if (state.isRemoteClient) {
          mqttClient.subscribe(stateTopic);
          mqttClient.subscribe(catalogTopic);
          const statEl = document.getElementById('remote-conn-status');
          if (statEl) statEl.textContent = 'Connected to TV';
          sendRemoteCmd('REQUEST_SYNC');
        } else {
          mqttClient.subscribe(cmdTopic);
          broadcastTVState();
          broadcastTVCatalog();
        }
      });

      mqttClient.on('message', (topic: string, payload: any) => {
        try {
          const data = JSON.parse(payload.toString());
          if (state.isRemoteClient) {
            if (topic.endsWith('/state')) updateRemoteStateView(data);
            if (topic.endsWith('/catalog')) handleIncomingCatalogSync(data);
          } else {
            if (topic.endsWith('/cmd')) handleIncomingRemoteCommand(data);
          }
        } catch (e) {}
      });
    }
  } catch (e) {}
}

export function sendRemoteCmd(action: string, payload: Record<string, any> = {}): void {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(35);
    } catch (e) {}
  }
  const msgId = `${action}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const cmd = { msgId, action, payload, roomId: state.roomId, sender: 'remote', time: Date.now() };

  if (broadcastChan) broadcastChan.postMessage(cmd);
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(`quantum_tv/${state.roomId}/cmd`, JSON.stringify(cmd));
  }
}

export function broadcastTVState(): void {
  if (state.isRemoteClient) return;

  const curCh = state.filteredChannels[state.currentChannelIndex] || state.channels[0];
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const hasFiniteDur = !!(video && video.duration && isFinite(video.duration) && video.duration > 0);

  const tvState = {
    roomId: state.roomId,
    channelId: curCh ? curCh.id : '',
    channelName: curCh ? curCh.name : 'Asianet News',
    channelLogo: curCh ? curCh.logo : '',
    channelUrl: curCh ? curCh.url : '',
    program: curCh ? curCh.program : 'Live Broadcast',
    isPlaying: video ? !video.paused : false,
    isMuted: video ? video.muted : false,
    volume: video ? video.volume : 1,
    currentTime: video ? video.currentTime || 0 : 0,
    duration: hasFiniteDur ? video!.duration : 0,
    hasFiniteDuration: hasFiniteDur,
    isVOD:
      hasFiniteDur ||
      (curCh && (curCh.type === 'vod' || curCh.type === 'series' || !!curCh.vodId || !!curCh.seriesId)),
    isFullscreen: state.isTheaterFullscreen,
    favorites: state.favorites
  };

  if (broadcastChan) broadcastChan.postMessage({ action: 'SYNC_STATE', payload: tvState });
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(`quantum_tv/${state.roomId}/state`, JSON.stringify(tvState));
  }
}

export function broadcastTVCatalog(): void {
  if (state.isRemoteClient) return;

  const session = QuantumSessionStore.loadSession();
  const series = state.channels
    ? state.channels.filter(c => c.type === 'series' || c.seriesId || (c.url && c.url.includes('/series/')))
    : [];
  const movies = state.channels
    ? state.channels.filter(c => c.type === 'vod' || c.vodId || (c.url && c.url.includes('/movie/')))
    : [];
  const live = state.channels
    ? state.channels.filter(c => c.type !== 'series' && c.type !== 'vod' && !c.seriesId && !c.vodId)
    : [];

  const ordered = [...series, ...movies, ...live];
  const catalogData = {
    channels: ordered.slice(0, 6000),
    session: session
  };

  if (broadcastChan) broadcastChan.postMessage({ action: 'SYNC_CATALOG', payload: catalogData });
  if (mqttClient && mqttClient.connected) {
    const lightCatalog = {
      channels: ordered.slice(0, 200),
      channelCount: state.channels ? state.channels.length : 0,
      session: session
    };
    mqttClient.publish(`quantum_tv/${state.roomId}/catalog`, JSON.stringify(lightCatalog));
  }
}

export async function handleIncomingCatalogSync(payload: any): Promise<void> {
  if (!payload) return;

  if (Array.isArray(payload.channels) && payload.channels.length > 0) {
    if (!state.channels || state.channels.length <= payload.channels.length || state.channels.length <= 5) {
      state.channels = payload.channels;
      state.filteredChannels = [...state.channels];
      QuantumSessionStore.saveChannels(state.channels);
    }
  }

  if (payload.session) {
    if (payload.session.xtreamHost) {
      state.lastXtreamHost = payload.session.xtreamHost;
      state.lastXtreamUser = payload.session.xtreamUser;
      state.lastXtreamPass = payload.session.xtreamPass;
    }
    QuantumSessionStore.saveSession(payload.session);
  }

  if (state.isRemoteClient) {
    if (state.channels.length <= 5) {
      const creds = getXtreamCredentials();
      if (creds && creds.host && creds.username && creds.password) {
        try {
          await xtreamConnector.fetchXtreamPlaylist(creds.host, creds.username, creds.password);
          QuantumSessionStore.saveChannels(state.channels);
        } catch (e) {}
      }
    }
    (window as any).renderRemoteChannelsList?.();
    (window as any).renderRemoteFavsList?.();
  }
}

const processedRemoteMsgIds = new Set<string>();
let lastRemoteCmdAction: string | null = null;
let lastRemoteCmdTime = 0;

export function handleIncomingRemoteCommand(msg: any): void {
  if (!msg || !msg.action || state.isRemoteClient) return;

  if (msg.msgId) {
    if (processedRemoteMsgIds.has(msg.msgId)) return;
    processedRemoteMsgIds.add(msg.msgId);
    if (processedRemoteMsgIds.size > 100) {
      const firstKey = processedRemoteMsgIds.values().next().value;
      if (firstKey) processedRemoteMsgIds.delete(firstKey);
    }
  }

  const now = Date.now();
  if (msg.action === lastRemoteCmdAction && now - lastRemoteCmdTime < 300) {
    return;
  }
  lastRemoteCmdAction = msg.action;
  lastRemoteCmdTime = now;

  if (['FULLSCREEN', 'TUNE_CHANNEL'].includes(msg.action)) {
    (window as any).closeModals?.();
  }

  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const volSlider = document.getElementById('vol-slider') as HTMLInputElement | null;

  switch (msg.action) {
    case 'REQUEST_SYNC':
      broadcastTVState();
      broadcastTVCatalog();
      const remoteModal = document.getElementById('modal-remote');
      if (remoteModal && !remoteModal.classList.contains('hidden')) {
        remoteModal.classList.add('hidden');
        (window as any).engine?.showToast?.('📱 Quant TV Remote Connected!', 'success');
      }
      break;
    case 'PLAY_PAUSE':
    case 'OK':
      (window as any).togglePlayPause?.();
      break;
    case 'CH_NEXT':
      if (state.currentChannelIndex < state.filteredChannels.length - 1) {
        (window as any).playChannel?.(state.currentChannelIndex + 1);
      } else {
        (window as any).playChannel?.(0);
      }
      break;
    case 'CH_PREV':
      if (state.currentChannelIndex > 0) {
        (window as any).playChannel?.(state.currentChannelIndex - 1);
      } else {
        (window as any).playChannel?.(state.filteredChannels.length - 1);
      }
      break;
    case 'VOL_UP':
      if (video) {
        video.volume = Math.min(1, Math.round((video.volume + 0.05) * 100) / 100);
        if (volSlider) volSlider.value = String(video.volume);
        video.muted = false;
        (window as any).showTvVolumeHud?.(video.volume, false);
        broadcastTVState();
      }
      break;
    case 'VOL_DOWN':
      if (video) {
        video.volume = Math.max(0, Math.round((video.volume - 0.05) * 100) / 100);
        if (volSlider) volSlider.value = String(video.volume);
        (window as any).showTvVolumeHud?.(video.volume, video.muted);
        broadcastTVState();
      }
      break;
    case 'MUTE':
      if (video) {
        video.muted = !video.muted;
        (window as any).showTvVolumeHud?.(video.volume, video.muted);
        broadcastTVState();
      }
      break;
    case 'SEEK_TO':
      if (video && msg.payload) {
        if (typeof msg.payload.timeSec === 'number') {
          video.currentTime = Math.max(0, Math.min(video.duration || 0, msg.payload.timeSec));
        } else if (typeof msg.payload.positionPercent === 'number' && video.duration && isFinite(video.duration)) {
          video.currentTime = Math.max(
            0,
            Math.min(video.duration, (msg.payload.positionPercent / 100) * video.duration)
          );
        }
        (window as any).updateTimeAndSeekBar?.();
        broadcastTVState();
      }
      break;
    case 'SEEK_DELTA':
      if (msg.payload && typeof msg.payload.seconds === 'number') {
        (window as any).seekVideo?.(msg.payload.seconds);
        broadcastTVState();
      }
      break;
    case 'FULLSCREEN':
      (window as any).toggleFullscreenMode?.();
      break;
    case 'TUNE_CHANNEL':
      if (msg.payload) {
        (window as any).tuneToChannel?.(msg.payload);
      }
      break;
    case 'SET_FAVORITES':
      if (msg.payload && Array.isArray(msg.payload.favorites)) {
        state.favorites = msg.payload.favorites;
        localStorage.setItem('quantum_iptv_favs', JSON.stringify(state.favorites));
        (window as any).updateFavoritesUI?.();
        (window as any).renderChannelList?.();
        broadcastTVState();
      }
      break;
    case 'CONFIGURE_PROVIDER':
      if (msg.payload) {
        handleRemoteProviderConfig(msg.payload);
      }
      break;
    case 'OPEN_SERIES_EXPLORER':
      if (msg.payload) {
        const seriesId = msg.payload.seriesId || msg.payload.id;
        const ch = state.channels.find(c => c.id === msg.payload.id || c.seriesId == seriesId);
        if (ch && (window as any).openSeriesExplorer) {
          (window as any).openSeriesExplorer(ch);
        }
      }
      break;
    case 'OPEN_MOVIE_EXPLORER':
      if (msg.payload) {
        const vodId = msg.payload.vodId || msg.payload.id;
        const ch = state.channels.find(c => c.id === msg.payload.id || c.vodId == vodId);
        if (ch && (window as any).openMovieExplorer) {
          (window as any).openMovieExplorer(ch);
        }
      }
      break;
  }
}

export async function handleRemoteProviderConfig(payload: any): Promise<void> {
  if (!payload || !payload.type) return;
  (window as any).closeModals?.();

  const remoteModal = document.getElementById('modal-remote');
  if (remoteModal) remoteModal.classList.add('hidden');

  try {
    if (payload.type === 'xtream') {
      const parsed = parseXtreamInput(payload.host, payload.username, payload.password);
      const hostInput = document.getElementById('input-xtream-host') as HTMLInputElement | null;
      const userInput = document.getElementById('input-xtream-user') as HTMLInputElement | null;
      const passInput = document.getElementById('input-xtream-pass') as HTMLInputElement | null;
      if (hostInput) hostInput.value = parsed.host || '';
      if (userInput) userInput.value = parsed.username || '';
      if (passInput) passInput.value = parsed.password || '';

      (window as any).engine?.showSpinner?.(true, 'Syncing Xtream Provider from Remote...');
      if (typeof (window as any).connectXtreamApi === 'function') {
        await (window as any).connectXtreamApi(parsed.host, parsed.username, parsed.password);
      }
    } else if (payload.type === 'm3u') {
      const m3uInput = document.getElementById('input-m3u-url') as HTMLInputElement | null;
      if (m3uInput) m3uInput.value = payload.url || '';

      (window as any).engine?.showSpinner?.(true, 'Loading M3U Playlist from Remote...');
      if (payload.url.startsWith('http://') || payload.url.startsWith('https://')) {
        await (window as any).loadCustomM3uUrl?.(payload.url);
      } else {
        await (window as any).parseAndLoadM3U?.(payload.url, 'Remote M3U');
      }
    }
    broadcastTVState();
  } catch (err) {
    console.error('Failed to configure provider from remote command:', err);
    (window as any).engine?.showSpinner?.(false);
  }
}

export function updateRemoteStateView(data: any): void {
  if (!data) return;
  const remName = document.getElementById('remote-now-channel');
  const remProg = document.getElementById('remote-now-prog');
  const remLogo = document.getElementById('remote-now-logo') as HTMLImageElement | null;
  const remFav = document.getElementById('remote-now-fav-btn');

  if (remName && data.channelName) {
    remName.textContent = data.channelName;
    remName.setAttribute('data-id', data.channelId || '');
    remName.setAttribute('data-url', data.channelUrl || '');
  }
  if (remProg && data.program) remProg.textContent = data.program;
  if (remLogo) remLogo.src = data.channelLogo || FALLBACK_LOGO;

  if (data.favorites && Array.isArray(data.favorites)) {
    state.favorites = data.favorites;
    localStorage.setItem('quantum_iptv_favs', JSON.stringify(state.favorites));
  }

  if (remFav && data.channelId) {
    const isFav = state.favorites.includes(data.channelId);
    remFav.innerHTML = isFav ? '<i class="fa-solid fa-star text-amber-400"></i>' : '<i class="fa-regular fa-star"></i>';
  }

  // Update Remote VOD / Content Seek Bar Card
  const seekCard = document.getElementById('remote-vod-seek-card');
  const curTimeEl = document.getElementById('remote-time-current');
  const durTimeEl = document.getElementById('remote-time-duration');
  const seekSlider = document.getElementById('remote-seek-slider') as HTMLInputElement | null;

  if (seekCard) {
    if (data.duration && isFinite(data.duration) && data.duration > 0) {
      (window as any).lastKnownRemoteDuration = data.duration;
      seekCard.classList.remove('hidden');
      if (curTimeEl) curTimeEl.textContent = formatTimestamp(data.currentTime || 0);
      if (durTimeEl) durTimeEl.textContent = formatTimestamp(data.duration);
      if (seekSlider && !(window as any).isRemoteUserScrubbing) {
        const percent = Math.min(100, Math.max(0, ((data.currentTime || 0) / data.duration) * 100));
        seekSlider.value = percent.toFixed(1);
      }
    } else if (data.isVOD) {
      seekCard.classList.remove('hidden');
      if (curTimeEl) curTimeEl.textContent = formatTimestamp(data.currentTime || 0);
      if (durTimeEl) durTimeEl.textContent = '--:--';
    } else {
      seekCard.classList.add('hidden');
    }
  }
}

export function setupRemoteSeekControls(): void {
  const seekSlider = document.getElementById('remote-seek-slider') as HTMLInputElement | null;
  const curTimeEl = document.getElementById('remote-time-current');
  if (!seekSlider) return;

  seekSlider.addEventListener('input', () => {
    (window as any).isRemoteUserScrubbing = true;
    const percent = parseFloat(seekSlider.value);
    const lastDur = (window as any).lastKnownRemoteDuration || 0;
    if (curTimeEl && lastDur > 0) {
      curTimeEl.textContent = formatTimestamp((percent / 100) * lastDur);
    }
  });

  const finishScrub = () => {
    if ((window as any).isRemoteUserScrubbing) {
      (window as any).isRemoteUserScrubbing = false;
      const percent = parseFloat(seekSlider.value);
      sendRemoteCmd('SEEK_TO', { positionPercent: percent });
    }
  };

  seekSlider.addEventListener('change', finishScrub);
  seekSlider.addEventListener('mouseup', finishScrub);
  seekSlider.addEventListener('touchend', finishScrub);
}

export function toggleCurrentPlayingFav(): void {
  const remName = document.getElementById('remote-now-channel');
  if (!remName) return;
  const chId = remName.getAttribute('data-id');
  if (chId) {
    toggleRemoteFav(chId);
  }
}

export function toggleRemoteFav(channelId: string, evt?: Event): void {
  if (evt) {
    evt.stopPropagation();
    evt.preventDefault();
  }
  const idx = state.favorites.indexOf(channelId);
  if (idx > -1) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.push(channelId);
  }
  localStorage.setItem('quantum_iptv_favs', JSON.stringify(state.favorites));

  sendRemoteCmd('SET_FAVORITES', { favorites: state.favorites });

  (window as any).renderRemoteChannelsList?.();
  (window as any).renderRemoteFavsList?.();

  const curChId = document.getElementById('remote-now-channel')?.getAttribute('data-id');
  const remFav = document.getElementById('remote-now-fav-btn');
  if (remFav && curChId) {
    const isFav = state.favorites.includes(curChId);
    remFav.innerHTML = isFav ? '<i class="fa-solid fa-star text-amber-400"></i>' : '<i class="fa-regular fa-star"></i>';
  }
}

export function setRemoteCategory(cat: string): void {
  state.remoteActiveCategory = cat;
  document.querySelectorAll('.rem-cat-btn').forEach(btn => {
    if (btn.getAttribute('data-cat') === cat) {
      btn.className = 'rem-cat-btn px-2.5 py-1 rounded-full bg-brand-600 text-white font-medium whitespace-nowrap';
    } else {
      btn.className =
        'rem-cat-btn px-2.5 py-1 rounded-full bg-slate-900 text-slate-400 font-medium whitespace-nowrap border border-slate-800';
    }
  });
  state.remoteLimit = 60;
  (window as any).renderRemoteChannelsList?.();
}

export function openRemotePairingModal(): void {
  const modal = document.getElementById('modal-remote');
  if (!modal) return;
  modal.classList.remove('hidden');

  const roomLabel = document.getElementById('remote-room-id');
  if (roomLabel) roomLabel.textContent = state.roomId;

  const remoteUrl = `${window.location.origin}${window.location.pathname}?remote=${state.roomId}`;
  const testBtn = document.getElementById('btn-test-remote') as HTMLAnchorElement | null;
  if (testBtn) testBtn.href = remoteUrl;

  const qrContainer = document.getElementById('qrcode-container');
  if (qrContainer) {
    qrContainer.innerHTML = '';
    try {
      if (typeof QRCode !== 'undefined') {
        new QRCode(qrContainer, {
          text: remoteUrl,
          width: 170,
          height: 170,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } else {
        qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=${encodeURIComponent(
          remoteUrl
        )}" alt="QR Code" class="rounded">`;
      }
    } catch {
      qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=${encodeURIComponent(
        remoteUrl
      )}" alt="QR Code" class="rounded">`;
    }
  }
}

export function checkAndLaunchRemoteView(): void {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('remote')) {
    state.isRemoteClient = true;

    const video = document.getElementById('video-player') as HTMLVideoElement | null;
    if (video) {
      video.pause();
      video.muted = true;
      video.src = '';
      video.removeAttribute('src');
      video.load();
    }

    const vStage = document.getElementById('video-stage');
    if (vStage) vStage.style.display = 'none';
    const tvHead = document.getElementById('tv-header');
    if (tvHead) tvHead.style.display = 'none';
    const sidebar = document.getElementById('channel-sidebar');
    if (sidebar) sidebar.style.display = 'none';

    const remoteApp = document.getElementById('mobile-remote-app');
    if (remoteApp) remoteApp.classList.remove('hidden');

    const roomTag = document.getElementById('remote-room-tag');
    if (roomTag) roomTag.textContent = state.roomId;

    const navPad = document.getElementById('rem-nav-pad');
    const navChannels = document.getElementById('rem-nav-channels');
    const navMovies = document.getElementById('rem-nav-movies');
    const navSeries = document.getElementById('rem-nav-series');
    const navFavs = document.getElementById('rem-nav-favs');
    const navConfig = document.getElementById('rem-nav-config');

    const bodyPad = document.getElementById('remote-body-pad');
    const bodyChannels = document.getElementById('remote-body-channels');
    const bodyFavs = document.getElementById('remote-body-favs');
    const bodyConfig = document.getElementById('remote-body-config');

    function switchRemoteTab(tab: string): void {
      if (bodyPad) bodyPad.classList.toggle('hidden', tab !== 'pad');
      if (bodyChannels) bodyChannels.classList.toggle('hidden', !['channels', 'movies', 'series'].includes(tab));
      if (bodyFavs) bodyFavs.classList.toggle('hidden', tab !== 'favs');
      if (bodyConfig) bodyConfig.classList.toggle('hidden', tab !== 'config');

      [navPad, navChannels, navMovies, navSeries, navFavs, navConfig].forEach(b => {
        if (b) {
          b.classList.remove('text-brand-400');
          b.classList.add('text-slate-400');
        }
      });

      if (tab === 'pad' && navPad) navPad.classList.add('text-brand-400');
      if (tab === 'channels' && navChannels) {
        navChannels.classList.add('text-brand-400');
        setRemoteCategory('LIVE');
      }
      if (tab === 'movies' && navMovies) {
        navMovies.classList.add('text-brand-400');
        setRemoteCategory('MOVIES');
      }
      if (tab === 'series' && navSeries) {
        navSeries.classList.add('text-brand-400');
        setRemoteCategory('SERIES');
      }
      if (tab === 'favs' && navFavs) {
        navFavs.classList.add('text-brand-400');
        (window as any).renderRemoteFavsList?.();
      }
      if (tab === 'config' && navConfig) {
        navConfig.classList.add('text-brand-400');
      }
    }

    if (navPad) navPad.addEventListener('click', () => switchRemoteTab('pad'));
    if (navChannels) navChannels.addEventListener('click', () => switchRemoteTab('channels'));
    if (navMovies) navMovies.addEventListener('click', () => switchRemoteTab('movies'));
    if (navSeries) navSeries.addEventListener('click', () => switchRemoteTab('series'));
    if (navFavs) navFavs.addEventListener('click', () => switchRemoteTab('favs'));
    if (navConfig) navConfig.addEventListener('click', () => switchRemoteTab('config'));

    // Real-time live search as you type on Quant TV Remote
    const remSearch = document.getElementById('remote-search-input') as HTMLInputElement | null;
    if (remSearch) {
      remSearch.addEventListener('input', () => {
        (window as any).renderRemoteChannelsList?.();
      });
    }
  }
}

export const setupRemoteModal = openRemotePairingModal;

export let currentRemoteConfigType = 'xtream';

export function setRemoteConfigType(type: string): void {
  currentRemoteConfigType = type;
  ['xtream', 'm3u', 'stalker', 'epg'].forEach(t => {
    const btn = document.getElementById(`rem-cfg-btn-${t}`);
    const form = document.getElementById(`rem-cfg-form-${t}`);
    if (btn) {
      btn.className =
        t === type
          ? 'py-1.5 rounded-lg bg-brand-600 text-white transition'
          : 'py-1.5 rounded-lg text-slate-400 hover:text-white transition';
    }
    if (form) {
      form.className = t === type ? 'flex flex-col gap-2.5 text-left' : 'hidden';
    }
  });
}

export function submitRemoteProviderConfig(): void {
  const payload: Record<string, any> = { type: currentRemoteConfigType };
  const statusEl = document.getElementById('rem-cfg-status-msg');

  if (currentRemoteConfigType === 'xtream') {
    const host = (document.getElementById('rem-xtream-host') as HTMLInputElement | null)?.value.trim();
    const user = (document.getElementById('rem-xtream-user') as HTMLInputElement | null)?.value.trim();
    const pass = (document.getElementById('rem-xtream-pass') as HTMLInputElement | null)?.value.trim();
    if (!host) {
      alert('Please enter a valid Xtream Server Host URL');
      return;
    }
    payload.host = host;
    payload.username = user;
    payload.password = pass;
  } else if (currentRemoteConfigType === 'm3u') {
    const url = (document.getElementById('rem-m3u-url') as HTMLTextAreaElement | null)?.value.trim();
    if (!url) {
      alert('Please enter a valid M3U URL or playlist content');
      return;
    }
    payload.url = url;
  } else if (currentRemoteConfigType === 'stalker') {
    const url = (document.getElementById('rem-stalker-url') as HTMLInputElement | null)?.value.trim();
    const mac = (document.getElementById('rem-stalker-mac') as HTMLInputElement | null)?.value.trim();
    if (!url) {
      alert('Please enter a Stalker Portal URL');
      return;
    }
    payload.url = url;
    payload.mac = mac;
  } else if (currentRemoteConfigType === 'epg') {
    const url = (document.getElementById('rem-epg-url') as HTMLInputElement | null)?.value.trim();
    if (!url) {
      alert('Please enter an XMLTV EPG URL');
      return;
    }
    payload.url = url;
  }

  sendRemoteCmd('CONFIGURE_PROVIDER', payload);

  if (statusEl) {
    statusEl.textContent = '✓ Configuration sent to TV! Syncing streams...';
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }
}

(window as any).sendRemoteCmd = sendRemoteCmd;
(window as any).broadcastTVState = broadcastTVState;
(window as any).broadcastTVCatalog = broadcastTVCatalog;
(window as any).openRemotePairingModal = openRemotePairingModal;
(window as any).setupRemoteModal = setupRemoteModal;
(window as any).setRemoteCategory = setRemoteCategory;
(window as any).toggleCurrentPlayingFav = toggleCurrentPlayingFav;
(window as any).toggleRemoteFav = toggleRemoteFav;
(window as any).setRemoteConfigType = setRemoteConfigType;
(window as any).submitRemoteProviderConfig = submitRemoteProviderConfig;
(window as any).setupRemoteSeekControls = setupRemoteSeekControls;


