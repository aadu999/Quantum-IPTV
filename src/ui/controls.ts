import { state } from '../state/store';
import { QuantumStreamEngine } from '../player/engine';
import { broadcastTVState } from '../services/remote';

let engineInstance: QuantumStreamEngine | null = null;

export function setEngineInstance(engine: QuantumStreamEngine): void {
  engineInstance = engine;
}

export function formatTimestamp(sec: number): string {
  if (isNaN(sec) || !isFinite(sec)) return '00:00:00';
  const totalSec = Math.floor(sec);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function isFullscreenActive(): boolean {
  return state.isTheaterFullscreen || !!document.fullscreenElement;
}

let controlsIdleTimer: any = null;
let hudAutoTimer: any = null;
const CONTROLS_HIDE_DELAY = 2500;

export function showEngineHud(visible: boolean, autoHideMs = 0): void {
  const hud = document.getElementById('engine-hud');
  if (!hud || state.isRemoteClient) return;

  if (hudAutoTimer) {
    clearTimeout(hudAutoTimer);
    hudAutoTimer = null;
  }

  if (visible) {
    hud.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-2');
    if (autoHideMs > 0) {
      hudAutoTimer = setTimeout(() => {
        hud.classList.add('opacity-0', 'pointer-events-none', '-translate-y-2');
      }, autoHideMs);
    }
  } else {
    hud.classList.add('opacity-0', 'pointer-events-none', '-translate-y-2');
  }
}

export function wakeControls(): void {
  const videoStage = document.getElementById('video-stage');
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  if (!videoStage || state.isRemoteClient) return;

  videoStage.classList.remove('fullscreen-idle');

  // Briefly reveal engine HUD if controls are awakened during playback
  if (video && !video.paused) {
    showEngineHud(true, 3000);
  }

  if (controlsIdleTimer) {
    clearTimeout(controlsIdleTimer);
    controlsIdleTimer = null;
  }

  if (isFullscreenActive() && video && !video.paused) {
    controlsIdleTimer = setTimeout(() => {
      if (isFullscreenActive() && video && !video.paused) {
        videoStage.classList.add('fullscreen-idle');
      }
    }, CONTROLS_HIDE_DELAY);
  }
}

export function toggleFullscreenMode(forceState?: boolean): void {
  const videoStage = document.getElementById('video-stage');
  const exitTheaterBtn = document.getElementById('exit-theater-btn');
  const shouldBeFull = forceState !== undefined ? forceState : !state.isTheaterFullscreen;
  state.isTheaterFullscreen = shouldBeFull;

  if (!videoStage) return;

  if (shouldBeFull) {
    videoStage.classList.add('theater-fullscreen');
    if (exitTheaterBtn) exitTheaterBtn.classList.remove('hidden');

    try {
      (window as any).AndroidTvNative?.setImmersiveFullscreen?.(true);
    } catch (e) {}

    try {
      if (!document.fullscreenElement && videoStage.requestFullscreen) {
        videoStage.requestFullscreen().catch(() => {});
      }
    } catch (e) {}

    wakeControls();

    // Focus on exit button or player control so D-pad works immediately
    const btnFull = document.getElementById('btn-fullscreen');
    if (btnFull) {
      document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(n => n.classList.remove('tv-focused', 'tv-focused-btn'));
      btnFull.classList.add('tv-focused-btn');
      btnFull.focus();
    }
  } else {
    videoStage.classList.remove('theater-fullscreen');
    videoStage.classList.remove('fullscreen-idle');
    if (controlsIdleTimer) clearTimeout(controlsIdleTimer);
    if (exitTheaterBtn) exitTheaterBtn.classList.add('hidden');

    try {
      (window as any).AndroidTvNative?.setImmersiveFullscreen?.(false);
    } catch (e) {}

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (e) {}

    const btnFull = document.getElementById('btn-fullscreen');
    if (btnFull) {
      document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(n => n.classList.remove('tv-focused', 'tv-focused-btn'));
      btnFull.classList.add('tv-focused-btn');
      btnFull.focus();
    }
  }
  broadcastTVState();
}

export function updatePlayPauseIcons(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const btnPlayPause = document.getElementById('btn-play-pause');
  if (!btnPlayPause || !video) return;

  if (video.paused) {
    btnPlayPause.innerHTML = '<i class="fa-solid fa-play text-sm"></i>';
  } else {
    btnPlayPause.innerHTML = '<i class="fa-solid fa-pause text-sm"></i>';
  }
}

export function togglePlayPause(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  if (!video || state.isRemoteClient) return;

  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  updatePlayPauseIcons();
  wakeControls();
  broadcastTVState();
}

let volumeHudTimer: any = null;

export function showTvVolumeHud(volume?: number, isMuted?: boolean): void {
  const hud = document.getElementById('tv-volume-hud');
  const icon = document.getElementById('tv-volume-hud-icon');
  const text = document.getElementById('tv-volume-hud-text');
  const bar = document.getElementById('tv-volume-hud-bar');
  const video = engineInstance?.video || (document.getElementById('video-player') as HTMLVideoElement | null);
  if (!hud || state.isRemoteClient) return;

  const actualVol = volume !== undefined ? volume : (video ? video.volume : 1);
  const actualMuted = isMuted !== undefined ? isMuted : (video ? video.muted : false);
  const percent = actualMuted ? 0 : Math.round(Math.max(0, Math.min(1, actualVol)) * 100);

  if (icon) {
    if (actualMuted || percent === 0) {
      icon.innerHTML = '<i class="fa-solid fa-volume-xmark text-rose-400"></i>';
    } else if (percent < 40) {
      icon.innerHTML = '<i class="fa-solid fa-volume-low text-brand-400"></i>';
    } else {
      icon.innerHTML = '<i class="fa-solid fa-volume-high text-brand-400"></i>';
    }
  }

  if (text) {
    text.textContent = actualMuted ? 'Muted' : `${percent}%`;
  }

  if (bar) {
    bar.style.width = `${percent}%`;
    bar.className = actualMuted
      ? 'h-full bg-rose-500 rounded-full transition-all duration-150'
      : 'h-full bg-gradient-to-r from-brand-500 to-indigo-500 rounded-full transition-all duration-150';
  }

  // Animate in HUD
  hud.classList.remove('opacity-0', 'translate-y-[-8px]', 'scale-95');
  hud.classList.add('opacity-100', 'translate-y-0', 'scale-100');

  if (volumeHudTimer) clearTimeout(volumeHudTimer);
  volumeHudTimer = setTimeout(() => {
    hud.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
    hud.classList.add('opacity-0', 'translate-y-[-8px]', 'scale-95');
  }, 1800);
}

export function unmuteAudioNow(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const btnMute = document.getElementById('btn-mute');
  const unmuteBanner = document.getElementById('unmute-banner');

  if (video) {
    video.muted = false;
    if (btnMute) btnMute.innerHTML = '<i class="fa-solid fa-volume-high text-xs"></i>';
    showTvVolumeHud(video.volume, false);
  }
  if (unmuteBanner) unmuteBanner.classList.add('hidden');
  broadcastTVState();
}

export function toggleMute(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const btnMute = document.getElementById('btn-mute');
  const unmuteBanner = document.getElementById('unmute-banner');

  if (!video) return;

  video.muted = !video.muted;
  if (btnMute) {
    btnMute.innerHTML = video.muted
      ? '<i class="fa-solid fa-volume-xmark text-xs text-red-400"></i>'
      : '<i class="fa-solid fa-volume-high text-xs"></i>';
  }
  if (!video.muted && unmuteBanner) {
    unmuteBanner.classList.add('hidden');
  }
  showTvVolumeHud(video.volume, video.muted);
  broadcastTVState();
}

export function seekVideo(secondsDelta: number): void {
  if (!engineInstance || !engineInstance.video) return;
  const video = engineInstance.video;
  if (video.duration && isFinite(video.duration)) {
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + secondsDelta));
    updateTimeAndSeekBar();
  }
}

