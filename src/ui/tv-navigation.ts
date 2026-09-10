// Android TV D-Pad Spatial Navigation & Focus Engine
// Enables universal remote-controlled TV experience with directional keys, D-Pad, OK, Back, and Media controls.
// All 4 D-Pad buttons (Up, Down, Left, Right) navigate across ANY and ALL buttons on the app.

import { state } from '../state/store';

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
        outline: 3.5px solid #818cf8 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 25px rgba(99, 102, 241, 0.9), 0 0 10px rgba(6, 182, 212, 0.7) !important;
        transform: scale(1.025) !important;
        transition: transform 0.12s ease, box-shadow 0.12s ease, outline 0.12s ease !important;
        z-index: 35 !important;
      }
      .tv-focused-btn {
        outline: 3px solid #38bdf8 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 22px rgba(56, 189, 248, 0.9), 0 0 8px rgba(99, 102, 241, 0.8) !important;
        transform: scale(1.08) !important;
        transition: transform 0.12s ease, box-shadow 0.12s ease, outline 0.12s ease !important;
        z-index: 45 !important;
      }
      #tv-channel-number-hud {
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
    `;
    document.head.appendChild(style);
  }

  // Handle global TV remote keydown events
  window.addEventListener('keydown', handleTvKeyDown, { capture: true });

  // Add double-click / double-tap to toggle fullscreen on video stage
  const videoStage = document.getElementById('video-stage');
  if (videoStage) {
    videoStage.addEventListener('dblclick', () => {
      (window as any).toggleFullscreenMode?.();
    });
  }

  // Expose global TV navigation handlers for Android native bridge (MainActivity.java)
  registerGlobalTvHandlers();

  // Initial focus placement after channels render
  setTimeout(() => {
    focusFirstInteractiveElement();
  }, 1000);
}

function registerGlobalTvHandlers(): void {
  (window as any).handleAndroidTvBack = handleAndroidTvBack;
  (window as any).playNextChannel = playNextChannel;
  (window as any).playPreviousChannel = playPreviousChannel;
  (window as any).toggleMute = (window as any).toggleMute;
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

  // 3. If search has text or is focused, clear search
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  if (searchInput && searchInput.value.trim().length > 0) {
    searchInput.value = '';
    (window as any).clearTvSearch?.();
    focusFirstInteractiveElement();
    return true;
  }

  // 4. Return false so native double-tap exit toast handles it
  return false;
}

let channelSwitchHudTimer: any = null;
export function showTvChannelSwitchHud(channelName: string, channelIndex: number): void {
  let hud = document.getElementById('tv-channel-switch-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'tv-channel-switch-hud';
    hud.className =
      'fixed top-6 left-6 z-[999999] bg-slate-900/95 border-2 border-indigo-500 rounded-2xl px-5 py-3 shadow-2xl backdrop-blur-md flex items-center gap-3 transition-all duration-200 pointer-events-none opacity-0 translate-y-[-10px] scale-95';
    hud.innerHTML = `
      <div class="w-10 h-10 rounded-xl bg-indigo-600/30 border border-indigo-500/50 flex items-center justify-center text-indigo-400 text-lg">
        <i class="fa-solid fa-satellite-dish"></i>
      </div>
      <div class="flex flex-col">
        <span id="tv-switch-hud-num" class="text-[10px] uppercase font-bold text-indigo-400 tracking-wider">CH 1</span>
        <span id="tv-switch-hud-name" class="text-base font-bold text-white max-w-xs truncate">Channel Name</span>
      </div>
    `;
    document.body.appendChild(hud);
  }
  const numEl = document.getElementById('tv-switch-hud-num');
  const nameEl = document.getElementById('tv-switch-hud-name');
  if (numEl) numEl.textContent = `CH ${channelIndex + 1} of ${state.filteredChannels.length}`;
  if (nameEl) nameEl.textContent = channelName;

  hud.classList.remove('opacity-0', 'translate-y-[-10px]', 'scale-95');
  hud.classList.add('opacity-100', 'translate-y-0', 'scale-100');

  if (channelSwitchHudTimer) clearTimeout(channelSwitchHudTimer);
  channelSwitchHudTimer = setTimeout(() => {
    if (hud) {
      hud.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
      hud.classList.add('opacity-0', 'translate-y-[-10px]', 'scale-95');
    }
  }, 2200);
}

export function playNextChannel(): void {
  if (state.filteredChannels.length === 0) return;
  const nextIndex = (state.currentChannelIndex + 1) % state.filteredChannels.length;
  const ch = state.filteredChannels[nextIndex];
  if (ch) {
    showTvChannelSwitchHud(ch.name, nextIndex);
  }
  (window as any).playChannel?.(nextIndex, { directPlay: true });
}

export function playPreviousChannel(): void {
  if (state.filteredChannels.length === 0) return;
  const prevIndex = (state.currentChannelIndex - 1 + state.filteredChannels.length) % state.filteredChannels.length;
  const ch = state.filteredChannels[prevIndex];
  if (ch) {
    showTvChannelSwitchHud(ch.name, prevIndex);
  }
  (window as any).playChannel?.(prevIndex, { directPlay: true });
}

export function toggleTvGuide(): void {
  const tabEpg = document.getElementById('tab-btn-epg');
  const tabChannels = document.getElementById('tab-btn-channels');
  const epgView = document.getElementById('view-epg');
  if (epgView && !epgView.classList.contains('hidden')) {
    tabChannels?.click();
    focusFirstInteractiveElement();
  } else {
    tabEpg?.click();
    if (tabEpg) focusElement(tabEpg);
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
      // Green button: Open Quant Remote (QR code pairing modal)!
      (window as any).openRemoteModal?.();
      break;
    case 'yellow':
      // Quick Tune Asianet News
      (window as any).tuneToAsianetNews?.();
      break;
    case 'blue':
      // Blue button: Shortcut to toggle Fullscreen Mode!
      (window as any).toggleFullscreenMode?.();
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

// ---------------------------------------------------------------------------
// 2D Spatial Navigation Core: Navigates cleanly between ANY and ALL buttons!
// ---------------------------------------------------------------------------

type Direction = 'up' | 'down' | 'left' | 'right';

function getFocusableElements(): HTMLElement[] {
  const modal = getVisibleModal();
  const root: ParentNode = modal || document.body;

  const selector = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[data-channel-id]',
    '[onclick*="playChannel"]',
    'a[href]',
    '[tabindex="0"]'
  ].join(', ');

  const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector));

  return nodes.filter(el => {
    if (el.classList.contains('hidden') || el.closest('.hidden')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  });
}

function getCurrentFocusedElement(): HTMLElement | null {
  const activeModal = getVisibleModal();
  if (activeModal) {
    const inside = activeModal.querySelector('.tv-focused, .tv-focused-btn') as HTMLElement | null;
    if (inside) return inside;
    const active = document.activeElement as HTMLElement | null;
    if (active && activeModal.contains(active)) return active;
    return null;
  }

  const existing = document.querySelector('.tv-focused, .tv-focused-btn') as HTMLElement | null;
  if (existing && !existing.closest('.hidden')) return existing;

  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && active !== document.documentElement && !active.closest('.hidden')) {
    return active;
  }

  return null;
}

export function focusElement(el: HTMLElement): void {
  document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(node => {
    node.classList.remove('tv-focused', 'tv-focused-btn');
  });

  const isCard = el.hasAttribute('data-channel-id') || el.hasAttribute('data-vod-id');
  if (isCard) {
    el.classList.add('tv-focused');
  } else {
    el.classList.add('tv-focused-btn');
  }

  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

  if (state.isTheaterFullscreen) {
    (window as any).wakeControls?.();
  }
}

export function focusFirstInteractiveElement(): void {
  const candidates = getFocusableElements();
  if (candidates.length === 0) return;

  // Prefer the currently playing channel card, or first channel card, or first button
  const currentCard = candidates.find(el => el.classList.contains('bg-brand-950/60') || el.hasAttribute('data-channel-id'));
  if (currentCard) {
    focusElement(currentCard);
    return;
  }

  focusElement(candidates[0]);
}

function navigateSpatial(dir: Direction): void {
  // If in fullscreen, ensure controls are visible when user presses D-pad
  if (state.isTheaterFullscreen) {
    (window as any).wakeControls?.();
  }

  const current = getCurrentFocusedElement();
  const candidates = getFocusableElements();

  if (!current) {
    focusFirstInteractiveElement();
    return;
  }

  const cRect = current.getBoundingClientRect();
  const cCenter = { x: cRect.left + cRect.width / 2, y: cRect.top + cRect.height / 2 };

  let bestElement: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const target of candidates) {
    if (target === current || target.contains(current) || current.contains(target)) continue;

    const tRect = target.getBoundingClientRect();
    const tCenter = { x: tRect.left + tRect.width / 2, y: tRect.top + tRect.height / 2 };

    let isDirectionValid = false;
    let primaryDist = 0;
    let orthogonalDist = 0;
    let overlap = 0;
    let overlapBonus = 0;

    switch (dir) {
      case 'down':
        if (tCenter.y > cCenter.y + 4 || (tRect.top >= cRect.top + 4 && tRect.bottom > cRect.bottom)) {
          isDirectionValid = true;
          primaryDist = Math.max(0, tRect.top - cRect.bottom);
          if (primaryDist === 0) primaryDist = Math.max(0, tCenter.y - cCenter.y);
          orthogonalDist = Math.abs(tCenter.x - cCenter.x);
          overlap = Math.max(0, Math.min(cRect.right, tRect.right) - Math.max(cRect.left, tRect.left));
          overlapBonus = overlap > 0 ? (overlap / Math.min(cRect.width, tRect.width)) * 50 : 0;
        }
        break;

      case 'up':
        if (tCenter.y < cCenter.y - 4 || (tRect.bottom <= cRect.bottom - 4 && tRect.top < cRect.top)) {
          isDirectionValid = true;
          primaryDist = Math.max(0, cRect.top - tRect.bottom);
          if (primaryDist === 0) primaryDist = Math.max(0, cCenter.y - tCenter.y);
          orthogonalDist = Math.abs(tCenter.x - cCenter.x);
          overlap = Math.max(0, Math.min(cRect.right, tRect.right) - Math.max(cRect.left, tRect.left));
          overlapBonus = overlap > 0 ? (overlap / Math.min(cRect.width, tRect.width)) * 50 : 0;
        }
        break;

      case 'right':
        if (tCenter.x > cCenter.x + 4 || (tRect.left >= cRect.left + 4 && tRect.right > cRect.right)) {
          isDirectionValid = true;
          primaryDist = Math.max(0, tRect.left - cRect.right);
          if (primaryDist === 0) primaryDist = Math.max(0, tCenter.x - cCenter.x);
          orthogonalDist = Math.abs(tCenter.y - cCenter.y);
          overlap = Math.max(0, Math.min(cRect.bottom, tRect.bottom) - Math.max(cRect.top, tRect.top));
          overlapBonus = overlap > 0 ? (overlap / Math.min(cRect.height, tRect.height)) * 50 : 0;
        }
        break;

      case 'left':
        if (tCenter.x < cCenter.x - 4 || (tRect.right <= cRect.right - 4 && tRect.left < cRect.left)) {
          isDirectionValid = true;
          primaryDist = Math.max(0, cRect.left - tRect.right);
          if (primaryDist === 0) primaryDist = Math.max(0, cCenter.x - tCenter.x);
          orthogonalDist = Math.abs(tCenter.y - cCenter.y);
          overlap = Math.max(0, Math.min(cRect.bottom, tRect.bottom) - Math.max(cRect.top, tRect.top));
          overlapBonus = overlap > 0 ? (overlap / Math.min(cRect.height, tRect.height)) * 50 : 0;
        }
        break;
    }

    if (isDirectionValid) {
      // Prioritize elements with lower primary distance and heavy orthogonal alignment penalty
      const score = primaryDist * 1.0 + orthogonalDist * 2.2 - overlapBonus;
      if (score < bestScore) {
        bestScore = score;
        bestElement = target;
      }
    }
  }

  if (bestElement) {
    focusElement(bestElement);
  } else {
    // If no candidate found in this direction, check if current element is inside a scrollable container
    const scrollContainer = findScrollableParent(current);
    if (scrollContainer) {
      if (dir === 'down') {
        scrollContainer.scrollBy({ top: 180, behavior: 'smooth' });
        setTimeout(() => retryFocusAfterScroll(dir, current), 150);
      } else if (dir === 'up') {
        scrollContainer.scrollBy({ top: -180, behavior: 'smooth' });
        setTimeout(() => retryFocusAfterScroll(dir, current), 150);
      }
    }
  }
}

function findScrollableParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      if (parent.scrollHeight > parent.clientHeight) {
        return parent;
      }
    }
    parent = parent.parentElement;
  }
  return null;
}

function retryFocusAfterScroll(dir: Direction, previousEl: HTMLElement): void {
  const candidates = getFocusableElements();
  const cRect = previousEl.getBoundingClientRect();
  const cCenter = { x: cRect.left + cRect.width / 2, y: cRect.top + cRect.height / 2 };

  let bestElement: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const target of candidates) {
    if (target === previousEl) continue;
    const tRect = target.getBoundingClientRect();
    const tCenter = { x: tRect.left + tRect.width / 2, y: tRect.top + tRect.height / 2 };

    if (dir === 'down' && tCenter.y > cCenter.y) {
      const score = (tCenter.y - cCenter.y) + Math.abs(tCenter.x - cCenter.x) * 2;
      if (score < bestScore) {
        bestScore = score;
        bestElement = target;
      }
    } else if (dir === 'up' && tCenter.y < cCenter.y) {
      const score = (cCenter.y - tCenter.y) + Math.abs(tCenter.x - cCenter.x) * 2;
      if (score < bestScore) {
        bestScore = score;
        bestElement = target;
      }
    }
  }

  if (bestElement) {
    focusElement(bestElement);
  }
}

function handleTvKeyDown(e: KeyboardEvent): void {
  // If user is actively typing text in an input field (search), let standard typing work
  if (e.target instanceof HTMLInputElement && !['ArrowUp', 'ArrowDown', 'Escape', 'Enter'].includes(e.key)) {
    return;
  }

  // Number keys (0-9) for direct channel dialing
  if (e.key >= '0' && e.key <= '9' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    handleTvDigitKey(parseInt(e.key, 10));
    return;
  }

  switch (e.key) {
    // D-Pad Directional Navigation - Pure spatial navigation across ALL buttons!
    case 'ArrowDown':
      e.preventDefault();
      navigateSpatial('down');
      break;

    case 'ArrowUp':
      e.preventDefault();
      navigateSpatial('up');
      break;

    case 'ArrowRight':
      e.preventDefault();
      navigateSpatial('right');
      break;

    case 'ArrowLeft':
      e.preventDefault();
      navigateSpatial('left');
      break;

    // D-Pad Center / OK / Enter
    case 'Enter':
    case 'Select':
      {
        e.preventDefault();
        const current = getCurrentFocusedElement();
        if (current) {
          if (current instanceof HTMLInputElement) {
            current.focus();
          } else {
            current.click();
          }
        } else {
          // If no element focused, toggle play/pause or focus video
          (window as any).togglePlayPause?.();
        }
      }
      break;

    // Back button
    case 'Back':
    case 'BrowserBack':
    case 'Escape':
      e.preventDefault();
      handleAndroidTvBack();
      break;

    // Direct Fullscreen toggle shortcuts (Key F or Info)
    case 'KeyF':
    case 'f':
    case 'F':
      e.preventDefault();
      (window as any).toggleFullscreenMode?.();
      break;

    // Direct Quant Remote toggle shortcuts (Key R)
    case 'KeyR':
    case 'r':
    case 'R':
      if (!(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        (window as any).openRemoteModal?.();
      }
      break;

    // Mute hardware & shortcut keys (Key M or VolumeMute)
    case 'KeyM':
    case 'm':
    case 'M':
    case 'VolumeMute':
    case 'AudioVolumeMute':
      if (!(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        (window as any).toggleMute?.();
      }
      break;

    // Volume hardware keys
    case 'VolumeUp':
    case 'AudioVolumeUp':
      e.preventDefault();
      {
        const video = document.getElementById('video-player') as HTMLVideoElement | null;
        if (video) {
          video.volume = Math.min(1, Math.round((video.volume + 0.05) * 100) / 100);
          video.muted = false;
          (window as any).showTvVolumeHud?.(video.volume, false);
          (window as any).broadcastTVState?.();
        }
      }
      break;

    case 'VolumeDown':
    case 'AudioVolumeDown':
      e.preventDefault();
      {
        const video = document.getElementById('video-player') as HTMLVideoElement | null;
        if (video) {
          video.volume = Math.max(0, Math.round((video.volume - 0.05) * 100) / 100);
          (window as any).showTvVolumeHud?.(video.volume, video.muted);
          (window as any).broadcastTVState?.();
        }
      }
      break;

    // Channel Up / Down & Program + / - hardware keys
    case 'ChannelUp':
    case 'PageUp':
      e.preventDefault();
      playNextChannel();
      break;

    case 'ChannelDown':
    case 'PageDown':
      e.preventDefault();
      playPreviousChannel();
      break;

    // Media hardware keys
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
