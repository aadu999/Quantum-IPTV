import { state } from '../state/store';
import { QuantumStreamEngine } from '../player/engine';
import { broadcastTVState } from '../services/remote';
import { circuitBreaker } from '../player/circuit-breaker';
import { seriesContext } from '../state/series-context';

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

    // Strip the mobile aspect-ratio clamp immediately; without this the stage
    // keeps the inline height it had while docked.
    adjustMobileVideoStage();

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

    // Restore the docked mobile layout, which the fullscreen branch cleared.
    adjustMobileVideoStage();

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

  if (video) {
    video.muted = false;
    if (video.volume <= 0) video.volume = 1.0;
    if (btnMute) btnMute.innerHTML = '<i class="fa-solid fa-volume-high text-xs"></i>';
    showTvVolumeHud(video.volume, false);
  }
  broadcastTVState();
}

export function toggleMute(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  if (video) {
    video.muted = false;
  }

  // Synchronize with native Android TV hardware audio manager
  try {
    const nativeBridge = (window as any).AndroidTvNative;
    if (nativeBridge) {
      nativeBridge.toggleMute?.();
    }
  } catch (e) {}

  broadcastTVState();
}

export function handleNativeVolumeUp(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const btnMute = document.getElementById('btn-mute');
  const unmuteBanner = document.getElementById('unmute-banner');
  const volSlider = document.getElementById('vol-slider') as HTMLInputElement | null;

  if (!video) return;

  video.muted = false;
  try {
    (window as any).AndroidTvNative?.unmute?.();
  } catch (e) {}

  video.volume = Math.min(1, Math.round((video.volume + 0.05) * 100) / 100);
  if (volSlider) volSlider.value = String(video.volume);
  if (btnMute) btnMute.innerHTML = '<i class="fa-solid fa-volume-high text-xs"></i>';
  if (unmuteBanner) unmuteBanner.classList.add('hidden');
  showTvVolumeHud(video.volume, false);
  broadcastTVState();
}

export function handleNativeVolumeDown(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const btnMute = document.getElementById('btn-mute');
  const volSlider = document.getElementById('vol-slider') as HTMLInputElement | null;

  if (!video) return;

  video.volume = Math.max(0, Math.round((video.volume - 0.05) * 100) / 100);
  if (volSlider) volSlider.value = String(video.volume);
  if (video.volume === 0 && btnMute) {
    btnMute.innerHTML = '<i class="fa-solid fa-volume-xmark text-xs text-red-400"></i>';
  }
  showTvVolumeHud(video.volume, video.muted);
  broadcastTVState();
}

export function isCurrentContentSeekable(): boolean {
  if (!engineInstance || !engineInstance.video) return false;
  const currentCh = state.filteredChannels[state.currentChannelIndex] || state.channels[state.currentChannelIndex];
  const video = engineInstance.video;
  const hasFiniteDuration = Boolean(video.duration && isFinite(video.duration) && video.duration > 0);
  
  if (!hasFiniteDuration) return false;
  if (!currentCh) return hasFiniteDuration;

  // Seeking is restricted to movies and series
  const isMovieOrSeries =
    currentCh.type === 'vod' ||
    currentCh.type === 'series' ||
    Boolean(currentCh.vodId) ||
    Boolean(currentCh.seriesId) ||
    (Boolean(currentCh.url) && (currentCh.url.includes('/movie/') || currentCh.url.includes('/series/')));

  return isMovieOrSeries;
}

export function seekVideo(secondsDelta: number, fromExplicitSeekBar = false): void {
  if (!engineInstance || !engineInstance.video) return;
  if (!isCurrentContentSeekable()) return;

  // Seeking can happen ONLY when the user selects the seek bar on movies and series
  const seekBar = document.getElementById('seek-bar-container');
  const isSelected =
    fromExplicitSeekBar ||
    (seekBar && (
      document.activeElement === seekBar ||
      seekBar.classList.contains('tv-focused-btn') ||
      seekBar.classList.contains('tv-focused') ||
      Boolean(seekBar.matches && seekBar.matches(':focus'))
    ));

  if (!isSelected) {
    return;
  }

  const video = engineInstance.video;
  if (video.duration && isFinite(video.duration)) {
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + secondsDelta));
    updateTimeAndSeekBar();
    wakeControls();
  }
}

