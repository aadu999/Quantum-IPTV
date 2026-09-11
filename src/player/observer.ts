import Hls from 'hls.js';
import { networkEstimator } from './network-estimator';
import { eventBus } from '../core/event-bus';

export interface TelemetrySnapshot {
  timestamp: number;
  currentTime: number;
  timeDelta: number;
  bufferedAhead: number;
  nextGapStart: number | null;
  bufferSlope: number;
  liveSyncDrift: number | null;
  readyState: number;
  paused: boolean;
  seeking: boolean;
  networkBandwidth: number;
  isLive: boolean;
}

export class PlaybackObserver {
  private video: HTMLVideoElement;
  private getHls: () => Hls | null;
  private lastTime = 0;
  private lastTickTimestamp = 0;

  constructor(video: HTMLVideoElement, getHls: () => Hls | null) {
    this.video = video;
    this.getHls = getHls;
  }

  sample(): TelemetrySnapshot {
    const now = Date.now();
    const current = this.video ? this.video.currentTime : 0;
    const timeDelta = Math.abs(current - this.lastTime);
    this.lastTime = current;
    this.lastTickTimestamp = now;

    let bufferedAhead = 0;
    let nextGapStart: number | null = null;

    if (this.video && this.video.buffered && this.video.buffered.length > 0) {
      for (let i = 0; i < this.video.buffered.length; i++) {
        const start = this.video.buffered.start(i);
        const end = this.video.buffered.end(i);

        if (start <= current && current <= end) {
          bufferedAhead = end - current;
        } else if (start > current && start - current <= 1.5) {
          if (nextGapStart === null || start < nextGapStart) {
            nextGapStart = start;
          }
        }
      }
    }

    const bufferSlope = networkEstimator.updateBufferSlope(bufferedAhead);

    const hls = this.getHls();
    let liveSyncDrift: number | null = null;
    let isLive = false;

    if (hls && hls.liveSyncPosition) {
      isLive = true;
      liveSyncDrift = Math.abs(current - hls.liveSyncPosition);
    }

    const snapshot: TelemetrySnapshot = {
      timestamp: now,
      currentTime: current,
      timeDelta,
      bufferedAhead,
      nextGapStart,
      bufferSlope,
      liveSyncDrift,
      readyState: this.video ? this.video.readyState : 0,
      paused: this.video ? this.video.paused : false,
      seeking: this.video ? this.video.seeking : false,
      networkBandwidth: networkEstimator.bandwidth,
      isLive
    };

    eventBus.emit('BUFFER_SNAPSHOT', {
      bufferedAhead,
      bufferSlope,
      networkBandwidth: snapshot.networkBandwidth,
      currentTime: current
    });

    return snapshot;
  }

  reset(): void {
    this.lastTime = this.video ? this.video.currentTime : 0;
    this.lastTickTimestamp = Date.now();
  }
}
