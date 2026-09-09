import Hls from 'hls.js';
import { Channel } from '../types';
import { state } from '../state/store';
import { circuitBreaker } from './circuit-breaker';
import { playbackMachine } from './playback-machine';
import { networkEstimator } from './network-estimator';
import { createHlsConfig } from './hls-config';
import { QuantumStreamWatchdog } from './watchdog';
import { getProxiedUrl, shouldProxy } from '../services/proxy';

export class QuantumStreamEngine {
  public video: HTMLVideoElement;
  public hls: Hls | null = null;
  private watchdog: QuantumStreamWatchdog;
  private networkErrorRetries = 0;
  private mediaErrorRetries = 0;
  private lastMediaErrorTime = 0;
  private isProxied = false;
  private offlineCountdownTimer: any = null;

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement;
    this.watchdog = new QuantumStreamWatchdog(
      this.video,
      () => this.hls,
      {
        onStallRecover: (action) => {
          playbackMachine.transition('RECOVERING', { action });
        },
        onStarvation: (durationSec) => {
          if (durationSec >= 8) {
            this.handlePersistentStarvation();
          }
        }
      }
    );
  }

  initHls(): void {
    if (state.isRemoteClient) return;

    if (Hls.isSupported()) {
      if (this.hls) {
        this.hls.destroy();
      }

      this.hls = new Hls(createHlsConfig());
      this.hls.attachMedia(this.video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.showSpinner(false);
        this.attemptAutoplay();
        this.updateHudResolution();
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        this.updateHudResolution();
      });

      this.hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        if (data && data.frag && data.frag.stats) {
          const stats = data.frag.stats;
          const loadDuration = stats.loading.end - stats.loading.start;
          const bytes = stats.loaded || stats.total || 0;
          if (loadDuration > 0 && bytes > 0) {
            networkEstimator.recordSample(bytes, loadDuration);
          }
        }
      });

      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        this.handleHlsError(data);
      });
    }

    this.watchdog.start();
  }

  private handleHlsError(data: any): void {
    if (!data.fatal) {
      // Non-fatal errors are routinely handled by HLS.js internal retries
      return;
    }

    console.warn('[QuantumStreamEngine] Fatal HLS error encountered:', data.type, data.details);
    playbackMachine.transition('ERROR', { type: data.type, details: data.details });

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        this.networkErrorRetries++;
        if (this.networkErrorRetries <= 2 && this.hls) {
          console.log(`[QuantumStreamEngine] Retrying network load (attempt ${this.networkErrorRetries})...`);
          this.hls.startLoad();
        } else {
          this.fallbackToNextSourceOrProxy('network_error');
        }
        break;

      case Hls.ErrorTypes.MEDIA_ERROR: {
        const now = Date.now();
        if (now - this.lastMediaErrorTime > 10000) {
          this.mediaErrorRetries = 0;
        }
        this.lastMediaErrorTime = now;
        this.mediaErrorRetries++;

        if (this.mediaErrorRetries === 1 && this.hls) {
          console.warn('[QuantumStreamEngine] Recovering media error (level 1)...');
          this.hls.recoverMediaError();
        } else if (this.mediaErrorRetries === 2 && this.hls) {
          console.warn('[QuantumStreamEngine] Swapping audio codec and recovering media error (level 2)...');
          this.hls.swapAudioCodec();
          this.hls.recoverMediaError();
        } else {
          console.warn('[QuantumStreamEngine] Media error unrecoverable; triggering failover...');
          this.fallbackToNextSourceOrProxy('media_error');
        }
        break;
      }

      default:
        this.fallbackToNextSourceOrProxy('fatal_error');
        break;
    }
  }

  private handlePersistentStarvation(): void {
    console.warn('[QuantumStreamEngine] Persistent starvation detected, attempting seamless failover...');
    this.fallbackToNextSourceOrProxy('starvation');
  }

  load(url: string, isRetry = false): void {
    if (state.isRemoteClient) return;

    const curCh = state.filteredChannels[state.currentChannelIndex] || null;
    if (!isRetry) {
      playbackMachine.startAttempt(curCh, url);
      this.networkErrorRetries = 0;
      this.mediaErrorRetries = 0;
      this.isProxied = false;
    }

    if (!circuitBreaker.isAvailable(url)) {
      console.warn(`[QuantumStreamEngine] Circuit Breaker OPEN for host: ${circuitBreaker.getHost(url)}. Trying fallback.`);
      this.fallbackToNextSourceOrProxy('circuit_breaker_open');
      return;
    }

    this.showSpinner(true, 'Buffering Stream...');
    playbackMachine.transition('BUFFERING');

    let targetUrl = url;
    if (shouldProxy(url) || this.isProxied) {
      targetUrl = getProxiedUrl(url);
    }

    const isDirectMedia =
      /\.(mp4|mkv|avi|mov|mp3|aac|flv)(\?.*)?$/i.test(url) ||
      url.includes('/movie/') ||
      url.includes('/series/');

    if (isDirectMedia) {
      if (this.hls) {
        this.hls.stopLoad();
        this.hls.detachMedia();
      }
      if (this.video) {
        this.video.src = targetUrl;
        this.video.addEventListener(
          'loadeddata',
          () => {
            this.showSpinner(false);
            this.attemptAutoplay();
          },
          { once: true }
        );
        this.video.addEventListener(
          'error',
          () => {
            this.fallbackToNextSourceOrProxy('direct_media_error');
          },
          { once: true }
        );
        this.attemptAutoplay();
      }
    } else if (this.hls && Hls.isSupported()) {
      this.hls.attachMedia(this.video);
      this.hls.loadSource(targetUrl);
    } else if (this.video && this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Apple HLS (Safari / iOS)
      this.video.src = targetUrl;
      this.video.addEventListener(
        'loadedmetadata',
        () => {
          this.showSpinner(false);
          this.attemptAutoplay();
        },
        { once: true }
      );
      this.attemptAutoplay();
    } else if (this.video) {
      this.video.src = targetUrl;
      this.attemptAutoplay();
    }
  }

  fallbackToNextSourceOrProxy(reason: string): void {
    const curCh = state.filteredChannels[state.currentChannelIndex];
    if (!curCh) return;

    // 1. In-Channel Multi-Source Failover: try secondary backup CDN/stream if available
    if (curCh.sources && curCh.sources.length > 1) {
      const curIndex = curCh.activeSourceIndex || 0;
      if (curIndex < curCh.sources.length - 1) {
        curCh.activeSourceIndex = curIndex + 1;
        const backupSource = curCh.sources[curCh.activeSourceIndex];
        console.log(`[QuantumStreamEngine] Failing over to Source ${curCh.activeSourceIndex + 1} (${backupSource.sourceName}) for ${curCh.name}`);
        this.showToast(`Switching to backup source (${backupSource.sourceName})...`, 'info');
        this.showSpinner(true, `Failing over to ${backupSource.sourceName}...`);
        this.load(backupSource.url, true);
        return;
      }
    }

    // 2. High-Performance Local Streaming Proxy Fallback
    if (!this.isProxied) {
      console.log(`[QuantumStreamEngine] Activating high-performance streaming proxy for ${curCh.name}`);
      this.isProxied = true;
      this.networkErrorRetries = 0;
      this.showSpinner(true, 'Connecting via Streaming Proxy...');
      this.load(curCh.url, true);
      return;
    }

    // 3. All sources and proxy failed
    circuitBreaker.recordFailure(curCh.url);
    this.onStreamFailed(reason);
  }

  onStreamPlaying(): void {
    this.showSpinner(false);
    this.hideOfflineOverlay();
    this.updateHudResolution();

    const curCh = state.filteredChannels[state.currentChannelIndex];
    if (curCh) {
      circuitBreaker.recordSuccess(curCh.url);
      playbackMachine.transition('PLAYING');
      state.offlineChannels.delete(curCh.id);
    }
    try {
      (window as any).adjustMobileVideoStage?.();
    } catch (e) {}
  }

  onStreamFailed(reason = 'Playback error'): void {
    this.showSpinner(false);
    const curCh = state.filteredChannels[state.currentChannelIndex];
    if (curCh) {
      circuitBreaker.recordFailure(curCh.url);
      playbackMachine.endAttempt('FAILED', reason);
      state.offlineChannels.add(curCh.id);
      this.showOfflineOverlay(curCh);
    }
  }

  attemptAutoplay(): void {
    if (!this.video || state.isRemoteClient) return;
    const playPromise = this.video.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          const unmuteBanner = document.getElementById('unmute-banner');
          if (unmuteBanner) unmuteBanner.classList.add('hidden');
          (window as any).updatePlayPauseIcons?.();
          (window as any).broadcastTVState?.();
        })
        .catch(() => {
          // Browser autoplay policy blocked audio. Mute and play smoothly.
          this.video.muted = true;
          const btnMute = document.getElementById('btn-mute');
          if (btnMute) {
            btnMute.innerHTML = '<i class="fa-solid fa-volume-xmark text-xs text-red-400"></i>';
          }
          this.video
            .play()
            .then(() => {
              const unmuteBanner = document.getElementById('unmute-banner');
              if (unmuteBanner) unmuteBanner.classList.remove('hidden');
            })
            .catch(() => {});
          (window as any).updatePlayPauseIcons?.();
          (window as any).broadcastTVState?.();
        });
    }
  }

  showSpinner(show: boolean, message = 'Loading...'): void {
    const videoSpinner = document.getElementById('video-spinner');
    const spinnerMessage = document.getElementById('spinner-message');
    if (!videoSpinner) return;
    if (show) {
      if (spinnerMessage) spinnerMessage.textContent = message;
      videoSpinner.classList.remove('hidden');
      requestAnimationFrame(() => videoSpinner.classList.remove('opacity-0'));
    } else {
      videoSpinner.classList.add('opacity-0');
      setTimeout(() => videoSpinner.classList.add('hidden'), 250);
    }
  }

  showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const toast = document.createElement('div');
    toast.className = `fixed top-5 right-5 z-50 px-4 py-2.5 rounded-xl shadow-xl text-xs font-bold flex items-center gap-2 border backdrop-blur-md transition-all duration-300 transform translate-y-[-10px] opacity-0 ${
      type === 'success'
        ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
        : type === 'error'
        ? 'bg-rose-950/90 border-rose-500/50 text-rose-200'
        : 'bg-slate-900/90 border-slate-700/50 text-white'
    }`;
    toast.innerHTML = `<i class="fa-solid ${
      type === 'success'
        ? 'fa-circle-check text-emerald-400'
        : type === 'error'
        ? 'fa-circle-exclamation text-rose-400'
        : 'fa-circle-info text-brand-400'
    }"></i> <span>${message}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-[-10px]', 'opacity-0');
    });
    setTimeout(() => {
      toast.classList.add('translate-y-[-10px]', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  updateHudResolution(): void {
    const hudRes = document.getElementById('hud-res');
    if (!hudRes || !this.video) return;
    if (this.video.videoWidth) {
      hudRes.textContent = `${this.video.videoHeight}p`;
    }
  }

  showOfflineOverlay(channel: Channel): void {
    if (state.isRemoteClient) return;
    const overlay = document.getElementById('offline-overlay');
    const nameEl = document.getElementById('offline-channel-name');
    const countdownEl = document.getElementById('offline-countdown');
    if (!overlay) return;

    if (nameEl && channel) nameEl.textContent = channel.name;
    overlay.classList.remove('hidden');

    if (this.offlineCountdownTimer) clearInterval(this.offlineCountdownTimer);
    let secondsLeft = 6;
    if (countdownEl) countdownEl.textContent = `${secondsLeft}s`;

    this.offlineCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = `${secondsLeft}s`;
      if (secondsLeft <= 0) {
        clearInterval(this.offlineCountdownTimer);
        (window as any).playNextWorkingChannel?.();
      }
    }, 1000);
  }

  hideOfflineOverlay(): void {
    if (this.offlineCountdownTimer) {
      clearInterval(this.offlineCountdownTimer);
      this.offlineCountdownTimer = null;
    }
    const overlay = document.getElementById('offline-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  updateSubtitlesAndAudioTracks(): void {
    const subList = document.getElementById('subtitles-track-list');
    const audioList = document.getElementById('audio-track-list');
    if (!subList || !audioList) return;

    // Subtitles
    let subHtml = `<button onclick="window.selectSubtitleTrack(-1)" class="w-full text-left px-2 py-1 rounded hover:bg-slate-800 ${
      !this.hls || this.hls.subtitleTrack === -1 ? 'text-brand-400 font-bold bg-slate-800/60' : 'text-slate-300'
    } text-xs">Off</button>`;

    if (this.hls && this.hls.subtitleTracks && this.hls.subtitleTracks.length > 0) {
      this.hls.subtitleTracks.forEach((tr, idx) => {
        const isSelected = this.hls!.subtitleTrack === idx;
        subHtml += `<button onclick="window.selectSubtitleTrack(${idx})" class="w-full text-left px-2 py-1 rounded hover:bg-slate-800 ${
          isSelected ? 'text-brand-400 font-bold bg-slate-800/60' : 'text-slate-300'
        } text-xs flex items-center justify-between">
          <span>${tr.name || tr.lang || 'Track ' + (idx + 1)}</span>
          ${isSelected ? '<i class="fa-solid fa-check text-brand-400"></i>' : ''}
        </button>`;
      });
    }
    subList.innerHTML = subHtml;

    // Audio Tracks
    let audioHtml = `<button onclick="window.selectAudioTrack(-1)" class="w-full text-left px-2 py-1 rounded hover:bg-slate-800 ${
      !this.hls || this.hls.audioTrack === -1 ? 'text-brand-400 font-bold bg-slate-800/60' : 'text-slate-300'
    } text-xs">Default / Auto</button>`;

    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 0) {
      this.hls.audioTracks.forEach((tr, idx) => {
        const isSelected = this.hls!.audioTrack === idx;
        audioHtml += `<button onclick="window.selectAudioTrack(${idx})" class="w-full text-left px-2 py-1 rounded hover:bg-slate-800 ${
          isSelected ? 'text-brand-400 font-bold bg-slate-800/60' : 'text-slate-300'
        } text-xs flex items-center justify-between">
          <span>${tr.name || tr.lang || 'Audio ' + (idx + 1)}</span>
          ${isSelected ? '<i class="fa-solid fa-check text-brand-400"></i>' : ''}
        </button>`;
      });
    }
    audioList.innerHTML = audioHtml;
  }
}
