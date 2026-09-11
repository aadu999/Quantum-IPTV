import { TelemetrySnapshot } from './observer';
import { eventBus } from '../core/event-bus';

export type StallClassificationType =
  | 'PROGRESSING'
  | 'PAUSED_OR_SEEKING'
  | 'MSE_BUFFER_GAP'
  | 'DECODER_FREEZE'
  | 'LIVE_EDGE_DRIFT'
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
  gapSize?: number;
  driftSeconds?: number;
  recommendedAction: RecoveryActionType;
  reason: string;
}

export class StallClassifier {
  private stallTicks = 0;
  private starvationTicks = 0;

  classify(snapshot: TelemetrySnapshot): StallDiagnosis {
    // 1. If player is paused or actively seeking by user intent
    if (snapshot.paused || snapshot.seeking) {
      this.stallTicks = 0;
      this.starvationTicks = 0;
      return {
        type: 'PAUSED_OR_SEEKING',
        severity: 'NONE',
        stallTicks: 0,
        starvationTicks: 0,
        recommendedAction: 'NONE',
        reason: snapshot.paused ? 'Playback is paused' : 'Seeking in progress'
      };
    }

    // 2. Playback is progressing normally
    if (snapshot.timeDelta >= 0.04) {
      this.stallTicks = 0;
      this.starvationTicks = 0;
      return {
        type: 'PROGRESSING',
        severity: 'NONE',
        stallTicks: 0,
        starvationTicks: 0,
        recommendedAction: 'NONE',
        reason: 'Stream is advancing smoothly'
      };
    }

    // 3. Playback is stalled! Count duration ticks
    this.stallTicks++;

    // Case A: Downstream MSE gap detected
    if (snapshot.nextGapStart !== null && snapshot.nextGapStart > snapshot.currentTime) {
      const gapSize = snapshot.nextGapStart - snapshot.currentTime;
      if (gapSize <= 1.5) {
        eventBus.emit('STALL_CLASSIFIED', {
          type: 'MSE_BUFFER_GAP',
          gapSize,
          stallTicks: this.stallTicks
        });
        return {
          type: 'MSE_BUFFER_GAP',
          severity: 'MEDIUM',
          stallTicks: this.stallTicks,
          starvationTicks: this.starvationTicks,
          gapSize,
          recommendedAction: 'GAP_BRIDGE',
          reason: `Detected MSE buffer gap of ${gapSize.toFixed(2)}s`
        };
      }
    }

    // Case B: Decoder Freeze (Buffer is healthy ahead, readyState >= 2, but playhead is frozen)
    if (snapshot.bufferedAhead >= 0.5 && this.stallTicks >= 2) {
      eventBus.emit('STALL_CLASSIFIED', {
        type: 'DECODER_FREEZE',
        bufferedAhead: snapshot.bufferedAhead,
        stallTicks: this.stallTicks
      });
      return {
        type: 'DECODER_FREEZE',
        severity: 'MEDIUM',
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        recommendedAction: 'DECODER_NUDGE',
        reason: `Decoder frozen despite having ${snapshot.bufferedAhead.toFixed(1)}s buffer`
      };
    }

    // Case C: Live Edge Drift (Live stream lagged too far behind live edge)
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
        driftSeconds: snapshot.liveSyncDrift,
        recommendedAction: 'LIVE_RESYNC',
        reason: `Live edge drifted by ${snapshot.liveSyncDrift.toFixed(1)}s`
      };
    }

    // Case D: Network Buffer Starvation (Under 0.3s buffer ahead)
    if (snapshot.bufferedAhead < 0.3) {
      this.starvationTicks++;

      const severity =
        this.starvationTicks >= 6
          ? 'CRITICAL'
          : this.starvationTicks >= 3
          ? 'HIGH'
          : 'LOW';

      const recommendedAction: RecoveryActionType =
        this.starvationTicks >= 6
          ? 'FAILOVER_SOURCE'
          : this.starvationTicks >= 3
          ? 'HLS_RELOAD'
          : 'NONE';

      eventBus.emit('STALL_CLASSIFIED', {
        type: 'NETWORK_STARVATION',
        starvationTicks: this.starvationTicks,
        recommendedAction
      });

      return {
        type: 'NETWORK_STARVATION',
        severity,
        stallTicks: this.stallTicks,
        starvationTicks: this.starvationTicks,
        recommendedAction,
        reason: `Buffer starvation for ${this.starvationTicks}s`
      };
    }

    return {
      type: 'UNKNOWN_STALL',
      severity: 'LOW',
      stallTicks: this.stallTicks,
      starvationTicks: this.starvationTicks,
      recommendedAction: 'NONE',
      reason: 'Playback stagnant with indeterminate cause'
    };
  }

  reset(): void {
    this.stallTicks = 0;
    this.starvationTicks = 0;
  }
}
