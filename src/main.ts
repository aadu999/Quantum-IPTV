import './index.css';
import { state, DEFAULT_PRESET_CHANNELS } from './state/store';
import { QuantumSessionStore } from './state/session';
import { userProfile, decisionEngine } from './state/user-profile';
import { circuitBreaker } from './player/circuit-breaker';
import { playbackMachine } from './player/playback-machine';
import { QuantumStreamEngine } from './player/engine';
import { loadM3uPlaylist, quarantineManager, sanitizeChannel } from './services/m3u';
import { xtreamConnector, parseXtreamInput, attachXtreamAutoParse } from './services/xtream';
import { stalkerConnector } from './services/stalker';
import { xmltvParser, renderEpgTimeline, startEpgAutoRefresh } from './services/xmltv';
import { QuantumOfflineCache, workerEngine } from './services/cache';
import {
  initRemoteSync,
  broadcastTVState,
  broadcastTVCatalog,
  checkAndLaunchRemoteView,
  setupRemoteModal,
  sendRemoteCmd,
  setupRemoteSeekControls,
  getPublicRemoteUrl
} from './services/remote';
import {
  setEngineInstance,
  togglePlayPause,
  toggleFullscreenMode,
  wakeControls,
  unmuteAudioNow,
  toggleMute,
  seekVideo,
  handleSeekBarClick,
  playNextWorkingChannel,
  updatePlayPauseIcons,
  showTvVolumeHud,
  updateTimeAndSeekBar,
  applyResumePosition,
  handleEpisodeEnded,
  adjustMobileVideoStage,
  showEngineHud
} from './ui/controls';
import {
  setChannelEngineInstance,
  playChannel,
  tuneToChannel,
  filterChannels,
  filterContentType,
  renderChannelList,
  updateFavoritesUI,
  loadMoreTvChannels,
  renderRemoteChannelsList,
  renderRemoteFavsList,
  clearRemoteSearch,
  loadMoreRemoteChannels,
  updateLanguageDropdown
} from './ui/channels';
import {
  setModalEngineInstance,
  openSeriesExplorer,
  closeSeriesExplorer,
  toggleSeriesExpandView,
  selectSeriesSeason,
  playEpisodeStream,
  openMovieExplorer,
  closeMovieExplorer,
  startMoviePlayback,
  openQuarantineModal,
  closeQuarantineModal,
  switchQuarantineTab,
  renderQuarantineTab,
  toggleSubtitlePopover,
  toggleAudioPopover,
  selectSubtitleTrack,
  selectNativeSubtitleTrack,
  selectAudioTrack,
  copyToClipboard,
  closeModals
} from './ui/modals';
import { showAppAlert, showAppConfirm, closeAppDialog } from './ui/dialog';
import { initTvNavigation } from './ui/tv-navigation';

// Instantiate Core Stream Engine
const videoElement = document.getElementById('video-player') as HTMLVideoElement;
export const engine = new QuantumStreamEngine(videoElement);

// Inject Engine instance into UI modules
setEngineInstance(engine);
setChannelEngineInstance(engine);
setModalEngineInstance(engine);

// Window Attachments for Global HTML Handlers
(window as any).engine = engine;
(window as any).state = state;
(window as any).xtreamConnector = xtreamConnector;
(window as any).circuitBreaker = circuitBreaker;
(window as any).quarantineManager = quarantineManager;
(window as any).playbackMachine = playbackMachine;
(window as any).decisionEngine = decisionEngine;
(window as any).userProfile = userProfile;
(window as any).QuantumSessionStore = QuantumSessionStore;
(window as any).QuantumOfflineCache = QuantumOfflineCache;
(window as any).loadM3uPlaylist = loadM3uPlaylist;

export function openM3uModal(): void {
  const modal = document.getElementById('modal-m3u');
  if (modal) modal.classList.remove('hidden');
}

export function closeM3uModal(): void {
  const modal = document.getElementById('modal-m3u');
  if (modal) modal.classList.add('hidden');
}

export function openRemoteModal(): void {
  setupRemoteModal();
  const modal = document.getElementById('modal-remote');
  if (modal) modal.classList.remove('hidden');
}

export function closeRemoteModal(): void {
  const modal = document.getElementById('modal-remote');
  if (modal) modal.classList.add('hidden');
}

/** True when the app is running on an Android TV / leanback device. */
function isLeanbackDevice(): boolean {
  const native = (window as any).AndroidTvNative;
  // The native bridge knows for certain (PackageManager.FEATURE_LEANBACK);
  // outside the APK fall back to user-agent sniffing.
  if (native && typeof native.isTvDevice === 'function') {
    try {
      return !!native.isTvDevice();
    } catch {
      /* older APK without the method — fall through */
    }
  }
  const ua = navigator.userAgent.toLowerCase();
  // Fire TV reports model codes such as AFTB, AFTT and AFTKA, so the prefix must
  // stay open-ended -- an \baft\b anchor misses every one of them.
  return /android tv|googletv|google tv|leanback|\baft[a-z0-9]*\b|smart-tv|smarttv|crkey|bravia|webos|tizen|hbbtv|viera|netcast/.test(ua);
}

