import Hls from 'hls.js';
import { Channel } from '../types';
import { state } from '../state/store';
import { circuitBreaker } from './circuit-breaker';
import { playbackMachine } from './playback-machine';
import { networkEstimator } from './network-estimator';
import { createHlsConfig } from './hls-config';
import { QuantumStreamWatchdog } from './watchdog';
import { eventBus } from '../core/event-bus';
import { sessionManager } from '../core/session';
import { sourceHealthTracker } from './source-health';
import { buildFailoverLadder, FailoverCandidate } from './failover-ladder';
import { getProxiedUrl, shouldProxy } from '../services/proxy';
import { channelReliability } from '../state/channel-health';
import { playbackDiagnostics } from './diagnostics';
import { seriesContext } from '../state/series-context';

/**
 * How long a load may sit without producing a single rendered frame before it is
 * abandoned.
 *
 * This is the failure mode IPTV hits most often and the one the engine
 * previously had no answer for: the manifest parses, hls.js reports no error,
 * and nothing ever plays. With no timeout the viewer stared at a spinner
 * indefinitely, because every recovery path was driven by error events that
 * never arrived.
 */
const STARTUP_TIMEOUT_MS = 12000;

/**
 * Later rungs get a shorter budget than the first.
 *
 * The first attempt deserves patience: it is usually the healthiest source and
 * a slow origin is still better than a switch the viewer sees. By the third or
 * fourth rung the evidence says this channel is in trouble, and spending a full
 * 12 seconds on each remaining candidate means a minute of spinner before the
 * channel is finally declared offline. Floor it well above a realistic manifest
 * round-trip so a merely slow source is not discarded.
 */
const MIN_STARTUP_TIMEOUT_MS = 6000;

function startupBudgetForRung(rung: number): number {
  return Math.max(MIN_STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS - rung * 2000);
}

/** Absolute cap on media-error recovery attempts within one load. */
const MAX_MEDIA_ERROR_RECOVERIES = 3;

/** Absolute cap on in-place network retries before moving down the ladder. */
const MAX_NETWORK_RETRIES = 2;

/**
 * Diagnostic probes allowed per playback attempt. Enough to characterise the
 * failure without spending a connection-limited account's whole budget.
 */
const MAX_PROBES_PER_ATTEMPT = 4;


/**
 * Ladder for a single on-demand asset (a series episode or a movie).
 *
 * Covers the two things that actually go wrong with Xtream VOD: the request
 * being blocked by mixed content or CORS, which the proxy fixes, and the panel
 * serving the asset under a different container than the API reported. Panels
 * routinely list an episode with no container_extension, or report one value and
 * store another, so the alternates are worth trying before declaring failure.
 */
function buildOnDemandLadder(url: string): FailoverCandidate[] {
  const candidates: FailoverCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidateUrl: string, sourceName: string, proxied: boolean) => {
    const targetUrl = proxied ? getProxiedUrl(candidateUrl) : candidateUrl;
    if (seen.has(targetUrl)) return;
    seen.add(targetUrl);
    candidates.push({ url: candidateUrl, targetUrl, sourceName, proxied, sourceIndex: -1, score: 100 });
  };

  const direct = !shouldProxy(url);
  if (direct) push(url, 'Direct', false);
  push(url, 'Via Proxy', true);

  // Containers the browser can actually decode, most likely first. Matroska is
  // deliberately absent: no browser or WebView can play it in <video>, so
  // retrying as .mkv only wastes the viewer's time.
  const match = url.match(/^(.*)\.([A-Za-z0-9]+)(\?.*)?$/);
  if (match) {
    const [, base, ext, query = ''] = match;
    for (const alt of ['mp4', 'm4v', 'mov']) {
      if (alt.toLowerCase() === ext.toLowerCase()) continue;
      const altUrl = `${base}.${alt}${query}`;
      if (direct) push(altUrl, `Direct (.${alt})`, false);
      push(altUrl, `Proxy (.${alt})`, true);
    }
  }

  return candidates;
}

