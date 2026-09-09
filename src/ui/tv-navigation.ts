// Android TV D-Pad Spatial Navigation & Focus Engine
// Enables 100% remote-controlled TV experience with directional keys, D-Pad, OK, Back, and Media controls

import { state } from '../state/store';

type FocusZone = 'channels' | 'player' | 'header' | 'modal';

let currentFocusZone: FocusZone = 'channels';
let currentFocusIndex = -1;
let currentHeaderIndex = 0;
let currentPlayerIndex = 1; // Default to play/pause

let channelNumberBuffer = '';
let channelNumberTimeout: any = null;

export function isAndroidTv(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return (
    ua.includes('android tv') ||
    ua.includes('smart-tv') ||
    ua.includes('googletv') ||
    ua.includes('leanback') ||
    ua.includes('aft') || // Amazon Fire TV
    (window as any).Capacitor?.getPlatform?.() === 'android'
  );
}

export function initTvNavigation(): void {
  // Inject TV focus styles into head if not already present
  if (!document.getElementById('tv-navigation-styles')) {
    const style = document.createElement('style');
    style.id = 'tv-navigation-styles';
    style.textContent = `
      .tv-focused {
        outline: 3px solid #818cf8 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 25px rgba(99, 102, 241, 0.85), 0 0 10px rgba(6, 182, 212, 0.6) !important;
        transform: scale(1.025) !important;
        transition: transform 0.12s ease, box-shadow 0.12s ease, outline 0.12s ease !important;
        z-index: 25 !important;
      }
      .tv-focused-btn {
        outline: 2.5px solid #38bdf8 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 20px rgba(56, 189, 248, 0.8) !important;
        transform: scale(1.06) !important;
        transition: transform 0.12s ease, box-shadow 0.12s ease, outline 0.12s ease !important;
        z-index: 25 !important;
      }
      #tv-channel-number-hud {
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
    `;
    document.head.appendChild(style);
  }

  // Handle global TV remote keydown events
  window.addEventListener('keydown', handleTvKeyDown, { capture: true });

  // Expose global TV navigation handlers for Android native bridge (MainActivity.java)
  registerGlobalTvHandlers();

  // Initial focus placement after channels render
  setTimeout(() => {
    focusFirstAvailableChannel();
  }, 1200);
}

function registerGlobalTvHandlers(): void {
  (window as any).handleAndroidTvBack = handleAndroidTvBack;
  (window as any).playPreviousChannel = playPreviousChannel;
  (window as any).toggleTvGuide = toggleTvGuide;
  (window as any).handleTvDigitKey = handleTvDigitKey;
  (window as any).handleTvColorButton = handleTvColorButton;
}

export function handleAndroidTvBack(): boolean {
  // 1. If any modal/dialog is visible, dismiss it
  const activeModal = getVisibleModal();
  if (activeModal) {
    (window as any).closeModals?.();
    return true;
  }

  // 2. If in theater/fullscreen mode, return to regular view
  if (state.isTheaterFullscreen) {
    (window as any).toggleFullscreenMode?.(false);
    return true;
  }

  // 3. If search has text, clear search
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  if (searchInput && searchInput.value.trim().length > 0) {
    searchInput.value = '';
    (window as any).clearTvSearch?.();
    focusFirstAvailableChannel();
    return true;
  }

  // 4. If in header or player focus zone, return focus to channel list
  if (currentFocusZone !== 'channels') {
    focusFirstAvailableChannel();
    return true;
  }

  // 5. Already on root channel list -> return false to trigger double-tap exit toast in MainActivity
  return false;
}

export function playPreviousChannel(): void {
  if (state.filteredChannels.length === 0) return;
  const prevIndex = (state.currentChannelIndex - 1 + state.filteredChannels.length) % state.filteredChannels.length;
  (window as any).playChannel?.(prevIndex);
}

export function toggleTvGuide(): void {
  const tabEpg = document.getElementById('tab-btn-epg');
  const tabChannels = document.getElementById('tab-btn-channels');
  const epgView = document.getElementById('view-epg');
  if (epgView && !epgView.classList.contains('hidden')) {
    tabChannels?.click();
    focusFirstAvailableChannel();
  } else {
    tabEpg?.click();
  }
}

