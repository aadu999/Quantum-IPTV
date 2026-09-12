import Hls from 'hls.js';
import { StallDiagnosis, RecoveryActionType } from './classifier';
import { eventBus } from '../core/event-bus';

export interface RecoveryContext {
  video: HTMLVideoElement;
  getHls: () => Hls | null;
  onFailover: (reason: string) => void;
  onStatusUpdate: (status: string) => void;
}

/**
 * Shortest gap between two executions of the same action.
 *
 * The watchdog ticks once a second and re-diagnoses from scratch each time, so
 * without a cooldown a persistent condition fires its remedy on every tick:
 * DECODER_NUDGE would seek the playhead forward once a second forever, and
 * HLS_RELOAD would restart the fragment loader before the previous restart had
 * a chance to buffer anything. Each remedy needs time to be judged.
 */
const ACTION_COOLDOWN_MS: Record<RecoveryActionType, number> = {
  NONE: 0,
  GAP_BRIDGE: 600,
  DECODER_NUDGE: 1200,
  LIVE_RESYNC: 5000,
  HLS_RELOAD: 3000,
  DOWN_SWITCH: 6000,
  FAILOVER_SOURCE: 10000
};

/** Beyond this many nudges the decoder is not going to recover on its own. */
const MAX_CONSECUTIVE_NUDGES = 4;

export class RecoveryPlanner {
  private lastExecutedAt = new Map<RecoveryActionType, number>();
  private consecutiveNudges = 0;
  private reloadAttempts = 0;
  private lastReloadAt = 0;

  planAndExecute(diagnosis: StallDiagnosis, context: RecoveryContext): boolean {
    const action = diagnosis.recommendedAction;
    if (action === 'NONE') {
      return false;
    }

    const now = Date.now();
    const cooldown = ACTION_COOLDOWN_MS[action] ?? 1000;
    const lastAt = this.lastExecutedAt.get(action) || 0;
    if (now - lastAt < cooldown) {
      // Still inside the window where the previous attempt should be given a
      // chance to work. Not a failure — just not yet.
      return false;
    }

    eventBus.emit('RECOVERY_PLANNED', {
      action,
      diagnosisType: diagnosis.type,
      reason: diagnosis.reason
    });

    this.lastExecutedAt.set(action, now);
    const success = this.execute(action, diagnosis, context);

    eventBus.emit('RECOVERY_EXECUTED', {
      action,
      success,
      reason: diagnosis.reason
    });

    return success;
  }

  /**
   * Keeps a seek target inside a range the element can actually play. Seeking
   * outside `seekable` throws or silently clamps to a wildly different position,
   * which on a live stream lands the viewer minutes away from the edge.
   */
  private clampToSeekable(video: HTMLVideoElement, target: number): number | null {
    if (!Number.isFinite(target) || target < 0) return null;

    try {
      const seekable = video.seekable;
      if (!seekable || seekable.length === 0) {
        return target;
      }
      const start = seekable.start(0);
      const end = seekable.end(seekable.length - 1);
      // Stop just short of the end: seeking exactly to it usually stalls again
      // waiting for the next segment to be appended.
      const clamped = Math.min(Math.max(target, start), Math.max(start, end - 0.3));
      return Number.isFinite(clamped) ? clamped : null;
    } catch {
      return null;
    }
  }

