import Hls from 'hls.js';
import { PlaybackObserver } from './observer';
import { StallClassifier } from './classifier';
import { recoveryPlanner } from './recovery-planner';
import { eventBus } from '../core/event-bus';
import { sessionManager } from '../core/session';

export interface WatchdogOptions {
  onStallRecover?: (action: string) => void;
  onStarvation?: (durationSec: number) => void;
  onFailover?: (reason: string) => void;
}

export class QuantumStreamWatchdog {
  private observer: PlaybackObserver;
  private classifier: StallClassifier;
  private getHls: () => Hls | null;
  private video: HTMLVideoElement;
  private intervalId: any = null;
  private options: WatchdogOptions;

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
    this.intervalId = setInterval(() => this.tick(), 1000);
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
    // 1. OBSERVE: Sample pure telemetry snapshot
    const snapshot = this.observer.sample();

    // 2. DIAGNOSE: Pure classification
    const diagnosis = this.classifier.classify(snapshot);

    // Update HUD buffer display
    this.updateHud(
      snapshot.bufferedAhead,
      diagnosis.type === 'PROGRESSING'
        ? 'Optimal'
        : diagnosis.type === 'PAUSED_OR_SEEKING'
        ? 'Paused'
        : diagnosis.reason
    );

    if (diagnosis.type === 'PROGRESSING' || diagnosis.type === 'PAUSED_OR_SEEKING') {
      return;
    }

    // Record stall in session
    sessionManager.recordStall(1000);
    eventBus.emit('STALL_DETECTED', {
      type: diagnosis.type,
      stallTicks: diagnosis.stallTicks,
      bufferedAhead: snapshot.bufferedAhead
    });

    if (diagnosis.type === 'NETWORK_STARVATION' && this.options.onStarvation) {
      this.options.onStarvation(diagnosis.starvationTicks);
    }

    // 3. PLAN & EXECUTE: Surgical recovery
    const recovered = recoveryPlanner.planAndExecute(diagnosis, {
      video: this.video,
      getHls: this.getHls,
      onFailover: (reason) => {
        if (this.options.onFailover) {
          this.options.onFailover(reason);
        }
      },
      onStatusUpdate: (status) => {
        this.updateHud(snapshot.bufferedAhead, status);
      }
    });

    if (recovered && this.options.onStallRecover) {
      this.options.onStallRecover(diagnosis.recommendedAction);
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