export function handleTvDigitKey(digit: number): void {
  channelNumberBuffer += digit.toString();
  showTvChannelNumberHud(channelNumberBuffer);

  if (channelNumberTimeout) clearTimeout(channelNumberTimeout);
  channelNumberTimeout = setTimeout(() => {
    const targetChannelNum = parseInt(channelNumberBuffer, 10);
    channelNumberBuffer = '';
    hideTvChannelNumberHud();

    if (!isNaN(targetChannelNum) && targetChannelNum >= 1 && targetChannelNum <= state.filteredChannels.length) {
      (window as any).playChannel?.(targetChannelNum - 1);
    }
  }, 1100);
}

export function handleTvColorButton(color: string): void {
  switch (color.toLowerCase()) {
    case 'red':
      // Toggle favorite for current playing channel
      {
        const currentCh = state.filteredChannels[state.currentChannelIndex] || state.channels[state.currentChannelIndex];
        if (currentCh) {
          (window as any).toggleFavorite?.(currentCh.id);
        }
      }
      break;
    case 'green':
      // Toggle EPG Guide
      toggleTvGuide();
      break;
    case 'yellow':
      // Quick Tune Asianet News
      (window as any).tuneToAsianetNews?.();
      break;
    case 'blue':
      // Smart Discovery Surprise Me
      (window as any).triggerSurpriseChannel?.();
      break;
  }
}

function showTvChannelNumberHud(channelNumberStr: string): void {
  let hud = document.getElementById('tv-channel-number-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'tv-channel-number-hud';
    hud.className = 'fixed top-6 right-6 z-[999999] bg-slate-900/95 border-2 border-brand-500 rounded-2xl px-5 py-3 shadow-2xl backdrop-blur-md flex items-center gap-3 transition-all duration-200 pointer-events-none opacity-0 translate-y-[-10px] scale-95';
    hud.innerHTML = `
      <div class="w-10 h-10 rounded-xl bg-brand-600/30 border border-brand-500/50 flex items-center justify-center text-brand-400 text-lg">
        <i class="fa-solid fa-tv"></i>
      </div>
      <div class="flex flex-col">
        <span class="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Channel Tune</span>
        <span id="tv-channel-num-text" class="text-2xl font-mono font-extrabold text-white tracking-widest">CH --</span>
      </div>
    `;
    document.body.appendChild(hud);
  }
  const textEl = document.getElementById('tv-channel-num-text');
  if (textEl) textEl.textContent = `CH ${channelNumberStr}`;
  hud.style.opacity = '1';
  hud.style.transform = 'translateY(0) scale(1)';
}

function hideTvChannelNumberHud(): void {
  const hud = document.getElementById('tv-channel-number-hud');
  if (hud) {
    hud.style.opacity = '0';
    hud.style.transform = 'translateY(-10px) scale(0.95)';
  }
}

function getVisibleModal(): HTMLElement | null {
  const modalIds = [
    'modal-app-dialog',
    'modal-movie-explorer',
    'modal-series-explorer',
    'modal-remote',
    'modal-m3u',
    'modal-quarantine'
  ];
  for (const id of modalIds) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) {
      return el;
    }
  }
  return null;
}