export class QuantumStreamEngine {
  public video: HTMLVideoElement;
  public hls: Hls | null = null;
  private watchdog: QuantumStreamWatchdog;

  private networkErrorRetries = 0;
  private mediaErrorRetries = 0;
  private currentTargetUrl = '';
  private currentSourceUrl = '';
  private offlineCountdownTimer: any = null;

  /**
   * Incremented on every user-initiated load. Async callbacks capture the value
   * current when they were registered and bail if it has moved on.
   *
   * Without this, zapping quickly left the previous stream's `error` and
   * `loadeddata` listeners live: a failure from the channel the viewer had
   * already left would trigger a failover on the channel they were now watching.
   */
  private loadGeneration = 0;

  private ladder: FailoverCandidate[] = [];
  private ladderIndex = -1;
  /** Guards against two handlers advancing the ladder for the same attempt. */
  private lastAdvancedGeneration = -1;
  /** Bounds diagnostic probes so a connection-limited account is not exhausted. */
  private probesThisAttempt = 0;
  /**
   * True while an episode or movie is loaded. currentChannelIndex still points
   * at the channel list during on-demand playback, so nothing downstream may
   * treat the selected channel as "what is playing".
   */
  private currentIsOnDemand = false;
  private startupTimer: any = null;
  private hasRenderedFrame = false;
  private mediaListenerCleanups: Array<() => void> = [];

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement;
    if (this.video) {
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.poster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%23020617'/%3E%3C/svg%3E";
      this.video.muted = false;
      this.video.volume = 1.0;
      this.video.addEventListener('playing', () => this.onStreamPlaying());
      this.video.addEventListener('canplay', () => {
        if (this.video && this.video.paused) {
          this.attemptAutoplay();
        }
      });
    }
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
        },
        onFailover: (reason) => {
          this.advanceLadder(reason);
        },
        getCurrentUrl: () => this.currentSourceUrl
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

      this.hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        this.showSpinner(false);
        this.attemptAutoplay();
        this.updateHudResolution();
        eventBus.emit('MANIFEST_PARSED', {
          url: this.currentTargetUrl,
          levels: data?.levels?.length || 0
        });
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        this.updateHudResolution();
      });

      this.hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        sourceHealthTracker.recordFragment(this.currentSourceUrl, true);
        if (data && data.frag && data.frag.stats) {
          const stats = data.frag.stats;
          const loadDuration = stats.loading.end - stats.loading.start;
          const ttfb = stats.loading.first > 0 ? stats.loading.first - stats.loading.start : undefined;
          const bytes = stats.loaded || stats.total || 0;
          if (loadDuration > 0 && bytes > 0) {
            networkEstimator.recordSample(bytes, loadDuration, ttfb);
            eventBus.emit('FRAG_LOADED', {
              bytes,
              durationMs: loadDuration,
              url: this.currentSourceUrl
            });
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
    // Non-fatal errors are hls.js's own retry territory, but they still say
    // something about the source: a stream shedding fragments is degrading even
    // while it plays, and that belongs in its health record.
    if (!data.fatal) {
      if (data.details && String(data.details).includes('fragLoadError')) {
        sourceHealthTracker.recordFragment(this.currentSourceUrl, false);
      }
      return;
    }

    console.warn('[QuantumStreamEngine] Fatal HLS error encountered:', data.type, data.details);
    playbackMachine.transition('ERROR', { type: data.type, details: data.details });
    sourceHealthTracker.recordFragment(this.currentSourceUrl, false);
    eventBus.emit('BUFFER_LOW', { type: data.type, details: data.details, url: this.currentSourceUrl });

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        this.networkErrorRetries++;
        if (this.networkErrorRetries <= MAX_NETWORK_RETRIES && this.hls) {
          // Back off before retrying: an origin that just refused a request is
          // rarely ready a few milliseconds later, and immediate retries burn
          // the budget without giving it a chance to recover.
          const delay = 500 * Math.pow(2, this.networkErrorRetries - 1) + Math.random() * 250;
          const generation = this.loadGeneration;
          console.log(`[QuantumStreamEngine] Retrying network load in ${Math.round(delay)}ms (attempt ${this.networkErrorRetries})`);
          setTimeout(() => {
            if (generation !== this.loadGeneration) return;
            this.hls?.startLoad();
          }, delay);
        } else {
          this.advanceLadder('network_error');
        }
        break;

      case Hls.ErrorTypes.MEDIA_ERROR: {
        this.mediaErrorRetries++;

        // A hard cap, unlike the previous 10-second sliding window: a stream
        // erroring every 11 seconds reset the counter each time and looped
        // through recoverMediaError() forever without ever failing over.
        if (this.mediaErrorRetries === 1 && this.hls) {
          console.warn('[QuantumStreamEngine] Recovering media error (level 1)...');
          this.hls.recoverMediaError();
        } else if (this.mediaErrorRetries === 2 && this.hls) {
          console.warn('[QuantumStreamEngine] Swapping audio codec and recovering media error (level 2)...');
          this.hls.swapAudioCodec();
          this.hls.recoverMediaError();
        } else if (this.mediaErrorRetries <= MAX_MEDIA_ERROR_RECOVERIES && this.hls) {
          console.warn('[QuantumStreamEngine] Final media error recovery attempt...');
          this.hls.recoverMediaError();
        } else {
          console.warn('[QuantumStreamEngine] Media error unrecoverable; triggering failover...');
          this.advanceLadder('media_error');
        }
        break;
      }

      default:
        this.advanceLadder('fatal_error');
        break;
    }
  }

  private handlePersistentStarvation(): void {
    console.warn('[QuantumStreamEngine] Persistent starvation detected, attempting seamless failover...');
    this.advanceLadder('starvation');
  }

  /**
   * Entry point for a user-initiated tune. Resets all failover state and builds
   * a fresh ladder for the channel.
   */
  load(url: string, isRetry = false): void {
    if (state.isRemoteClient) return;

    if (isRetry) {
      // Retries come from advanceLadder(), which has already positioned itself.
      this.startAttempt(url, url, false, 'Retry');
      return;
    }

    const channel = state.filteredChannels[state.currentChannelIndex] || null;

    // A new tune invalidates every in-flight callback from the previous one.
    this.loadGeneration++;
    this.clearMediaListeners();
    this.clearStartupTimer();
    this.networkErrorRetries = 0;
    this.mediaErrorRetries = 0;
    this.hasRenderedFrame = false;

    if (!sessionManager.getActiveSession() || (channel && sessionManager.getActiveSession()?.contentId !== channel.id)) {
      sessionManager.startSession(
        channel ? channel.id : 'unknown',
        channel ? channel.name : 'Unknown Channel',
        Date.now(),
        { estimatedBandwidth: networkEstimator.bandwidth }
      );
    }

    playbackMachine.startAttempt(channel, url);
    // Name what the viewer actually chose. currentChannelIndex still points at
    // whatever live channel was last tuned, so using it for an episode labelled
    // the failure with an unrelated channel's name.
    const episode = /\/(series|movie)\//i.test(url) ? seriesContext.currentEpisode : null;
    playbackDiagnostics.begin(episode?.title || channel?.name || 'Requested stream', url);

    // An episode or movie stream is self-contained: it belongs to the title the
    // viewer picked, not to whatever channel happens to be selected in the list.
    // Building the ladder from that channel meant a failed episode fell back to
    // an unrelated live stream, so the viewer ended up watching something they
    // never asked for instead of seeing the episode fail.
    const isOnDemand = /\/(series|movie)\//i.test(url);
    this.currentIsOnDemand = isOnDemand;

    if (isOnDemand) {
      this.ladder = buildOnDemandLadder(url);
    } else {
      this.ladder = buildFailoverLadder(channel);

      if (!this.ladder.some(c => c.url === url)) {
        this.ladder.unshift({
          url,
          targetUrl: shouldProxy(url) ? getProxiedUrl(url) : url,
          sourceName: 'Requested Stream',
          proxied: shouldProxy(url),
          sourceIndex: -1,
          score: 100
        });
      }
    }

    // Otherwise start at the healthiest rung rather than whatever order the
    // playlist happened to list the sources in.
    this.probesThisAttempt = 0;
    this.ladderIndex = 0;
    this.playCandidate(this.ladder[0]);
  }

  /**
   * Raised by the video element's own error event.
   *
   * This used to terminate playback outright: a permanent listener called
   * onStreamFailed() directly, so the very first error killed the attempt and
   * marked the channel offline without the failover ladder ever running. For
   * on-demand content that meant an episode never got its proxied or
   * alternate-container retry, and simply refused to play.
   */
  handleVideoElementError(generation?: number): void {
    if (!this.currentSourceUrl) return;
    // Every other error path is generation-guarded; without the same check a
    // late error from a source the viewer already left burns a rung of the
    // attempt that replaced it.
    if (typeof generation === 'number' && generation !== this.loadGeneration) return;
    this.advanceLadder('video_element_error');
  }

  /** Current load token, so external listeners can guard their callbacks. */
  get currentLoadGeneration(): number {
    return this.loadGeneration;
  }

  /** Moves to the next untried rung, or declares the channel offline. */
  private advanceLadder(reason: string): void {
    // Several sources can observe the same failure (the element's error event,
    // an hls.js fatal, the watchdog). Each advance starts a new generation, so a
    // repeat call for a generation already handled is a duplicate and would skip
    // a rung.
    if (this.lastAdvancedGeneration === this.loadGeneration) return;
    this.lastAdvancedGeneration = this.loadGeneration;

    const channel = state.filteredChannels[state.currentChannelIndex];

    // Attribute the failure to the source that actually failed, once. The old
    // code recorded the same failure twice — in the fallback path and again in
    // onStreamFailed — which made every source look twice as unreliable as it was.
    if (this.currentSourceUrl) {
      circuitBreaker.recordFailure(this.currentSourceUrl, reason);
    }

    const abandoned = this.ladder[this.ladderIndex];
    if (abandoned) {
      const rungId = playbackDiagnostics.recordRung({
        sourceName: abandoned.sourceName,
        url: abandoned.url,
        proxied: abandoned.proxied,
        reason,
        mediaErrorCode: this.video?.error?.code
      });
      // The element reports only a generic code; the panel's actual status is
      // what distinguishes bad credentials from a missing file, so fetch it.
      this.probeStatus(abandoned.targetUrl, rungId);
    }

    const next = this.ladderIndex + 1;
    if (next >= this.ladder.length) {
      this.onStreamFailed(reason);
      return;
    }
    this.ladderIndex = next;
    const candidate = this.ladder[next];
    if (!candidate) {
      this.onStreamFailed(reason);
      return;
    }

    if (candidate.sourceIndex >= 0 && channel) {
      channel.activeSourceIndex = candidate.sourceIndex;
    }

    // channel is absent for on-demand playback and whenever the list is empty,
    // so it can never be dereferenced here.
    const label = this.currentIsOnDemand
      ? seriesContext.currentEpisode?.title || 'requested stream'
      : channel?.name || 'current stream';
    console.log(
      `[QuantumStreamEngine] Failing over to ${candidate.sourceName} (rung ${next + 1}/${this.ladder.length}) for ${label}`
    );
    eventBus.emit('SOURCE_SWITCHED', {
      fromUrl: this.currentSourceUrl,
      toUrl: candidate.targetUrl,
      sourceName: candidate.sourceName,
      reason
    });

    this.showToast(`Switching to ${candidate.sourceName}...`, 'info');
    this.showSpinner(true, `Failing over to ${candidate.sourceName}...`);
    this.playCandidate(candidate);
  }

  /**
   * Asks the origin what it actually returns for a URL that just failed to play.
   *
   * Fire-and-forget: the answer only annotates the diagnostic record, so it must
   * never delay the next rung. Range-limited so it costs a few bytes rather than
   * pulling the asset.
   */
  /**
   * Asks the origin what it actually returns for a URL that just failed to play.
   *
   * HEAD first: many IPTV accounts allow only one or two concurrent connections,
   * and a ranged GET against every rung of an eight-step ladder can exhaust that
   * budget and manufacture the very 403 the probe is trying to diagnose. HEAD
   * costs no body and releases immediately; a ranged GET is the fallback for
   * panels that reject it.
   *
   * Fire-and-forget: the result only annotates a diagnostic record, so it must
   * never delay the next rung.
   */
  private probeStatus(targetUrl: string, rungId: number): void {
    if (this.probesThisAttempt >= MAX_PROBES_PER_ATTEMPT) return;
    this.probesThisAttempt++;

    const annotate = (patch: { httpStatus?: number; httpNote?: string }) =>
      playbackDiagnostics.annotateRung(rungId, patch);

    const rangedGet = () =>
      fetch(targetUrl, { method: 'GET', headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout(6000) })
        .then(resp => annotate({ httpStatus: resp.status, httpNote: resp.headers.get('content-type') || undefined }))
        .catch((err: any) => annotate({ httpStatus: 0, httpNote: err?.name || 'fetch failed' }));

    try {
      fetch(targetUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
        .then(resp => {
          // 405/501 mean the panel refuses HEAD, not that the asset is missing.
          if (resp.status === 405 || resp.status === 501) return rangedGet();
          annotate({ httpStatus: resp.status, httpNote: resp.headers.get('content-type') || undefined });
        })
        // A network-level rejection is not evidence that HEAD is unsupported,
        // and retrying with a GET would spend another connection on an account
        // that may only allow one -- manufacturing the very 403 that explain()
        // would then report as bad credentials.
        .catch((err: any) => annotate({ httpStatus: 0, httpNote: err?.name || 'fetch failed' }));
    } catch {
      /* fetch unavailable */
    }
  }

  private playCandidate(candidate: FailoverCandidate): void {
    if (!candidate) return;
    this.startAttempt(candidate.url, candidate.targetUrl, candidate.proxied, candidate.sourceName);
  }

  private startAttempt(sourceUrl: string, targetUrl: string, proxied: boolean, sourceName: string): void {
    this.loadGeneration++;
    const generation = this.loadGeneration;

    this.clearMediaListeners();
    this.clearStartupTimer();
    this.networkErrorRetries = 0;
    this.mediaErrorRetries = 0;
    this.hasRenderedFrame = false;

    this.currentSourceUrl = sourceUrl;
    this.currentTargetUrl = targetUrl;

    sessionManager.recordAttempt(sourceUrl, sourceName, proxied);

    this.showSpinner(true, 'Buffering Stream...');
    playbackMachine.transition('BUFFERING');
    try {
      (window as any).showEngineHud?.(true, 0);
    } catch (e) {}

    // Restart telemetry so stall counters and recovery budgets from the previous
    // stream do not carry into this one.
    this.watchdog.start();
    this.armStartupTimer(generation, sourceName);

    const isDirectMedia =
      /\.(mp4|mkv|avi|mov|mp3|aac|flv)(\?.*)?$/i.test(sourceUrl) ||
      sourceUrl.includes('/movie/') ||
      sourceUrl.includes('/series/');

    if (isDirectMedia) {
      this.loadDirectMedia(targetUrl, generation);
    } else if (this.hls && Hls.isSupported()) {
      this.hls.stopLoad();
      this.hls.attachMedia(this.video);
      this.hls.loadSource(targetUrl);
    } else if (this.video && this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.loadNativeHls(targetUrl, generation);
    } else if (this.video) {
      this.video.src = targetUrl;
      this.attemptAutoplay();
    }
  }

  private loadDirectMedia(targetUrl: string, generation: number): void {
    if (this.hls) {
      this.hls.stopLoad();
      this.hls.detachMedia();
    }
    if (!this.video) return;

    this.video.src = targetUrl;

    this.addMediaListener('loadeddata', () => {
      if (generation !== this.loadGeneration) return;
      this.showSpinner(false);
      this.attemptAutoplay();
    });

    this.addMediaListener('error', () => {
      // The generation check is the whole point: without it a late error from
      // an abandoned stream fails over the channel the viewer moved to.
      if (generation !== this.loadGeneration) return;
      this.advanceLadder('direct_media_error');
    });

    this.attemptAutoplay();
  }

  private loadNativeHls(targetUrl: string, generation: number): void {
    if (!this.video) return;
    this.video.src = targetUrl;

    this.addMediaListener('loadedmetadata', () => {
      if (generation !== this.loadGeneration) return;
      this.showSpinner(false);
      this.attemptAutoplay();
    });

    this.addMediaListener('error', () => {
      if (generation !== this.loadGeneration) return;
      this.advanceLadder('native_hls_error');
    });

    this.attemptAutoplay();
  }

  /**
   * Registers a listener and remembers how to remove it, so a load that is
   * superseded leaves nothing behind on the shared video element.
   */
  private addMediaListener(type: string, handler: EventListener): void {
    if (!this.video) return;
    this.video.addEventListener(type, handler, { once: true });
    this.mediaListenerCleanups.push(() => this.video?.removeEventListener(type, handler));
  }

  private clearMediaListeners(): void {
    for (const cleanup of this.mediaListenerCleanups) {
      try {
        cleanup();
      } catch (e) {}
    }
    this.mediaListenerCleanups = [];
  }

  /**
   * Catches the silent-failure case: no error, no frame, no progress. Every
   * other recovery path is reactive to an event; this one fires when nothing
   * happens at all.
   */
  private armStartupTimer(generation: number, sourceName: string): void {
    const budget = startupBudgetForRung(Math.max(0, this.ladderIndex));
    this.startupTimer = setTimeout(() => {
      if (generation !== this.loadGeneration) return;
      if (this.hasRenderedFrame) return;
      console.warn(`[QuantumStreamEngine] ${sourceName} produced no frame within ${budget}ms; failing over`);
      this.advanceLadder('startup_timeout');
    }, budget);
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /** Retained for callers outside the engine that still request a manual failover. */
  fallbackToNextSourceOrProxy(reason: string): void {
    this.advanceLadder(reason);
  }

  onStreamPlaying(): void {
    this.hasRenderedFrame = true;
    this.clearStartupTimer();
    this.showSpinner(false);
    this.hideOfflineOverlay();
    this.updateHudResolution();

    playbackDiagnostics.end('PLAYING');
    const ztf = sessionManager.recordFirstFrame();
    if (ztf !== null) {
      const ztfEl = document.getElementById('hud-ztf');
      if (ztfEl) {
        ztfEl.textContent = `${ztf}ms`;
      }
    }

    // Credit the source that actually played, not the channel's nominal url —
    // otherwise a successful proxy attempt cleared the failure record of the
    // direct source that had just failed.
    if (this.currentSourceUrl) {
      circuitBreaker.recordSuccess(this.currentSourceUrl, ztf || undefined);
    }

    const curCh = state.filteredChannels[state.currentChannelIndex];
    if (curCh) {
      playbackMachine.transition('PLAYING');
      state.offlineChannels.delete(curCh.id);
      // Records that this channel genuinely plays, so the list can rank it
      // above entries that have never produced a frame.
      channelReliability.recordPlayed(curCh.id);
    }
    try {
      (window as any).adjustMobileVideoStage?.();
    } catch (e) {}

    // Auto-hide HUD engine status 3 seconds after loading finishes and stream starts playing
    try {
      (window as any).showEngineHud?.(true, 3000);
    } catch (e) {}
  }

  onStreamFailed(reason = 'Playback error'): void {
    this.clearStartupTimer();
    this.clearMediaListeners();
    this.showSpinner(false);
    const curCh = state.filteredChannels[state.currentChannelIndex];
    playbackDiagnostics.end('FAILED');
    sessionManager.endSession('FAILED');
    playbackMachine.endAttempt('FAILED', reason);

    // Only a live channel's failure reflects on that channel. An episode that
    // will not play says nothing about whichever channel happens to be selected
    // in the list, and marking it offline would hide and demote a healthy one.
    if (curCh && !this.currentIsOnDemand) {
      state.offlineChannels.add(curCh.id);
      channelReliability.recordFailed(curCh.id);
    }

    // Shown regardless: an on-demand failure with no valid selected channel
    // previously produced no overlay at all.
    this.showOfflineOverlay(curCh || null);
    try {
      (window as any).showEngineHud?.(true, 0);
    } catch (e) {}
  }

  attemptAutoplay(): void {
    if (!this.video || state.isRemoteClient) return;
    this.video.playsInline = true;

    const tryPlay = (muted = false) => {
      if (!this.video) return;
      this.video.muted = muted;
      const playPromise = this.video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            (window as any).updatePlayPauseIcons?.();
            (window as any).broadcastTVState?.();
            if (muted) {
              // Unmute immediately on first remote keypress or pointer interaction
              const unmuteOnInteraction = () => {
                if (this.video) this.video.muted = false;
                window.removeEventListener('keydown', unmuteOnInteraction);
                window.removeEventListener('pointerdown', unmuteOnInteraction);
              };
              window.addEventListener('keydown', unmuteOnInteraction, { once: true });
              window.addEventListener('pointerdown', unmuteOnInteraction, { once: true });
            }
          })
          .catch((err) => {
            console.warn('[QuantumStreamEngine] Autoplay unmuted was blocked by policy:', err?.message || err);
            if (!muted) {
              // Start muted instantly so video decodes and renders immediately on TV
              tryPlay(true);
            }
          });
      }
    };

    // 1. Try unmuted playback first
    tryPlay(false);

    // 2. Register kickstart listener so any remote keypress will start playback if still paused
    const kickstart = () => {
      if (this.video && this.video.paused) {
        this.video.muted = false;
        this.video.play().catch(() => {});
      }
      window.removeEventListener('keydown', kickstart);
      window.removeEventListener('pointerdown', kickstart);
    };
    window.addEventListener('keydown', kickstart, { once: true });
    window.addEventListener('pointerdown', kickstart, { once: true });
  }

  showSpinner(show: boolean, message = 'Loading...'): void {
    const videoSpinner = document.getElementById('video-spinner');
    const spinnerMessage = document.getElementById('spinner-message');
    const spinnerChannel = document.getElementById('spinner-channel');
    if (!videoSpinner) return;
    if (show) {
      if (spinnerMessage) spinnerMessage.textContent = message;
      if (spinnerChannel) {
        // currentChannelIndex indexes filteredChannels; reading it out of
        // state.channels showed an unrelated channel's name on the spinner.
        const cur = state.filteredChannels[state.currentChannelIndex];
        spinnerChannel.textContent = cur ? cur.name : '';
      }
      videoSpinner.classList.remove('hidden');
      videoSpinner.classList.remove('opacity-0');
    } else {
      videoSpinner.classList.add('opacity-0');
      setTimeout(() => {
        if (videoSpinner.classList.contains('opacity-0')) {
          videoSpinner.classList.add('hidden');
        }
      }, 250);
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
    }"></i> <span></span>`;
    // Channel and source names come from third-party playlists; inserting them
    // as text keeps a crafted name from injecting markup into the page.
    const label = toast.querySelector('span');
    if (label) label.textContent = message;
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

  showOfflineOverlay(channel: Channel | null): void {
    if (state.isRemoteClient) return;
    const overlay = document.getElementById('offline-overlay');
    const nameEl = document.getElementById('offline-channel-name');
    const reasonEl = document.getElementById('offline-reason');
    const detailsEl = document.getElementById('offline-details');
    const countdownEl = document.getElementById('offline-countdown');
    if (!overlay) return;

    const onDemandTitle = /\/(series|movie)\//i.test(this.currentSourceUrl || '')
      ? seriesContext.currentEpisode?.title
      : null;
    if (nameEl) nameEl.textContent = onDemandTitle || channel?.name || 'this stream';

    // The probe that supplies the HTTP status resolves shortly after the last
    // rung fails, so explain once now and refresh when it lands.
    const renderDiagnosis = () => {
      if (reasonEl) reasonEl.textContent = playbackDiagnostics.explain();
      if (detailsEl && !detailsEl.classList.contains('hidden')) {
        detailsEl.textContent = playbackDiagnostics.report();
      }
    };
    renderDiagnosis();
    setTimeout(renderDiagnosis, 1500);

    overlay.classList.remove('hidden');
    overlay.classList.add('flex');

    const detailsBtn = document.getElementById('offline-details-btn');
    if (detailsBtn && !detailsBtn.dataset.bound) {
      detailsBtn.dataset.bound = 'true';
      detailsBtn.addEventListener('click', () => {
        if (!detailsEl) return;
        detailsEl.classList.toggle('hidden');
        detailsEl.textContent = playbackDiagnostics.report();
      });
    }

    const retryBtn = document.getElementById('offline-retry-btn');
    if (retryBtn && !retryBtn.dataset.bound) {
      retryBtn.dataset.bound = 'true';
      retryBtn.addEventListener('click', () => {
        this.hideOfflineOverlay();
        // Retry the asset that failed. Falling back to the selected channel's
        // URL restarted an unrelated live stream instead of the episode.
        const failed = this.currentSourceUrl;
        const cur = state.filteredChannels[state.currentChannelIndex];
        const target = failed || cur?.url;
        if (target) this.load(target);
      });
    }

    const nextBtn = document.getElementById('offline-next-btn');
    if (nextBtn && !nextBtn.dataset.bound) {
      nextBtn.dataset.bound = 'true';
      nextBtn.addEventListener('click', () => {
        this.hideOfflineOverlay();
        (window as any).playNextWorkingChannel?.();
      });
    }

    if (this.offlineCountdownTimer) clearInterval(this.offlineCountdownTimer);

    // Auto-advancing away from an episode would drop the viewer out of the
    // series they chose, so on-demand failures wait for a decision. The
    // countdown is hidden in that case rather than counting to zero and doing
    // nothing, which read as the app having hung.
    const willAutoAdvance = !this.currentIsOnDemand && !!channel;
    const countdownWrap = countdownEl?.parentElement;
    if (countdownWrap) countdownWrap.classList.toggle('hidden', !willAutoAdvance);
    if (!willAutoAdvance) return;

    let secondsLeft = 6;
    if (countdownEl) countdownEl.textContent = `${secondsLeft}s`;

    this.offlineCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = `${secondsLeft}s`;
      if (secondsLeft <= 0) {
        clearInterval(this.offlineCountdownTimer);
        this.offlineCountdownTimer = null;
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
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
    }
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
          <span>${escapeHtml(tr.name || tr.lang || 'Track ' + (idx + 1))}</span>
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
          <span>${escapeHtml(tr.name || tr.lang || 'Audio ' + (idx + 1))}</span>
          ${isSelected ? '<i class="fa-solid fa-check text-brand-400"></i>' : ''}
        </button>`;
      });
    }
    audioList.innerHTML = audioHtml;
  }
}

/** Track names originate in the manifest, so they are untrusted markup. */
function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}
