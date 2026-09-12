import Hls from 'hls.js';
import { networkEstimator } from './network-estimator';
import { eventBus } from '../core/event-bus';

export interface TelemetrySnapshot {
  timestamp: number;
  /** Wall-clock seconds since the previous sample. */
  wallDelta: number;
  currentTime: number;
  /** Signed media-time advance since the previous sample. */
  timeDelta: number;
  /** How much of `wallDelta` the playhead actually covered, 0..1+. */
  progressRatio: number;
  bufferedAhead: number;
  nextGapStart: number | null;
  gapSize: number | null;
  bufferSlope: number;
  timeToStarvation: number;
  liveSyncDrift: number | null;
  readyState: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  playbackRate: number;
  networkBandwidth: number;
  currentLevelBitrate: number | null;
  /** Frames the decoder dropped since the previous sample. */
  droppedFrameDelta: number;
  /** Frames decoded since the previous sample. */
  decodedFrameDelta: number;
  isLive: boolean;
  seekableEnd: number | null;
}

/**
 * Media Source Extensions routinely reports a single contiguous buffer as two
 * ranges separated by a sub-frame sliver. Treating those as a real gap makes the
 * player believe it has almost nothing buffered and triggers spurious recovery,
 * so ranges closer together than this are merged.
 */
const RANGE_MERGE_TOLERANCE = 0.12;

interface MergedRange {
  start: number;
  end: number;
}

export class PlaybackObserver {
  private video: HTMLVideoElement;
  private getHls: () => Hls | null;
  private lastTime = 0;
  private lastTickTimestamp = 0;
  private lastDroppedFrames = 0;
  private lastDecodedFrames = 0;

  constructor(video: HTMLVideoElement, getHls: () => Hls | null) {
    this.video = video;
    this.getHls = getHls;
  }