  private execute(action: RecoveryActionType, diagnosis: StallDiagnosis, context: RecoveryContext): boolean {
    const { video, getHls, onFailover, onStatusUpdate } = context;
    const hls = getHls();

    switch (action) {
      case 'GAP_BRIDGE': {
        if (!diagnosis.gapSize || diagnosis.gapSize <= 0) return false;
        const target = this.clampToSeekable(video, video.currentTime + diagnosis.gapSize + 0.05);
        if (target === null) return false;

        console.warn(`[RecoveryPlanner] Bridging MSE gap (${diagnosis.gapSize.toFixed(2)}s) to ${target.toFixed(2)}s`);
        video.currentTime = target;
        video.play().catch(() => {});
        onStatusUpdate('Bridged Gap');
        return true;
      }

      case 'DECODER_NUDGE': {
        this.consecutiveNudges++;
        if (this.consecutiveNudges > MAX_CONSECUTIVE_NUDGES) {
          // Nudging has demonstrably failed; escalate rather than keep jerking
          // the playhead forward under the viewer.
          console.warn('[RecoveryPlanner] Decoder unresponsive after repeated nudges; escalating to failover');
          onStatusUpdate('Failing over...');
          onFailover('decoder_unrecoverable');
          this.consecutiveNudges = 0;
          return true;
        }

        // Escalating step: a frame-sized bump first, larger only if that fails.
        const step = 0.08 * this.consecutiveNudges;
        const target = this.clampToSeekable(video, video.currentTime + step);
        if (target === null) return false;

        console.warn(`[RecoveryPlanner] Decoder freeze; nudging playhead by +${step.toFixed(2)}s`);
        video.currentTime = target;
        video.play().catch(() => {});
        onStatusUpdate('Nudged Decoder');
        return true;
      }

      case 'LIVE_RESYNC': {
        // Prefer hls.js's own sync point, but fall back to the seekable end so
        // native and direct-media live streams can resync too.
        let syncTarget: number | null = null;
        if (hls && typeof hls.liveSyncPosition === 'number' && Number.isFinite(hls.liveSyncPosition)) {
          syncTarget = hls.liveSyncPosition;
        } else {
          try {
            const seekable = video.seekable;
            if (seekable && seekable.length > 0) syncTarget = seekable.end(seekable.length - 1);
          } catch {
            syncTarget = null;
          }
        }
        if (syncTarget === null) return false;

        // Sit a few seconds behind the edge rather than on it, so a momentary
        // dip in segment availability does not immediately re-stall.
        const target = this.clampToSeekable(video, Math.max(0, syncTarget - 3));
        if (target === null) return false;

        console.warn(`[RecoveryPlanner] Live drift of ${diagnosis.driftSeconds?.toFixed(1)}s; resyncing to live edge`);
        video.currentTime = target;
        hls?.startLoad();
        video.play().catch(() => {});
        onStatusUpdate('Live Resync');
        return true;
      }

      case 'HLS_RELOAD': {
        if (!hls) return false;

        // Exponential backoff with jitter: hammering a struggling origin once a
        // second makes the outage worse and wastes the recovery budget.
        const now = Date.now();
        const backoff = Math.min(15000, 1500 * Math.pow(2, this.reloadAttempts));
        if (this.lastReloadAt && now - this.lastReloadAt < backoff) return false;

        this.reloadAttempts++;
        this.lastReloadAt = now + Math.random() * 400;

        console.warn(`[RecoveryPlanner] Restarting HLS fragment loader (attempt ${this.reloadAttempts})`);
        hls.startLoad();
        onStatusUpdate('Reloading Buffer...');
        return true;
      }

      case 'DOWN_SWITCH': {
        if (!hls || !hls.levels || hls.levels.length <= 1) return false;

        const currentLevel = hls.currentLevel >= 0 ? hls.currentLevel : hls.levels.length - 1;
        if (currentLevel <= 0) return false;

        const targetLevel = currentLevel - 1;
        console.warn(
          `[RecoveryPlanner] Stepping down to level ${targetLevel} (${hls.levels[targetLevel]?.bitrate} bps) to protect the buffer`
        );

        // nextLevel applies from the following fragment without discarding what
        // is already buffered, so the switch is seamless; currentLevel would
        // flush and cause the very stall this is trying to avoid.
        hls.nextLevel = targetLevel;
        onStatusUpdate('Reducing Quality');
        return true;
      }

      case 'FAILOVER_SOURCE': {
        console.warn('[RecoveryPlanner] Recovery exhausted; triggering source failover');
        onStatusUpdate('Failing over...');
        onFailover(`unrecoverable_${diagnosis.type.toLowerCase()}`);
        return true;
      }

      default:
        return false;
    }
  }

  /** Called whenever a new stream is loaded, so budgets do not leak across zaps. */
  reset(): void {
    this.lastExecutedAt.clear();
    this.consecutiveNudges = 0;
    this.reloadAttempts = 0;
    this.lastReloadAt = 0;
  }

  /** Playback recovered on its own — clear the escalation state. */
  notifyHealthy(): void {
    this.consecutiveNudges = 0;
    this.reloadAttempts = 0;
  }
}

export const recoveryPlanner = new RecoveryPlanner();