/**
 * Restores Picture-in-Picture.
 *
 * The control was removed from the markup in 88d8c87 while its click handler was
 * left behind in this file, so for several releases the feature looked wired up
 * but had no button to trigger it. It is back, with the two things that were
 * missing before: it is only shown where PiP genuinely works, and it is excluded
 * from D-pad navigation (via tabindex="-1") so it does not add a dead focus stop
 * on TV — the reason it was dropped.
 */
function setupPictureInPicture(btnPip: HTMLElement, video: HTMLVideoElement): void {
  const nativeBridge = (window as any).AndroidTvNative;
  const hasNativePip = !!nativeBridge && typeof nativeBridge.enterPictureInPicture === 'function';
  // Android's WebView does not implement the HTMLVideoElement PiP API, so inside
  // the APK the web call silently does nothing and the native path is required.
  const hasWebPip =
    typeof document !== 'undefined' &&
    (document as any).pictureInPictureEnabled === true &&
    typeof (video as any).requestPictureInPicture === 'function' &&
    !(video as any).disablePictureInPicture;

  if (isLeanbackDevice() || (!hasWebPip && !hasNativePip)) {
    // Leave it hidden rather than offering a button that cannot work.
    return;
  }

  btnPip.classList.remove('hidden');
  btnPip.classList.add('flex');

  const setIcon = (active: boolean) => {
    btnPip.innerHTML = `<i class="fa-solid ${
      active ? 'fa-compress' : 'fa-clone'
    } text-xs pointer-events-none"></i>`;
    btnPip.setAttribute('title', active ? 'Exit Picture in Picture (I)' : 'Picture in Picture (I)');
  };

  const toggle = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (hasWebPip) {
        await (video as any).requestPictureInPicture();
        return;
      }
      if (hasNativePip && nativeBridge.enterPictureInPicture() === false) {
        engine.showToast('Picture-in-Picture is not available on this device.', 'error');
      }
    } catch (err: any) {
      // Chrome rejects the request when it is not tied to a user gesture, or
      // when no video track is decoding yet.
      console.warn('[QuantumPiP] Request failed:', err?.message || err);
      engine.showToast('Picture-in-Picture could not start right now.', 'error');
    }
  };

  btnPip.addEventListener('click', toggle);
  video.addEventListener('enterpictureinpicture', () => setIcon(true));
  video.addEventListener('leavepictureinpicture', () => setIcon(false));

  // Keyboard shortcut, matching the hint in the button's tooltip.
  window.addEventListener('keydown', e => {
    if (e.key !== 'i' && e.key !== 'I') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    toggle();
  });

  // Native PiP swaps the whole activity into a small tile, so the player chrome
  // has to get out of the way; the web API only moves the video element.
  (window as any).onNativePipModeChanged = (inPip: boolean) => {
    document.body.classList.toggle('native-pip-active', !!inPip);
    setIcon(!!inPip);
  };

  setIcon(!!document.pictureInPictureElement);
}

export function dismissBootSplash(): void {
  const splash = document.getElementById('app-boot-splash');
  if (!splash || splash.classList.contains('dismissed')) return;
  splash.classList.add('dismissed');
  splash.style.opacity = '0';
  splash.style.pointerEvents = 'none';
  setTimeout(() => {
    splash.classList.add('hidden');
  }, 750);
}
(window as any).dismissBootSplash = dismissBootSplash;

export function setM3uUrl(url: string): void {
  const input = document.getElementById('input-m3u-url') as HTMLInputElement | null;
  if (input) input.value = url;
}

export function switchProviderTab(tab: string): void {
  const tabs = ['m3u', 'xtream', 'stalker', 'xmltv'];
  tabs.forEach(t => {
    const tabBtn = document.getElementById(`tab-provider-${t}`);
    const sec = document.getElementById(`provider-section-${t}`);
    if (tabBtn && sec) {
      if (t === tab) {
        tabBtn.className = 'pb-2 border-b-2 border-brand-500 text-brand-400 font-bold transition';
        sec.classList.remove('hidden');
      } else {
        tabBtn.className = 'pb-2 border-b-2 border-transparent text-slate-400 hover:text-white font-semibold transition';
        sec.classList.add('hidden');
      }
    }
  });
}