export function handleSeekBarClick(e: MouseEvent): void {
  if (!engineInstance || !engineInstance.video || !engineInstance.video.duration || !isFinite(engineInstance.video.duration))
    return;
  const container = document.getElementById('seek-bar-container');
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percent = Math.max(0, Math.min(1, clickX / rect.width));
  engineInstance.video.currentTime = percent * engineInstance.video.duration;
  updateTimeAndSeekBar();
}

export function updateTimeAndSeekBar(): void {
  if (!engineInstance || !engineInstance.video) return;
  const video = engineInstance.video;
  const curTime = video.currentTime || 0;
  const dur = video.duration;

  const timeContainer = document.getElementById('hud-time-container');
  const curLabel = document.getElementById('hud-time-current');
  const durLabel = document.getElementById('hud-time-duration');
  const progressPlayed = document.getElementById('progress-played');
  const progressBuffer = document.getElementById('progress-buffer');
  const seekHandle = document.getElementById('seek-handle');

  if (dur && isFinite(dur) && dur > 0) {
    if (timeContainer) timeContainer.classList.remove('hidden');
    if (curLabel) curLabel.textContent = formatTimestamp(curTime);
    if (durLabel) durLabel.textContent = formatTimestamp(dur);

    const percent = Math.min(100, Math.max(0, (curTime / dur) * 100));
    if (progressPlayed) progressPlayed.style.width = `${percent}%`;
    if (seekHandle) seekHandle.style.left = `${percent}%`;

    if (video.buffered && video.buffered.length > 0) {
      const bufEnd = video.buffered.end(video.buffered.length - 1);
      const bufPercent = Math.min(100, Math.max(0, (bufEnd / dur) * 100));
      if (progressBuffer) progressBuffer.style.width = `${bufPercent}%`;
    }
  } else {
    if (timeContainer) timeContainer.classList.add('hidden');
    if (progressPlayed) progressPlayed.style.width = '100%';
    if (seekHandle) seekHandle.style.left = '100%';
  }
}

