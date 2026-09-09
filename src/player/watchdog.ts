import Hls from 'hls.js';
import { networkEstimator } from './network-estimator';

export interface WatchdogOptions {
  onStallRecover?: (action: string) => void;
  onStarvation?: (durationSec: number) => void;
}

export class QuantumStreamWatchdog {
  private video: HTMLVideoElement;
  private getHls: () => Hls | null;
  private intervalId: any = null;
  private lastTime = 0;
  private stallTicks = 0;
  private starvationTicks = 0;
  private options: WatchdogOptions;

  constructor(video: HTMLVideoElement, getHls: () => Hls | null, options: WatchdogOptions = {}) {
    this.video = video;
    this.getHls = getHls;
    this.options = options;
  }

  start(): void {
    this.stop();
    this.intervalId = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stallTicks = 0;
    this.starvationTicks = 0;
    this.lastTime = 0;
  }

  private tick(): void {
    if (!this.video || this.video.paused || this.video.seeking) {
      this.stallTicks = 0;
      this.starvationTicks = 0;
      this.lastTime = this.video ? this.video.currentTime : 0;
      this.updateHud(0, 'Paused');
      return;
    }

    const current = this.video.currentTime;
    const timeDelta = Math.abs(current - this.lastTime);
    this.lastTime = current;

    // 1. Calculate buffer ahead and look for downstream MSE gaps
    let bufferedAhead = 0;
    let nextGapStart: number | null = null;

    if (this.video.buffered && this.video.buffered.length > 0) {
      for (let i = 0; i < this.video.buffered.length; i++) {
        const start = this.video.buffered.start(i);
        const end = this.video.buffered.end(i);

        if (start <= current && current <= end) {
          bufferedAhead = end - current;
        } else if (start > current && start - current <= 1.5) {
          // A buffer range exists just ahead of current playhead
          if (nextGapStart === null || start < nextGapStart) {
            nextGapStart = start;
          }
        }
      }
    }

    networkEstimator.updateBufferSlope(bufferedAhead);

    // 2. Playback progress detection (stalled if delta < 0.04s)
    const isProgressing = timeDelta >= 0.04;

    if (isProgressing) {
      this.stallTicks = 0;
      this.starvationTicks = 0;
      this.updateHud(bufferedAhead, 'Optimal');
      return;
    }

    // 3. Playback is stalled! Determine cause and apply surgical recovery
    this.stallTicks++;

    // Case A: Discontinuity / MSE Buffer Gap (stuck in a gap between buffered ranges)
    if (nextGapStart !== null && nextGapStart > current) {
      const gapSize = nextGapStart - current;
      if (gapSize <= 1.2) {
        console.warn(`[Watchdog] Bridging MSE timestamp gap (${gapSize.toFixed(2)}s) to ${nextGapStart.toFixed(2)}s`);
        this.video.currentTime = nextGapStart + 0.05;
        this.stallTicks = 0;
        this.updateHud(bufferedAhead, 'Bridged Gap');
        if (this.options.onStallRecover) this.options.onStallRecover('gap_bridge');
        return;
      }
    }

    // Case B: Decoder freeze with buffer available (readyState >= 2 but stuck for 2s)
    if (bufferedAhead > 0.5 && this.stallTicks >= 2) {
      console.warn('[Watchdog] Buffer available but playback stalled; nudging decoder playhead');
      this.video.currentTime += 0.08;
      this.video.play().catch(() => {});
      this.stallTicks = 0;
      this.updateHud(bufferedAhead, 'Nudged Decoder');
      if (this.options.onStallRecover) this.options.onStallRecover('decoder_nudge');
      return;
    }

    // Case C: Buffer starvation (no buffer ahead)
    if (bufferedAhead < 0.3) {
      this.starvationTicks++;
      this.updateHud(bufferedAhead, `Buffering (${this.starvationTicks}s)`);

      const hls = this.getHls();
      // If starved for 3+ seconds, trigger HLS reload of fragments
      if (this.starvationTicks === 3 && hls) {
        console.warn('[Watchdog] Starvation detected; triggering hls.startLoad()');
        hls.startLoad();
      }

      // If live stream has drifted too far behind live edge during stall, resync
      if (this.starvationTicks >= 5 && hls && hls.liveSyncPosition) {
        const drift = Math.abs(current - hls.liveSyncPosition);
        if (drift > 12) {
          console.warn(`[Watchdog] Live stream drifted ${drift.toFixed(1)}s; resyncing to live edge`);
          this.video.currentTime = hls.liveSyncPosition - 3;
          hls.startLoad();
          this.starvationTicks = 0;
          this.updateHud(bufferedAhead, 'Live Resync');
          if (this.options.onStallRecover) this.options.onStallRecover('live_resync');
          return;
        }
      }

      if (this.options.onStarvation) {
        this.options.onStarvation(this.starvationTicks);
      }
    }
  }

  private updateHud(bufferedAhead: number, healthStatus: string): void {
    const hudBuffer = document.getElementById('hud-buffer');
    const hudBufferBar = document.getElementById('hud-buffer-bar');
    const hudHealth = document.getElementById('hud-health');

    if (hudBuffer) hudBuffer.textContent = `${bufferedAhead.toFixed(1)}s`;
    if (hudBufferBar) {
      hudBufferBar.style.width = `${Math.min(100, (bufferedAhead / 30) * 100)}%`;
    }
    if (hudHealth) hudHealth.textContent = healthStatus;
  }
}