  /** Collapses `video.buffered` into ranges with the MSE slivers merged out. */
  private mergedBufferedRanges(): MergedRange[] {
    const ranges: MergedRange[] = [];
    const buffered = this.video?.buffered;
    if (!buffered || buffered.length === 0) return ranges;

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      const previous = ranges[ranges.length - 1];
      if (previous && start - previous.end <= RANGE_MERGE_TOLERANCE) {
        previous.end = Math.max(previous.end, end);
      } else {
        ranges.push({ start, end });
      }
    }
    return ranges;
  }

  sample(): TelemetrySnapshot {
    const now = Date.now();
    const current = this.video ? this.video.currentTime : 0;

    // Wall-clock elapsed drives every progress judgement below. The old code
    // assumed a fixed 1s tick, which meant a throttled background timer or a
    // slow main thread read as a stall even though playback was fine.
    const wallDelta = this.lastTickTimestamp ? (now - this.lastTickTimestamp) / 1000 : 0;

    // Signed, deliberately: Math.abs() made a backward seek look like forward
    // progress and masked genuine stalls right after one.
    const timeDelta = current - this.lastTime;

    this.lastTime = current;
    this.lastTickTimestamp = now;

    const playbackRate = this.video?.playbackRate || 1;
    const expectedAdvance = wallDelta * playbackRate;
    const progressRatio = expectedAdvance > 0 ? timeDelta / expectedAdvance : 1;

    const ranges = this.mergedBufferedRanges();
    let bufferedAhead = 0;
    let nextGapStart: number | null = null;

    for (const range of ranges) {
      if (range.start <= current && current <= range.end) {
        bufferedAhead = range.end - current;
      } else if (range.start > current) {
        if (nextGapStart === null || range.start < nextGapStart) {
          nextGapStart = range.start;
        }
      }
    }

    // A gap only matters when the playhead is not already inside a range: if
    // there is buffer ahead, the player has somewhere to go.
    const gapSize = nextGapStart !== null && bufferedAhead <= 0.01 ? nextGapStart - current : null;

    const bufferSlope = networkEstimator.updateBufferSlope(bufferedAhead);
    const timeToStarvation = networkEstimator.getTimeToStarvation(bufferedAhead);

    const hls = this.getHls();
    const { isLive, liveSyncDrift, seekableEnd } = this.sampleLiveState(hls, current);
    const currentLevelBitrate = this.sampleLevelBitrate(hls);
    const { droppedFrameDelta, decodedFrameDelta } = this.sampleFrameStats();

    const snapshot: TelemetrySnapshot = {
      timestamp: now,
      wallDelta,
      currentTime: current,
      timeDelta,
      progressRatio,
      bufferedAhead,
      nextGapStart,
      gapSize,
      bufferSlope,
      timeToStarvation,
      liveSyncDrift,
      readyState: this.video ? this.video.readyState : 0,
      paused: this.video ? this.video.paused : false,
      seeking: this.video ? this.video.seeking : false,
      ended: this.video ? this.video.ended : false,
      playbackRate,
      networkBandwidth: networkEstimator.bandwidth,
      currentLevelBitrate,
      droppedFrameDelta,
      decodedFrameDelta,
      isLive,
      seekableEnd
    };

    eventBus.emit('BUFFER_SNAPSHOT', {
      bufferedAhead,
      bufferSlope,
      timeToStarvation,
      networkBandwidth: snapshot.networkBandwidth,
      currentTime: current
    });

    return snapshot;
  }

  /**
   * Live detection used to hinge on `hls.liveSyncPosition` being truthy, which
   * misses native/direct playback entirely and reads 0 as "not live". The
   * manifest's own live flag is authoritative; an infinite duration covers the
   * non-HLS paths.
   */
  private sampleLiveState(
    hls: Hls | null,
    current: number
  ): { isLive: boolean; liveSyncDrift: number | null; seekableEnd: number | null } {
    let isLive = false;
    let liveSyncDrift: number | null = null;
    let seekableEnd: number | null = null;

    try {
      const seekable = this.video?.seekable;
      if (seekable && seekable.length > 0) {
        seekableEnd = seekable.end(seekable.length - 1);
      }
    } catch {
      /* seekable can throw while the element is tearing down */
    }

    if (hls) {
      const level = hls.levels?.[hls.currentLevel];
      if (level?.details?.live) isLive = true;
      const syncPosition = hls.liveSyncPosition;
      if (isLive && typeof syncPosition === 'number' && Number.isFinite(syncPosition)) {
        // Signed would be misleading here: being ahead of the sync point is not
        // a drift condition, so only lag counts.
        liveSyncDrift = Math.max(0, syncPosition - current);
      }
    }

    if (!isLive && this.video && this.video.duration === Infinity) {
      isLive = true;
      if (seekableEnd !== null) {
        liveSyncDrift = Math.max(0, seekableEnd - current);
      }
    }

    return { isLive, liveSyncDrift, seekableEnd };
  }

  private sampleLevelBitrate(hls: Hls | null): number | null {
    if (!hls) return null;
    const level = hls.levels?.[hls.currentLevel];
    return level?.bitrate ?? null;
  }

  /**
   * Dropped-frame rate separates a decoder that is struggling (dropping frames
   * while still consuming buffer) from one that is genuinely wedged. Without it,
   * both look identical from `currentTime` alone.
   */
  private sampleFrameStats(): { droppedFrameDelta: number; decodedFrameDelta: number } {
    try {
      const quality = (this.video as any)?.getVideoPlaybackQuality?.();
      if (!quality) return { droppedFrameDelta: 0, decodedFrameDelta: 0 };

      const dropped = quality.droppedVideoFrames || 0;
      const decoded = quality.totalVideoFrames || 0;

      // A decreasing counter means the element was reloaded; rebase instead of
      // reporting a large negative delta.
      const droppedFrameDelta = dropped >= this.lastDroppedFrames ? dropped - this.lastDroppedFrames : 0;
      const decodedFrameDelta = decoded >= this.lastDecodedFrames ? decoded - this.lastDecodedFrames : 0;

      this.lastDroppedFrames = dropped;
      this.lastDecodedFrames = decoded;

      return { droppedFrameDelta, decodedFrameDelta };
    } catch {
      return { droppedFrameDelta: 0, decodedFrameDelta: 0 };
    }
  }

  reset(): void {
    this.lastTime = this.video ? this.video.currentTime : 0;
    // Zeroed rather than set to now: the first sample after a reset has no
    // meaningful previous tick, and reporting wallDelta 0 keeps it from being
    // judged as progress or as a stall.
    this.lastTickTimestamp = 0;
    this.lastDroppedFrames = 0;
    this.lastDecodedFrames = 0;
  }
}
