import { TelemetrySnapshot } from './observer';
import { eventBus } from '../core/event-bus';

export type StallClassificationType =
  | 'PROGRESSING'
  | 'PAUSED_OR_SEEKING'
  | 'MICRO_STUTTER'
  | 'MSE_BUFFER_GAP'
  | 'DECODER_FREEZE'
  | 'DECODER_OVERLOAD'
  | 'LIVE_EDGE_DRIFT'
  | 'BANDWIDTH_DEFICIT'
  | 'NETWORK_STARVATION'
  | 'UNKNOWN_STALL';

export type RecoveryActionType =
  | 'NONE'
  | 'GAP_BRIDGE'
  | 'DECODER_NUDGE'
  | 'LIVE_RESYNC'
  | 'HLS_RELOAD'
  | 'DOWN_SWITCH'
  | 'FAILOVER_SOURCE';

export interface StallDiagnosis {
  type: StallClassificationType;
  severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  stallTicks: number;
  starvationTicks: number;
  /** Seconds of wall-clock time the current stall has lasted. */
  stallDurationSec: number;
  gapSize?: number;
  driftSeconds?: number;
  recommendedAction: RecoveryActionType;
  reason: string;
}

/**
 * Below this fraction of the expected advance, playback is not keeping up.
 *
 * The previous implementation compared the raw media-time delta against a flat
 * 0.04s, which passed anything that moved at all: a stream limping along at
 * 5% speed was reported as healthy while the viewer watched a slideshow. Judging
 * the ratio against elapsed wall-clock time catches that, and is immune to tick
 * jitter and non-1x playback rates.
 */
const PROGRESS_OK_RATIO = 0.65;
const MICRO_STUTTER_RATIO = 0.2;

/** Buffer below this is treated as starving regardless of what else is true. */
const STARVATION_BUFFER_SEC = 0.35;

/**
 * Seconds of projected buffer runway below which recovery starts early. Acting
 * while there is still buffer left is the difference between a correction the
 * viewer never notices and a visible freeze.
 */
const PREEMPTIVE_HORIZON_SEC = 2.5;

export class StallClassifier {
  private stallTicks = 0;
  private starvationTicks = 0;
  private stallStartedAt = 0;
  private consecutiveStutterTicks = 0;