export function updateSessionBannerUI(session: any = null): void {
  const banner = document.getElementById('m3u-session-banner');
  const text = document.getElementById('m3u-session-status-text');
  if (!banner) return;

  const activeSession = session || QuantumSessionStore.loadSession();
  if (activeSession && (activeSession.xtreamHost || activeSession.customM3uUrl || activeSession.stalkerUrl)) {
    let desc = 'Saved connection session active';
    if (activeSession.providerType === 'xtream' && activeSession.xtreamHost) {
      desc = `Xtream API: ${activeSession.xtreamHost} (${activeSession.xtreamUser || 'user'})`;
    } else if (activeSession.providerType === 'm3u' && activeSession.customM3uUrl) {
      desc = `M3U URL: ${activeSession.customM3uUrl}`;
    } else if (activeSession.providerType === 'stalker' && activeSession.stalkerUrl) {
      desc = `Stalker Portal: ${activeSession.stalkerUrl}`;
    }
    if (text) text.textContent = desc;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

export async function clearSavedConnectionSession(): Promise<void> {
  const confirmed = await showAppConfirm(
    'Disconnect current session and clear saved server credentials?',
    { title: 'Disconnect Session', confirmText: 'Disconnect', cancelText: 'Keep Session', type: 'danger' }
  );
  if (confirmed) {
    QuantumSessionStore.clearSession();
    state.lastXtreamHost = undefined;
    state.lastXtreamUser = undefined;
    state.lastXtreamPass = undefined;
    const xtreamHostInput = document.getElementById('input-xtream-host') as HTMLInputElement | null;
    const xtreamUserInput = document.getElementById('input-xtream-user') as HTMLInputElement | null;
    const xtreamPassInput = document.getElementById('input-xtream-pass') as HTMLInputElement | null;
    if (xtreamHostInput) xtreamHostInput.value = '';
    if (xtreamUserInput) xtreamUserInput.value = '';
    if (xtreamPassInput) xtreamPassInput.value = '';
    updateSessionBannerUI();
    engine.showToast('Saved session credentials and stored channels cleared.', 'info');
  }
}

export async function connectXtreamApi(overrideHost?: string, overrideUser?: string, overridePass?: string): Promise<number | void> {
  const hostInput = document.getElementById('input-xtream-host') as HTMLInputElement | null;
  const userInput = document.getElementById('input-xtream-user') as HTMLInputElement | null;
  const passInput = document.getElementById('input-xtream-pass') as HTMLInputElement | null;

  const host = overrideHost || hostInput?.value.trim() || '';
  const user = overrideUser || userInput?.value.trim() || '';
  const pass = overridePass || passInput?.value.trim() || '';

  const { host: cleanHost, username: cleanUser, password: cleanPass } = parseXtreamInput(host, user, pass);

  if (!cleanHost || (!cleanUser && !user) || (!cleanPass && !pass)) {
    engine.showToast('Please enter Host, Username, and Password for Xtream API', 'error');
    return;
  }

  engine.showSpinner(true, 'Connecting to Xtream API...');
  try {
    const count = await xtreamConnector.fetchXtreamPlaylist(cleanHost, cleanUser, cleanPass);
    QuantumSessionStore.saveSession({
      providerType: 'xtream',
      xtreamHost: cleanHost,
      xtreamUser: cleanUser,
      xtreamPass: cleanPass
    });
    QuantumSessionStore.saveChannels(state.channels);
    updateSessionBannerUI();
    engine.showSpinner(false);
    closeM3uModal();
    engine.showToast(`Imported ${count.toLocaleString()} streams from Xtream API!`, 'success');
    broadcastTVState();
    broadcastTVCatalog();
    return count;
  } catch (e: any) {
    engine.showSpinner(false);
    engine.showToast(`Xtream API Error: ${e.message}`, 'error');
  }
}

export function purgeXtreamLiveChannels(): number {
  const initial = state.channels.length;
  state.channels = state.channels.filter(ch => !ch.id.startsWith('xt_live_') && ch.group !== 'Xtream Live');
  const removed = initial - state.channels.length;
  updateLanguageDropdown();
  filterChannels();
  QuantumSessionStore.saveChannels(state.channels);
  broadcastTVState();
  broadcastTVCatalog();
  engine.showToast(
    removed > 0
      ? `Blocked & removed ${removed.toLocaleString()} Xtream live channels. M3U channels preserved!`
      : 'No Xtream live channels in the current playlist.',
    'info'
  );
  return removed;
}
(window as any).purgeXtreamLiveChannels = purgeXtreamLiveChannels;

export async function connectStalkerPortal(): Promise<void> {
  const portal = (document.getElementById('input-stalker-url') as HTMLInputElement | null)?.value.trim();
  const mac = (document.getElementById('input-stalker-mac') as HTMLInputElement | null)?.value.trim();
  if (!portal || !mac) {
    showAppAlert('Please enter Stalker Portal URL and Device MAC address.', { title: 'Missing Credentials', type: 'warning' });
    return;
  }
  engine.showSpinner(true, 'Connecting Stalker Portal...');
  try {
    await stalkerConnector.fetchStalkerPortal(portal, mac);
    QuantumSessionStore.saveSession({
      providerType: 'stalker',
      stalkerUrl: portal,
      stalkerMac: mac
    });
    QuantumSessionStore.saveChannels(state.channels);
    updateSessionBannerUI();
    engine.showSpinner(false);
    closeM3uModal();
    showAppAlert('Stalker Portal connected successfully!', { title: 'Stalker Portal', type: 'success' });
  } catch (e: any) {
    engine.showSpinner(false);
    showAppAlert(`Stalker Portal Error: ${e.message}`, { title: 'Stalker Portal Error', type: 'error' });
  }
}

export async function loadXmltvFeed(): Promise<void> {
  const url = (document.getElementById('input-xmltv-url') as HTMLInputElement | null)?.value.trim();
  if (!url) {
    showAppAlert('Please enter an XMLTV Guide Feed URL.', { title: 'Missing URL', type: 'warning' });
    return;
  }
  engine.showSpinner(true, 'Downloading XMLTV EPG...');
  try {
    const mapped = await xmltvParser.loadExternalEPG(url);
    QuantumSessionStore.saveSession({ xmltvUrl: url });
    engine.showSpinner(false);
    closeM3uModal();
    showAppAlert(`Successfully mapped ${mapped} broadcast guide entries from XMLTV feed!`, { title: 'XMLTV Guide', type: 'success' });
  } catch (e: any) {
    engine.showSpinner(false);
    showAppAlert(`XMLTV Guide Error: ${e.message}`, { title: 'XMLTV Guide Error', type: 'error' });
  }
}

export function tuneToAsianetNews(): void {
  if (!state.channels || state.channels.length === 0) {
    engine.showToast('Loading India M3U playlist for Asianet News...', 'info');
    loadM3uPlaylist('https://iptv-org.github.io/iptv/countries/in.m3u');
    return;
  }
  const asianetCh =
    state.channels.find(c => /asianet\s*news/i.test(c.name)) ||
    state.channels.find(c => /asianet/i.test(c.name));

  if (asianetCh) {
    const idx = state.filteredChannels.indexOf(asianetCh);
    if (idx !== -1) {
      playChannel(idx);
    } else {
      tuneToChannel(asianetCh);
    }
  } else {
    engine.showToast('Asianet News not in active view. Fetching India channels bundle...', 'info');
    loadM3uPlaylist('https://iptv-org.github.io/iptv/countries/in.m3u');
  }
}

export function triggerSurpriseChannel(): void {
  const surprise = decisionEngine.getRandomSurpriseChannel();
  if (!surprise) return;

  const idx = state.filteredChannels.findIndex(c => c.id === surprise.id);
  if (idx !== -1) {
    playChannel(idx);
  } else {
    tuneToChannel(surprise);
  }
}

// Bind interactive handlers to window
(window as any).openM3uModal = openM3uModal;
(window as any).closeM3uModal = closeM3uModal;
(window as any).openRemoteModal = openRemoteModal;
(window as any).closeRemoteModal = closeRemoteModal;
(window as any).closeModals = closeModals;
(window as any).showAppAlert = showAppAlert;
(window as any).showAppConfirm = showAppConfirm;
(window as any).closeAppDialog = closeAppDialog;
(window as any).setM3uUrl = setM3uUrl;
(window as any).switchProviderTab = switchProviderTab;
(window as any).updateSessionBannerUI = updateSessionBannerUI;
(window as any).clearSavedConnectionSession = clearSavedConnectionSession;
(window as any).connectXtreamApi = connectXtreamApi;
(window as any).connectStalkerPortal = connectStalkerPortal;
(window as any).loadXmltvFeed = loadXmltvFeed;
(window as any).tuneToAsianetNews = tuneToAsianetNews;
(window as any).triggerSurpriseChannel = triggerSurpriseChannel;
(window as any).hideOfflineOverlay = () => engine.hideOfflineOverlay();

export function setupEventListeners(): void {
  // Auto-parse full get.php URLs pasted into Host inputs
  attachXtreamAutoParse('input-xtream-host', 'input-xtream-user', 'input-xtream-pass');
  attachXtreamAutoParse('rem-xtream-host', 'rem-xtream-user', 'rem-xtream-pass');

  // Prevent double-tap and gesture zoom
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    e => {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );

  document.addEventListener(
    'touchstart',
    e => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
    document.addEventListener(evt, e => e.preventDefault());
  });

  const video = engine.video;
  const videoStage = document.getElementById('video-stage');
  const btnPlayPause = document.getElementById('btn-play-pause');
  const btnPrevChannel = document.getElementById('btn-prev-channel');
  const btnNextChannel = document.getElementById('btn-next-channel');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnHeaderFullscreen = document.getElementById('btn-header-fullscreen');
  const btnMute = document.getElementById('btn-mute');
  const unmuteBanner = document.getElementById('unmute-banner');
  const volSlider = document.getElementById('vol-slider') as HTMLInputElement | null;
  const btnAspect = document.getElementById('btn-aspect');
  const btnPip = document.getElementById('btn-pip');
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const regionFilter = document.getElementById('region-filter') as HTMLSelectElement | null;
  const categoryFilter = document.getElementById('category-filter') as HTMLSelectElement | null;
  const languageFilter = document.getElementById('language-filter') as HTMLSelectElement | null;
  const filterActiveOnly = document.getElementById('filter-active-only') as HTMLInputElement | null;
  const viewChannels = document.getElementById('view-channels');
  const viewEpg = document.getElementById('view-epg');
  const viewFavorites = document.getElementById('view-favorites');
  const playerControls = document.getElementById('player-controls');

  if (video && !state.isRemoteClient) {
    video.addEventListener('click', () => {
      if (video.muted) unmuteAudioNow();
      togglePlayPause();
    });
    video.addEventListener('play', () => {
      updatePlayPauseIcons();
      wakeControls();
    });
    video.addEventListener('pause', () => {
      updatePlayPauseIcons();
      if (videoStage) videoStage.classList.remove('fullscreen-idle');
    });
    video.addEventListener('loadedmetadata', () => {
      adjustMobileVideoStage();
      updateTimeAndSeekBar();
    });
    video.addEventListener('playing', () => {
      adjustMobileVideoStage();
      engine.onStreamPlaying();
      showEngineHud(true, 3000);
      wakeControls();
    });
    video.addEventListener('resize', adjustMobileVideoStage);
    video.addEventListener('waiting', () => {
      engine.showSpinner(true, 'Buffering Stream...');
      showEngineHud(true, 0);
    });
    video.addEventListener('error', () => {
      engine.onStreamFailed('Video playback error');
    });

    // Series continuity: resume where the viewer left off, and roll into the
    // next episode when one finishes.
    video.addEventListener('playing', () => {
      applyResumePosition();
    });
    video.addEventListener('ended', () => {
      handleEpisodeEnded();
    });

    let lastTimeBroadcast = 0;
    video.addEventListener('timeupdate', () => {
      updateTimeAndSeekBar();
      const now = Date.now();
      if (video.duration && isFinite(video.duration) && now - lastTimeBroadcast > 1000) {
        lastTimeBroadcast = now;
        broadcastTVState();
      }
    });
    video.addEventListener('durationchange', () => {
      updateTimeAndSeekBar();
      broadcastTVState();
    });
  }

  if (btnPlayPause) btnPlayPause.addEventListener('click', togglePlayPause);
  if (btnPrevChannel) {
    btnPrevChannel.addEventListener('click', () => {
      if (state.currentChannelIndex > 0) playChannel(state.currentChannelIndex - 1);
    });
  }
  if (btnNextChannel) {
    btnNextChannel.addEventListener('click', () => {
      if (state.currentChannelIndex < state.filteredChannels.length - 1) {
        playChannel(state.currentChannelIndex + 1);
      }
    });
  }
  if (btnFullscreen) btnFullscreen.addEventListener('click', () => toggleFullscreenMode());
  if (btnHeaderFullscreen) btnHeaderFullscreen.addEventListener('click', () => toggleFullscreenMode());

  if (btnMute) {
    btnMute.addEventListener('click', () => {
      toggleMute();
    });
  }

  if (volSlider) {
    volSlider.addEventListener('input', e => {
      if (video) {
        video.volume = parseFloat((e.target as HTMLInputElement).value);
        video.muted = false;
        if (unmuteBanner) unmuteBanner.classList.add('hidden');
        showTvVolumeHud(video.volume, false);
        broadcastTVState();
      }
    });
  }

  if (btnAspect) {
    btnAspect.addEventListener('click', () => {
      state.aspectIndex = (state.aspectIndex + 1) % state.aspectModes.length;
      if (video) video.className = `w-full h-full ${state.aspectModes[state.aspectIndex]} bg-black`;
      btnAspect.textContent = state.aspectLabels[state.aspectIndex];
    });
  }

  if (btnPip && video) {
    setupPictureInPicture(btnPip, video);
  }

  const tabChannels = document.getElementById('tab-btn-channels');
  const tabEpg = document.getElementById('tab-btn-epg');
  const tabFavs = document.getElementById('tab-btn-favs');

  function switchTab(view: 'channels' | 'epg' | 'favs'): void {
    if (viewChannels) viewChannels.classList.toggle('hidden', view !== 'channels');
    if (viewEpg) viewEpg.classList.toggle('hidden', view !== 'epg');
    if (viewFavorites) viewFavorites.classList.toggle('hidden', view !== 'favs');

    [tabChannels, tabEpg, tabFavs].forEach(b => {
      if (b) {
        b.classList.remove('bg-brand-600', 'text-white');
        b.classList.add('text-slate-400');
      }
    });

    if (view === 'channels' && tabChannels) {
      tabChannels.classList.add('bg-brand-600', 'text-white');
    } else if (view === 'epg' && tabEpg) {
      tabEpg.classList.add('bg-brand-600', 'text-white');
      renderEpgTimeline();
    } else if (view === 'favs' && tabFavs) {
      tabFavs.classList.add('bg-brand-600', 'text-white');
      updateFavoritesUI();
    }
  }

  if (tabChannels) tabChannels.addEventListener('click', () => switchTab('channels'));
  if (tabEpg) tabEpg.addEventListener('click', () => switchTab('epg'));
  if (tabFavs) tabFavs.addEventListener('click', () => switchTab('favs'));

  if (searchInput) searchInput.addEventListener('input', () => filterChannels());
  if (regionFilter) regionFilter.addEventListener('change', () => filterChannels());
  if (languageFilter) languageFilter.addEventListener('change', () => filterChannels());
  if (categoryFilter) categoryFilter.addEventListener('change', () => filterChannels());

  if (filterActiveOnly) {
    filterActiveOnly.addEventListener('change', e => {
      state.hideOfflineFeeds = (e.target as HTMLInputElement).checked;
      filterChannels();
    });
  }

  if (viewChannels) {
    viewChannels.addEventListener('scroll', () => {
      if (viewChannels.scrollTop + viewChannels.clientHeight >= viewChannels.scrollHeight - 160) {
        loadMoreTvChannels();
      }
    });
  }

  const btnRetryOffline = document.getElementById('btn-retry-offline');
  if (btnRetryOffline) {
    btnRetryOffline.addEventListener('click', () => {
      engine.hideOfflineOverlay();
      playChannel(state.currentChannelIndex);
    });
  }

  const btnSkipOffline = document.getElementById('btn-skip-offline');
  if (btnSkipOffline) {
    btnSkipOffline.addEventListener('click', () => {
      playNextWorkingChannel();
    });
  }

  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const channelSidebar = document.getElementById('channel-sidebar');
  if (btnToggleSidebar && channelSidebar) {
    btnToggleSidebar.addEventListener('click', () => {
      channelSidebar.classList.toggle('hidden');
    });
  }

  const btnOpenRemote = document.getElementById('btn-open-remote-modal');
  const btnCloseRemote = document.getElementById('btn-close-remote-modal');
  const btnCloseM3u = document.getElementById('btn-close-m3u-modal');
  const modalRemote = document.getElementById('modal-remote');
  const btnFetchM3u = document.getElementById('btn-fetch-m3u');
  const btnCopyRemote = document.getElementById('btn-copy-remote-link');

  if (btnOpenRemote) {
    btnOpenRemote.addEventListener('click', () => {
      openRemoteModal();
    });
  }
  if (btnCloseRemote) {
    btnCloseRemote.addEventListener('click', () => {
      closeRemoteModal();
    });
  }
  if (btnCloseM3u) {
    btnCloseM3u.addEventListener('click', () => {
      closeM3uModal();
    });
  }

  if (btnFetchM3u) {
    btnFetchM3u.addEventListener('click', () => {
      const urlInput = document.getElementById('input-m3u-url') as HTMLInputElement | null;
      if (urlInput && urlInput.value) {
        const url = urlInput.value.trim();
        loadM3uPlaylist(url);
        QuantumSessionStore.saveSession({
          providerType: 'm3u',
          customM3uUrl: url
        });
        setTimeout(() => {
          QuantumSessionStore.saveChannels(state.channels);
          updateSessionBannerUI();
        }, 1200);
      }
    });
  }

  if (btnCopyRemote) {
    btnCopyRemote.addEventListener('click', () => {
      const remoteUrl = getPublicRemoteUrl();
      copyToClipboard(remoteUrl);
      btnCopyRemote.textContent = 'Copied!';
      setTimeout(() => {
        btnCopyRemote.innerHTML = '<i class="fa-regular fa-copy mr-1"></i>Copy Link';
      }, 2000);
    });
  }

  if (videoStage) {
    ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'keydown'].forEach(evt => {
      videoStage.addEventListener(evt, wakeControls, { passive: true });
    });
  }

  if (playerControls) {
    playerControls.addEventListener('mouseenter', () => {
      if (videoStage) videoStage.classList.remove('fullscreen-idle');
    });
    playerControls.addEventListener('mouseleave', wakeControls);
  }

  window.addEventListener('keydown', e => {
    if (
      state.isRemoteClient ||
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const hasFiniteDuration = video && video.duration && isFinite(video.duration) && video.duration > 0;

    switch (e.code) {
      case 'Space':
      case 'KeyK':
      case 'MediaPlayPause':
      case 'MediaPlay':
      case 'MediaPause':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Select':
        if (!document.activeElement || document.activeElement === document.body || document.activeElement === video) {
          e.preventDefault();
          togglePlayPause();
        }
        break;
      case 'KeyF':
        toggleFullscreenMode();
        break;
      case 'KeyM':
        toggleMute();
        break;
      case 'KeyL':
      case 'MediaFastForward':
        seekVideo(10, true);
        break;
      case 'KeyJ':
      case 'MediaRewind':
        seekVideo(-10, true);
        break;
      case 'KeyN':
      case 'MediaTrackNext':
        if (state.currentChannelIndex < state.filteredChannels.length - 1) {
          playChannel(state.currentChannelIndex + 1);
        }
        break;
      case 'KeyP':
      case 'MediaTrackPrevious':
        if (state.currentChannelIndex > 0) {
          playChannel(state.currentChannelIndex - 1);
        }
        break;
    }
  });

  window.addEventListener('resize', adjustMobileVideoStage);

  // Rotating the device is the usual way into landscape viewing, and several
  // mobile browsers report stale dimensions if measured during the event
  // itself, so re-measure once the new layout has settled. visualViewport
  // additionally covers the URL bar sliding in and out, which changes the
  // usable height without firing a window resize on iOS.
  window.addEventListener('orientationchange', () => {
    adjustMobileVideoStage();
    setTimeout(adjustMobileVideoStage, 250);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustMobileVideoStage);
  }
}

// Global App Initialization
export function initApp(): void {
  // 1. Restore persistent QuantumSessionStore session & credentials
  const savedSession = QuantumSessionStore.loadSession();
  if (savedSession) {
    if (savedSession.xtreamHost) state.lastXtreamHost = savedSession.xtreamHost;
    if (savedSession.xtreamUser) state.lastXtreamUser = savedSession.xtreamUser;
    if (savedSession.xtreamPass) state.lastXtreamPass = savedSession.xtreamPass;

    const xtreamHostInput = document.getElementById('input-xtream-host') as HTMLInputElement | null;
    const xtreamUserInput = document.getElementById('input-xtream-user') as HTMLInputElement | null;
    const xtreamPassInput = document.getElementById('input-xtream-pass') as HTMLInputElement | null;
    const m3uUrlInput = document.getElementById('input-m3u-url') as HTMLInputElement | null;
    const stalkerUrlInput = document.getElementById('input-stalker-url') as HTMLInputElement | null;
    const stalkerMacInput = document.getElementById('input-stalker-mac') as HTMLInputElement | null;
    const xmltvUrlInput = document.getElementById('input-xmltv-url') as HTMLInputElement | null;

    if (xtreamHostInput && savedSession.xtreamHost) xtreamHostInput.value = savedSession.xtreamHost;
    if (xtreamUserInput && savedSession.xtreamUser) xtreamUserInput.value = savedSession.xtreamUser;
    if (xtreamPassInput && savedSession.xtreamPass) xtreamPassInput.value = savedSession.xtreamPass;
    if (m3uUrlInput && savedSession.customM3uUrl) m3uUrlInput.value = savedSession.customM3uUrl;
    if (stalkerUrlInput && savedSession.stalkerUrl) stalkerUrlInput.value = savedSession.stalkerUrl;
    if (stalkerMacInput && savedSession.stalkerMac) stalkerMacInput.value = savedSession.stalkerMac;
    if (xmltvUrlInput && savedSession.xmltvUrl) xmltvUrlInput.value = savedSession.xmltvUrl;

    updateSessionBannerUI(savedSession);
  }

  // 2. Restore instant micro-bootstrap channels (< 50 items for sub-5ms boot)
  const savedBootstrap = QuantumSessionStore.loadChannels();
  if (savedBootstrap && Array.isArray(savedBootstrap) && savedBootstrap.length > 0) {
    state.channels = savedBootstrap.map(ch => sanitizeChannel(ch));
  } else {
    state.channels = [...DEFAULT_PRESET_CHANNELS];
  }

  // Always ensure default preset Live channels are present
  DEFAULT_PRESET_CHANNELS.forEach(preset => {
    if (!state.channels.some(c => c.id === preset.id || (c.url && c.url === preset.url))) {
      state.channels.push(preset);
    }
  });
  state.filteredChannels = [...state.channels];

  // 3. Asynchronously hydrate complete catalog from IndexedDB (offline-first, non-blocking)
  setTimeout(() => {
    QuantumOfflineCache.loadAllChannels().then(idbChannels => {
      if (idbChannels && idbChannels.length > 0) {
        const existingIds = new Set(state.channels.map(c => c.id));
        const existingUrls = new Set(state.channels.map(c => c.url).filter(Boolean));
        let added = 0;

        for (let i = 0; i < idbChannels.length; i++) {
          const c = idbChannels[i];
          if (!existingIds.has(c.id) && (!c.url || !existingUrls.has(c.url))) {
            state.channels.push(sanitizeChannel(c));
            existingIds.add(c.id);
            if (c.url) existingUrls.add(c.url);
            added++;
          }
        }

        if (added > 0) {
          console.log(`[QuantumIndexedDB] Hydrated ${added} items from IndexedDB`);
          updateLanguageDropdown();
          const curCh = state.filteredChannels[state.currentChannelIndex];
          filterChannels();
          if (curCh) {
            const preservedIdx = state.filteredChannels.findIndex(c => c.id === curCh.id);
            if (preservedIdx !== -1) state.currentChannelIndex = preservedIdx;
          }
          renderChannelList();
        }
      }
    }).catch(err => console.warn('[QuantumIndexedDB] Hydration warning:', err));
  }, 100);

  checkAndLaunchRemoteView();
  if (state.isRemoteClient) {
    dismissBootSplash();
  }
  setupEventListeners();
  initRemoteSync();
  setupRemoteSeekControls();

  if (!state.isRemoteClient) {
    engine.initHls();

    // Bring up D-Pad navigation before any of the boot work below, so a failure
    // while restoring the playlist can never leave the remote unresponsive.
    initTvNavigation();

    // Keeps "now playing" and the guide progress bar current once EPG is loaded.
    startEpgAutoRefresh();

    // 1. Configure Malayalam Language & Live TV category by default on startup
    const languageFilter = document.getElementById('language-filter') as HTMLSelectElement | null;
    const labelLanguageFilter = document.getElementById('label-language-filter');
    if (languageFilter) {
      languageFilter.value = 'Malayalam';
    }
    if (labelLanguageFilter) {
      labelLanguageFilter.textContent = 'Malayalam';
    }

    // Set Live TV category and apply filter
    filterContentType('live');
    updateLanguageDropdown();
    filterChannels();

    updateFavoritesUI();
    adjustMobileVideoStage();

    // 2. Play initial Malayalam Live TV channel immediately
    let initialIndex = 0;
    const firstMalLive = state.filteredChannels.findIndex(c =>
      (c.type !== 'series' && c.type !== 'vod') &&
      ((c.language && c.language.toLowerCase() === 'malayalam') ||
       (c.name && c.name.toLowerCase().includes('malayalam')) ||
       (c.name && c.name.toLowerCase().includes('asianet')))
    );
    if (firstMalLive !== -1) {
      initialIndex = firstMalLive;
    } else if (state.filteredChannels.length > 0) {
      initialIndex = 0;
    }
    playChannel(initialIndex, { directPlay: true });

    // 3. Immediately launch in Fullscreen Mode
    toggleFullscreenMode(true);
    setTimeout(() => {
      if (!state.isRemoteClient) {
        toggleFullscreenMode(true);
      }
    }, 300);

    // 4. Smoothly dismiss boot splash once video starts or on canplay
    videoElement.addEventListener('playing', () => {
      dismissBootSplash();
    }, { once: true });
    videoElement.addEventListener('canplay', () => {
      dismissBootSplash();
    }, { once: true });
    setTimeout(() => {
      dismissBootSplash();
    }, 800);

    // 4. Background re-sync for active provider session or public live channels
    const liveCount = state.channels.filter(c => c.type !== 'series' && c.type !== 'vod' && !c.seriesId && !c.vodId).length;
    const hasCustomProvider = savedSession && (
      (savedSession.providerType === 'xtream' && savedSession.xtreamHost) ||
      (savedSession.providerType === 'm3u' && savedSession.customM3uUrl) ||
      (savedSession.providerType === 'stalker' && savedSession.stalkerUrl)
    );

    if (
      savedSession &&
      savedSession.providerType === 'xtream' &&
      savedSession.xtreamHost &&
      savedSession.xtreamUser &&
      savedSession.xtreamPass
    ) {
      xtreamConnector
        .fetchXtreamPlaylist(savedSession.xtreamHost, savedSession.xtreamUser, savedSession.xtreamPass)
        .then(() => {
          renderChannelList();
          QuantumSessionStore.saveChannels(state.channels);
        })
        .catch(err => console.warn('Background Xtream re-sync warning:', err.message));
    } else if (savedSession && savedSession.providerType === 'm3u' && savedSession.customM3uUrl) {
      loadM3uPlaylist(savedSession.customM3uUrl, true);
    }

    // Always ensure live regional channels from iptv-org are imported if not on custom provider or count is low
    if (!hasCustomProvider || liveCount < 30) {
      loadM3uPlaylist('https://iptv-org.github.io/iptv/countries/in.m3u', true);
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/mal.m3u', true, 'Malayalam');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/tel.m3u', true, 'Telugu');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/tam.m3u', true, 'Tamil');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/kan.m3u', true, 'Kannada');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/hin.m3u', true, 'Hindi');
    }
  } else {
    adjustMobileVideoStage();
    const remoteLiveCount = state.channels.filter(c => c.type !== 'series' && c.type !== 'vod' && !c.seriesId && !c.vodId).length;
    if (remoteLiveCount < 30) {
      loadM3uPlaylist('https://iptv-org.github.io/iptv/countries/in.m3u', true);
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/mal.m3u', true, 'Malayalam');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/tel.m3u', true, 'Telugu');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/tam.m3u', true, 'Tamil');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/kan.m3u', true, 'Kannada');
      loadM3uPlaylist('https://iptv-org.github.io/iptv/languages/hin.m3u', true, 'Hindi');
    }
    renderRemoteChannelsList();
    renderRemoteFavsList();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