function handleTvKeyDown(e: KeyboardEvent): void {
  // If user is actively typing in an input field, let standard typing work
  if (e.target instanceof HTMLInputElement && !['ArrowUp', 'ArrowDown', 'Escape', 'Enter'].includes(e.key)) {
    return;
  }

  // Numeric dialing from remote
  if (e.key >= '0' && e.key <= '9' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    handleTvDigitKey(parseInt(e.key, 10));
    return;
  }

  const activeModal = getVisibleModal();
  if (activeModal) {
    handleModalNavigation(e, activeModal);
    return;
  }

  // Fullscreen / Theater TV controls
  if (state.isTheaterFullscreen) {
    handleFullscreenTvKey(e);
    return;
  }

  // TV remote keys in standard dashboard
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (currentFocusZone === 'header') {
        focusFirstAvailableChannel();
      } else if (currentFocusZone === 'player') {
        cyclePlayerControl(1);
      } else {
        navigateChannelList(1);
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (currentFocusZone === 'channels') {
        if (currentFocusIndex === 0) {
          focusHeaderZone();
        } else {
          navigateChannelList(-1);
        }
      } else if (currentFocusZone === 'player') {
        cyclePlayerControl(-1);
      }
      break;

    case 'ArrowRight':
      e.preventDefault();
      if (currentFocusZone === 'channels') {
        focusPlayerControls();
      } else if (currentFocusZone === 'header') {
        navigateHeaderZone(1);
      } else if (currentFocusZone === 'player') {
        cyclePlayerControl(1);
      }
      break;

    case 'ArrowLeft':
      e.preventDefault();
      if (currentFocusZone === 'player') {
        if (currentPlayerIndex === 0 || currentPlayerIndex === 1) {
          focusFirstAvailableChannel();
        } else {
          cyclePlayerControl(-1);
        }
      } else if (currentFocusZone === 'header') {
        navigateHeaderZone(-1);
      } else {
        focusFirstAvailableChannel();
      }
      break;

    case 'Enter':
    case 'Select':
      if (currentFocusZone === 'channels') {
        e.preventDefault();
        const items = getChannelElements();
        if (items[currentFocusIndex]) {
          items[currentFocusIndex].click();
        }
      } else if (currentFocusZone === 'player') {
        e.preventDefault();
        const controls = getPlayerControlElements();
        if (controls[currentPlayerIndex]) {
          controls[currentPlayerIndex].click();
        }
      }
      break;

    case 'Back':
    case 'BrowserBack':
    case 'Escape':
      e.preventDefault();
      handleAndroidTvBack();
      break;

    case 'ChannelUp':
      e.preventDefault();
      (window as any).playNextWorkingChannel?.();
      break;

    case 'ChannelDown':
      e.preventDefault();
      playPreviousChannel();
      break;

    case 'MediaPlayPause':
      e.preventDefault();
      (window as any).togglePlayPause?.();
      break;

    case 'MediaPlay':
      e.preventDefault();
      (window as any).togglePlayPause?.();
      break;

    case 'MediaPause':
      e.preventDefault();
      (window as any).togglePlayPause?.();
      break;

    case 'MediaFastForward':
      e.preventDefault();
      (window as any).seekVideo?.(10);
      break;

    case 'MediaRewind':
      e.preventDefault();
      (window as any).seekVideo?.(-10);
      break;
  }
}

function handleFullscreenTvKey(e: KeyboardEvent): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (video) {
        video.volume = Math.min(1, Math.round((video.volume + 0.05) * 100) / 100);
        (window as any).showTvVolumeHud?.(video.volume, video.muted);
      }
      (window as any).wakeControls?.();
      break;

    case 'ArrowDown':
      e.preventDefault();
      if (video) {
        video.volume = Math.max(0, Math.round((video.volume - 0.05) * 100) / 100);
        (window as any).showTvVolumeHud?.(video.volume, video.muted);
      }
      (window as any).wakeControls?.();
      break;

    case 'ArrowLeft':
      e.preventDefault();
      (window as any).seekVideo?.(-10);
      (window as any).wakeControls?.();
      break;

    case 'ArrowRight':
      e.preventDefault();
      (window as any).seekVideo?.(10);
      (window as any).wakeControls?.();
      break;

    case 'Enter':
    case 'Select':
      e.preventDefault();
      (window as any).togglePlayPause?.();
      (window as any).wakeControls?.();
      break;

    case 'Back':
    case 'BrowserBack':
    case 'Escape':
      e.preventDefault();
      (window as any).toggleFullscreenMode?.(false);
      break;
  }
}