export function handleSeekBarClick(e: MouseEvent): void {
  if (!engineInstance || !engineInstance.video || !isCurrentContentSeekable()) return;
  const container = document.getElementById('seek-bar-container');
  if (!container) return;

  // Focus the seek bar on click so future keyboard / remote left-right commands seek directly
  container.focus();
  document.querySelectorAll('.tv-focused, .tv-focused-btn').forEach(n => n.classList.remove('tv-focused', 'tv-focused-btn'));
  container.classList.add('tv-focused-btn');

  const rect = container.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percent = Math.max(0, Math.min(1, clickX / rect.width));
  engineInstance.video.currentTime = percent * engineInstance.video.duration;
  updateTimeAndSeekBar();
  wakeControls();
}


let lastResumeWriteAt = 0;

/**
 * Stores where the viewer has got to in the current episode.
 *
 * Throttled to roughly once every five seconds: this runs on timeupdate, which
 * fires several times a second, and the resume map is persisted to
 * localStorage.
 */
function recordResumeProgress(positionSec: number, durationSec: number): void {
  const ctx = seriesContext.current;
  const ep = seriesContext.currentEpisode;
  if (!ctx || !ep) return;
  if (!durationSec || !isFinite(durationSec) || durationSec <= 0) return;

  const now = Date.now();
  if (now - lastResumeWriteAt < 5000) return;
  lastResumeWriteAt = now;

  seriesContext.recordProgress({
    contentId: ep.id,
    title: ep.title,
    seriesId: ctx.seriesId,
    seriesName: ctx.seriesName,
    season: ep.season,
    episodeNum: ep.episodeNum,
    url: ep.url,
    thumb: ep.thumb,
    positionSec,
    durationSec
  });
}

/**
 * Seeks to a stored resume point once the stream is ready. Called on the first
 * frame of a newly loaded episode.
 */
export function applyResumePosition(): void {
  const ep = seriesContext.currentEpisode;
  if (!ep || !engineInstance?.video) return;
  const point = seriesContext.getResume(ep.id);
  if (!point || point.positionSec < 30) return;

  const video = engineInstance.video;
  const seek = () => {
    try {
      // Guard against a stored position past the end, which would stall.
      if (video.duration && isFinite(video.duration) && point.positionSec < video.duration - 5) {
        video.currentTime = point.positionSec;
        engineInstance?.showToast(`Resumed at ${formatTimestamp(point.positionSec)}`, 'info');
      }
    } catch {
      /* seeking not possible yet */
    }
  };

  if (video.readyState >= 2) seek();
  else video.addEventListener('loadeddata', seek, { once: true });
}

/**
 * Plays the next episode when one finishes.
 *
 * Every competing player treats this as standard; without it the screen simply
 * went black at the end of an episode and the viewer had to reopen the series
 * explorer to continue.
 */
export function handleEpisodeEnded(): void {
  const ep = seriesContext.currentEpisode;
  if (ep) seriesContext.markFinished(ep.id);

  const next = seriesContext.nextEpisode;
  if (!next) return;

  const ctx = seriesContext.current;
  if (ctx) seriesContext.setIndex(ctx.index + 1);
  engineInstance?.showToast(`Up next: ${next.title}`, 'info');
  (window as any).playEpisodeRef?.(next);
}

export function updateTimeAndSeekBar(): void {
  if (!engineInstance || !engineInstance.video) return;
  const video = engineInstance.video;
  const curTime = video.currentTime || 0;
  const dur = video.duration;

  recordResumeProgress(curTime, dur);

  const timeContainer = document.getElementById('hud-time-container');
  const curLabel = document.getElementById('hud-time-current');
  const durLabel = document.getElementById('hud-time-duration');
  const progressPlayed = document.getElementById('progress-played');
  const progressBuffer = document.getElementById('progress-buffer');
  const seekHandle = document.getElementById('seek-handle');
  const seekBar = document.getElementById('seek-bar-container');

  const seekable = isCurrentContentSeekable();

  if (seekable && dur && isFinite(dur) && dur > 0) {
    if (seekBar) {
      seekBar.setAttribute('tabindex', '0');
      seekBar.classList.remove('pointer-events-none', 'opacity-40');
    }
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
    // Live stream or unseekable content
    if (seekBar) {
      seekBar.setAttribute('tabindex', '-1');
      seekBar.classList.add('pointer-events-none', 'opacity-40');
    }
    if (timeContainer) timeContainer.classList.add('hidden');
    if (progressPlayed) progressPlayed.style.width = '100%';
    if (seekHandle) seekHandle.style.left = '100%';
  }
}

