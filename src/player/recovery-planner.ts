import Hls from 'hls.js';
import { StallDiagnosis, RecoveryActionType } from './classifier';
import { eventBus } from '../core/event-bus';

export interface RecoveryContext {
  video: HTMLVideoElement;
  getHls: () => Hls | null;
  onFailover: (reason: string) => void;
  onStatusUpdate: (status: string) => void;
}

export class RecoveryPlanner {
  planAndExecute(diagnosis: StallDiagnosis, context: RecoveryContext): boolean {
    if (diagnosis.recommendedAction === 'NONE') {
      return false;
    }

    eventBus.emit('RECOVERY_PLANNED', {
      action: diagnosis.recommendedAction,
      diagnosisType: diagnosis.type,
      reason: diagnosis.reason
    });

    const success = this.execute(diagnosis.recommendedAction, diagnosis, context);

    eventBus.emit('RECOVERY_EXECUTED', {
      action: diagnosis.recommendedAction,
      success,
      reason: diagnosis.reason
    });

    return success;
  }

  private execute(action: RecoveryActionType, diagnosis: StallDiagnosis, context: RecoveryContext): boolean {
    const { video, getHls, onFailover, onStatusUpdate } = context;
    const hls = getHls();

    switch (action) {
      case 'GAP_BRIDGE': {
        if (diagnosis.gapSize && diagnosis.gapSize > 0) {
          const target = video.currentTime + diagnosis.gapSize + 0.05;
          console.warn(`[RecoveryPlanner] Bridging MSE gap (${diagnosis.gapSize.toFixed(2)}s) to ${target.toFixed(2)}s`);
          video.currentTime = target;
          onStatusUpdate('Bridged Gap');
          return true;
        }
        return false;
      }

      case 'DECODER_NUDGE': {
        console.warn('[RecoveryPlanner] Decoder freeze detected; nudging playhead by +0.08s');
        video.currentTime += 0.08;
        video.play().catch(() => {});
        onStatusUpdate('Nudged Decoder');
        return true;
      }

      case 'LIVE_RESYNC': {
        if (hls && hls.liveSyncPosition) {
          console.warn(`[RecoveryPlanner] Live drift of ${diagnosis.driftSeconds?.toFixed(1)}s; resyncing to live edge`);
          video.currentTime = hls.liveSyncPosition - 3;
          hls.startLoad();
          onStatusUpdate('Live Resync');
          return true;
        }
        return false;
      }

      case 'HLS_RELOAD': {
        if (hls) {
          console.warn('[RecoveryPlanner] Starvation persistent; restarting HLS fragment loader');
          hls.startLoad();
          onStatusUpdate('Reloading Buffer...');
          return true;
        }
        return false;
      }

      case 'FAILOVER_SOURCE': {
        console.warn('[RecoveryPlanner] Persistent starvation reached critical threshold; triggering failover');
        onStatusUpdate('Failing over...');
        onFailover('persistent_starvation');
        return true;
      }

      default:
        return false;
    }
  }
}

export const recoveryPlanner = new RecoveryPlanner();