function handleModalNavigation(e: KeyboardEvent, modal: HTMLElement): void {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const buttons = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled])')) as HTMLElement[];
    if (buttons.length === 0) return;

    const currentIndex = buttons.indexOf(document.activeElement as HTMLElement);
    let nextIndex = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % buttons.length;
    } else {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    }
    buttons[nextIndex]?.focus();
    highlightElement(buttons[nextIndex], 'tv-focused-btn');
  } else if (e.key === 'Back' || e.key === 'BrowserBack' || e.key === 'Escape') {
    e.preventDefault();
    (window as any).closeModals?.();
  }
}

function getChannelElements(): HTMLElement[] {
  const container = document.getElementById('view-channels');
  if (!container) return [];
  return Array.from(container.querySelectorAll('[data-channel-id], [onclick*="playChannel"]')) as HTMLElement[];
}

export function focusFirstAvailableChannel(): void {
  currentFocusZone = 'channels';
  const items = getChannelElements();
  if (items.length > 0) {
    currentFocusIndex = Math.max(0, Math.min(items.length - 1, state.currentChannelIndex >= 0 ? state.currentChannelIndex : 0));
    setChannelFocus(items[currentFocusIndex]);
  }
}

export function navigateChannelList(direction: number): void {
  currentFocusZone = 'channels';
  const items = getChannelElements();
  if (items.length === 0) return;

  currentFocusIndex = Math.max(0, Math.min(items.length - 1, currentFocusIndex + direction));
  const target = items[currentFocusIndex];
  if (target) {
    setChannelFocus(target);
  }
}

function setChannelFocus(el: HTMLElement): void {
  document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(node => {
    node.classList.remove('tv-focused', 'tv-focused-btn');
  });
  el.classList.add('tv-focused');
  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function getHeaderElements(): HTMLElement[] {
  const ids = [
    'search-input',
    'tab-btn-channels',
    'tab-btn-epg',
    'tab-btn-favs',
    'btn-quick-asianet',
    'btn-header-surprise',
    'btn-open-m3u-modal',
    'btn-open-remote-modal',
    'btn-header-fullscreen'
  ];
  return ids
    .map(id => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null && !el.classList.contains('hidden'));
}

function focusHeaderZone(): void {
  currentFocusZone = 'header';
  const elements = getHeaderElements();
  if (elements.length > 0) {
    currentHeaderIndex = 0;
    highlightHeaderElement(elements[0]);
  }
}

function navigateHeaderZone(direction: number): void {
  const elements = getHeaderElements();
  if (elements.length === 0) return;
  currentHeaderIndex = (currentHeaderIndex + direction + elements.length) % elements.length;
  highlightHeaderElement(elements[currentHeaderIndex]);
}

function highlightHeaderElement(el: HTMLElement): void {
  document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(node => {
    node.classList.remove('tv-focused', 'tv-focused-btn');
  });
  el.classList.add('tv-focused-btn');
  el.focus();
}

function getPlayerControlElements(): HTMLElement[] {
  const ids = [
    'btn-rewind',
    'btn-play-pause',
    'btn-forward',
    'btn-audio-tracks',
    'btn-aspect',
    'btn-fullscreen'
  ];
  return ids
    .map(id => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null && !el.classList.contains('hidden'));
}

function focusPlayerControls(): void {
  currentFocusZone = 'player';
  const controls = getPlayerControlElements();
  if (controls.length > 0) {
    currentPlayerIndex = 1; // Play/Pause button
    const target = controls[currentPlayerIndex] || controls[0];
    highlightPlayerElement(target);
  }
}

function cyclePlayerControl(direction: number): void {
  const controls = getPlayerControlElements();
  if (controls.length === 0) return;
  currentPlayerIndex = (currentPlayerIndex + direction + controls.length) % controls.length;
  highlightPlayerElement(controls[currentPlayerIndex]);
}

function highlightPlayerElement(el: HTMLElement): void {
  document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(node => {
    node.classList.remove('tv-focused', 'tv-focused-btn');
  });
  el.classList.add('tv-focused-btn');
  el.focus();
  (window as any).wakeControls?.();
}

function highlightElement(el: HTMLElement, focusClass: string): void {
  document.querySelectorAll(`.${focusClass}`).forEach(node => node.classList.remove(focusClass));
  el.classList.add(focusClass);
}
