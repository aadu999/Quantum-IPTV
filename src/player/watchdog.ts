import Hls from 'hls.js';
import { PlaybackObserver } from './observer';
import { StallClassifier, StallDiagnosis } from './classifier';
import { recoveryPlanner } from './recovery-planner';
import { eventBus } from '../core/event-bus';
import { sessionManager } from '../core/session';
import { sourceHealthTracker } from './source-health';

export interface WatchdogOptions {
  onStallRecover?: (action: string) => void;
  onStarvation?: (durationSec: number) => void;
  onFailover?: (reason: string) => void;
  /** URL currently loaded, so stalls are attributed to the right source. */
  getCurrentUrl?: () => string;
}

/**
 * Sampling interval. 1s was coarse enough that a stall could run for nearly a
 * second before the first observation; 500ms halves the detection latency
 * without meaningfully adding work, and every threshold downstream is expressed
 * in seconds so the rate can change independently.
 */
const TICK_INTERVAL_MS = 500;

export class QuantumStreamWatchdog {
  private observer: PlaybackObserver;
  private classifier: StallClassifier;
  private getHls: () => Hls | null;
  private video: HTMLVideoElement;
  private intervalId: any = null;
  private options: WatchdogOptions;
  private wasStalled = false;

  constructor(video: HTMLVideoElement, getHls: () => Hls | null, options: WatchdogOptions = {}) {
    this.video = video;
    this.getHls = getHls;
    this.options = options;
    this.observer = new PlaybackObserver(video, getHls);
    this.classifier = new StallClassifier();
  }

  start(): void {
    this.stop();
    this.observer.reset();
    this.classifier.reset();
    recoveryPlanner.reset();
    this.wasStalled = false;
    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.observer.reset();
    this.classifier.reset();
  }

  private tick(): void {
    // 1. OBSERVE: pure telemetry snapshot, no interpretation.
    const snapshot = this.observer.sample();

    // 2. DIAGNOSE: pure classification, no side effects on playback.
    const diagnosis = this.classifier.classify(snapshot);

    this.updateHud(snapshot.bufferedAhead, this.describeHealth(diagnosis));

    const isHealthy = diagnosis.type === 'PROGRESSING' || diagnosis.type === 'PAUSED_OR_SEEKING';

    if (isHealthy) {
      if (this.wasStalled) {
        // Recovered without further intervention — release the escalation
        // budgets so the next unrelated stall starts from a clean slate.
        this.wasStalled = false;
        recoveryPlanner.notifyHealthy();
        eventBus.emit('RECOVERY_EXECUTED', { action: 'SELF_HEALED', success: true, reason: diagnosis.reason });
      }
      return;
    }

    this.wasStalled = true;

    sessionManager.recordStall(TICK_INTERVAL_MS);

    // Attribute the stall to the source that produced it. This path existed but
    // was never called, so per-endpoint stall history stayed permanently empty
    // and could never influence source ranking.
    const currentUrl = this.options.getCurrentUrl?.();
    if (currentUrl) {
      sourceHealthTracker.recordStall(currentUrl, TICK_INTERVAL_MS);
    }

    eventBus.emit('STALL_DETECTED', {
      type: diagnosis.type,
      severity: diagnosis.severity,
      stallTicks: diagnosis.stallTicks,
      stallDurationSec: diagnosis.stallDurationSec,
      bufferedAhead: snapshot.bufferedAhead
    });

    if (diagnosis.type === 'NETWORK_STARVATION' && this.options.onStarvation) {
      this.options.onStarvation(diagnosis.stallDurationSec);
    }

    // 3. PLAN & EXECUTE: the only stage permitted to touch playback.
    const recovered = recoveryPlanner.planAndExecute(diagnosis, {
      video: this.video,
      getHls: this.getHls,
      onFailover: reason => this.options.onFailover?.(reason),
      onStatusUpdate: status => this.updateHud(snapshot.bufferedAhead, status)
    });

    if (recovered && this.options.onStallRecover) {
      this.options.onStallRecover(diagnosis.recommendedAction);
    }
  }

  private describeHealth(diagnosis: StallDiagnosis): string {
    switch (diagnosis.type) {
      case 'PROGRESSING':
        return 'Optimal';
      case 'PAUSED_OR_SEEKING':
        return 'Paused';
      case 'MICRO_STUTTER':
        return 'Stuttering';
      case 'BANDWIDTH_DEFICIT':
        return 'Bandwidth Low';
      case 'DECODER_OVERLOAD':
        return 'Decoder Strained';
      default:
        return diagnosis.reason;
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