  classify(snapshot: TelemetrySnapshot): StallDiagnosis {
    // A tick with no elapsed wall time carries no information — the first
    // sample after a reset, or a duplicated timer fire.
    if (snapshot.wallDelta <= 0) {
      return this.healthy('PROGRESSING', 'Awaiting first telemetry interval');
    }

    // 1. Paused, seeking or ended by intent — never a fault condition.
    if (snapshot.paused || snapshot.seeking || snapshot.ended) {
      this.resetCounters();
      return this.healthy(
        'PAUSED_OR_SEEKING',
        snapshot.ended ? 'Playback ended' : snapshot.paused ? 'Playback is paused' : 'Seeking in progress'
      );
    }

    // 2. A backward jump is a seek the observer saw mid-flight, not a stall.
    if (snapshot.timeDelta < 0) {
      this.resetCounters();
      return this.healthy('PAUSED_OR_SEEKING', 'Playhead moved backwards (seek in flight)');
    }

    const healthyProgress = snapshot.progressRatio >= PROGRESS_OK_RATIO;

    if (healthyProgress) {
      this.resetCounters();

      // Still advancing, but the buffer is draining toward empty. Correcting
      // now is invisible; correcting after the freeze is not.
      if (
        snapshot.timeToStarvation < PREEMPTIVE_HORIZON_SEC &&
        snapshot.bufferedAhead < 4 &&
        snapshot.bufferSlope < -0.15
      ) {
        return {
          type: 'BANDWIDTH_DEFICIT',
          severity: 'LOW',
          stallTicks: 0,
          starvationTicks: 0,
          stallDurationSec: 0,
          recommendedAction: 'DOWN_SWITCH',
          reason: `Buffer draining, ~${snapshot.timeToStarvation.toFixed(1)}s of runway left`
        };
      }

      // Decoder keeping up with the clock but shedding frames to do it.
      if (this.isDroppingHeavily(snapshot)) {
        return {
          type: 'DECODER_OVERLOAD',
          severity: 'LOW',
          stallTicks: 0,
          starvationTicks: 0,
          stallDurationSec: 0,
          recommendedAction: 'DOWN_SWITCH',
          reason: `Decoder dropped ${snapshot.droppedFrameDelta} frames this interval`
        };
      }

      return this.healthy('PROGRESSING', 'Stream is advancing smoothly');
    }

    // 3. Playback is behind the clock. Track how long, in real time.
    if (this.stallTicks === 0) {
      this.stallStartedAt = snapshot.timestamp;
    }
    this.stallTicks++;
    const stallDurationSec = (snapshot.timestamp - this.stallStartedAt) / 1000;

    // Case A: an MSE hole immediately ahead of a playhead with nothing buffered.
    if (snapshot.gapSize !== null && snapshot.gapSize > 0 && snapshot.gapSize <= 3) {
      eventBus.emit('STALL_CLASSIFIED', {
        type: 'MSE_BUFFER_GAP',
        gapSize: snapshot.gapSize,
        stallTicks: this.stallTicks
      });
      return {
        type: 'MSE_BUFFER_GAP',
        severity: 'MEDIUM',
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        stallDurationSec,
        gapSize: snapshot.gapSize,
        recommendedAction: 'GAP_BRIDGE',
        reason: `Detected MSE buffer gap of ${snapshot.gapSize.toFixed(2)}s`
      };
    }

    // Case B: buffer is healthy and frames are decoding, but the clock is stuck.
    // Requiring readyState >= 3 avoids nudging a decoder that simply has not
    // been handed enough data yet.
    if (snapshot.bufferedAhead >= 0.6 && snapshot.readyState >= 3) {
      if (this.stallTicks >= 2) {
        eventBus.emit('STALL_CLASSIFIED', {
          type: 'DECODER_FREEZE',
          bufferedAhead: snapshot.bufferedAhead,
          stallTicks: this.stallTicks
        });
        return {
          type: 'DECODER_FREEZE',
          severity: this.stallTicks >= 5 ? 'HIGH' : 'MEDIUM',
          stallTicks: this.stallTicks,
          starvationTicks: this.starvationTicks,
          stallDurationSec,
          recommendedAction: this.stallTicks >= 8 ? 'FAILOVER_SOURCE' : 'DECODER_NUDGE',
          reason: `Decoder frozen despite having ${snapshot.bufferedAhead.toFixed(1)}s buffer`
        };
      }

      // One slow tick with a full buffer is a stutter, not a freeze. Reporting
      // it lets the HUD stay honest without provoking a seek the viewer would
      // see as a jump.
      this.consecutiveStutterTicks++;
      return {
        type: 'MICRO_STUTTER',
        severity: 'LOW',
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        stallDurationSec,
        recommendedAction:
          this.consecutiveStutterTicks >= 4 || snapshot.progressRatio < MICRO_STUTTER_RATIO
            ? 'DOWN_SWITCH'
            : 'NONE',
        reason: `Playback running at ${Math.round(snapshot.progressRatio * 100)}% of realtime`
      };
    }

    // Case C: live stream has fallen behind the edge far enough that the origin
    // may have already rolled those segments out of the window.
    if (snapshot.isLive && snapshot.liveSyncDrift !== null && snapshot.liveSyncDrift > 12) {
      eventBus.emit('STALL_CLASSIFIED', {
        type: 'LIVE_EDGE_DRIFT',
        driftSeconds: snapshot.liveSyncDrift,
        stallTicks: this.stallTicks
      });
      return {
        type: 'LIVE_EDGE_DRIFT',
        severity: 'HIGH',
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        stallDurationSec,
        driftSeconds: snapshot.liveSyncDrift,
        recommendedAction: 'LIVE_RESYNC',
        reason: `Live edge drifted by ${snapshot.liveSyncDrift.toFixed(1)}s`
      };
    }

    // Case D: nothing left to play and nothing arriving.
    if (snapshot.bufferedAhead < STARVATION_BUFFER_SEC) {
      this.starvationTicks++;

      // Escalation is driven by elapsed seconds rather than tick count so the
      // thresholds mean the same thing regardless of timer jitter.
      const severity =
        stallDurationSec >= 6 ? 'CRITICAL' : stallDurationSec >= 3 ? 'HIGH' : 'LOW';

      const recommendedAction: RecoveryActionType =
        stallDurationSec >= 6 ? 'FAILOVER_SOURCE' : stallDurationSec >= 2.5 ? 'HLS_RELOAD' : 'NONE';

      eventBus.emit('STALL_CLASSIFIED', {
        type: 'NETWORK_STARVATION',
        starvationTicks: this.starvationTicks,
        stallDurationSec,
        recommendedAction
      });

      return {
        type: 'NETWORK_STARVATION',
        severity,
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        stallDurationSec,
        recommendedAction,
        reason: `Buffer starvation for ${stallDurationSec.toFixed(1)}s`
      };
    }

    return {
      type: 'UNKNOWN_STALL',
      severity: this.stallTicks >= 6 ? 'HIGH' : 'LOW',
      stallTicks: this.stallTicks,
      starvationTicks: this.starvationTicks,
      stallDurationSec,
      // An unexplained stall that outlasts every specific remedy still has to be
      // escaped; leaving it at NONE is how a stream ends up frozen forever.
      recommendedAction: this.stallTicks >= 10 ? 'FAILOVER_SOURCE' : 'NONE',
      reason: 'Playback stagnant with indeterminate cause'
    };
  }

  private isDroppingHeavily(snapshot: TelemetrySnapshot): boolean {
    if (snapshot.decodedFrameDelta < 10) return false;
    return snapshot.droppedFrameDelta / snapshot.decodedFrameDelta > 0.15;
  }

  private healthy(type: StallClassificationType, reason: string): StallDiagnosis {
    return {
      type,
      severity: 'NONE',
      stallTicks: 0,
      starvationTicks: 0,
      stallDurationSec: 0,
      recommendedAction: 'NONE',
      reason
    };
  }

  private resetCounters(): void {
    this.stallTicks = 0;
    this.starvationTicks = 0;
    this.stallStartedAt = 0;
    this.consecutiveStutterTicks = 0;
  }

  reset(): void {
    this.resetCounters();
  }
}