export function playNextWorkingChannel(): void {
  engineInstance?.hideOfflineOverlay();
  if (state.filteredChannels.length === 0) return;

  let nextIndex = state.currentChannelIndex;
  let searchedCount = 0;

  do {
    nextIndex = (nextIndex + 1) % state.filteredChannels.length;
    searchedCount++;
    const ch = state.filteredChannels[nextIndex];
    if (ch && !state.offlineChannels.has(ch.id)) {
      (window as any).playChannel?.(nextIndex);
      return;
    }
  } while (searchedCount < state.filteredChannels.length);

  (window as any).playChannel?.((state.currentChannelIndex + 1) % state.filteredChannels.length);
}

export function adjustMobileVideoStage(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const stage = document.getElementById('video-stage');
  if (!video || !stage) return;

  const isMobile = window.innerWidth < 768;
  if (!isMobile) {
    stage.style.height = '';
    stage.style.minHeight = '';
    stage.style.maxHeight = '';
    stage.style.aspectRatio = '';
    video.style.height = '';
    video.style.width = '';
    return;
  }

  // Calculate width from stage or window
  const stageWidth = stage.clientWidth || window.innerWidth || 400;

  let targetHeight: number;
  if (video.videoWidth && video.videoHeight && video.videoHeight > 0) {
    const streamRatio = video.videoWidth / video.videoHeight;
    targetHeight = Math.round(stageWidth / streamRatio);
  } else {
    // Default 16:9 until video metadata arrives
    targetHeight = Math.round(stageWidth * (9 / 16));
  }

  // Cap height to maximum 45% of viewport height so controls & channel sidebar remain usable
  const maxAllowed = Math.round(window.innerHeight * 0.45);
  const minAllowed = 140;
  const clampedHeight = Math.max(minAllowed, Math.min(maxAllowed, targetHeight));

  stage.style.height = `${clampedHeight}px`;
  stage.style.minHeight = `${clampedHeight}px`;
  stage.style.maxHeight = `${clampedHeight}px`;
  video.style.width = '100%';
  video.style.height = '100%';
}

// Attach functions to window for any inline DOM event handlers
(window as any).togglePlayPause = togglePlayPause;
(window as any).updatePlayPauseIcons = updatePlayPauseIcons;
(window as any).toggleFullscreenMode = toggleFullscreenMode;
(window as any).wakeControls = wakeControls;
(window as any).unmuteAudioNow = unmuteAudioNow;
(window as any).seekVideo = seekVideo;
(window as any).handleSeekBarClick = handleSeekBarClick;
(window as any).playNextWorkingChannel = playNextWorkingChannel;
(window as any).showTvVolumeHud = showTvVolumeHud;
(window as any).toggleMute = toggleMute;
(window as any).adjustMobileVideoStage = adjustMobileVideoStage;
(window as any).showEngineHud = showEngineHud;