/**
 * Picks the next channel that stands a real chance of playing.
 *
 * Walking forward and taking the first entry not currently marked offline was
 * only half the test: it happily landed on a channel whose CDN had just failed
 * for a dozen other channels, producing another six-second timeout and another
 * hop. Consulting the breaker as well means the walk skips an entire dead origin
 * in one step, and staying inside the current content type stops an auto-advance
 * from a live channel dropping the viewer into a movie.
 */
export function playNextWorkingChannel(): void {
  engineInstance?.hideOfflineOverlay();
  const list = state.filteredChannels;
  if (list.length === 0) return;

  const current = list[state.currentChannelIndex];
  const preferLive = current ? current.type !== 'series' && current.type !== 'vod' : true;

  let firstNotOffline = -1;

  for (let hop = 1; hop <= list.length; hop++) {
    const index = (state.currentChannelIndex + hop) % list.length;
    const candidate = list[index];
    if (!candidate) continue;
    if (state.offlineChannels.has(candidate.id)) continue;
    if (preferLive && (candidate.type === 'series' || candidate.type === 'vod')) continue;

    // Remember the first merely-untried candidate, in case nothing passes the
    // stricter health check below.
    if (firstNotOffline === -1) firstNotOffline = index;

    if (circuitBreaker.isAvailable(candidate.url)) {
      (window as any).playChannel?.(index, { directPlay: true });
      return;
    }
  }

  // Every reachable candidate is on a struggling origin. Trying one anyway beats
  // leaving the viewer on a dead channel.
  const fallback = firstNotOffline !== -1 ? firstNotOffline : (state.currentChannelIndex + 1) % list.length;
  (window as any).playChannel?.(fallback, { directPlay: true });
}

/** Drops every inline sizing override so the stylesheet alone decides the size. */
function clearStageSizing(stage: HTMLElement, video: HTMLVideoElement): void {
  stage.style.height = '';
  stage.style.minHeight = '';
  stage.style.maxHeight = '';
  stage.style.aspectRatio = '';
  video.style.height = '';
  video.style.width = '';
}

export function adjustMobileVideoStage(): void {
  const video = document.getElementById('video-player') as HTMLVideoElement | null;
  const stage = document.getElementById('video-stage');
  if (!video || !stage) return;

  // In theater mode the stage must fill the screen, so none of the inline
  // sizing below may survive.
  //
  // This is what limited mobile fullscreen to a band across the top: the
  // function writes an inline max-height capped at 45% of the viewport, and
  // .theater-fullscreen only overrides `height`. An inline max-height has
  // nothing competing with it, so it clamped the "fullscreen" stage to 45% of
  // the screen. It reapplied on every resize and every `playing` event, so even
  // a stage that started correct was clamped moments later.
  // isFullscreenActive() rather than the app's own flag alone, so the clamp also
  // stays off when the browser's Fullscreen API is driving (a native control, or
  // the user pressing F11 / the system gesture).
  if (isFullscreenActive()) {
    clearStageSizing(stage, video);
    return;
  }

  const isMobile = window.innerWidth < 768;
  if (!isMobile) {
    clearStageSizing(stage, video);
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
(window as any).handleNativeVolumeUp = handleNativeVolumeUp;
(window as any).handleNativeVolumeDown = handleNativeVolumeDown;
(window as any).adjustMobileVideoStage = adjustMobileVideoStage;
(window as any).showEngineHud = showEngineHud;
(window as any).isCurrentContentSeekable = isCurrentContentSeekable;
(window as any).updateTimeAndSeekBar = updateTimeAndSeekBar;
(window as any).applyResumePosition = applyResumePosition;
(window as any).handleEpisodeEnded = handleEpisodeEnded;
(window as any).state = state;

