// Android TV D-Pad Spatial Navigation & Focus Engine
// Enables 100% remote-controlled TV experience with directional keys and glowing focus rings

import { state } from '../state/store';

let currentFocusIndex = -1;
let isTvModeActive = false;

export function isAndroidTv(): boolean {
  // Check user agent, Capacitor platform, or TV characteristics
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
  isTvModeActive = true;

  // Inject TV focus styles into head if not already present
  if (!document.getElementById('tv-navigation-styles')) {
    const style = document.createElement('style');
    style.id = 'tv-navigation-styles';
    style.textContent = `
      .tv-focused {
        outline: 2px solid #818cf8 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 25px rgba(99, 102, 241, 0.75), 0 0 8px rgba(6, 182, 212, 0.5) !important;
        transform: scale(1.02) !important;
        transition: transform 0.15s ease, box-shadow 0.15s ease, outline 0.15s ease !important;
        z-index: 25 !important;
      }
      .tv-focused-btn {
        outline: 2px solid #38bdf8 !important;
        box-shadow: 0 0 20px rgba(56, 189, 248, 0.7) !important;
        transform: scale(1.05) !important;
        transition: transform 0.15s ease, box-shadow 0.15s ease !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Handle global TV D-Pad remote keydown events
  window.addEventListener('keydown', handleTvDpadKey, { capture: true });

  // Initial focus placement after content renders
  setTimeout(() => {
    focusFirstAvailableChannel();
  }, 1000);
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

function handleTvDpadKey(e: KeyboardEvent): void {
  const activeModal = getVisibleModal();

  // If a modal is open, constrain D-Pad navigation to the modal's buttons
  if (activeModal) {
    handleModalNavigation(e, activeModal);
    return;
  }

  // If in fullscreen/theater playback, prioritize player controls
  if (state.isTheaterFullscreen) {
    handleFullscreenTvKey(e);
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      navigateChannelList(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      navigateChannelList(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      focusPlayerControls();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      focusFirstAvailableChannel();
      break;
    case 'Enter':
    case 'Select':
      // Let standard click handler execute if an item is focused
      break;
    case 'Back':
    case 'BrowserBack':
    case 'Escape':
      e.preventDefault();
      if (state.isTheaterFullscreen) {
        (window as any).toggleFullscreenMode?.(false);
      } else {
        (window as any).closeModals?.();
      }
      break;
    case 'ChannelUp':
      e.preventDefault();
      (window as any).playNextWorkingChannel?.();
      break;
    case 'ChannelDown':
      e.preventDefault();
      if (state.currentChannelIndex > 0) {
        (window as any).playChannel?.(state.currentChannelIndex - 1);
      }
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
    const buttons = Array.from(modal.querySelectorAll('button:not([disabled])')) as HTMLElement[];
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
  const items = getChannelElements();
  if (items.length > 0) {
    currentFocusIndex = 0;
    setChannelFocus(items[0]);
  }
}

export function navigateChannelList(direction: number): void {
  const items = getChannelElements();
  if (items.length === 0) return;

  currentFocusIndex = Math.max(0, Math.min(items.length - 1, currentFocusIndex + direction));
  const target = items[currentFocusIndex];
  if (target) {
    setChannelFocus(target);
  }
}

function setChannelFocus(el: HTMLElement): void {
  document.querySelectorAll('.tv-focused').forEach(node => node.classList.remove('tv-focused'));
  el.classList.add('tv-focused');
  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function focusPlayerControls(): void {
  const btnPlay = document.getElementById('btn-play-pause');
  if (btnPlay) {
    document.querySelectorAll('.tv-focused').forEach(node => node.classList.remove('tv-focused'));
    btnPlay.classList.add('tv-focused-btn');
    btnPlay.focus();
    (window as any).wakeControls?.();
  }
}

function highlightElement(el: HTMLElement, focusClass: string): void {
  document.querySelectorAll(`.${focusClass}`).forEach(node => node.classList.remove(focusClass));
  el.classList.add(focusClass);
}
